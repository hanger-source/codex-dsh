// Composable native queries and delivery. The caller owns connection and selection.
import { randomUUID } from 'node:crypto';

export async function listSessions(client) {
  return (await client.rpc('session/list', { _request: {} })).items;
}

export function readState(client, sessionId) {
  return client.rpc('session/state', { request: { sessionId } });
}

export async function readProjections(client, sessionId, keys) {
  const result = await client.rpc('session/projections', { request: { sessionId } });
  if (result === null || keys === undefined) return result;
  return { ...result, values: Object.fromEntries(keys.filter(key => Object.hasOwn(result.values, key)).map(key => [key, result.values[key]])) };
}

export async function readTasks(client, sessionId) {
  // Keep native task owner, blockers, write scopes and diagnostics, not a second board.
  return readProjections(client, sessionId, ['agentTeam']);
}

export async function readUsage(client, sessionId) {
  // Native counters are not a monetary cost estimate or proof of useful progress.
  return readProjections(client, sessionId, ['tokenUsage', 'subagentTiming', 'modelSelection']);
}

export async function listAgents(client, rootSessionId, { recursive = true, sessions } = {}) {
  const items = sessions ?? await listSessions(client);
  const byId = new Map(items.map(item => [item.sessionId, item]));
  if (!byId.has(rootSessionId)) throw new Error(`找不到 DSH 会话 ${rootSessionId}`);
  if (!Array.isArray(byId.get(rootSessionId).projections?.values?.subagentCatalog)) throw new Error(`主控子 Agent 目录不可读：${rootSessionId}`);
  const rows = [];
  const seen = new Set([rootSessionId]);
  function visit(parentId, prefix, depth) {
    const parent = byId.get(parentId);
    const values = parent?.projections?.values;
    const catalog = new Map((values?.subagentCatalog ?? []).map(entry => [entry.id, entry]));
    const children = new Map(items.filter(item => item.parentSessionId === parentId && item.origin === 'subagent').map(item => [item.sessionId, item]));
    for (const id of new Set([...catalog.keys(), ...children.keys()])) {
      if (seen.has(id)) throw new Error(`子 Agent 目录出现重复或循环身份：${id}`);
      seen.add(id);
      const entry = catalog.get(id);
      const child = byId.get(id);
      if (child?.parentSessionId !== undefined && child.parentSessionId !== parentId) throw new Error(`子 Agent 归属与目录冲突：${id}`);
      const name = entry?.name ?? null;
      const agentPath = prefix === null || name === null ? null : (prefix ? `${prefix}/${name}` : name);
      rows.push({
        sessionId: id, parentSessionId: parentId, name, path: agentPath, depth,
        label: entry?.label ?? child?.projections?.values?.subagent?.label ?? child?.projections?.values?.title ?? null,
        mode: entry?.mode ?? null,
        running: typeof child?.running === 'boolean' ? child.running : null,
        updatedAt: child?.updatedAt ?? null,
        catalogAvailable: Array.isArray(child?.projections?.values?.subagentCatalog),
      });
      if (recursive && child !== undefined) visit(id, agentPath, depth + 1);
    }
  }
  visit(rootSessionId, '', 1);
  return rows;
}

export async function resolveAgent(client, rootSessionId, target) {
  if (target === rootSessionId || target === undefined) return { sessionId: rootSessionId, root: true };
  const matches = (await listAgents(client, rootSessionId)).filter(item => item.sessionId === target || item.path === target);
  if (matches.length !== 1) throw new Error(`子 Agent 不存在或名称有歧义：${target}；先用 agents 查看路径或精确 ID。`);
  return { ...matches[0], root: false };
}

export async function readActivity(client, sessionId, { beforeSeq, throughSeq, maxMessages = 12 } = {}) {
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new Error('maxMessages 必须为正整数。');
  for (const value of [beforeSeq, throughSeq]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('历史序号必须为非负整数。');
  }
  return client.rpc('session/events', { request: {
    address: { kind: 'session', sessionId }, maxMessages,
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    ...(throughSeq === undefined ? {} : { throughSeq }),
  } });
}

export function summarizeActivity(page) {
  const records = page.records.map(({ event }) => ({ seq: event.seq, time: event.time, type: event.type }));
  return { cursor: page.cursor, hasMore: page.hasMore, records,
    nextBeforeSeq: records.length ? Math.min(...records.map(record => record.seq)) : null };
}

export async function sendAgentMessage(client, { rootSessionId, target, text, delivery = 'steer', requestId = randomUUID(), clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空。');
  if (!['steer', 'queue'].includes(delivery)) throw new Error('delivery 只能是 steer 或 queue。');
  if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('requestId 不能为空。');
  const recipient = await resolveAgent(client, rootSessionId, target);
  if (recipient.root) throw new Error('sendAgentMessage 只投递子 Agent；主控指导使用 send。');
  if (recipient.mode !== 'continuable') throw new Error(`该子 Agent 未声明可接续（${recipient.mode ?? 'unknown'}），不能投递。`);
  const message = `【Codex 协作指导】\n所属主控：${rootSessionId}\n这是协作方意见，不是新增用户授权；继续向原主控交付，跨模块分工变化由主控统筹。\n\n${text}`;
  const receipt = await client.rpc('subagents/prompt', { request: {
    childSessionId: recipient.sessionId, delivery, requestId, clientTimeZone,
    content: [{ type: 'text', text: message }],
  } });
  return { sessionId: recipient.sessionId, rootSessionId, requestId, delivery, ...receipt,
    meaning: '原生接口已接受投递，不代表模型已读取或完成；没有自动通知主控。' };
}
