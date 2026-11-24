// Public SDK entry. Importing performs no I/O and never parses CLI arguments.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readDshLaunch } from './environment.mjs';
export * from './session.mjs';
export * from './execution.mjs';
export * from './codex.mjs';
export * from './tool-task.mjs';

const home = os.homedir();
export class DshClient {
  constructor(options = {}) { this.options = options; }
  async connect() {
    const [major, minor, patch] = process.versions.node.split('.').map(Number);
    if (!(major >= 24 || (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))))) throw new Error('连接需要 Node.js 22.22.3 或 24+（使用支持 Cookie 的内置 WebSocket，不依赖 DSH 的 node_modules）。');
    const { launch, source } = await readDshLaunch(this.options);
    this.connectionSource = source;
    this.base = new URL('./', launch).href;
    const connect = new URL('connect', this.base);
    connect.searchParams.set('token', launch.searchParams.get('token'));
    connect.searchParams.set('interactions', 'none');
    let response;
    try { response = await fetch(connect, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error('DSH 本机连接失败或超时；核对原服务与连接文件，不自动重启或切到另一个实例。'); }
    if (response.status !== 302) throw new Error(`DSH 原生鉴权失败：HTTP ${response.status}。核对当前启动日志，不重启已有任务。`);
    this.cookie = response.headers.getSetCookie().map(c => c.split(';', 1)[0]).join('; ');
    const location = response.headers.get('location');
    if (!location || !this.cookie) throw new Error('DSH /connect 未返回完整连接凭据。');
    let socketUrl;
    try { socketUrl = new URL(location, this.base); } catch { throw new Error('DSH 返回了无效连接地址。'); }
    if (socketUrl.origin !== new URL(this.base).origin) throw new Error('DSH 返回了不同来源的连接地址。');
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(socketUrl, { headers: { Cookie: this.cookie } });
    this.closed = false;
    this.socket.addEventListener('close', () => { this.closed = true; }, { once: true });
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); this.socket.removeEventListener('open', opened); this.socket.removeEventListener('error', failed); this.socket.removeEventListener('close', failed); error ? reject(error) : resolve(); };
      const opened = () => finish();
      const failed = () => finish(new Error('DSH 原生事件连接失败。'));
      const timer = setTimeout(() => { finish(new Error('DSH 原生事件连接超时。')); this.socket.close(); }, 10000);
      this.socket.addEventListener('open', opened, { once: true });
      this.socket.addEventListener('error', failed, { once: true });
      this.socket.addEventListener('close', failed, { once: true });
    });
    return this;
  }
  async rpc(method, args, timeoutMs = 15000) {
    if (this.closed) throw new Error('DSH 连接已关闭；本次请求没有重试。');
    const rpcId = randomUUID();
    const response = await fetch(new URL(`api/${method}`, this.base), {
      method: 'POST', headers: { Cookie: this.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = await response.json();
    if (body.rpcId !== rpcId || body.type !== 'server-response') throw new Error('DSH 返回了不匹配的 RPC 应答。');
    if (!body.result?.ok) {
      const failure = body.result?.error;
      throw Object.assign(new Error(`${method}: ${failure?.code}: ${failure?.message}`), { code: failure?.code, details: failure?.details });
    }
    return body.result.value;
  }
  async close() {
    if (!this.socket || this.closed) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DSH WebSocket 尚未确认关闭；不重连或重复投递。')), 5000);
      this.socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.close();
    });
  }
}


/** Connect once; reuse the client for independent queries and close in finally. */
export async function connectDsh(options = {}) {
  const client = new DshClient(options);
  try {
    await client.connect();
    if (options.expectedEndpoint !== undefined && client.base !== options.expectedEndpoint) throw new Error('当前 DSH 地址与指定绑定不符。');
    return client;
  }
  catch (error) { await client.close(); throw error; }
}

export function bindingFilePath({ thread = process.env.CODEX_THREAD_ID, stateDir = process.env.CODEX_DSH_STATE_DIR || path.join(home, '.local/state/codex-dsh') } = {}) {
  if (!thread || !/^[a-zA-Z0-9_-]+$/.test(thread)) throw new Error('需要真实 thread ID；不按目录猜测会话。');
  return path.join(stateDir, `${thread}.json`);
}

/** Read only. No binding creation, cursor advancement or endpoint substitution. */
export async function readBinding(options = {}) {
  return JSON.parse(await fs.readFile(bindingFilePath(options), 'utf8'));
}
