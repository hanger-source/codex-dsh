// Public SDK entry. Importing performs no I/O and never parses CLI arguments.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
export * from './session.mjs';

const home = os.homedir();
const execFileAsync = promisify(execFile);
const desktopCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

async function codexCommand(executable, args, cwd) {
  if (!path.isAbsolute(executable)) throw new Error('Codex 必须使用桌面配套 CLI 的绝对路径，可用 --codex 指定。');
  try { return (await execFileAsync(executable, args, { cwd, timeout: 15000, maxBuffer: 65536 })).stdout; }
  catch (error) { throw new Error(`Codex 命令未确认成功（${error.code || 'unknown'}）：${String(error.stderr || '').trim().slice(0, 1200)}。未自动重试；投递可能已入队，先核对目标会话。`); }
}
export async function inspectCodex(options = {}) {
  const executable = options.codex || process.env.CODEX_DSH_CODEX || desktopCodex;
  const help = await codexCommand(executable, ['queue', '--help']);
  if (!help.includes('--thread') || !help.includes('--message')) throw new Error('所选 Codex CLI 不支持原生 queue，不能用 exec resume 替代。');
  return { executable, version: (await codexCommand(executable, ['--version'])).trim(), queueAvailable: true };
}

export class DshClient {
  constructor(options = {}) { this.options = options; }
  async connect() {
    const source = this.options.urlFile || this.options.logPath || path.join(home, '.dsh/runtime/dsh-desktop/server.log');
    const raw = await fs.readFile(source, 'utf8');
    const urls = this.options.urlFile ? [raw.trim()] : [...raw.matchAll(/dsh web:\s+(https?:\/\/[^\s]+)/g)].map(m => m[1]);
    if (!urls.length) throw new Error('没有找到 DSH 启动地址。用 --url-file 指定保存本次启动 URL 的本机文件；不要把 token 放进消息或命令行。');
    const launch = new URL(urls.at(-1));
    if (!launch.searchParams.get('token')) throw new Error('DSH 启动地址缺少 token。');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(launch.hostname)) throw new Error('此 Skill 只连接本机 DSH，不向远端传递工作区或凭据。');
    this.base = new URL('./', launch).href;
    const connect = new URL('connect', this.base);
    connect.searchParams.set('token', launch.searchParams.get('token'));
    connect.searchParams.set('interactions', 'none');
    const response = await fetch(connect, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (response.status !== 302) throw new Error(`DSH 原生鉴权失败：HTTP ${response.status}。核对当前启动日志，不重启已有任务。`);
    this.cookie = response.headers.getSetCookie().map(c => c.split(';', 1)[0]).join('; ');
    const location = response.headers.get('location');
    if (!location || !this.cookie) throw new Error('DSH /connect 未返回完整连接凭据。');
    const socketUrl = new URL(location, this.base);
    if (socketUrl.origin !== new URL(this.base).origin) throw new Error('DSH 返回了不同来源的连接地址。');
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const packagePath = this.options.dshPackage || process.env.CODEX_DSH_PACKAGE || '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json';
    const WebSocket = createRequire(packagePath)('ws');
    this.socket = new WebSocket(socketUrl, { headers: { Cookie: this.cookie }, handshakeTimeout: 10000 });
    this.closed = false;
    this.socket.on('error', () => {});
    this.socket.on('close', () => { this.closed = true; });
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', () => reject(new Error('DSH 原生事件连接失败。'))); });
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
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 1000);
      this.socket.once('close', () => { clearTimeout(timer); resolve(); });
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

/** Explicit one-way dispatch; receipt does not mean the destination processed it. */
export async function queueCodexMessage({ executable = desktopCodex, thread, text, workspace }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread || '')) throw new Error('需要真实 Codex thread UUID。');
  if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空。');
  const receipt = await codexCommand(executable, ['queue', '--thread', thread, '--message', text], workspace);
  return { codexThreadId: thread, queueAccepted: true, receipt: receipt.trim(), meaning: '已入原生队列，不代表读取或完成；无自动重试。' };
}
