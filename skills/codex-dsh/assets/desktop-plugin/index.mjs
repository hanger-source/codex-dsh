// No extra server or session runtime: compose the official authentication provider.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as Token from '@deepseek-ai/dsh-host-authentication-token';
import { Context } from '@deepseek-ai/cordis';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

export const name = 'codex-dsh-desktop';
export const inject = ['connection', 'connection.authentication', 'credentials', 'webServer'];

export async function apply(ctx) {
  if (typeof Context.root !== 'symbol') throw new Error('This Desktop token provider requires the Cordis 4.2 Context.root API; keep the Desktop runtime packages matched instead of installing another Cordis into its profile.');
  // Never turn a listener on another interface into an externally accessible owner API.
  if (!['127.0.0.1', '::1'].includes(ctx.webServer.host)) throw new Error('codex-dsh-desktop requires a loopback-only DSH Host.');
  const token = ctx.plugin(Token, { cookieMaxAgeDays: 1 });
  await token.await();
  const entries = [];
  ctx.emit('webserver/entry-url', ctx.webServer.getOrigin() + '/', entries);
  const entry = entries.find(item => item.label === 'dsh web');
  if (!entry || !new URL(entry.url).searchParams.get('token')) throw new Error('Native DSH token provider did not publish a connection URL.');
  const directory = path.join(resolveDshHome(), 'runtime', 'codex-dsh');
  const file = path.join(directory, 'desktop.url');
  const temporary = path.join(directory, `desktop.${randomUUID()}.tmp`);
  const contents = entry.url + '\n';
  await ctx.effect(async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    try { await fs.rename(temporary, file); }
    catch (error) { throw new Error(`Could not publish local DSH connection file (${error.code}); temporary file retained at ${temporary}.`); }
    return async () => {
      // Keep no usable discovery file after unloading; do not touch another generation's file.
      try {
        if (await fs.readFile(file, 'utf8') === contents) await fs.unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }, 'codex-dsh-desktop: local connection discovery');
}
