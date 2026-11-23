import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import * as DesktopAuthentication from '@deepseek-ai/dsh-host-authentication-desktop';
import { WebSocketServer } from 'ws';
import * as Plugin from '../skills/codex-dsh/assets/desktop-plugin/index.mjs';
import { connectDsh } from '../skills/codex-dsh/scripts/sdk.mjs';

// Real Cordis, Desktop authentication, Token authentication, Connection and WebServer.
// Only remote.mux payload handling is substituted; no agent/session/model is started.
test('Desktop private auth coexists with native API peers; unload removes discovery and revokes peers', { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-desktop-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  const ctx = new Context();
  const desktopSecret = randomBytes(32).toString('base64url');
  let client;
  try {
    await ctx.plugin(Credentials, { dshHome: directory, watch: false }).await();
    await ctx.plugin(Connection).await();
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await();
    await ctx.plugin(DesktopAuthentication, { readSecret: () => desktopSecret }).await();
    ctx.webServer.register({ kind: 'exact', path: '/proof', auth: 'required', handler: (_req, res) => { res.end('authenticated'); } });
    const wss = new WebSocketServer({ noServer: true });
    let transportClosed;
    ctx.webServer.registerUpgrade({ path: '/api/remote.mux', auth: 'required', handler: (req, socket, head) => {
      transportClosed = new Promise(resolve => socket.once('close', resolve));
      wss.handleUpgrade(req, socket, head, () => {});
    } });
    const origin = ctx.webServer.getOrigin();
    assert.equal((await fetch(origin + '/proof')).status, 401);
    const desktopHeaders = { Cookie: `dsh-desktop-session=${desktopSecret}` };
    assert.equal(await (await fetch(origin + '/proof', { headers: desktopHeaders })).text(), 'authenticated');
    const plugin = ctx.plugin(Plugin);
    await plugin.await();
    const file = path.join(directory, 'runtime/codex-dsh/desktop.url');
    client = await connectDsh({ urlFile: file });
    assert.equal(client.base, origin + '/');
    assert.equal(await (await fetch(origin + '/proof', { headers: { Cookie: client.cookie } })).text(), 'authenticated');
    const cookie = client.cookie;
    await client.close();
    await transportClosed;
    assert.equal((await fetch(origin + '/proof', { headers: { Cookie: cookie } })).status, 401);
    client = await connectDsh({ urlFile: file });
    const activeCookie = client.cookie;
    await plugin.dispose();
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    assert.equal((await fetch(origin + '/proof', { headers: { Cookie: activeCookie } })).status, 401);
    assert.equal((await fetch(origin + '/proof', { headers: desktopHeaders })).status, 200);
    await new Promise(resolve => wss.close(resolve));
  } finally {
    await client?.close();
    await ctx.fiber.dispose();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
  }
});
