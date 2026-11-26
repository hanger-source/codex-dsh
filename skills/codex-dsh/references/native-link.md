# 原生会话连接

DSH 侧复用原生 Remote 协议的 Session 与 Agent Teams；Codex 侧复用原生 `queue`。客户端用 Node.js 22.22.3 或 24+ 的内置 WebSocket，不依赖 DSH 的 npm/Homebrew 安装，不需要 `--dsh-package`。不使用 `subagent_codex`：那个插件每次新建一次性 Codex，不保留本模式所需的用户主会话关系。

## 连接与权限

使用原生 `/connect?interactions=none` 换取 API Peer Cookie，并保持原生 WebSocket 的连接生命周期。只接受回环 HTTP(S) 地址，凭据不打印、不写进绑定文件、不传给模型。

入口由 `--url-file` / `CODEX_DSH_URL_FILE` 或 `--log` / `CODEX_DSH_LOG` 指定，两类不要同时设置。地址文件仅含本次启动 URL，支持 UTF-8、UTF-8 BOM、PowerShell 5 默认的 UTF-16LE、CRLF。日志取最后一条 `dsh web:` 地址；显式路径失败不会改连其它安装。

未指定入口时，只检查 `$DSH_HOME/runtime/codex-dsh/desktop.url`（下述插件发布）与 `$DSH_HOME/runtime/dsh-desktop/server.log`（自建 Web 壳日志）。`DSH_HOME` 未设时用用户目录下 `.dsh`，不猜 `%APPDATA%` 包目录。两者同时存在时须明确选一个；已有绑定可用 expectedEndpoint 区分，不能按新旧时间改接会话。

DSH 未运行时，通过它实际安装的桌面入口启动。macOS 的 `open -a DSH` 只适用于确实名为 DSH 的自建 App，不是 Windows 或官方 Desktop 的通用命令。已有服务正在运行但鉴权或 API 报错时，检查当前入口和版本，不重启任务、不另启 Web 服务承接原会话、不改全局权限。默认会话沿用 DSH 已配置的模型。

连接使用 `interactions=none`，不会冒领 DSH 原生审批或自动回答人工问题。遇到 `input-required`，通过 DSH 界面查看实际提问或审批；如果用户的决定已明确且原生接口能表达，再按对应权限操作，不能把普通 prompt 当成审批结果。

## 官方 Desktop

官方 Desktop 的父进程通过私有 IPC 向 Host 交付鉴权凭据，不保证存在 `dsh web:` 启动日志；不能读取 Electron Cookie 数据库或把它的私有凭据当成公开接入协议。官方 [Token Provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/authentication-token/README.md) 明确支持与 [Desktop Provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/authentication-desktop/README.md) 同时装配。

本 Skill 的 `assets/desktop-plugin/` 是可选的普通 Cordis bundle：在现有、仅绑定回环地址的 Host 内装配官方 Token Provider，再通过原生 `webserver/entry-url` 取得连接地址，写入 `$DSH_HOME/runtime/codex-dsh/desktop.url`。不创建服务器、Agent 或 Session，不读取 Desktop 的私有 Cookie。API Peer、鉴权、连接关闭和撤销都由官方组件负责；插件卸载清理自己发布的地址文件，Desktop 原来的私有连接继续工作。

该文件含有本机 owner 级接入凭据：POSIX 目录/文件分别以 0700/0600 创建；Windows 继承用户目录的 ACL，Node 的 mode 不等于配置 Windows ACL。因此 DSH_HOME 必须处于用户私有目录，不能置于共享目录。文件不提交 Git、不输出正文。进程崩溃可能留下过期文件，连接失败须核对 Desktop 当前运行状态，不凭此创建新实例。

**版本条件**：插件使用 `host-authentication-token` 和 `Context.root` API，须由 Desktop 自己提供相匹配的组件；当前组件试验组合是 DSH `0.2.3-alpha.1` + Cordis `4.2.0-alpha.1`。该 Token 包的 npm peer 声明仍为 Cordis `~4.1.0`，实际代码却使用 4.2 的符号 API。仓库测试对 Cordis 作了显式依赖锁定，证明这组实际代码的行为；这不证明任意已发行 Desktop 都能直接安装。安装检查若拒绝，保留具体版本差异，不能在用户 Desktop 里 force 安装、豁免检查或单独替换 Cordis。较旧 Desktop 缺少这些原生能力时，需匹配的官方发行版本；不能只改路径就宣称支持。

通过官方 Desktop 的插件管理安装本地 bundle。若使用 CLI，先从 Desktop 自带的命令安装入口确认 `dsh` 属于这个 Desktop；不要拿 npm 的独立 dsh 操作它的专属 profile。官方 CLI 管理 Desktop 插件要求先初始化 profile、完全退出应用，安装后重开；正在执行任务时不要擅自退出。参考 [官方命令说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#bundled-command-runtime)。

Windows PowerShell，在已核对上述版本并安排好退出后：

```powershell
$Skill = Join-Path $HOME '.agents/skills/codex-dsh'
Get-Command dsh -All | Select-Object Source
dsh plugin --profile desktop add (Join-Path $Skill 'assets/desktop-plugin')
# 重新打开原官方 Desktop，然后只读检查。
node (Join-Path $Skill 'scripts/dsh.mjs') doctor --codex 'C:\实际桌面配套目录\codex.exe'
```

POSIX 对应安装参数是 `dsh plugin --profile desktop add "$HOME/.agents/skills/codex-dsh/assets/desktop-plugin"`。不把此命令作为每次连接的前置步骤；已装配后直接连接。doctor 确认 `sessionApi` 后，再查原主会话、核对真实 cwd，按既有 attach 规则接入。

## Windows 的 Codex 与 SDK

`Get-Command codex -All | Select-Object Source` 只用于定位。客户端只接收可执行二进制（Windows 为 codex.exe），以参数数组传递中文、多行、引号和 shell 符号，不经过 PowerShell/cmd 求值。PATH 里的 npm cmd 包装器不等于桌面配套 CLI。用 `--codex` 或 `CODEX_DSH_CODEX` 指定绝对路径；检查 queue 能力后将实际路径固化进绑定，不将 `exec resume` 当成替代。

Windows ESM 不接受裸盘符路径作为模块 URL。跨平台导入：

```js
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const file = path.join(os.homedir(), '.agents', 'skills', 'codex-dsh', 'scripts', 'sdk.mjs');
const sdk = await import(pathToFileURL(file).href);
```

### 验证范围

- macOS 的已有 Web 型 DSH `0.2.2-rc.5`：Node 22.22.3 原生连接、只读 Session API、桌面配套 Codex CLI `0.171.0-alpha.13` 的 queue 能力检查通过。
- 官方组件隔离试验：真实 Cordis、WebServer、Connection、Desktop/Token 双 Provider，验证私有连接与 API Peer 并存、Cookie 随 WebSocket 实际传递、断开后拒绝旧 Cookie、卸载后撤销并清理地址。仅 mux 业务负载使用测试载体，未启动真实 Agent。
- UTF-16/BOM/CRLF、中文空格路径、CLI 入口与原样传参已在 macOS 验证；`.github/workflows/compatibility.yml` 在 Windows/macOS/Linux 运行同组测试。提交 workflow 不等于 CI 已执行。
- Windows 真机官方 Desktop 安装、真实原会话接入和 Codex queue 唤醒尚未验证。首次目标机接入仍需验证这些边界，不能用组件试验或 HTTP 成功代替。

## 命令

```sh
DSH_LINK="$HOME/.agents/skills/codex-dsh/scripts/dsh.mjs"
node "$DSH_LINK" help
node "$DSH_LINK" sessions --workspace /absolute/workspace
node "$DSH_LINK" status
node "$DSH_LINK" send --file /absolute/brief.md
node "$DSH_LINK" report --thread CODEX_UUID --session DSH_SESSION_ID --file /absolute/report.md
node "$DSH_LINK" read --after 123 --max-messages 30 --max-chars 24000
```

Codex 侧默认绑定当前 `CODEX_THREAD_ID`，创建绑定必须是实际 UUID。只有用户指定另一会话或做隔离验证时才覆盖它。DSH 的 `report` 必须显式传递首次派活提供的 `--thread` 和 `--session`，避免继承到别人的环境变量。来源 ID 检查用于防止投错，不是独立的身份认证系统。

绑定文件保存 Codex UUID 与配套 CLI 路径、DSH Session ID、真实工作区、无 token 的地址、读取游标和最近投递请求编号。它只保存双方关联，不保存模型历史、任务生命周期或消息副本。原生会话仍是上下文、执行和队列的 owner。

这是一对一的项目主控绑定。独立 [DSH 工具任务](agent-as-tool.md) 通过 `task/task-read/task-report` 使用另外的普通会话与回传票据，不覆盖绑定、不调用 `start/attach`，也不能借主控 `report` 冒充来源。

当前线程没有绑定时才 `start/attach`。已有绑定需要改接另一会话时，先确认原 DSH 主控是否仍在执行以及用户是否要求停止；不能仅因换绑取消旧任务。将确实要退出的绑定移入该状态目录的 `.trash/` 后再接入，不永久删除或覆盖。应用重启导致地址变化时，先用新地址的 `sessions` 核对同一 Session ID 与工作区，再只修改该绑定的无凭据 endpoint。

## 请求与结果边界

- 新建会话先以真实目录调用 `workspace/create({request:{path}})`，取得创建或复用的 `workspace.workspaceId`，再调用 `session/create({request:{workspaceId}})`。`cwd` 只指定执行目录，不建立项目归属；两字段不能同时传入。`createSessionInWorkspace` 为 `start` 和独立 `task` 共用此链路，项目失败时直接停止。
- 其它原生方法：`session/list`、`rename`、`projections`、`state`、`prompt`、`wait`，以及 `agentTeams/setEnabled`。
- `session/list` 当前返回全部摘要；`_request` 是该方法实际声明的参数名。其它 Session 方法使用 `request`。不根据相近名称自动尝试不同协议。
- `status` 组合主控状态、投影与直属子会话，不推进读取游标。子树、状态、任务板、历史与子 Agent 投递可从 SDK 独立使用，见 [协作 SDK](session-tools.md)。idle 仅表示当前未运行，不证明任务完成；不同查询的快照时间可能不同。
- `send` 默认使用 `mode: steer`，对应 DSH 的插话发送：输入进入 `next-step`，不必等整轮结束。明确留待下一轮才用 `send --mode queue`，输入进入 `next-turn`。插话不等于取消；要求停工时应使用原生 `session/cancel` 并核对作用范围，本脚本未暴露取消命令。
- 对已经排队的消息，先从原生 `session/state` 核对队列项 ID、来源 requestId 和内容，再调用 `session/updateQueue`，参数为 `{request:{sessionId,itemId,action:{kind:"steer"}}}`。它保留原消息身份并改为插话，不重新发送正文。仅在目标仍处于 queued 且 Agent 正在运行时可提升；若已被消费或当前不接受插话，如实返回状态，不重发。此操作由明确的用户意图触发，不批量提升其它排队消息。
- 脚本保留原生被动 `session.wait` 作为连接诊断工具，每次最长 55 秒；它观察 idle、人工输入或超时，不取消 Agent。它不是本模式的通信驱动，禁止以循环等待替代异步入站。
- `requestId` 是 DSH 原生去重身份。投递失败可能已被受理；绑定的 `lastRequest.accepted:false` 表示客户端未确认，不表示服务端一定没收到。检查状态，必要时用原 ID 和同一内容重发，不自动换 ID 重发。
- `wait/read` 使用 DSH 原生 seq 作为增量窗口，忽略思考和工具正文。截断会明确报告，游标不前进，完整资料仍在原 DSH 会话。

## 唤醒边界

`report` 不连接 DSH、不等模型回复，只读取已绑定的目标，执行：

```js
execFile(binding.codexExecutable, ['queue', '--thread', binding.codexThreadId, '--message', text]);
```

脚本使用参数数组调用 CLI，消息不经 shell 求值。返回 `queueAccepted` 只表示命令接受投递，不代表 Codex 已决策；超时或不确定错误不能盲目重发。此命令未提供本 Skill 可用的 requestId 去重参数，因此不额外声称恰好一次投递。DSH 需要反馈时由 Codex `send` 回同一原生 Session，普通汇报无需逐条确认。

保持持有线程的桌面 App 可用。已验证的行为是：Codex 一轮结束后，DSH 投递进入同一个线程并触发下一轮；没有另启 Agent 执行器。`queue` 沿用目标线程模型与设置，不能借它切换成 Astra Ultra。已关闭 App、远程主机、云端线程的消费行为未在本机验证，不据此承诺离线唤醒。

PATH 中的 Codex CLI 可能与桌面配套版本不同。`doctor` 与 `start/attach` 检查实际选用的二进制；其他安装位置通过 `--codex` 或 `CODEX_DSH_CODEX` 明确指定，创建时固化到绑定。CLI 或应用升级后，先核对 `queue --help` 和实际投递行为，不用另开 `exec resume`、改写会话数据库或绕过内部 App Tools 进程校验替代。

原生队列路线参考 [Wake Codex 的 QueueAdapter](https://github.com/rotcev/wake-codex/blob/main/scripts/wakecodex.py)。该项目为普通后台进程提供监听、回调与持久投递；DSH 本身能主动执行 `report`，本 Skill 不需要再运行那套监听服务。双向会话的参考还有 [Claude–Codex Bridge](https://github.com/KeeVeeG/claude-codex-bridge)，其 macOS/SSH 装配不作为本机依赖。
