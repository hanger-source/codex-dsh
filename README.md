# Codex × DSH

让 Codex 把高推理能力用在方向、架构与关键判断上，让 DeepSeek Harness（DSH）主会话组织 Agent Team 完成调查、实现、调试与验证。用户主要与 Codex 讨论，两边通过固定会话异步交流。

也可把限定调查、检索整理和多步操作交给独立普通 DSH 会话作为工具：`task` 派发、`task-send` 补充、`task-read` 读取、`task --reuse` 接续，DSH 用 `task-report` 回传。SDK 后续操作直接接派发返回的对象，无需再提取 ID 或拼协作消息。按范围复用，不占项目主控绑定、不默认开 Team。机制、SDK 与示例单独见 [DSH Agent as tool](skills/codex-dsh/references/agent-as-tool.md)。

Codex 会亲自查看目录、层次、类型、接口和函数分布，并按需要深入关键链路；DSH 有自己的判断权，不把每一步实现都变成请示。目标是减少高成本模型处理原始资料、重复调查和等待的消耗，并不保证某个固定的 token 节省比例。

## 安装

使用与其他 Agent Skills 相同的安装方式：

```sh
npx skills add hanger-source/codex-dsh --skill codex-dsh --global --agent codex
```

Skill 安装到用户级 `~/.agents/skills/codex-dsh/`。仓库无需单独发布 npm 包，也不修改 Codex 或 DSH 的模型、权限与全局配置。

## 使用

在要承担指导工作的 Codex 会话里说：

> 用 $codex-dsh 在当前工作区开启省 token 协作。先看整体结构，再让 DSH 主控组织执行。

也可以接入已有 DSH 主会话：

> 用 $codex-dsh 接入 DSH 的“我的开发任务”会话，保留它现有的上下文和任务。

Codex 自行识别当前线程 UUID、查找指定 DSH 主会话、核对其真实工作目录、建立绑定，并将回传命令交给 DSH。已有主会话不因接入而重建或清空。用户也可以指定另一个工作区创建 DSH 主会话。

如果希望采用 Astra Ultra，请在 Codex 会话中选择对应模型与推理档位；Skill 不会自动切换模型，也不会声称改变了配置。

## 通信如何工作

```text
用户 ⇄ Codex 原会话
          │ send：DSH 原生 Session 插话（steer）
          ▼
       DSH 原主会话 ⇄ 它的 Agent Team
          │ report：codex queue
          └──────────────────────► Codex 原会话
```

- Codex 派活后可以结束当前轮次，不需要挂着等待。
- Codex 发给 DSH 的指导默认插话发送，DSH 在下一步读取，不必等整轮结束；明确要留到下一轮的任务可用 `send --mode queue`。
- DSH 在约定的整批交付完成、确需 Codex 判断的阻塞或关键反证出现时主动汇报；普通修复、测试计数、接收和等待不逐条唤醒。
- DSH 的汇报进入原 Codex 会话队列，由原会话继续处理。正在执行时不强行打断；队列接受不等于模型已处理。
- Codex 的反馈进入原 DSH 会话，双方保留各自上下文。普通回执不触发反复互发消息。

只使用两端原生会话机制，没有额外常驻消息服务、模型轮询或一次性的 Codex 执行器。代码参考了 [Wake Codex 的原生队列用法](https://github.com/rotcev/wake-codex)，无需安装它的监听服务。

## 运行条件

客户端需要 Node.js 22.22.3 或 24+，使用内置 HTTP/WebSocket；安装 Skill 后无需安装 npm 依赖，也不读取 DSH 的 node_modules。仓库的 npm 依赖只用于维护者运行测试。

- 保持 DSH 桌面服务和持有目标线程的 Codex 桌面应用可用。
- Codex CLI 必须支持 `queue --thread … --message …`。优先使用显式指定的二进制；未指定时检查 macOS 桌面配套路径和 PATH，Windows 检查 PATH 中的 codex.exe。只有通过能力检查的路径才能进入绑定。
- DSH 连接使用其原生 Remote HTTP / WebSocket API。Web 服务和官方 Desktop 的连接入口不同：Desktop 使用本 Skill 的可选原生插件接入。不是把 DeepSeek 模型替换进 Codex，也不要求另填模型 API Key。
- 尚未验证关闭桌面应用后的离线消费、跨机器通信或云端线程。

安装后可做不调用模型的接口检查：

```sh
node "$HOME/.agents/skills/codex-dsh/scripts/dsh.mjs" doctor
```

Windows PowerShell：

```powershell
$D = Join-Path $HOME '.agents/skills/codex-dsh/scripts/dsh.mjs'
node $D doctor --codex 'C:\实际安装目录\codex.exe'
```

`--codex` 或 `CODEX_DSH_CODEX` 指定桌面配套 CLI，保留带空格的完整路径，不使用 cmd/bat 包装器。DSH 地址由 `--log` / `CODEX_DSH_LOG` 或 `--url-file` / `CODEX_DSH_URL_FILE` 指定，地址文件支持 PowerShell 的 UTF-16LE、UTF-8 BOM 和 CRLF；不要将含 token 的 URL 发进会话。SDK 在 Windows 中通过 `pathToFileURL(绝对路径)` 导入，不能直接 `import('C:\\...')`。

**官方 DSH Desktop 不等于自建 DSH.app。** 官方 Desktop 默认使用私有 IPC 鉴权；找不到自建 App 的 server.log 是正常情况。可选 [Desktop 接入插件](skills/codex-dsh/references/native-link.md#官方-desktop) 在原 Host 内组合官方 Token Provider，供 SDK 连接同一服务与会话，不额外启动 Web Host。不依赖 AppData 或 Homebrew 安装位置。支持版本、安装及凭据边界见该说明。

验证范围：macOS 的现有 DSH `0.2.2-rc.5` 只读连接与 Codex CLI `0.171.0-alpha.13` 能力检查成立；官方鉴权组件的隔离集成测试、Windows 编码和参数传递测试已在 macOS 通过。仓库提供 Windows/macOS/Linux CI；Windows 真机的官方 Desktop 安装及 Codex 会话唤醒尚需目标环境验证，不能由本机测试替代。

## 本地状态与权限

会话关联保存在 `~/.local/state/codex-dsh/`，只包含双方会话身份、工作目录、无凭据的地址、CLI 路径及读取游标。模型上下文与任务状态仍由原生会话管理。

DSH 连接凭据在运行时从本机启动信息取得，仅用于本机连接，不写入绑定文件。仓库不包含任何用户会话、日志、模型凭据或工作区内容。协作消息也不代表新增的人类授权；发布、外发和其他需要授权的操作仍遵守原任务边界。

## 可组合的会话能力

以 `scripts/sdk.mjs` 为主入口，连接、绑定读取、子树、状态与队列、任务板、历史查询以及消息投递都能直接用 JavaScript 组合。批量数据在程序内筛选、关联，只将影响判断的信息送入 Codex 上下文，减少 Codex 的重复阅读和工具往返。已有子 Agent 可通过原生投递接口获得局部指导，继续向原主控交付，跨模块分工由主控统筹。

```sh
D="$HOME/.agents/skills/codex-dsh/scripts/dsh.mjs"
node "$D" agents --session ROOT_ID
node "$D" state --session ROOT_ID --agent investigator
node "$D" tasks --session ROOT_ID
node "$D" activity --session ROOT_ID --agent investigator --max-messages 3
```

CLI 是可选的薄入口；SDK 导入时没有副作用，不需要调用 CLI，也不建立第二份任务状态。使用者按需组织查询与消息，详见 [SDK、示例与投递边界](skills/codex-dsh/references/session-tools.md)。

## 可组合的工程观察

Skill 还提供文件枚举、声明提取、Git 差异和紧凑展示函数，供 Agent 单独调用或导入自己的 JavaScript。Agent 自己选择范围、变换数据和组织判断，工具不规定审查流程。

```sh
P="$HOME/.agents/skills/codex-dsh/scripts/project.mjs"
node "$P" files /absolute/project --depth 2
node "$P" symbols /absolute/project src --kind class,interface,type,function --detail names
node "$P" changes /absolute/project --since main
```

输出覆盖整个选定范围，不分页、不截短签名。名称视图按作用域合并全部声明名称，签名视图完整展示声明；可独立按路径、名称、类型、作用域或静态模块引用检索。JSON 用于管道或保存中间结果，避免把重复字段和路径灌入模型。TS 声明由项目的 TypeScript 编译器提取，其他常见语言复用 Universal Ctags。文件枚举使用 ripgrep；仅调用差异与展示函数无需解析器。详见 [组合示例与边界](skills/codex-dsh/references/project-tools.md)。

## 仓库结构

```text
skills/codex-dsh/
├── SKILL.md                    # 使用与协作规则
├── agents/openai.yaml          # Codex Skill 元数据
├── scripts/
│   ├── sdk.mjs                 # 公开 SDK 入口、连接、绑定读取与 Codex 投递
│   ├── tool-task.mjs           # 独立普通 Session 工具任务、回查与回传
│   ├── codex.mjs               # Codex 原生 queue 与配套 CLI 检查
│   ├── environment.mjs         # 连接入口、编码与 CLI 路径识别
│   ├── dsh.mjs                 # 可选 CLI 封装
│   ├── session.mjs             # 独立会话查询、子树发现与子 Agent 投递
│   ├── project.mjs             # 可独立组合的工程观察与展示函数
│   └── typescript-outline.mjs  # TypeScript 原生语法提取
├── assets/desktop-plugin/      # 官方 Desktop 原生 Token 接入插件
└── references/
    ├── agent-as-tool.md        # 工具任务机制与独立用法
    ├── dsh-brief.md            # 交给 DSH 主控的协作约定
    ├── native-link.md          # 接口、状态及诊断说明
    ├── session-tools.md        # Session SDK 组合示例
    └── project-tools.md        # 工程观察组合示例
```

## License

Apache-2.0，见 [LICENSE](LICENSE)。
