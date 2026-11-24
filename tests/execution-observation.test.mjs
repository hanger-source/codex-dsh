import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DshClient, readExecution, summarizeExecution } from '../skills/codex-dsh/scripts/sdk.mjs';

// Native durable event shapes: dsh-agent-loop/tool-calls.ts and dsh-tools/types.ts.
const event = (seq, type, data, extra = {}) => ({ event: { seq, time: 1700000000000 + seq, type, data, ...extra } });
const page = (records, hasMore = false) => ({ cursor: records.at(-1)?.event.seq ?? -1, hasMore, records });
const call = (seq, callId, name, args, turn = 1) => event(seq, 'tool/call', { callId, name, arguments: JSON.stringify(args), turn, step: 1 });
const result = (seq, callId, startSeq, text, turn = 1) => event(seq, 'tool/result', {
  turn, step: 1, message: { callId, isError: false, content: [{ type: 'text', text }] },
}, { sourceEventSeqs: [startSeq] });
const nested = (seq, type, subCallId, name, args, content = []) => event(seq, type, {
  rootCallId: 'code', parentCallId: 'code', subCallId, name, arguments: args, content, isError: false,
});

test('等待调用与返回按身份关联，保留时点和最近正文，排除流式及推理碎片', () => {
  const start = page([
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { message: { content: [{ type: 'text', text: '已提交，等待核验。' }] }, stream: '不重复交付' }),
    call(3, 'wait-1', 'wait_agent', { timeout_ms: 300000 }),
    event(4, 'assistant/chunk', { text: '不把碎片当新动作' }),
  ]);
  const waiting = summarizeExecution(start);
  assert.equal(waiting.calls[0].returned, null);
  assert.equal(waiting.calls[0].closedBy, null);
  assert.equal(waiting.calls[0].started.time, 1700000000003);
  assert.deepEqual(JSON.parse(waiting.calls[0].input.text), { timeout_ms: 300000 });
  assert.equal(waiting.lastMessage.text.text, '已提交，等待核验。');
  assert.equal(waiting.lastEvent.seq, 3);
  const finished = summarizeExecution(page([...start.records, result(5, 'wait-1', 3, '等待超时'), call(6, 'cmd-1', 'bash', { command: 'git status --short' })]));
  assert.equal(finished.calls[0].returned.output.text, '等待超时');
  assert.equal(finished.calls[1].returned, null);
  assert.equal(finished.calls[1].name, 'bash');
});

test('run_code 内并发工具按原生 subCallId 配对，不根据源码文字猜等待', () => {
  const records = [
    event(1, 'turn/start', { turn: 1 }),
    call(2, 'code', 'run_code', { code: 'await Promise.all([tools.job_output(...), tools.bash(...)])' }),
    nested(3, 'tool/code-dispatch-start', 'j1', 'job_output', { job_id: 'job-A', wait: true, timeout_ms: 300000 }),
    nested(4, 'tool/code-dispatch-start', 'c1', 'bash', { command: 'git status --short' }),
    nested(5, 'tool/code-dispatch', 'c1', 'bash', { command: 'git status --short' }, [{ type: 'text', text: 'clean' }]),
  ];
  let view = summarizeExecution(page(records.toReversed()));
  assert.equal(view.calls.find(c => c.callId === 'j1').returned, null);
  assert.equal(view.calls.find(c => c.callId === 'c1').returned.output.text, 'clean');
  assert.deepEqual(JSON.parse(view.calls.find(c => c.callId === 'j1').input.text), { job_id: 'job-A', wait: true, timeout_ms: 300000 });
  assert.equal(view.calls.find(c => c.callId === 'j1').parentCallId, 'code');
  view = summarizeExecution(page([...records, result(6, 'code', 2, '结束')]));
  // Missing nested return remains missing, but a returned parent is not an active wait.
  assert.equal(view.calls.find(c => c.callId === 'j1').returned, null);
  assert.equal(view.calls.find(c => c.callId === 'j1').closedBy.seq, 6);
  const opaque = summarizeExecution(page([call(8, 'opaque', 'run_code', { code: 'await tools.wait_agent({ timeout_ms: 300000 })' })]));
  assert.deepEqual(opaque.calls.map(c => c.name), ['run_code']);
});

test('终止旧轮的未返回调用不污染新轮；同名/复用 ID 按真实事件配对', () => {
  const view = summarizeExecution(page([
    event(1, 'turn/start', { turn: 1 }), call(2, 'same', 'bash', {}, 1),
    event(3, 'turn/end', { turn: 1, reason: 'aborted' }),
    event(4, 'turn/start', { turn: 2 }), call(5, 'same', 'bash', {}, 2),
    result(6, 'same', 5, '新轮成功', 2),
  ]));
  assert.equal(view.calls[0].returned, null);
  assert.equal(view.calls[0].closedBy.seq, 3);
  assert.equal(view.calls[1].returned.output.text, '新轮成功');
  assert.equal(view.calls[1].closedBy, null);
});

test('分页缺开始、文本截断与非文本块均保留可追溯边界，不伪造空闲/完整', () => {
  const r = result(52, 'missing', 10, '完整输出'.repeat(20));
  r.event.data.message.content.push({ type: 'image', data: '不输出二进制原件' });
  const view = summarizeExecution(page([r], true), { maxChars: 8 });
  assert.equal(view.hasMore, true);
  assert.equal(view.nextBeforeSeq, 52);
  assert.equal(view.calls[0].started, null);
  assert.equal(view.calls[0].name, null);
  assert.equal(view.calls[0].returned.output.text.length, 8);
  assert.equal(view.calls[0].returned.output.truncated, true);
  assert.equal(view.calls[0].returned.output.chars, 80);
  assert.deepEqual(view.calls[0].returned.contentTypes, ['text', 'image']);
  assert.equal(view.turn, null);
});

test('HTTP 读取保留子地址和原生队列，固定窗口，两次只读请求，无激活/重试/自动翻页', async () => {
  const calls = [];
  let cursor = 12;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    calls.push(rpc);
    const args = rpc.payload.args.request;
    let value;
    let error;
    if (rpc.method === 'session/state') value = { cursor, active: true, running: true,
      queue: [{ id: 'queued', placement: 'steering' }], pendingInput: [{ id: 'approval' }] };
    else if (rpc.method === 'session/events' && args.address.parentSessionId === 'parent') {
      value = { ...page([call(11, 'wait', 'wait_agent', { timeout_ms: 300000 })], true), cursor: 12 };
    } else error = { code: 'subagent/unauthorized', message: 'wrong parent or unexpected method' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: error ? { ok: false, error } : { ok: true, value } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new DshClient();
  client.base = `http://127.0.0.1:${server.address().port}/`;
  client.cookie = '';
  const target = { address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' } };
  try {
    const view = await readExecution(client, target);
    assert.deepEqual(calls.map(c => c.method), ['session/state', 'session/events']);
    assert.deepEqual(calls[0].payload.args.request, { sessionId: 'child' });
    assert.deepEqual(calls[1].payload.args.request, { address: target.address, maxMessages: 3, throughSeq: 12 });
    assert.equal(view.hasMore, true);
    assert.equal(view.state.running, true);
    assert.equal(view.state.queue[0].id, 'queued');
    assert.equal(view.state.pendingInput[0].id, 'approval');
    assert.equal(view.calls[0].name, 'wait_agent');
    assert.equal(view.calls[0].returned, null);
    await readExecution(client, target, { beforeSeq: 11, throughSeq: 12, maxMessages: 5 });
    assert.equal(calls.at(-1).payload.args.request.beforeSeq, 11);
    assert.equal(calls.at(-1).payload.args.request.maxMessages, 5);
    await assert.rejects(readExecution(client, { ...target.address, parentSessionId: 'wrong' }), { code: 'subagent/unauthorized' });
    assert.equal(calls.length, 6);
    cursor = -1;
    const empty = await readExecution(client, target);
    assert.equal(calls.length, 7);
    assert.deepEqual(empty.calls, []);
    assert.equal(empty.throughSeq, -1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
