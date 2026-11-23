#!/usr/bin/env node
// Independent primitives. Import them into an agent's own script, or use the thin CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { typescriptOutline } from './typescript-outline.mjs';

const typed = new Set(['.ts', '.tsx', '.mts', '.cts']);
const otherCode = new Set(['.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.sh', '.bash', '.zsh', '.lua', '.scala', '.ex', '.exs', '.erl', '.dart', '.zig', '.sql', '.r', '.R', '.m', '.mm']);
const shortKind = { function: 'fn', namespace: 'ns', variable: 'var', constant: 'const', property: 'field' };
const safe = value => /[\n\r\t]/.test(value) ? JSON.stringify(value) : value;
const qualified = (scope, name) => scope ? scope + '.' + name : name;
const pathOrder = (a, b) => path.posix.dirname(a).localeCompare(path.posix.dirname(b)) || a.localeCompare(b);
function run(tool, args, cwd, input) {
  try { return execFileSync(tool, args, { cwd, input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(tool + ': ' + String(error.stderr || error.message).trim()); }
}
function projectRoot(value) {
  if (!value) throw new Error('必须指定具体项目目录。');
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory() || root === path.parse(root).root || root === os.homedir()) throw new Error('不扫描整个磁盘或用户目录。');
  return root;
}
function matches(file, prefix) {
  if (!prefix || prefix === '.') return true;
  const p = prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return file === p || file.startsWith(p + '/');
}

// Inventory only. No parsing, cache, required follow-up, or project mutation.
export function listFiles(root, { exclude = [] } = {}) {
  root = projectRoot(root);
  const globs = ['.git', 'node_modules', '.trash', ...exclude];
  const output = run('rg', ['--files', '--hidden', '-0', ...globs.flatMap(g => ['-g', '!' + g])], root);
  return output.split('\0').filter(Boolean).map(p => p.replace(/^\.\//, '')).sort(pathOrder);
}

// Parse exactly the caller's selection. Missing/unsupported files remain visible in the result.
export function readSymbols(root, paths, options = {}) {
  root = projectRoot(root);
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) throw new Error('文件选择必须是相对路径字符串数组。');
  const files = [...new Set(paths)].sort(pathOrder).map(name => {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('路径必须位于指定项目内：' + name);
    const file = { path: name, symbols: [], imports: [] };
    try {
      const stat = fs.lstatSync(path.join(root, name));
      file.bytes = stat.size; file.mtimeMs = stat.mtimeMs;
      if (!stat.isFile()) file.problem = '非普通文件，未读取';
    } catch { file.problem = '文件不存在，未读取'; }
    return file;
  });
  const tsFiles = files.filter(f => !f.problem && typed.has(path.extname(f.path)));
  let ts;
  if (tsFiles.length) {
    const require = createRequire(path.join(root, 'package.json'));
    try { ts = require(options.typescript ? path.resolve(options.typescript) : 'typescript'); }
    catch { throw new Error('未找到项目的 TypeScript 编译器；安装项目依赖，或用 --typescript 指向已有 typescript.js。'); }
  }
  for (const file of tsFiles) {
    Object.assign(file, typescriptOutline(ts, file.path, fs.readFileSync(path.join(root, file.path), 'utf8')),
      { parser: 'typescript', language: 'TypeScript' });
  }
  const ctagsFiles = files.filter(f => !f.problem && otherCode.has(path.extname(f.path)));
  let ctagsVersion;
  if (ctagsFiles.length) {
    ctagsVersion = run('ctags', ['--version'], root).split('\n')[0];
    if (!ctagsVersion.includes('Universal Ctags')) throw new Error('需要支持 JSON 的 Universal Ctags。');
    const accepted = ctagsFiles.filter(f => {
      if (/[\r\n]/.test(f.path)) { f.problem = 'Ctags 文件清单不支持带换行的路径'; return false; }
      return true;
    });
    const byPath = new Map(accepted.map(f => [f.path, f]));
    if (accepted.length) {
      const raw = run('ctags', ['--options=NONE', '--map-JavaScript=+.cjs', '--output-format=json',
        '--fields=+nKSlEaie', '--fields=-P', '--extras=+f', '--sort=no', '-f', '-', '-L', '-'],
        root, accepted.map(f => './' + f.path).join('\n') + '\n');
      for (const line of raw.split('\n').filter(Boolean)) {
        const tag = JSON.parse(line);
        if (tag._type !== 'tag') continue;
        const file = byPath.get(tag.path.replace(/^\.\//, ''));
        if (!file) continue;
        file.parser = 'ctags'; file.language = tag.language;
        if (tag.kind === 'file' || ['local', 'parameter', 'label'].includes(tag.kind)
          || (tag.scopeKind === 'function' && ['variable', 'constant'].includes(tag.kind))) continue;
        file.symbols.push({ name: tag.name, kind: tag.kind, scope: tag.scope || '', line: tag.line, end: tag.end,
          declaration: tag.name + (tag.signature || '') + (tag.typeref ? ': ' + tag.typeref : '')
            + (tag.inherits ? ' extends ' + tag.inherits : '') });
      }
    }
  }
  for (const file of files) {
    if (!file.problem && !file.parser) file.problem = '未提取声明（配置、文档或不支持的语言）';
    if (file.parser) {
      try {
        const stat = fs.lstatSync(path.join(root, file.path));
        if (stat.mtimeMs !== file.mtimeMs || stat.size !== file.bytes) file.problem = '读取期间发生变化';
      } catch { file.problem = '读取期间文件消失'; }
    }
    file.symbols.sort((a, b) => a.line - b.line);
  }
  return { root, readAt: new Date().toISOString(), parsers: { typescript: ts?.version, ctags: ctagsVersion }, files };
}

// Git owns the baseline and status. This primitive does not infer task completion.
export function gitChanges(root, { since = 'HEAD' } = {}) {
  root = projectRoot(root);
  const head = run('git', ['rev-parse', '--short', 'HEAD'], root).trim();
  const raw = run('git', ['diff', '--relative', '--name-status', '-z', '--find-renames', since, '--', '.'], root).split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < raw.length;) {
    const status = raw[i++], first = raw[i++];
    if (/^[RC]/.test(status)) changes.push({ status, path: raw[i++], from: first });
    else changes.push({ status, path: first });
  }
  for (const name of run('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], root).split('\0').filter(Boolean)) changes.push({ status: '?', path: name });
  changes.sort((a, b) => pathOrder(a.path, b.path));
  return { root, since, head, changes };
}

// Renderers accept ordinary data. Filtering, selection and persistence belong to the caller.
export function selectSymbols(data, options = {}) {
  const kinds = options.kind?.split(',');
  const contains = (value, query) => !query || value.toLowerCase().includes(query.toLowerCase());
  const symbolQuery = options.kind || options.name || options.scope || options.text;
  const files = data.files.filter(file => matches(file.path, options.path)
    && (!options.imports || file.imports?.some(value => contains(value, options.imports))))
    .map(file => ({ ...file, symbols: file.symbols.filter(symbol =>
      (!kinds || kinds.includes(symbol.kind))
      && contains(qualified(symbol.scope, symbol.name), options.name)
      && contains(symbol.scope || '', options.scope)
      && contains(symbol.declaration, options.text)) }))
    .filter(file => file.symbols.length || !symbolQuery || file.problem || file.diagnostics?.length);
  return { ...data, files };
}
export function compactPaths(paths, options = {}) {
  const groups = new Map(), depth = options.depth ?? Infinity;
  for (const name of paths) {
    const parts = name.split('/');
    const label = parts.length > depth ? parts.slice(0, depth).join('/') + '/' : name;
    groups.set(label, (groups.get(label) || 0) + 1);
  }
  const rows = [...groups].sort(([a], [b]) => pathOrder(a.replace(/\/$/, ''), b.replace(/\/$/, '')));
  const lines = [paths.length + ' 文件 · 全部覆盖' + (Number.isFinite(depth) ? ' · 目录深度 ' + depth : '')];
  let dir;
  for (const [label, count] of rows) {
    const clean = label.replace(/\/$/, ''), current = path.posix.dirname(clean);
    if (dir !== current) { dir = current; lines.push(safe(dir) + '/'); }
    lines.push('  ' + safe(path.posix.basename(clean)) + (label.endsWith('/') ? '/ [' + count + ' 文件]' : ''));
  }
  return lines.join('\n');
}
export function compactSymbols(data, options = {}) {
  const selected = selectSymbols(data, options);
  const detail = options.detail || 'signatures';
  if (!['names', 'signatures'].includes(detail)) throw new Error('detail 只能是 names 或 signatures。');
  const lines = ['根 ' + data.root + ' · 读取 ' + data.readAt];
  const queries = ['path', 'kind', 'name', 'scope', 'imports', 'text'].filter(k => options[k]);
  if (queries.length) lines.push('检索 ' + queries.map(k => k + '=' + safe(options[k])).join(' · '));
  lines.push(selected.files.length + ' 文件 · '
    + selected.files.reduce((n, f) => n + f.symbols.length, 0) + ' 声明 · '
    + (detail === 'names' ? '完整名称' : '完整签名') + ' · 全部展示');
  let dir;
  for (const file of selected.files) {
    const current = path.posix.dirname(file.path);
    if (dir !== current) { dir = current; lines.push(safe(dir) + '/'); }
    lines.push('  ' + safe(path.posix.basename(file.path)) + (file.problem ? ' [' + file.problem + ']' : ''));
    for (const d of file.diagnostics || []) lines.push('    ! ' + d.line + ' ' + d.message);
    if ((options.deps || options.imports) && file.imports?.length) lines.push('    → ' + file.imports.join(' | '));
    if (detail === 'names') {
      const scopes = new Map();
      for (const symbol of file.symbols) {
        const kinds = scopes.get(symbol.scope) || new Map();
        const names = kinds.get(symbol.kind) || [];
        names.push((symbol.exported ? '+' : '') + safe(symbol.name) + '@' + symbol.line);
        kinds.set(symbol.kind, names); scopes.set(symbol.scope, kinds);
      }
      for (const [scope, kinds] of scopes) {
        if (scope) lines.push('    [' + scope + ']');
        for (const [kind, names] of kinds) lines.push((scope ? '      ' : '    ') + (shortKind[kind] || kind) + ' ' + names.join(' · '));
      }
    } else {
      let scope = '';
      for (const symbol of file.symbols) {
        if (symbol.scope && symbol.scope !== scope) lines.push('    [' + symbol.scope + ']');
        scope = symbol.scope;
        const declaration = symbol.declaration.replace(/\r?\n[\t ]*/g, ' ').trim();
        const hasKind = /^(?:(?:export|default|declare|abstract|async)\s+)*(?:class|interface|type|enum|namespace|function)\b/.test(declaration);
        const prefix = hasKind || (scope && ['property', 'method', 'enum-member'].includes(symbol.kind)) ? '' : (shortKind[symbol.kind] || symbol.kind) + ' ';
        const exported = symbol.exported && !/^export\b/.test(declaration) ? 'export ' : '';
        lines.push((scope ? '      ' : '    ') + symbol.line + ' ' + exported + prefix + declaration);
        if (['class', 'interface', 'namespace', 'enum'].includes(symbol.kind)) scope = qualified(symbol.scope, symbol.name);
      }
    }
  }
  if (detail === 'names') lines.push('+ 表示显式导出，@ 后是源码行号。');
  return lines.join('\n');
}
export function compactChanges(data) {
  const lines = ['根 ' + data.root + ' · HEAD ' + data.head + ' · ' + data.since + ' → 工作区（含暂存，? 为未跟踪）'];
  lines.push(data.changes.length + ' 个变化 · 全部展示');
  let dir;
  for (const row of data.changes) {
    const current = path.posix.dirname(row.path);
    if (dir !== current) { dir = current; lines.push(safe(dir) + '/'); }
    lines.push('  ' + row.status + ' ' + safe(path.posix.basename(row.path)) + (row.from ? ' ← ' + safe(row.from) : ''));
  }
  return lines.join('\n');
}

function main() {
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: {
    ...Object.fromEntries(['out', 'input', 'path', 'depth', 'detail', 'kind', 'name', 'scope', 'imports', 'text', 'since', 'typescript'].map(k => [k, { type: 'string' }])),
    exclude: { type: 'string', multiple: true }, deps: { type: 'boolean' },
    json: { type: 'boolean' }, stdin: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (options.depth !== undefined) {
    const n = Number(options.depth);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('depth 必须是 >= 1 的整数');
    options.depth = n;
  }
  const [command, target, ...paths] = positionals;
  if (!command || command === 'help' || options.help) {
    console.log('project.mjs files ROOT [--path DIR] [--depth 2] [--exclude GLOB]\nproject.mjs symbols ROOT [FILE_OR_DIR...] [--input FILE|--stdin] [--typescript FILE]\nproject.mjs changes ROOT [--since REF] [--path DIR]\nproject.mjs render paths|symbols|changes --input FILE|--stdin\n数据：--json 输出可组合数据，--out FILE 另存数据；默认输出紧凑文本。\n展示全部选定范围：--detail names|signatures（默认 signatures），--deps；不分页、不截短签名。\n声明检索：--path DIR|FILE --name TEXT --kind class,interface,type,function,method --scope TEXT --imports MODULE --text TEXT\n可导入 listFiles、readSymbols、selectSymbols、gitChanges、compactPaths、compactSymbols、compactChanges 自行组合。\n文件枚举尊重 ignore，额外排除 .git/node_modules/.trash。索引不是全文阅读或业务验收；没有自动扫描、缓存或审查流程。');
    return;
  }
  if (options.input && options.stdin) throw new Error('--input 与 --stdin 二选一。');
  const input = () => JSON.parse(fs.readFileSync(options.stdin ? 0 : options.input, 'utf8'));
  let data, format;
  if (command === 'files') {
    data = listFiles(target, options).filter(f => matches(f, options.path)); format = compactPaths;
  } else if (command === 'symbols') {
    const chosen = options.input || options.stdin ? input()
      : listFiles(target, options).filter(f => (!paths.length || paths.some(p => matches(f, p))) && matches(f, options.path));
    data = readSymbols(target, chosen, options); format = compactSymbols;
  } else if (command === 'changes') {
    data = gitChanges(target, options);
    data.changes = data.changes.filter(c => matches(c.path, options.path)); format = compactChanges;
  } else if (command === 'render') {
    format = { paths: compactPaths, symbols: compactSymbols, changes: compactChanges }[target];
    if (!format || (!options.input && !options.stdin)) throw new Error('render 需要数据类型及 --input 或 --stdin。');
    data = input();
  } else throw new Error('未知命令；运行 help 查看。');
  if (format === compactSymbols) data = selectSymbols(data, options);
  else if (format === compactPaths) data = data.filter(name => matches(name, options.path));
  else if (format === compactChanges) data = { ...data, changes: data.changes.filter(change => matches(change.path, options.path)) };
  if (options.out) {
    const out = path.resolve(options.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(data), { mode: 0o600 });
    process.stderr.write('数据 ' + out + '\n');
  }
  console.log(options.json ? JSON.stringify(data) : format(data, options));
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
