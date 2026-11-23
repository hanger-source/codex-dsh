import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DshClient, delegateTask, sendTaskMessage, readTaskTicket, readTaskResult } from '../skills/codex-dsh/scripts/sdk.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), "DSH 工具 ' & "));
const originalCwd = process.cwd();
process.chdir(root);
after(() => process.chdir(originalCwd));
// Node is a harmless stand-in executable: queue only returns argv, never calls Codex.
await fs.writeFile(path.join(root, 'queue'), 'console.log(process.argv.includes("--help") ? "--thread --message" : JSON.stringify(process.argv.slice(2)))');
const thread = '12345678-1234-1234-1234-123456789012';

async function gateway(run) {
  const calls = [];
  const sessions = [];
  const state = { cursor: 10, active: true, running: false, queue: [], pendingInput: [] };
  let rejectPrompt = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const request = body.payload.args.request;
    let value;
    if (body.method === 'session/create') {
      const sessionId = `session-${sessions.length + 1}`;
      sessions.push({ sessionId, cwd: request.cwd, projections: { values: { agentTeam: { enabled: false } } } });
      value = { sessionId };
    } else if (body.method === 'session/list') value = { items: sessions };
    else if (body.method === 'session/state') value = state;
    else if (body.method === 'session/rename') value = { sessionId: request.sessionId, title: request.title };
    else if (body.method === 'session/prompt') value = { requestId: request.requestId, messageId: 'native-message' };
    else if (body.method === 'session/events') {
      const event = (seq, type, data) => ({ event: { seq, type, data } });
      value = { cursor: 20, hasMore: true, records: request.beforeSeq === 15
        ? [event(12, 'assistant/message', { message: { content: [{ type: 'text', text: '早期证据' }] } }), event(10, 'user/message', { content: [{ type: 'text', text: '之前任务' }] })]
        : [event(18, 'assistant/message', { message: { content: [{ type: 'text', text: '有待核实的结果与证据' }] }, stream: 'DO_NOT_LOAD', usage: 'DO_NOT_LOAD' }),
          event(17, 'tool/result', { secret: 'DO_NOT_LOAD' }), event(15, 'user/message', { content: [{ type: 'text', text: '限定任务' }] })] };
    }
    const result = body.method === 'session/prompt' && rejectPrompt
      ? { ok: false, error: { code: 'session/delivery-unavailable', message: 'unconfirmed' } }
      : value !== undefined ? { ok: true, value } : { ok: false, error: { code: 'unexpected', message: body.method } };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new DshClient();
  client.base = `http://127.0.0.1:${server.address().port}/`;
  client.cookie = '';
  const stateDir = await fs.mkdtemp(path.join(root, 'state '));
  const options = { thread, workspace: root, codex: process.execPath, stateDir, task: '只读核对公开接口并提供证据', title: '接口核对' };
  try { await run({ client, calls, sessions, state, options, reject: () => { rejectPrompt = true; } }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('independent work dispatch and reuse preserve project binding and native request identity', async () => {
  await gateway(async ({ client, calls, sessions, options }) => {
    const bindingPath = path.join(options.stateDir, `${thread}.json`);
    const original = JSON.stringify({ sessionId: 'project-controller', afterSeq: 1234 });
    await fs.writeFile(bindingPath, original);
    const first = await delegateTask(client, options);
    const ticket = await readTaskTicket(first);
    assert.equal(ticket.sessionId, first.sessionId);
    const delivered = calls.find(call => call.method === 'session/prompt').payload.args.request;
    assert.equal(delivered.requestId, first.requestId);
    assert.equal(delivered.mode, 'queue');
    assert.ok(delivered.content[0].text.includes('task-report --ticket'));
    assert.equal(calls.some(call => call.method.startsWith('agentTeams/')), false);
    const next = await delegateTask(client, { ...options, reuse: first, task: '沿原接口补查异常返回' });
    assert.equal(next.sessionId, first.sessionId);
    assert.notEqual(next.requestId, first.requestId);
    assert.equal(sessions.length, 1);
    assert.equal(await fs.readFile(bindingPath, 'utf8'), original);
  });
});

test('guidance steers the busy original Session and keeps its return address and request history', async () => {
  await gateway(async ({ client, calls, sessions, state, options }) => {
    const task = await delegateTask(client, options);
    const before = await fs.readFile(task.ticketPath, 'utf8');
    const ticketFiles = await fs.readdir(path.dirname(task.ticketPath));
    state.running = true;
    const receipt = await sendTaskMessage(client, task, { text: '重点核对人工接管后的出站', requestId: 'guidance-once' });
    const sent = calls.filter(call => call.method === 'session/prompt').at(-1).payload.args.request;
    assert.equal(sent.sessionId, task.sessionId);
    assert.equal(sent.mode, 'steer');
    assert.equal(sent.requestId, 'guidance-once');
    assert.ok(sent.content[0].text.includes(task.requestId));
    assert.ok(sent.content[0].text.endsWith('重点核对人工接管后的出站'));
    assert.equal(receipt.requestId, task.requestId);
    assert.equal(receipt.deliveryRequestId, 'guidance-once');
    assert.equal(sessions.length, 1);
    assert.deepEqual(await fs.readdir(path.dirname(task.ticketPath)), ticketFiles);
    assert.equal(await fs.readFile(task.ticketPath, 'utf8'), before);
    state.cursor = 20;
    const result = await readTaskResult(client, task);
    assert.equal(result.state.running, true);
    assert.ok(result.messages.some(message => message.text === '有待核实的结果与证据'));
    state.running = false;
    const next = await delegateTask(client, { ...options, reuse: task, task: '结合刚才的证据补查权限变化' });
    assert.equal(next.sessionId, task.sessionId);
    assert.notEqual(next.requestId, task.requestId);
    assert.equal((await readTaskTicket(task)).requestId, task.requestId);
    assert.equal((await readTaskTicket(next)).afterSeq, 20);
    assert.equal(await fs.readFile(task.ticketPath, 'utf8'), before);
  });
});

test('guidance rejects wrong identity or endpoint, and an unconfirmed send is not retried', async () => {
  await gateway(async ({ client, calls, sessions, options, reject }) => {
    const task = await delegateTask(client, options);
    await assert.rejects(sendTaskMessage(client, { ...task, sessionId: 'another' }, { text: '核对权限' }), /身份不一致/);
    await assert.rejects(readTaskResult(client, { ...task, requestId: 'another' }), /身份不一致/);
    await assert.rejects(sendTaskMessage({ base: 'http://127.0.0.1:1/' }, task, { text: '核对权限' }), /endpoint/);
    sessions[0].projections.values.agentTeam.enabled = true;
    await assert.rejects(sendTaskMessage(client, task, { text: '核对权限' }), /Team/);
    sessions[0].projections.values.agentTeam.enabled = false;
    reject();
    await assert.rejects(sendTaskMessage(client, task, { text: '核对权限', requestId: 'unconfirmed-guidance' }), error => {
      assert.equal(error.sessionId, task.sessionId);
      assert.equal(error.requestId, 'unconfirmed-guidance');
      assert.equal(error.ticketPath, task.ticketPath);
      return /未自动重试/.test(error.message);
    });
    assert.equal(calls.filter(call => call.method === 'session/prompt').length, 2);
    assert.equal(sessions.length, 1);
  });
});

test('busy, approval-blocked, team, cross-thread and wrong-endpoint reuse cannot dispatch work', async () => {
  await gateway(async ({ client, calls, sessions, state, options }) => {
    const first = await delegateTask(client, options);
    const reuse = { ...options, reuse: first.ticketPath };
    state.running = true;
    await assert.rejects(delegateTask(client, reuse), /仍有执行/);
    state.running = false;
    state.pendingInput = ['approval'];
    await assert.rejects(delegateTask(client, reuse), /待回答/);
    state.pendingInput = [];
    sessions[0].projections.values.agentTeam.enabled = true;
    await assert.rejects(delegateTask(client, reuse), /Team/);
    sessions[0].projections.values.agentTeam.enabled = false;
    await assert.rejects(delegateTask(client, { ...reuse, thread: '87654321-1234-1234-1234-123456789012' }), /不匹配/);
    await assert.rejects(delegateTask({ base: 'http://127.0.0.1:1/' }, reuse), /不匹配/);
    assert.equal(calls.filter(call => call.method === 'session/prompt').length, 1);
  });
});

test('an uncertain dispatch preserves its created session and ticket without duplicate submission', async () => {
  await gateway(async ({ client, calls, options, reject }) => {
    reject();
    let failure;
    try { await delegateTask(client, options); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.equal((await readTaskTicket(failure.ticketPath)).requestId, failure.requestId);
    assert.equal(failure.sessionId, 'session-1');
    assert.equal(calls.filter(call => call.method === 'session/create').length, 1);
    assert.equal(calls.filter(call => call.method === 'session/prompt').length, 1);
  });
});

test('text reading exposes missing history and truncation without advancing a ticket or leaking raw events', async () => {
  await gateway(async ({ client, state, options }) => {
    const task = await delegateTask(client, options);
    const before = await fs.readFile(task.ticketPath, 'utf8');
    state.cursor = 20;
    const page = await readTaskResult(client, task.ticketPath, { maxChars: 5 });
    assert.equal(page.truncated, true);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBeforeSeq, 15);
    assert.equal(JSON.stringify(page).includes('DO_NOT_LOAD'), false);
    const earlier = await readTaskResult(client, task.ticketPath, { throughSeq: page.throughSeq, beforeSeq: page.nextBeforeSeq });
    assert.equal(earlier.hasMore, false);
    assert.deepEqual(earlier.messages.map(message => message.text), ['早期证据']);
    assert.equal(await fs.readFile(task.ticketPath, 'utf8'), before);
  });
});

test('tool report reaches its recorded Codex thread even under a different environment and main binding', async () => {
  await gateway(async ({ client, options }) => {
    const task = await delegateTask(client, options);
    const cli = fileURLToPath(new URL('../skills/codex-dsh/scripts/dsh.mjs', import.meta.url));
    const text = '实际结论\n中文 "quoted" & $(do-not-run) `ignored`';
    const file = path.join(root, '结果.txt');
    await fs.writeFile(file, Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'task-report', '--ticket', task.ticketPath, '--file', file], {
      windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: 'not-the-recipient', CODEX_DSH_STATE_DIR: path.join(root, 'unrelated') },
    });
    const args = JSON.parse(JSON.parse(stdout).receipt);
    assert.deepEqual(args.slice(0, 3), ['--thread', thread, '--message']);
    assert.ok(args[3].includes(task.sessionId));
    assert.ok(args[3].includes(task.requestId));
    assert.ok(args[3].endsWith(text));
  });
});
