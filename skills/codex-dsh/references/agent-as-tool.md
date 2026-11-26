# DSH Agent as tool

把一项可独立交付的工作交给普通 DSH Session，Codex 只接收结论和可核对的证据。DSH 自主检索、使用工具和完成多步任务；Codex 保留目标、关键判断与验收。这是异步委派，`accepted` 只表示投递受理，不是函数已经返回业务结果。

调用习惯围绕同一个任务展开：派出去、补充指导、取结果、在原上下文继续。SDK、原生 Session、主控协作、票据和异步回传各自继续承担原来的责任。统一调用方式即可，不要求与 Codex 原生子 Agent 使用相同实现，也不以此替换现有协作机制。

## 与项目主控分开

项目主控负责实施、分工、共享源码与整合；工具会话只负责本次任务，不开 Team，不再派 Agent，也不指挥项目主控。创建工具会话不会改变现有主控绑定。多个独立调查可以分别派发，同一范围的后续优先复用已建立上下文的工具会话，不固定预建一批空会话。

同一个 cwd 不等于写入授权。只读调查不得改工程；需要生成材料可写自己的临时目录。明确授权的独立修改要有清楚写域，不能与主控施工冲突；跨模块实施和整合交回主控。文件、shell、网络权限由 DSH 实际宿主承担，这套工具不会提供额外沙箱，也不会把任务文字变成权限隔离。当前宿主不允许委派时不用此入口。

## 什么时候交出去

精确定位一个符号或核对两段源码，Codex 直接做。工作扩成跨模块找入口、整理大量日志、核对多份报告与原件、批量索引、准备数据或独立多步 shell 操作时，值得交给工具会话；不要等自己已读完才派它重复调查。Terra 等可用调查者也是选择，按材料类型、能力、启动与交接成本判断，不按固定比例分配。

例如一次疑点扩成 channel-worker 迁移调查，可直接委派：

> 只读检查 channel-worker 当前实际调用的查询和命令，沿客户端到新数据模块的注册与实现，区分配置未接和领域能力未迁移。范围是给定两仓当前 checkout；不要查全部 Git 历史或改代码。已有结论是旧客户端仍被导入，尚不确定实际业务操作是否迁移。返回调用关系、准确文件与函数、缺项证据和未查范围；不要只报字符串命中数量。

说明要解决的问题、准确范围、已成立事实、限制和交付含义即可；无需复制全场对话，也不必套固定表格。工具会话可提出推荐，但不能把推断写成实测。Codex 按影响抽查关键原件；需要重建上下文的无关任务另开会话。

## SDK：一次派发，异步回传

统一从 `scripts/sdk.mjs` 导入。首次使用确认支持原生队列的 Codex CLI；同一工具会话接续沿用已确认路径。

```js
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const sdkFile = path.join(os.homedir(), '.agents/skills/codex-dsh/scripts/sdk.mjs');
const { connectDsh, delegateTask, sendTaskMessage, readTaskResult } = await import(pathToFileURL(sdkFile).href);
const client = await connectDsh();
try {
  const task = await delegateTask(client, {
    thread: process.env.CODEX_THREAD_ID, // 发起 Codex 的真实 UUID
    workspace: '/absolute/project',
    title: '渠道查询迁移核对',
    task: '只读检查……准确范围、已有事实、需区分的问题、交付含义。',
  });
  console.log(task); // sessionId / requestId / ticketPath / afterSeq / accepted
  // 需要补充时，直接使用 task；无需读票据、提取 ID 或手工拼协作消息。
  await sendTaskMessage(client, task, { text: '重点区分配置未接与领域操作缺失。' });
  // 需要结果时读一次；派发后不必挂着等，可以继续其它工作或结束本轮。
  const result = await readTaskResult(client, task);
  console.log(result); // 状态和正文窗口，不把 idle 当成功
  // 原任务交付并空闲后，同范围继续查：
  // const next = await delegateTask(client, { reuse: task, task: '沿已查到的入口补查权限变化。' });
} finally { await client.close(); }
```

`delegateTask` 按实际工作目录创建或复用原生项目，在项目下创建普通 Session、核对工作区与空闲状态、保存准确回传地址，再通过原生 `session/prompt` 投递一次。消息已带本任务的 `task-report` 命令，不必手工抄接收线程 ID，也不依赖 DSH 环境中的 `CODEX_THREAD_ID`。完成或遇到需要判断的阻塞时，DSH 调用该命令，将报告通过原生 `codex queue` 送回发起线程。

派发结果 `task` 是现有票据的引用，可直接交给后续函数；跨轮时用其 `ticketPath` 恢复，无需把对象全文或任务正文再传一遍。`sendTaskMessage` 将补充送进同一个原生 Session，沿用本次任务的回传地址；`delegateTask({reuse: task, ...})` 则在空闲会话里受理下一次工作并返回新请求。运行中纠正与交付后接续有不同含义，不能因原会话忙就另建同题任务。

Codex 派发后可继续自己的工作或结束本轮，保持原应用可用；不用常驻等待或模型轮询。DSH 仍按消息中已填好的 `task-report` 命令回传，结果进入发起 Codex 的原生队列；本入口没有另加事件监听服务或自动判定任务成功。本地测试证明派发、补充、接续和回传边界，具体宿主上真实模型执行与唤醒效果以实际交付为准。

| SDK | 用法 |
| --- | --- |
| `delegateTask(client, {task, workspace?, title?, thread?, codex?, reuse?, stateDir?})` | 创建并派发；`reuse` 直接接先前返回的对象或 ticketPath，只接续同 Codex、同 endpoint、同 cwd 的空闲工具会话。新请求返回新票据，旧请求仍可回查。thread 优先采用显式值或当前发起端环境；复用且环境未提供时沿用票据中的原收件人，环境身份矛盾则拒绝。 |
| `sendTaskMessage(client, task, {text, delivery?, requestId?})` | 补充原任务，默认原生 steer，明确留待下一轮时用 queue；接 task 对象或 ticketPath。返回原任务 requestId 与本条 deliveryRequestId，不新建会话或票据，不改变原回传地址；入队不代表已读取。 |
| `readTaskResult(client, task, {beforeSeq?, throughSeq?, maxMessages?, maxChars?})` | 接 task 对象或 ticketPath，即刻读原生状态和投递后的正文窗口；默认6条消息、12000字符，保留分页与截断标记，不含 stream/reasoning/usage。工具证据按需另用 `readActivity` 取，不把正文摘要当全轨迹。 |
| `readTaskTicket(task)` | 从 task 对象或 ticketPath 读取来源身份、回传地址及投递前 cursor；需要底层组合时再用，不是日常操作的前置步骤。 |
| `reportTaskResult(task, text)` | 工具会话显式回传一次，固定来源 Session、请求和发起 Codex；接 task 对象或 ticketPath，无需主控绑定或 DSH 连接。不自动重试、去重或认定任务完成。 |

## CLI：派发、补充、读取和接续

POSIX 示例；Windows PowerShell 将 `$D` 设为 `Join-Path $HOME '.agents/skills/codex-dsh/scripts/dsh.mjs'`，其余参数一致，使用实际 Windows 路径。

```sh
D="$HOME/.agents/skills/codex-dsh/scripts/dsh.mjs"
node "$D" task --workspace /absolute/project --title '渠道查询核对' --file /absolute/task.md
# 输出 ticketPath。后续不需要重新查找来源、复制 thread 或改主控绑定。
node "$D" task-send --ticket /absolute/ticket.json --file /absolute/guidance.md
node "$D" task-read --ticket /absolute/ticket.json
node "$D" task --reuse /absolute/ticket.json --file /absolute/followup.md
```

工具会话在自己一侧使用派发消息中已填好的命令：

```sh
node "$D" task-report --ticket /absolute/ticket.json --file /absolute/result.md
```

`task-read` 不是自动验收，也不是同步等待函数。`running:false` 不等于完成；消息窗口还可能包含后续接续。跨页读取固定 `throughSeq`，以 `nextBeforeSeq` 向前翻；正文截断则提高 `maxChars`。票据的 `afterSeq` 永不因读取推进，不会把没读完的材料当成已消费。

同范围交付并空闲后用 `task --reuse` 接续。原任务的纠正、补充或阻塞问题的回答用 `task-send`，不另开任务；它自动关联原请求，不必手工读票据。`--mode queue` 明确留到下一轮，默认 steer 是在后续可接续处读取，不等于立即中断。审批仍通过原宿主处理，普通指导不代表批准。停止任务使用原生 `session/cancel` 并核对执行，不通过重复发“停止”替代取消。

同一工具会话由发起者顺序复用；SDK 的空闲检查不是跨调用并发锁。确需并行的独立任务使用不同会话，并确认没有争用写域、端口或外部资源。

## 汇报和信息保真

工具任务通常只有一次交付；无消息不等于没工作。不发送接收、开工、已找到文件、正常测试或等待回执；发现必须 Codex 决定的阻塞、关键反证才提前发具体问题。原任务中可自行解决的错误自行处理，完成时合并结果。多个任务的结果由 Codex 汇总判断，不逐条再转发成项目主控的新指令。

结果先说结论和对下一步的影响，再给足以核验的路径／符号／run／片段及未覆盖范围。保留区分“没找到”“没有实现”“没装配”“没验证”的证据；关键条件、版本、失败和反例不能为省字去掉。大材料留在原会话或约定文件，只回必要正文及索引。普通交付不自动回执；Codex 有实质补查再接续原工具会话。

## 状态与失败边界

`$CODEX_DSH_STATE_DIR/tool-tasks/`（默认 `~/.local/state/codex-dsh/tool-tasks/`）每次请求只保存一个回传票据：Session、requestId、cwd、endpoint、Codex地址和投递前cursor。不存凭据、任务副本、状态机、结果或新队列。原生 Session 是执行与上下文的唯一来源；该本机票据用于正确投递，不是另一套身份认证或权限系统。

创建、改名或投递失败会保留已知 Session/requestId/ticketPath。先核对该身份及原生事件／队列，不因错误就再次创建或盲重发；创建响应丢失时核对会话列表。回传失败可能已入队，保留原结果与错误，不能换主控 report 冒充来源。endpoint 变化先确认仍是原实例和 Session，不自动改接另一安装。工具会话结束后留在 DSH 原生历史中，按实际需要通过原生界面归档，不另加后台守护或自动清理器。
