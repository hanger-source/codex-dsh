# 会话协作 SDK

统一从 `scripts/sdk.mjs` 导入。SDK 不解析命令行、不打印查询结果、不读取会话历史或自动发消息；只有显式调用才执行对应操作。连接与查询、投递独立，复用一次连接即可用普通 JavaScript 自由筛选、关联和并行。`scripts/dsh.mjs` 只是可选 CLI 封装，`status` 是一种组合视图。

Windows 导入绝对路径要先 `pathToFileURL(file).href`，不要直接 `import('C:\\...')`。官方 Desktop 的入口与自建 Web 壳不同，首次连接先看 [安装形态与 Windows 说明](native-link.md)，不扫描 AppData 或寻找 Homebrew 依赖。

目标是减少 Codex 的 token 消耗和协作摩擦：原始返回留在程序内，向模型只输出影响当前判断的信息；已知数据可以复用，不为每个筛选重新启动命令和查询。遇到疑点仍读取关键正文与真实实现，不能把少输出误当成可以遗漏证据。

需要把限定调查或多步操作直接交给独立普通 DSH 会话时，使用 [DSH Agent as tool](agent-as-tool.md) 的 `delegateTask/sendTaskMessage/readTaskResult/reportTaskResult`，同样从本 SDK 导入。派发返回的对象可直接用于补充、读取和 `reuse` 接续，票据路径适合跨轮恢复；无需自己提取 Session ID 和拼接指导正文。它与项目主控绑定分开；这里的底层查询和投递函数仍可自由组合。

| 函数 | 作用与返回边界 |
| --- | --- |
| `connectDsh({logPath?, urlFile?, expectedEndpoint?})` | 建立本机连接，返回 client；可核对已有绑定 endpoint。使用 Node 内置 WebSocket，无需指定 DSH 安装目录。调用方在 finally 中 close，不重启服务，不创建 Agent。 |
| `readBinding({thread?, stateDir?})` | 只读当前或明确指定的 Codex 绑定。省略 thread 时使用 CODEX_THREAD_ID；没有绑定就报错，不猜其它会话。 |
| `listSessions(client)` | 原生会话列表，含父子关系及投影；数据可能较大，先在代码或管道中选材再交模型。 |
| `listAgents(client, rootSessionId, {recursive?, sessions?})` | 子树目录及运行快照。默认递归，返回路径、父 ID、名称、标签、模式、运行状态、更新时间及 `catalogAvailable`。可复用已经取得的 sessions；目录记录缺少会话状态时 `running:null`，子目录不可读时保留该行并以 `catalogAvailable:false` 表达，不能据此断言没有后代。 |
| `resolveAgent(client, rootSessionId, target)` | 在指定子树中按完整路径或 ID 找成员。省略 target 或指定根 ID 时返回根；歧义、归属冲突或不在树内会拒绝。 |
| `readState(client, sessionId)` | 原生 cursor、active、running、完整消息队列和待人工输入类别；缺少 live Agent 时队列可为 null。 |
| `readProjections(client, sessionId, keys?)` | 原生 sequenced／migration-required 及 asOfSeq；可只保留指定投影。不存在的会话返回 null；不存在的 key 不凭空补值。 |
| `readTasks(client, rootSessionId)` | 根会话的原生 agentTeam 投影，含任务状态、ownerId、blockedBy、writeScopes 和原生诊断。空任务板不代表没有子 Agent 工作，主控可能未使用任务板。 |
| `readActivity(client, sessionId, {beforeSeq?, throughSeq?, maxMessages?})` | 有界、向前翻页的原生事件 records、cursor、hasMore。maxMessages 限制消息数量，期间工具等事件也保留。不会推进绑定游标；首次 cursor 可作为后续 throughSeq 固定观察窗口，下一页 beforeSeq 用本页最小 seq。 |
| `summarizeActivity(page)` | 只投影事件 seq／time／type，保留 hasMore、cursor、nextBeforeSeq。需要正文时读取原 page.records，不把元数据视图当完整内容。 |
| `sendAgentMessage(client, {rootSessionId, target, text, delivery?, requestId?, clientTimeZone?})` | 在已核对的子树中，向 continuable 子 Agent 的原生 `subagents/prompt` 投递。默认 steer，queue 留待后续轮次；返回原生 messageId 与请求身份。不投根会话、不创建绑定、不改任务板、不自动通知主控、不重试。 |
| `sendSessionMessage(client, {sessionId, text, delivery?, requestId?, clientTimeZone?})` | 向主控等普通会话投递。返回请求身份和原生 receipt，不依赖 CLI 或写绑定；子会话身份由原生所有权检查拒绝。 |
| `queueCodexMessage({executable?, thread, text, workspace?})` | 显式调用桌面配套 Codex queue，将文本投递指定真实 UUID；不依赖 DSH 连接。返回 queueAccepted，不代表处理完成；不自动重试。 |
| `inspectCodex({codex?})` | 按需检查桌面配套 CLI 与 queue 能力；沿用已成立的检查，不作为每轮查询前置。 |

`DshClient` 同时开放 `rpc(method, args, timeoutMs?)`，精细能力可直接组合已确认的原生 API，不必等待新增一个包装函数。原生失败保留 `error.code` 和 `error.details`。不按名称猜接口，也不自动尝试其它协议。

## 自由组合

```js
const { connectDsh, readBinding, listSessions, listAgents, readState } =
  await import('/absolute/skill/scripts/sdk.mjs');
const binding = await readBinding();
const client = await connectDsh({ expectedEndpoint: binding.endpoint });
try {
  const sessions = await listSessions(client);
  const agents = await listAgents(client, binding.sessionId, { sessions });
  // 整体关系已在内存，自己选择需要深入的对象，不把全量投影交给模型。
  const target = agents.find(agent => agent.path === 'investigator');
  if (target) {
    const state = await readState(client, target.sessionId);
    console.log(JSON.stringify({ agent: target.path, running: state.running,
      pendingInput: state.pendingInput, queued: state.queue?.length ?? null }));
  }
} finally { await client.close(); }
```

历史正文也先在程序内提取。`assistant/message` 的 `event.data` 同时可能含已提交 message、stream、usage；直接输出整条 event 会把流式片段与完整正文一起送进上下文。下面用已经选定的 sessionId 和 selectedSeqs 读取提交文字：

```js
const { readActivity } = await import('/absolute/skill/scripts/sdk.mjs');
const page = await readActivity(client, sessionId, { maxMessages: 3 });
const messages = [];
for (const { event } of page.records) {
  if (!selectedSeqs.has(event.seq)) continue;
  let content;
  if (event.type === 'assistant/message') content = event.data.message.content;
  else if (event.type === 'user/message') content = event.data.content;
  else continue;
  if (!Array.isArray(content)) throw new Error(`未识别的正文结构：${event.type}@${event.seq}`);
  const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  messages.push({ seq: event.seq, type: event.type, text });
}
console.log(JSON.stringify({ sessionId, cursor: page.cursor, hasMore: page.hasMore, messages }));
```

selectedSeqs 可由先前的事件元数据选择；返回页没有包含所需 seq 时，继续按 beforeSeq／throughSeq 读对应范围，不能把空结果解释为没有消息。这里仅查看选中的提交文字，不输出 stream、reasoning、usage；工具结果、附件或协作消息的其它结构按当前问题从对应事件定向提取，不能为省 token 丢掉决定结论的内容。保留 seq、来源与运行身份便于回读；这一页、选定文字和完整历史分别表达，不把其中一个冒充另一个。使用现有原子函数和普通 JavaScript 即可，不另建摘要服务或读取协议。

同样可以只用 CLI 和 `jq`，无需先执行 status：

```sh
D="$HOME/.agents/skills/codex-dsh/scripts/dsh.mjs"
node "$D" agents --session ROOT_ID
node "$D" state --session ROOT_ID --agent investigator
node "$D" tasks --session ROOT_ID
node "$D" projections --session ROOT_ID --keys plan,inbox
node "$D" activity --session ROOT_ID --agent investigator --max-messages 3
node "$D" activity --session ROOT_ID --agent investigator --max-messages 3 --detail full
```

这些命令有 `--session` 时只按指定 ID 查询；省略时使用当前 Codex 绑定的主控。`--agent` 是相对所选根的完整路径或精确 ID；任务板在根上查询，再自行按 ownerId 筛选。activity 默认只显示元数据，用 `--before`／`--through` 翻页和固定窗口；`--detail full` 返回该页完整原生事件，可能含较长工具结果，应先保存或在管道中选材。

获得当前任务所需授权后，可从 SDK 直接投递，无需 shell 拼接消息：

```js
const { randomUUID } = await import('node:crypto');
const { sendSessionMessage, sendAgentMessage } = await import('/absolute/skill/scripts/sdk.mjs');
const requestId = randomUUID(); // 调用者可保存此身份供核对不确定结果。
const receipt = await sendSessionMessage(client, {
  sessionId: binding.sessionId, text: guidance, requestId, delivery: 'steer',
});
// 原子能力可独立使用；需要直达责任子 Agent 时使用 sendAgentMessage，
// 不自动向所有人广播，也不因为示例展示两个函数就同时投递。
```

CLI 的等价入口仍可按需使用：

```sh
node "$D" send-agent --session ROOT_ID --agent investigator \
  --file /absolute/guidance.md --mode steer --request-id GUIDANCE_UUID
```

CLI 在投递前把 requestId 打到 stderr，stdout 是结果 JSON。函数调用者可以预先生成并保存 requestId；原生接口报错保留 code／details，超时等不确定结果不可推断为未送达，也不应换 ID 盲发。返回 messageId 只证明接受，是否读取、执行和取得结果仍需按队列、历史和实际交付判断。

消息正文会标识 Codex 协作方及所属主控，不冒充新增用户授权。局部指导可直达，跨模块合同、范围、顺序和写入责任由主控统筹；必要时单独用 send 告知主控，由调用方决定时机，不自动双发。子 Agent 继续向原主控交付。某一会话或工具限制直接联系子 Agent 时遵守该限制，不因工具可用绕过边界。

## 证据与使用范围

运行状态、投影、任务板、子目录及历史读取已在本机 DSH 验证。投递合同按本机 DSH 源码实现，并以本地 HTTP 替身验证目标归属拒绝、请求身份、原生回执和拒绝后不重试；没有向现有工程子 Agent 发送试验消息，不能把替身通过宣称为真实子 Agent 已接收。被动读取不激活 Agent；运行快照和不同投影的采样不构成全系统同一事务。
