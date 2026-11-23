import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DshClient } from '../skills/codex-dsh/scripts/dsh.mjs';
import { sendAgentMessage } from '../skills/codex-dsh/scripts/session.mjs';

// Only the native HTTP boundary is substituted; no live model receives messages.
async function withGateway(run) {
  const deliveries = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    let result;
    if (body.method === 'session/list') {
      result = { ok: true, value: { items: [
        { sessionId: 'root', projections: { values: { subagentCatalog: [{ id: 'child', name: 'reader', mode: 'continuable' }, { id: 'finished', name: 'once', mode: 'one-shot' }] } } },
        { sessionId: 'child', parentSessionId: 'root', origin: 'subagent', running: true, projections: { values: { subagentCatalog: [] } } },
        { sessionId: 'finished', parentSessionId: 'root', origin: 'subagent', running: false },
        { sessionId: 'stranger', parentSessionId: 'other', origin: 'subagent' },
      ] } };
    } else if (body.method === 'subagents/prompt') {
      deliveries.push(body.payload.args.request);
      result = deliveries.at(-1).requestId === 'capacity-reject'
        ? { ok: false, error: { code: 'subagent/delivery-unavailable', message: 'capacity reached' } }
        : { ok: true, value: { messageId: 'native-inbox-receipt' } };
    } else {
      result = { ok: false, error: { code: 'unexpected-method', message: body.method } };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new DshClient();
  client.base = `http://127.0.0.1:${server.address().port}/`;
  client.cookie = '';
  try { await run(client, deliveries); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('foreign and one-shot sessions cannot receive a continuation', async () => {
  await withGateway(async (client, deliveries) => {
    for (const target of ['stranger', 'once']) {
      await assert.rejects(sendAgentMessage(client, { rootSessionId: 'root', target, text: 'check the source' }));
    }
    assert.equal(deliveries.length, 0);
  });
});

test('delivery reaches the native child inbox route with the supplied identity', async () => {
  await withGateway(async (client, deliveries) => {
    const receipt = await sendAgentMessage(client, { rootSessionId: 'root', target: 'reader', text: 'inspect the result', delivery: 'queue', requestId: 'one-guidance' });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].childSessionId, 'child');
    assert.equal(deliveries[0].requestId, 'one-guidance');
    assert.equal(deliveries[0].delivery, 'queue');
    assert.equal(receipt.messageId, 'native-inbox-receipt');
    assert.equal(receipt.requestId, 'one-guidance');
  });
});

test('a native capacity refusal is exposed without retrying or switching routes', async () => {
  await withGateway(async (client, deliveries) => {
    await assert.rejects(sendAgentMessage(client, { rootSessionId: 'root', target: 'reader', text: 'inspect the result', requestId: 'capacity-reject' }), /subagent\/delivery-unavailable/);
    assert.equal(deliveries.length, 1);
  });
});
