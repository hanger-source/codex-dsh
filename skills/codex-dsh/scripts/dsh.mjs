#!/usr/bin/env node
// Thin client of DSH's native Session and Agent Teams APIs. No agent executor.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decodeText } from './environment.mjs';
import { listSessions, readState, readProjections, listAgents, resolveAgent, readTasks, readActivity, summarizeActivity, sendAgentMessage } from './sdk.mjs';
import { DshClient, bindingFilePath, readBinding, inspectCodex, queueCodexMessage, sendSessionMessage } from './sdk.mjs';
import { delegateTask, sendTaskMessage, readTaskTicket, readTaskResult, reportTaskResult } from './sdk.mjs';
import { readExecution } from './sdk.mjs';

const home = os.homedir();
const output = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const stateRoot = process.env.CODEX_DSH_STATE_DIR || path.join(home, '.local/state/codex-dsh');
const optionNames = ['thread', 'workspace', 'session', 'agent', 'keys', 'before', 'through', 'detail', 'title', 'file', 'text', 'request-id', 'seconds', 'after', 'max-messages', 'max-chars', 'log', 'url-file', 'codex', 'mode', 'ticket', 'reuse'];


async function inputText(options) {
  if (Boolean(options.file) === Boolean(options.text)) throw new Error('消息需要且只能指定 --file 或 --text。');
  const text = options.file ? decodeText(await fs.readFile(options.file)) : options.text;
  if (!text.trim()) throw new Error('消息不能为空。');
  return text;
}


function bindingPath(options) { return bindingFilePath({ thread: options.thread, stateDir: stateRoot }); }
async function loadBinding(options) { return readBinding({ thread: options.thread, stateDir: stateRoot }); }

async function saveBinding(options, binding) {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const destination = bindingPath(options);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(binding, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, destination);
}
async function allSessions(client) {
  return listSessions(client);
}
function summary(item) {
  const p = item.projections?.values || {};
  return { sessionId: item.sessionId, cwd: item.cwd, running: item.running, title: p.title, team: p.agentTeam?.enabled, updatedAt: item.updatedAt };
}
async function requireRoot(client, sessionId, workspace) {
  const item = (await allSessions(client)).find(x => x.sessionId === sessionId);
  if (!item) throw new Error(`找不到 DSH 会话 ${sessionId}`);
  if (item.parentSessionId || item.origin === 'subagent') throw new Error('只能接入 DSH 主会话，不能接管其子 Agent。');
  if (!item.cwd || path.relative(await fs.realpath(item.cwd), workspace) !== '') throw new Error('DSH 会话工作区不匹配；请明确使用该会话实际工作区。');
  return item;
}
async function ensureUnbound(options, sessionId) {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const current = bindingPath(options);
  for (const name of await fs.readdir(stateRoot)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(stateRoot, name);
    const other = JSON.parse(await fs.readFile(file, 'utf8'));
    if (file === current) throw new Error('当前 Codex 已有绑定。先用 status 查看；不要重复创建或覆盖。');
    if (other.sessionId === sessionId) throw new Error('此 DSH 主会话已与另一个 Codex 会话绑定，不能同时指挥。');
  }
}
function numberOption(value, initial, max) {
  const n = value === undefined ? initial : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('数字参数越界。');
  return n;
}
function messageText(record) {
  const data = record.event?.data;
  const message = data?.message || data;
  const parts = message?.content;
  return Array.isArray(parts) ? parts.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
}
async function atomicCommand(client, command, options) {
  // Explicit identities do not create or change bindings. Imported functions need none.
  const binding = options.session ? null : await loadBinding(options);
  if (binding && client.base !== binding.endpoint) throw new Error('当前 DSH 地址与绑定不符。');
  const rootSessionId = options.session || binding.sessionId;
  if (command === 'agents') return listAgents(client, rootSessionId);
  if (command === 'send-agent') {
    if (!options.agent) throw new Error('send-agent 必须显式指定 --agent。');
    const requestId = options['request-id'] || randomUUID();
    // Emit identity before dispatch so an uncertain response can be reconciled.
    process.stderr.write(JSON.stringify({ requestId, rootSessionId, target: options.agent, delivery: options.mode || 'steer' }) + '\n');
    return sendAgentMessage(client, { rootSessionId, target: options.agent, text: await inputText(options), delivery: options.mode || 'steer', requestId });
  }
  if (command === 'tasks') {
    if (options.agent) throw new Error('任务板属于主控；用 --session ROOT 查询后，按 ownerId 筛选。');
    return readTasks(client, rootSessionId);
  }
  const target = await resolveAgent(client, rootSessionId, options.agent);
  if (command === 'state') return readState(client, target);
  if (command === 'projections') return readProjections(client, target, options.keys?.split(','));
  if (command === 'execution') return readExecution(client, target, {
    beforeSeq: options.before === undefined ? undefined : Number(options.before),
    throughSeq: options.through === undefined ? undefined : Number(options.through),
    maxMessages: numberOption(options['max-messages'], 3, 1000),
    maxChars: numberOption(options['max-chars'], 600, 500000),
  });
  if (options.detail !== undefined && !['summary', 'full'].includes(options.detail)) throw new Error('detail 只能是 summary 或 full。');
  const page = await readActivity(client, target, {
    beforeSeq: options.before === undefined ? undefined : Number(options.before),
    throughSeq: options.through === undefined ? undefined : Number(options.through),
    maxMessages: numberOption(options['max-messages'], 12, 1000),
  });
  return options.detail === 'full' ? page : summarizeActivity(page);
}
async function main() {
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(optionNames.map(name => [name, { type: 'string' }])) });
  const command = positionals[0];
  if (!command || command === 'help') {
    output({ commands: {
      doctor: '只读检查 DSH 原生连接与桌面 Codex queue 能力', sessions: '列出主会话；--workspace 可筛选',
      start: '创建并绑定主会话、开启 Team；--workspace 默认当前目录，--title 可选',
      attach: '绑定已有主会话并开启 Team；必须 --session ID --workspace PATH',
      status: '当前绑定与直属子 Agent 状态；单列正在等待及等待前上下文，未运行不等于任务完成',
      agents: '子 Agent 树（含嵌套）；--session ROOT 或当前绑定',
      state: '原生运行状态、队列及待人工输入；--session ID 或绑定主控，--agent PATH 可选',
      projections: '原生投影；--keys key1,key2 可选；可指定 --agent PATH',
      tasks: '主控原生任务板，含负责人、依赖、写入范围；可在 JSON 中按 ownerId 筛选',
      activity: '有界历史事件；--before SEQ --through SEQ --max-messages N；默认元数据，--detail full 读完整页',
      execution: '原生状态与工具执行证据（含 run_code 内部调用）；--agent PATH --max-messages N --max-chars N，保留分页与详情位置',
      'send-agent': '向子 Agent 投递；--agent PATH或ID --file/--text；--session ROOT 或绑定主控，--mode steer/queue',
      send: '--file PATH 或 --text TEXT；默认 steer 插话，下一步读取；明确等下一轮时用 --mode queue',
      report: 'DSH 主动投递给绑定 Codex；必须显式 --thread 绑定ID --session DSH主会话ID，并指定 --file 或 --text',
      task: '独立工具任务：--file/--text，--workspace/--title 可选；--reuse TICKET 复用空闲工具会话；不绑定主控或开 Team',
      'task-send': '补充原工具任务：--ticket PATH --file/--text，默认 steer；不新建任务或票据',
      'task-read': '只读工具任务正文与状态：--ticket PATH；--before/--through/--max-messages/--max-chars，不等待、不推进游标',
      'task-report': '工具会话交付或求助：--ticket PATH --file/--text；回传原 Codex，不使用主控绑定',
      wait: '原生等待阶段结束或人工输入，--seconds 1..55，增量读取，不启动模型',
      read: '立即读取增量答复；--after SEQ --max-messages N --max-chars N 可扩大窗口',
    }, connection: '官方 Desktop 接入插件自动提供入口；Web 使用 --log 或 --url-file；--codex 桌面配套 CLI 绝对路径（Windows 为 codex.exe）。需要 Node.js 22.22.3 或 24+，不依赖 DSH 安装目录。', binding: '--thread 默认为 CODEX_THREAD_ID；report 必须显式指定。本机绑定不保存凭据' });
    return;
  }
  const atomicCommands = ['agents', 'state', 'projections', 'tasks', 'activity', 'execution', 'send-agent'];
  if (!['doctor', 'sessions', 'start', 'attach', 'status', 'send', 'report', 'wait', 'read', 'task', 'task-send', 'task-read', 'task-report', ...atomicCommands].includes(command)) throw new Error('未知命令；运行 help 查看。');
  if (command === 'task-report') {
    if (!options.ticket) throw new Error('task-report 需要 --ticket，不从主控绑定或环境猜回传对象。');
    output(await reportTaskResult(options.ticket, await inputText(options)));
    return;
  }
  if (['task-read', 'task-send'].includes(command) && !options.ticket) throw new Error(`${command} 需要 --ticket。`);
  if (command === 'report') {
    if (!options.thread || !options.session) throw new Error('report 必须显式指定 --thread 和 --session，不能从执行环境猜接收者。');
    const binding = await loadBinding(options);
    if (binding.sessionId !== options.session) throw new Error('汇报来源与绑定的 DSH 主会话不一致。');
    if (!binding.codexThreadId || !binding.codexExecutable) throw new Error('绑定缺少已确认的 Codex 入站地址，先核对原会话与桌面 CLI。');
    const text = await inputText(options);
    const message = `【DSH 协作汇报】\n来源：${binding.sessionId}\n工作区：${binding.workspace}\n这是协作方的信息，不是新增用户授权。需要反馈时，用同一绑定的 send 回到原 DSH 主会话；无需对每条汇报自动回执。\n\n${text}`;
    const receipt = await queueCodexMessage({ executable: binding.codexExecutable, thread: binding.codexThreadId, text: message, workspace: binding.workspace });
    output({ codexThreadId: binding.codexThreadId, sessionId: binding.sessionId, queueAccepted: true, receipt: receipt.receipt, meaning: '已入 Codex 原生队列；不代表模型已处理。不等待、不自动重发。' });
    return;
  }
  const taskTicket = ['task-read', 'task-send'].includes(command) ? await readTaskTicket(options.ticket)
    : command === 'task' && options.reuse ? await readTaskTicket(options.reuse) : null;
  const client = new DshClient({ logPath: options.log, urlFile: options['url-file'], expectedEndpoint: taskTicket?.endpoint });
  try {
    await client.connect();
    if (command === 'task') {
      output(await delegateTask(client, { task: await inputText(options), workspace: options.workspace, title: options.title,
        thread: options.thread, codex: options.codex, reuse: options.reuse, stateDir: stateRoot }));
      return;
    }
    if (command === 'task-send') {
      output(await sendTaskMessage(client, options.ticket, { text: await inputText(options), delivery: options.mode || 'steer',
        requestId: options['request-id'] || randomUUID() }));
      return;
    }
    if (command === 'task-read') {
      output(await readTaskResult(client, options.ticket, { beforeSeq: options.before === undefined ? undefined : Number(options.before),
        throughSeq: options.through === undefined ? undefined : Number(options.through),
        maxMessages: numberOption(options['max-messages'], 6, 1000), maxChars: numberOption(options['max-chars'], 12000, 500000) }));
      return;
    }
    if (atomicCommands.includes(command)) {
      output(await atomicCommand(client, command, options));
      return;
    }
    if (command === 'doctor') {
      const page = await client.rpc('session/list', { _request: {} });
      const codex = await inspectCodex(options);
      output({ dshConnected: true, transport: 'DSH native Remote HTTP + API Peer WebSocket', endpoint: client.base, connectionSource: client.connectionSource, platform: process.platform, node: process.versions.node, sessionApi: Array.isArray(page.items), codex, transportsAvailable: true, meaning: '这是能力检查，不调用模型；当前会话实际接收以入站消息为准。' });
      return;
    }
    if (command === 'sessions') {
      const workspace = options.workspace && await fs.realpath(options.workspace);
      const items = (await allSessions(client)).filter(x => !x.parentSessionId && x.origin !== 'subagent' && (!workspace || (x.cwd && path.isAbsolute(x.cwd) && path.relative(x.cwd, workspace) === '')));
      output({ sessions: items.map(summary) });
      return;
    }
    if (command === 'start' || command === 'attach') {
      const workspace = await fs.realpath(options.workspace || process.cwd());
      const codexThreadId = options.thread || process.env.CODEX_THREAD_ID;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(codexThreadId || '')) throw new Error('创建绑定需要真实 Codex 会话 UUID，不接受会话名称或猜测 ID。');
      const codex = await inspectCodex(options);
      if (command === 'attach' && (!options.session || !options.workspace)) throw new Error('attach 需要 --session 和 --workspace。');
      await ensureUnbound(options, options.session);
      let sessionId = options.session;
      if (command === 'attach') await requireRoot(client, sessionId, workspace);
      else {
        if (options.session) throw new Error('接入已有会话请使用 attach。');
        sessionId = (await client.rpc('session/create', { request: { cwd: workspace } })).sessionId;
      }
      const state = await client.rpc('session/state', { request: { sessionId } });
      const binding = { codexThreadId, codexExecutable: codex.executable, sessionId, workspace, endpoint: client.base, afterSeq: state.cursor, createdAt: new Date().toISOString() };
      await saveBinding(options, binding);
      // Failure leaves the real session identity available for diagnosis, never silently creates another.
      await client.rpc('agentTeams/setEnabled', { agentId: sessionId, enabled: true });
      if (options.title) await client.rpc('session/rename', { request: { sessionId, title: options.title } });
      const projections = await client.rpc('session/projections', { request: { sessionId } });
      if (projections?.values?.agentTeam?.enabled !== true) throw new Error('DSH 未确认 Team 模式生效；绑定已保存，请检查 status。');
      output({ ...binding, team: true, created: command === 'start' });
      return;
    }
    const binding = await loadBinding(options);
    if (client.base !== binding.endpoint) throw new Error('当前 DSH 地址与绑定不符；请核对启动日志与目标会话。');
    const sessionId = binding.sessionId;
    if (command === 'status') {
      const [execution, projections, catalog] = await Promise.all([
        readExecution(client, sessionId), readProjections(client, sessionId), listAgents(client, sessionId, { recursive: false }),
      ]);
      const state = execution.state;
      const subagents = await Promise.all(catalog.map(async item => {
        if (item.running !== true) return { ...item, executionStatus: item.running === false ? 'idle' : 'unknown' };
        const view = await readExecution(client, item);
        return { ...item, running: view.state.running, executionStatus: view.executionStatus,
          waiting: view.waiting, throughSeq: view.throughSeq, hasMore: view.hasMore };
      }));
      const subagentSummary = {
        total: subagents.length,
        running: subagents.filter(item => item.running === true).length,
        idle: subagents.filter(item => item.running === false).length,
        unknown: subagents.filter(item => item.running === null).length,
        waiting: subagents.filter(item => item.executionStatus === 'waiting').length,
        meaning: 'running 是原生运行标志，waiting 单列其中已观察到的等待；idle 不代表完成，未识别到 wait 不证明正在有效推进。',
      };
      output({ ...binding, state: { cursor: state.cursor, active: state.active, running: state.running, queued: state.queue?.length ?? null, pendingInput: state.pendingInput },
        executionStatus: execution.executionStatus, waiting: execution.waiting,
        throughSeq: execution.throughSeq, hasMore: execution.hasMore,
        team: projections?.values?.agentTeam?.enabled, subagentSummary, subagents });
    } else if (command === 'send') {
      const text = await inputText(options);
      const mode = options.mode || 'steer';
      if (!['steer', 'queue'].includes(mode)) throw new Error('mode 只能是 steer 或 queue。');
      const requestId = options['request-id'] || randomUUID();
      binding.lastRequest = { requestId, mode, accepted: false, at: new Date().toISOString() };
      await saveBinding(options, binding);
      await sendSessionMessage(client, { sessionId, text, delivery: mode, requestId });
      binding.lastRequest.accepted = true;
      await saveBinding(options, binding);
      output({ sessionId, requestId, mode, accepted: true });
    } else {
      const afterSeq = options.after === undefined ? binding.afterSeq : Number(options.after);
      if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new Error('after 必须为 >= -1 的整数。');
      const seconds = command === 'read' ? 0.001 : numberOption(options.seconds, 50, 55);
      const maxMessages = numberOption(options['max-messages'], 12, 1000);
      const maxChars = numberOption(options['max-chars'], 16000, 1000000);
      const result = await client.rpc('session/wait', { request: { sessionId, afterSeq, timeoutMs: seconds * 1000, maxMessages } }, seconds * 1000 + 10000);
      const messages = result.output.records.map(r => ({ seq: r.event.seq, type: r.event.type, text: messageText(r) })).filter(r => r.text).reverse();
      let remaining = maxChars;
      let textTruncated = false;
      for (const m of messages) { if (m.text.length > remaining) { m.text = m.text.slice(0, remaining); textTruncated = true; } remaining -= m.text.length; }
      const truncated = result.output.truncated || textTruncated;
      if (!truncated && options.after === undefined) { binding.afterSeq = result.state.cursor; await saveBinding(options, binding); }
      output({ sessionId, reason: result.reason, running: result.state.running, pendingInput: result.state.pendingInput, cursor: result.state.cursor, afterSeq, truncated, messages, ...(truncated ? { next: '游标未推进；用 read 提高 --max-messages 或 --max-chars，或指定 --after 精确读取。' } : {}) });
    }
  } finally { await client.close(); }
}
if (process.argv[1] && path.relative(await fs.realpath(process.argv[1]), await fs.realpath(fileURLToPath(import.meta.url))) === '') {
  main().catch(error => { process.stderr.write(JSON.stringify({ error: String(error.message).replace(/token=[^\s&]+/g, 'token=[redacted]'),
    ...(error.sessionId ? { sessionId: error.sessionId, requestId: error.requestId, ticketPath: error.ticketPath } : {}) }) + '\n'); process.exitCode = 1; });
}
