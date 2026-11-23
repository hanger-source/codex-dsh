# 原生会话连接

已验证环境为 macOS、DSH `0.2.2-rc.5` 与桌面配套 Codex CLI `0.171.0-alpha.13`。DSH 侧复用原生 Remote 协议的 Session 与 Agent Teams；Codex 侧复用原生 `queue`。不使用 `subagent_codex`：那个插件每次新建一次性 Codex，不保留本模式所需的用户主会话关系。

## 连接与权限

默认读取本机 `~/.dsh/runtime/dsh-desktop/server.log` 的最后一个 `dsh web:` 启动地址，用原生 `/connect?interactions=none` 换取 API Peer Cookie，并保持原生 WebSocket 的连接生命周期。凭据只在当前脚本内存里使用，不打印、不写进绑定文件、不传给模型。只接受回环地址。

`--log` 可以指定对应 DSH 启动日志；`--url-file` 可以指定仅包含本次启动 URL 的本机文件。不要把含 token 的 URL 贴入会话或命令参数。`--dsh-package` 或 `CODEX_DSH_PACKAGE` 指定实际 DSH 安装的 `package.json`；默认是本机 Homebrew 全局安装路径，复用随 DSH 安装的 `ws`，不额外安装依赖。

DSH 未运行时，可用本机原生入口 `open -a DSH` 启动，再执行 `doctor`。已有 DSH 正在运行但鉴权或 API 报错时，检查当前地址、版本和错误，不为了本 Skill 重启它或改全局权限。默认会话沿用 DSH 已配置的模型，不冒充设置了 DeepSeek 的某个档位。

连接使用 `interactions=none`，不会冒领 DSH 原生审批或自动回答人工问题。遇到 `input-required`，通过 DSH 界面查看实际提问或审批；如果用户的决定已明确且原生接口能表达，再按对应权限操作，不能把普通 prompt 当成审批结果。

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

当前线程没有绑定时才 `start/attach`。已有绑定需要改接另一会话时，先确认原 DSH 主控是否仍在执行以及用户是否要求停止；不能仅因换绑取消旧任务。将确实要退出的绑定移入该状态目录的 `.trash/` 后再接入，不永久删除或覆盖。应用重启导致地址变化时，先用新地址的 `sessions` 核对同一 Session ID 与工作区，再只修改该绑定的无凭据 endpoint。

## 请求与结果边界

- 原生方法：`session/list`、`create`、`rename`、`projections`、`state`、`prompt`、`wait`，以及 `agentTeams/setEnabled`。
- `session/list` 当前返回全部摘要；`_request` 是该方法实际声明的参数名。其它 Session 方法使用 `request`。不根据相近名称自动尝试不同协议。
- `status` 将主控的 `subagentCatalog` 与 `session/list` 的直属子会话合并，展示名称、任务标签和 `running`，并汇总 running／idle／unknown 数量。目录有记录但列表未取得状态时保留该项并标 unknown；idle 仅表示当前未运行，不证明任务完成。它是只读快照，不读取子会话正文、不推进读取游标，也不接管子 Agent；主控与子会话取样时间可能不同。
- `send` 默认使用 `mode: steer`，对应 DSH 的插话发送：输入进入 `next-step`，不必等整轮结束。明确留待下一轮才用 `send --mode queue`，输入进入 `next-turn`。插话不等于取消；要求停工时应使用原生 `session/cancel` 并核对作用范围，本脚本未暴露取消命令。
- 对已经排队的消息，先从原生 `session/state` 核对队列项 ID、来源 requestId 和内容，再调用 `session/updateQueue`，参数为 `{request:{sessionId,itemId,action:{kind:"steer"}}}`。它保留原消息身份并改为插话，不重新发送正文。仅在目标仍处于 queued 且 Agent 正在运行时可提升；若已被消费或当前不接受插话，如实返回状态，不重发。此操作由明确的用户意图触发，不批量提升其它排队消息。
- 脚本保留原生被动 `session.wait` 作为连接诊断工具，每次最长 55 秒；它观察 idle、人工输入或超时，不取消 Agent。它不是本模式的通信驱动，禁止以循环等待替代异步入站。
- `requestId` 是 DSH 原生去重身份。投递失败可能已被受理；绑定的 `lastRequest.accepted:false` 表示客户端未确认，不表示服务端一定没收到。检查状态，必要时用原 ID 和同一内容重发，不自动换 ID 重发。
- `wait/read` 使用 DSH 原生 seq 作为增量窗口，忽略思考和工具正文。截断会明确报告，游标不前进，完整资料仍在原 DSH 会话。

## 唤醒边界

`report` 不连接 DSH、不等模型回复，只读取已绑定的目标，执行：

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
  queue --thread CODEX_UUID --message '协作汇报'
```

脚本使用参数数组调用 CLI，消息不经 shell 求值。返回 `queueAccepted` 只表示命令接受投递，不代表 Codex 已决策；超时或不确定错误不能盲目重发。此命令未提供本 Skill 可用的 requestId 去重参数，因此不额外声称恰好一次投递。DSH 需要反馈时由 Codex `send` 回同一原生 Session，普通汇报无需逐条确认。

保持持有线程的桌面 App 可用。已验证的行为是：Codex 一轮结束后，DSH 投递进入同一个线程并触发下一轮；没有另启 Agent 执行器。`queue` 沿用目标线程模型与设置，不能借它切换成 Astra Ultra。已关闭 App、远程主机、云端线程的消费行为未在本机验证，不据此承诺离线唤醒。

PATH 中的 Codex CLI 可能与桌面配套版本不同。`doctor` 与 `start/attach` 检查实际选用的二进制；其他安装位置通过 `--codex` 或 `CODEX_DSH_CODEX` 明确指定，创建时固化到绑定。CLI 或应用升级后，先核对 `queue --help` 和实际投递行为，不用另开 `exec resume`、改写会话数据库或绕过内部 App Tools 进程校验替代。

原生队列路线参考 [Wake Codex 的 QueueAdapter](https://github.com/rotcev/wake-codex/blob/main/scripts/wakecodex.py)。该项目为普通后台进程提供监听、回调与持久投递；DSH 本身能主动执行 `report`，本 Skill 不需要再运行那套监听服务。双向会话的参考还有 [Claude–Codex Bridge](https://github.com/KeeVeeG/claude-codex-bridge)，其 macOS/SSH 装配不作为本机依赖。
