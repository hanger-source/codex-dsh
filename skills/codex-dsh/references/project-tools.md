# 可组合的工程观察能力

`scripts/project.mjs` 同时提供函数和薄 CLI。它只复用文件枚举、语法提取、Git 差异与展示的重复代码；读哪些文件、判断什么、是否留存、怎样组合仍由 Agent 决定。可以使用其中一个函数，也可以接上现有 `rg`、`jq`、Git 或自行编写的 JavaScript，不必经过统一扫描流程。

## 函数

| 导出 | 输入与结果 |
| --- | --- |
| `listFiles(root, {exclude?})` | 返回项目相对路径数组；用 ripgrep 枚举，遵循 ignore，额外排除 `.git`、`node_modules`、`.trash`。 |
| `readSymbols(root, paths, {typescript?})` | 只解析指定文件，返回 `{root, readAt, parsers, files}`；各文件含声明、作用域、行号、原声明文本和解析问题。 |
| `selectSymbols(data, conditions)` | 在已有数据中按 `path`、`name`、`kind`、`scope`、`imports`、`text` 交叉检索，返回全部匹配声明；不重读源码，不改原数据。 |
| `gitChanges(root, {since?})` | 返回 `{root, since, head, changes}`；比较 Git 基线到当前工作区，包含暂存和未跟踪文件、重命名来源。默认基线 `HEAD`。 |
| `compactPaths(paths, options)` | 把任意相对路径数组按目录合并展示，可用 `depth` 折叠层次。 |
| `compactSymbols(data, options)` | 完整展示选定范围，目录与作用域只写一次；`detail: 'names'` 按作用域和类型合并全部名称，默认 `'signatures'` 展示完整签名。也可传入上述检索条件，`deps` 展示静态模块引用。 |
| `compactChanges(data, options)` | 把 Git 变化按目录合并展示，不推断实现完成度。 |

展示函数返回字符串，不修改传入数据。文件、声明和 Git 变化均覆盖完整选定范围，不分页，不截取前若干项，也不截短签名。名称视图与签名视图保留同一批声明，只改变表达粒度；名称视图将同一作用域、同一类型的名称合并成一行，保留源码行号，`+` 表示显式导出。目录视图可按深度聚合，但每个目录都计入其覆盖的全部文件。

全景展示和检索是独立可组合的能力。范围大时，Agent 可以选择更紧凑的名称视图、目录深度或与问题相关的检索条件，而不是依靠翻页补齐全局。脚本不擅自丢掉排序靠后的模块；工具调用方也不要再用固定尾部或头部截断伪装成完整结构。

例如，让 Agent 自己选择目标，再借用提取和排版：

```js
const { listFiles, readSymbols, compactSymbols } =
  await import('/absolute/skill/scripts/project.mjs');
const root = '/absolute/project';
const paths = listFiles(root).filter(p => p.startsWith('packages/runtime/') && p.endsWith('.ts'));
const data = readSymbols(root, paths);
console.log(compactSymbols(data, { kind: 'class,interface,type,function', detail: 'names' }));
```

也可以将 `gitChanges(root).changes` 自行筛选成路径，交给 `readSymbols`；按自定义规则过滤 `data.files` 或其中的 `symbols`，再调用展示函数。删除文件需由调用者排除，或保留它返回的“文件不存在”信息。依赖、发布入口、特定框架或业务关系的判断仍可由 Agent 自己编写针对性逻辑。

## CLI 与管道

```sh
P="$HOME/.agents/skills/codex-dsh/scripts/project.mjs"

# 只枚举和展示目录，不读取声明。
node "$P" files /absolute/project --depth 2

# 只解析指定文件或目录；不要求先建立索引。
node "$P" symbols /absolute/project packages/runtime/src --kind class,interface,type,function --detail names

# 独立读取 Git 变化。
node "$P" changes /absolute/project --since main

# 由标准工具选材；JSON 在进程之间流动，最终给模型的是紧凑文本。
node "$P" changes /absolute/project --json \
  | jq '[.changes[] | select(.status != "D") | .path]' \
  | node "$P" symbols /absolute/project --stdin
```

文件枚举可用 `--path` 限定子目录、重复 `--exclude` 排除特定范围；`symbols` 的位置参数可指定多个文件或目录。通过 `--input FILE` 或 `--stdin` 提供选材时，内容是相对路径字符串数组，直接采用这个选择，不再枚举整仓。

需要重复换角度展示同一批数据时再保存：

```sh
node "$P" symbols /absolute/project packages/runtime --out /tmp/runtime-symbols.json --detail names
node "$P" render symbols --input /tmp/runtime-symbols.json --name recover
node "$P" render symbols --input /tmp/runtime-symbols.json --imports '@example/storage' --kind class,function
```

`--out` 保存当前选定范围的完整数据，当前输出仍是紧凑文本；`--json` 输出相同范围的机器数据。若希望保留全景供后续反复检索，保存时不加检索条件，之后按需 `selectSymbols` 或 `render`。`render paths|symbols|changes` 可读取对应数据或接标准输入。没有自动缓存、后台进程或新的任务状态；数据只代表读取时的文件，源文件变化后按需要重新取得相关部分。

名称、作用域、模块引用和声明文本的检索采用不区分大小写的子串匹配；类型使用明确的类型名，路径使用项目相对路径或目录前缀。复杂正则、相关性排序等由调用方用普通 JavaScript 或现有工具组合。声明检索仍保留范围内解析失败或不支持的文件标记，不能把未提取声明当成确认无匹配。

## 展示与边界

```text
packages/runtime/src/
  session.ts
    18 export class Session
      32 submit(input: Input): Promise<Result>
      71 restore(id: string): Session
```

不要把 Ctags 原始 JSON、完整中间索引或长路径重复行直接灌入模型上下文。利用共享目录、作用域和类型标签压缩重复表达；检索时明确条件，返回范围内的全部匹配。“提取过声明”不等于“读过全部实现”，更不等于验证通过。

- TS/TSX/MTS/CTS 使用项目已安装的 TypeScript 编译器，只做语法解析。没有编译器时明确报错，可用 `--typescript` 指向现有编译器；不自动下载，也不用正则替代。
- JS、Python、Go、Rust 等常见代码文件使用支持 JSON 的 Universal Ctags；macOS 的系统旧版 Ctags 不适用。Ctags 的识别和签名完整度依语言而异，不把它当成类型系统。
- 提取具名声明、类型与成员；不展开函数内普通变量或匿名回调，不做类型推断、动态调用解析。函数体仍需按问题直接阅读。
- TS 的静态 import/export 模块路径可用 `--deps` 展示，它不是完整依赖图。其他语言未提供该信息时不要推断“没有依赖”。
- 非普通文件、未支持的文件及语法错误保留明确标记。脚本不执行项目代码、不修改源码、不把临时数据自动写进项目。

运行文件枚举需要 `rg`；解析非 TS 代码需要 Universal Ctags。只使用 Git 差异或展示函数时，不要求安装解析器。依赖按需要准备，避免把辅助工具变成每次任务的前置流程。
