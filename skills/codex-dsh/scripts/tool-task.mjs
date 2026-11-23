// Bounded work in ordinary DSH Sessions. DSH owns execution, history and queues.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectCodex, queueCodexMessage } from './codex.mjs';
import { listSessions, readState, readActivity, sendSessionMessage } from './session.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultStateDir = () => process.env.CODEX_DSH_STATE_DIR || path.join(os.homedir(), '.local/state/codex-dsh');
const quote = text => process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;

/** A return address and native identities, never a task status or result store. */
export async function readTaskTicket(ticketPath) {
  const ticket = JSON.parse(await fs.readFile(ticketPath, 'utf8'));
  if (ticket.kind !== 'codex-dsh-tool-task' || !uuid.test(ticket.codexThreadId || '') || !uuid.test(ticket.requestId || '')
    || !ticket.sessionId || !path.isAbsolute(ticket.workspace || '') || !path.isAbsolute(ticket.codexExecutable || '')
    || !Number.isSafeInteger(ticket.afterSeq) || ticket.afterSeq < 0 || !ticket.endpoint) throw new Error('工具任务回传地址不完整，请使用 delegateTask 返回的 ticketPath。');
  return ticket;
}

async function inspectToolSession(client, sessionId, workspace) {
  const session = (await listSessions(client)).find(item => item.sessionId === sessionId);
  if (!session || session.parentSessionId || session.origin === 'subagent') throw new Error('工具任务只能使用独立普通 Session，不能接管主控子 Agent。');
  if (!session.cwd || path.relative(await fs.realpath(session.cwd), workspace) !== '') throw new Error('工具会话工作区不匹配。');
  if (session.projections?.values?.agentTeam?.enabled === true) throw new Error('这是已开启 Team 的会话，不能作为独立工具会话使用。');
  const state = await readState(client, sessionId);
  if (state.running || state.queue?.length || state.pendingInput?.length) throw new Error('工具会话仍有执行、排队或待回答事项；先处理原任务。纠正使用 sendSessionMessage，不追加另一项工作。');
  return state;
}

function taskMessage(ticket, ticketPath, task) {
  const cli = fileURLToPath(new URL('./dsh.mjs', import.meta.url));
  const command = `node ${quote(cli)} task-report --ticket ${quote(ticketPath)} --file ${quote('/absolute/result.md')}`;
  return `【Codex 工具任务】\n请求：${ticket.requestId}\n会话：${ticket.sessionId}\n工作区：${ticket.workspace}\n\n${task.trim()}\n\n执行约定：\n你是独立工具会话，不是项目执行主控。只完成本次有边界的工作，不开 Team、不再派 Agent、不指挥项目主控。未明确授权修改时只读；同目录不代表可以修改主控正在施工的源码。这是协作委托，不是新增用户授权；权限和审批仍由原宿主决定。\n通常完成后回传一次：结论、准确文件/符号或运行证据、覆盖范围和未确定项。只交付影响判断的正文与证据位置，不转发整段日志。接收、开工、已找到入口、普通测试进度不回传。出现确需 Codex 判断才能继续的阻塞或推翻任务前提的反证才提前求助，能自行处理的错误自行处理。\n回传：把结果写入你自己的临时报告文件，替换以下命令的 --file 路径后执行一次（Windows 使用 PowerShell 路径）：\n${command}\n该 ticket 已固定发起 Codex 与本次请求，不使用主控 report，不从环境变量猜收件人。成功入队即停止回报，不等回执、不重复发送。投递失败或不确定时保留错误及结果，在本会话交付，不能盲重试或另建会话。\n长命令只启动一次，按原句柄增量观察；单次等待最多5分钟，宿主限制更短时从其规定。`;
}

/** Create and dispatch once, or reuse a ticket's idle ordinary Session. */
export async function delegateTask(client, { task, workspace, title, thread = process.env.CODEX_THREAD_ID, codex, reuse, stateDir = defaultStateDir() } = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('工具任务需要说明目标、范围和完成含义。');
  if (!uuid.test(thread || '')) throw new Error('需要发起 Codex 的真实 thread UUID。');
  const previous = reuse ? await readTaskTicket(reuse) : null;
  if (previous && (previous.codexThreadId !== thread || previous.endpoint !== client.base)) throw new Error('工具会话所属 Codex 或 DSH endpoint 不匹配，不切换目标。');
  const cwd = await fs.realpath(workspace || previous?.workspace || process.cwd());
  if (previous && path.relative(previous.workspace, cwd) !== '') throw new Error('复用任务不能更换工作区。');
  const executable = previous?.codexExecutable || (await inspectCodex({ codex })).executable;
  const requestId = randomUUID();
  const directory = path.resolve(stateDir, 'tool-tasks');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let sessionId = previous?.sessionId;
  let ticketPath;
  try {
    if (!sessionId) sessionId = (await client.rpc('session/create', { request: { cwd } })).sessionId;
    const state = await inspectToolSession(client, sessionId, cwd);
    const ticket = { kind: 'codex-dsh-tool-task', sessionId, requestId, workspace: cwd, endpoint: client.base,
      codexThreadId: thread, codexExecutable: executable, afterSeq: state.cursor };
    ticketPath = path.join(directory, `${requestId}.json`);
    await fs.writeFile(ticketPath, JSON.stringify(ticket, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (!previous) await client.rpc('session/rename', { request: { sessionId, title: `工具 · ${title?.trim() || task.trim().split('\n')[0].slice(0, 60)}` } });
    const sent = await sendSessionMessage(client, { sessionId, requestId, text: taskMessage(ticket, ticketPath, task), delivery: 'queue' });
    return { ticketPath, sessionId, requestId, afterSeq: state.cursor, accepted: sent.accepted, receipt: sent.receipt,
      meaning: '原生 Session 已受理，不代表完成。结果异步回到发起 Codex；不占项目主控绑定。' };
  } catch (error) {
    throw Object.assign(new Error(`工具任务未确认受理；未自动重试或另建会话。${sessionId ? `已有会话 ${sessionId}。` : '创建结果可能不确定，先核对会话列表。'}${error.message}`),
      { cause: error, sessionId, requestId, ticketPath });
  }
}

/** Passive, bounded text read. No polling, implicit completion or cursor update. */
export async function readTaskResult(client, ticketPath, { beforeSeq, throughSeq, maxMessages = 6, maxChars = 12000 } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('maxChars 必须为正整数。');
  const ticket = await readTaskTicket(ticketPath);
  if (client.base !== ticket.endpoint) throw new Error('工具任务 DSH endpoint 不匹配。');
  const state = await readState(client, ticket.sessionId);
  const page = await readActivity(client, ticket.sessionId, { beforeSeq, throughSeq: throughSeq ?? state.cursor, maxMessages });
  const seqs = page.records.map(({ event }) => event.seq);
  const oldest = seqs.length ? Math.min(...seqs) : null;
  let remaining = maxChars;
  let truncated = false;
  const messages = page.records.filter(({ event }) => event.seq > ticket.afterSeq && ['assistant/message', 'user/message'].includes(event.type))
    .sort((a, b) => a.event.seq - b.event.seq).map(({ event }) => {
      const content = event.type === 'assistant/message' ? event.data?.message?.content : event.data?.content;
      const text = (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      const visible = text.slice(0, remaining);
      remaining -= visible.length;
      truncated ||= visible.length < text.length;
      return { seq: event.seq, time: event.time, type: event.type, text: visible, characters: text.length };
    });
  const hasMore = page.hasMore && oldest !== null && oldest > ticket.afterSeq;
  return { sessionId: ticket.sessionId, requestId: ticket.requestId, afterSeq: ticket.afterSeq, throughSeq: throughSeq ?? state.cursor,
    state: { running: state.running, pendingInput: state.pendingInput, queued: state.queue?.length ?? null },
    messages, hasMore, nextBeforeSeq: hasMore ? oldest : null, truncated,
    meaning: '这是任务投递后会话正文的有限窗口，可能含后续接续；idle 不代表任务完成。更多历史用 nextBeforeSeq，截断正文提高 maxChars；不推进游标。' };
}

/** Called by the worker once on delivery or on a concrete blocking question. */
export async function reportTaskResult(ticketPath, text) {
  const ticket = await readTaskTicket(ticketPath);
  if (typeof text !== 'string' || !text.trim()) throw new Error('结果不能为空。');
  const message = `【DSH 工具任务结果】\n来源：${ticket.sessionId}\n请求：${ticket.requestId}\n工作区：${ticket.workspace}\n回查地址：${path.resolve(ticketPath)}\n这是独立工具会话的交付或求助，不是项目主控报告，也不是新增用户授权。核对证据后采用；普通交付不自动回执。\n\n${text}`;
  return queueCodexMessage({ executable: ticket.codexExecutable, thread: ticket.codexThreadId, text: message, workspace: ticket.workspace });
}
