// Installation discovery only: no process launch, profile changes or credential output.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function dshHome(env = process.env, home = os.homedir()) {
  const configured = env.DSH_HOME?.trim();
  if (!configured) return path.join(home, '.dsh');
  const expanded = configured.replace(/^~(?=[/\\]|$)/, () => home);
  if (!path.isAbsolute(expanded)) throw new Error('DSH_HOME 必须是绝对路径。');
  return path.normalize(expanded);
}

// Windows PowerShell 5 writes redirected text as UTF-16LE; PowerShell 7 uses UTF-8.
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

export function localLaunchUrl(text) {
  let url;
  try { url = new URL(text); } catch { throw new Error('DSH 启动地址格式无效；请核对本机地址文件，不要将含 token 的内容贴到消息里。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('DSH 连接只接受无用户名密码的本机回环 HTTP(S) 地址。');
  }
  if (!url.searchParams.get('token')) throw new Error('DSH 启动地址缺少 token；官方 Desktop 的私有 IPC 凭据不是 Web 启动地址，请按 native-link.md 启用接入插件。');
  return url;
}

export async function readDshLaunch(options = {}) {
  const urlFile = options.urlFile || process.env.CODEX_DSH_URL_FILE;
  const logPath = options.logPath || process.env.CODEX_DSH_LOG;
  if (urlFile && logPath) throw new Error('只指定 urlFile/--url-file 或 logPath/--log 之一。');
  let sources = urlFile ? [{ file: urlFile, kind: 'url' }] : logPath ? [{ file: logPath, kind: 'log' }] : [];
  if (!sources.length) {
    const root = dshHome();
    const candidates = [
      { file: path.join(root, 'runtime/codex-dsh/desktop.url'), kind: 'url' },
      { file: path.join(root, 'runtime/dsh-desktop/server.log'), kind: 'log' },
    ];
    for (const candidate of candidates) {
      try { await fs.access(candidate.file); sources.push(candidate); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取 DSH 连接文件（${error.code}）：${candidate.file}`); }
    }
  }
  if (!sources.length) throw new Error('未找到 DSH 连接入口。官方 Desktop 默认使用私有 IPC，不会生成自建 App 的 server.log；请看 references/native-link.md 的 Desktop 接入。Web 服务用 --url-file 指定当前启动地址文件。不要另启服务接管原会话。');
  const launches = [];
  for (const source of sources) {
    let text;
    try { text = decodeText(await fs.readFile(source.file)); }
    catch (error) { throw new Error(`无法读取 DSH 连接文件（${error.code}）：${source.file}`); }
    const values = source.kind === 'url' ? [text.trim()] : [...text.matchAll(/dsh web:\s+(https?:\/\/[^\s]+)/g)].map(m => m[1]);
    if (!values.length) throw new Error(`DSH 日志中没有启动地址：${source.file}。官方 Desktop 请使用接入插件，不猜 AppData 日志目录。`);
    const launch = localLaunchUrl(values.at(-1));
    if (!options.expectedEndpoint || new URL('./', launch).href === options.expectedEndpoint) launches.push({ launch, source: source.file });
  }
  if (!launches.length) throw new Error('当前 DSH 连接入口与绑定 endpoint 不符；核对原服务，不自动改绑。');
  if (launches.length > 1) throw new Error('检测到多个 DSH 入口；用 --url-file 或 --log 明确选择，不按安装路径猜目标会话。');
  return launches[0];
}

export async function codexCandidates(explicit) {
  const selected = explicit || process.env.CODEX_DSH_CODEX;
  if (selected) return [selected];
  const files = process.platform === 'darwin'
    ? ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'] : [];
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const directory = entry.replace(/^"|"$/g, '');
    if (path.isAbsolute(directory)) files.push(path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  }
  const found = [];
  for (const file of files) {
    try { if ((await fs.stat(file)).isFile()) found.push(await fs.realpath(file)); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return [...new Set(found)];
}
