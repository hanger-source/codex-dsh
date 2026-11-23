// Native Codex queue; importing never discovers executables or sends messages.
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { codexCandidates } from './environment.mjs';

const execFileAsync = promisify(execFile);

async function codexCommand(executable, args, cwd) {
  if (!path.isAbsolute(executable)) throw new Error('Codex 必须使用桌面配套 CLI 的绝对路径，可用 --codex 指定。');
  if (/\.(cmd|bat|ps1)$/i.test(executable)) throw new Error('请指定桌面配套 codex.exe，不使用需要 shell 转义的 cmd/bat/ps1 包装器。');
  try { return (await execFileAsync(executable, args, { cwd, windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' })).stdout; }
  catch (error) { throw new Error(`Codex 命令未确认成功（${error.code || 'unknown'}）：${String(error.stderr || '').trim().slice(0, 1200)}。未自动重试；投递可能已入队，先核对目标会话。`); }
}
export async function inspectCodex(options = {}) {
  const failures = [];
  for (const executable of await codexCandidates(options.codex)) {
    try {
      const help = await codexCommand(executable, ['queue', '--help']);
      if (!help.includes('--thread') || !help.includes('--message')) throw new Error('CLI 不支持 queue --thread --message。');
      return { executable, version: (await codexCommand(executable, ['--version'])).trim(), queueAvailable: true };
    } catch (error) { failures.push(`${executable}: ${error.message}`); }
  }
  throw new Error(`未找到支持原生 queue 的 Codex CLI。用 --codex 或 CODEX_DSH_CODEX 指定桌面配套二进制的绝对路径（Windows 为 codex.exe），不能用 exec resume 替代。${failures.length ? '\n' + failures.join('\n') : ''}`);
}

/** Explicit one-way dispatch; receipt does not mean the destination processed it. */
export async function queueCodexMessage({ executable, thread, text, workspace }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread || '')) throw new Error('需要真实 Codex thread UUID。');
  if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空。');
  executable ||= (await inspectCodex()).executable;
  const receipt = await codexCommand(executable, ['queue', '--thread', thread, '--message', text], workspace);
  return { codexThreadId: thread, queueAccepted: true, receipt: receipt.trim(), meaning: '已入原生队列，不代表读取或完成；无自动重试。' };
}
