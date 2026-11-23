# Codex × DSH

让 Codex 把高推理能力用在方向、架构与关键判断上，让 DeepSeek Harness（DSH）主会话组织 Agent Team 完成调查、实现、调试与验证。用户主要与 Codex 讨论，两边通过固定会话异步交流。

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
- DSH 在有阶段成果、方向性问题或需要讨论的关键决策时主动汇报。
- DSH 的汇报进入原 Codex 会话队列，由原会话继续处理。正在执行时不强行打断；队列接受不等于模型已处理。
- Codex 的反馈进入原 DSH 会话，双方保留各自上下文。普通回执不触发反复互发消息。

只使用两端原生会话机制，没有额外常驻消息服务、模型轮询或一次性的 Codex 执行器。代码参考了 [Wake Codex 的原生队列用法](https://github.com/rotcev/wake-codex)，无需安装它的监听服务。

## 运行条件

已验证环境：macOS、Node.js 26、DSH `0.2.2-rc.5`、桌面配套 Codex CLI `0.171.0-alpha.13`。

- 保持 DSH 桌面服务和持有目标线程的 Codex 桌面应用可用。
- Codex CLI 必须支持 `queue --thread … --message …`。默认选择 ChatGPT 桌面内附的 CLI，PATH 中另一个版本可能没有此能力。
- DSH 连接使用其原生 Remote HTTP / WebSocket API，复用随 DSH 安装的 `ws`。不是把 DeepSeek 模型替换进 Codex，也不要求另填模型 API Key。
- 尚未验证关闭桌面应用后的离线消费、跨机器通信或云端线程。

安装后可做不调用模型的接口检查：

```sh
node "$HOME/.agents/skills/codex-dsh/scripts/dsh.mjs" doctor
```

默认路径对应 macOS 的 ChatGPT 桌面与 Homebrew 全局安装的 DSH。其他安装位置应明确提供 `--codex`、`--dsh-package`；也可使用 `CODEX_DSH_CODEX`、`CODEX_DSH_PACKAGE`。DSH 启动地址可由 `--log` 或 `--url-file` 指定，后者应是本机保存地址的文件，不把含 token 的 URL 发给模型。具体见 [原生接口说明](skills/codex-dsh/references/native-link.md)。

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
│   ├── dsh.mjs                 # 可选 CLI 封装
│   ├── session.mjs             # 独立会话查询、子树发现与子 Agent 投递
│   ├── project.mjs             # 可独立组合的工程观察与展示函数
│   └── typescript-outline.mjs  # TypeScript 原生语法提取
└── references/
    ├── dsh-brief.md            # 交给 DSH 主控的协作约定
    ├── native-link.md          # 接口、状态及诊断说明
    └── project-tools.md        # 工程观察组合示例
```

## License

Apache-2.0，见 [LICENSE](LICENSE)。
