import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DshClient, listAgents, resolveAgent, readActivity, readState, readProjections } from '../skills/codex-dsh/scripts/sdk.mjs';

// Read-only native HTTP contract: bare child history and wrong parent/mode are rejected.
async function gateway(run) {
  const calls = [];
  const catalog = entries => ({ values: { subagentCatalog: entries } });
  const sessions = [
    { sessionId: 'root', projections: catalog([{ id: 'child', name: 'reader', mode: 'continuable' }]) },
    { sessionId: 'child', parentSessionId: 'root', origin: 'subagent', projections: catalog([{ id: 'nested', name: 'audit', mode: 'one-shot' }]) },
    { sessionId: 'nested', parentSessionId: 'child', origin: 'subagent', projections: catalog([]) },
  ];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const request = body.payload.args.request;
    let value;
    let error;
    if (body.method === 'session/list') value = { items: sessions };
    else if (body.method === 'session/events') {
      const a = request.address;
      if (a.kind === 'session' && a.sessionId !== 'root') error = { code: 'session/agent-busy', message: 'subagent Sessions require their durable parent address' };
      else if (a.kind === 'subagent' && !((a.childSessionId === 'child' && a.parentSessionId === 'root' && ['continuable', 'unknown'].includes(a.mode))
        || (a.childSessionId === 'nested' && a.parentSessionId === 'child' && ['one-shot', 'unknown'].includes(a.mode)))) {
        error = { code: 'subagent/unauthorized', message: 'wrong durable parent or mode' };
      } else value = { cursor: 40, hasMore: true, records: [{ event: { seq: 35, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '调查结果' }] } } } }] };
    } else if (body.method === 'session/state' || body.method === 'session/projections') {
      if (!request.sessionId || Object.hasOwn(request, 'address')) error = { code: 'gateway/bad-request', message: 'state and projections require sessionId' };
      else value = body.method === 'session/state' ? { cursor: 40, active: false, running: false, queue: null, pendingInput: [] }
        : { kind: 'sequenced', asOfSeq: 40, values: { title: request.sessionId } };
    } else error = { code: 'unexpected-mutation', message: body.method };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: error ? { ok: false, error } : { ok: true, value } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new DshClient();
  client.base = `http://127.0.0.1:${server.address().port}/`;
  client.cookie = '';
  try { await run(client, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('resolved direct and nested children keep their immediate durable parent for passive history reads', async () => {
  await gateway(async (client, calls) => {
    const children = await listAgents(client, 'root');
    await readActivity(client, children[0], { maxMessages: 3 });
    const nested = await resolveAgent(client, 'root', 'reader/audit');
    const page = await readActivity(client, nested, { maxMessages: 3, throughSeq: 40, beforeSeq: 39 });
    await readState(client, nested);
    await readProjections(client, nested.address, ['title']);
    assert.equal(page.hasMore, true);
    assert.equal(page.records[0].event.seq, 35);
    const reads = calls.filter(call => call.method === 'session/events').map(call => call.payload.args.request);
    assert.deepEqual(reads[0].address, { kind: 'subagent', parentSessionId: 'root', childSessionId: 'child', mode: 'continuable' });
    assert.deepEqual(reads[1], { address: { kind: 'subagent', parentSessionId: 'child', childSessionId: 'nested', mode: 'one-shot' }, maxMessages: 3, throughSeq: 40, beforeSeq: 39 });
    assert.deepEqual(calls.find(call => call.method === 'session/state').payload.args.request, { sessionId: 'nested' });
    assert.ok(calls.every(call => ['session/list', 'session/events', 'session/state', 'session/projections'].includes(call.method)));
  });
});

test('ordinary reads still work; bare child IDs and wrong addresses are rejected without retry or activation', async () => {
  await gateway(async (client, calls) => {
    const root = await resolveAgent(client, 'root');
    await readActivity(client, root);
    await readActivity(client, 'root');
    await assert.rejects(readActivity(client, 'child'), /durable parent address/);
    await assert.rejects(readActivity(client, { kind: 'subagent', parentSessionId: 'root', childSessionId: 'nested', mode: 'one-shot' }), /subagent\/unauthorized/);
    await assert.rejects(readActivity(client, { kind: 'subagent', parentSessionId: 'root', childSessionId: 'child', mode: 'one-shot' }), /subagent\/unauthorized/);
    const count = calls.length;
    await assert.rejects(readActivity(client, { kind: 'subagent', childSessionId: 'child', mode: 'continuable' }), /直接父地址/);
    assert.equal(calls.length, count);
    assert.equal(calls.filter(call => call.method === 'session/events').length, 5);
    assert.ok(calls.every(call => ['session/list', 'session/events'].includes(call.method)));
  });
});
