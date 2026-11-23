# 可组合的会话查询与投递

`scripts/dsh.mjs` 导出 `DshClient`（连接、RPC、关闭）；`scripts/session.mjs` 导出下面的独立函数。连接只建立一次，可由调用方并行查询、筛选和组合；函数不启动新会话，不保存任务状态或自动发送后续消息。`status` 是这些查询的一种组合，不是其它能力的必经入口。

| 函数 | 作用与返回边界 |
| --- | --- |
| `listSessions(client)` | 原生会话列表，含父子关系及投影；数据可能较大，先在代码或管道中选材再交模型。 |
| `listAgents(client, rootSessionId, {recursive?, sessions?})` | 子树目录及运行快照。默认递归，返回路径、父 ID、名称、标签、模式、运行状态、更新时间及 `catalogAvailable`。可复用已经取得的 sessions；目录记录缺少会话状态时 `running:null`，子目录不可读时保留该行并以 `catalogAvailable:false` 表达，不能据此断言没有后代。 |
| `resolveAgent(client, rootSessionId, target)` | 在指定子树中按完整路径或 ID 找成员。省略 target 或指定根 ID 时返回根；歧义、归属冲突或不在树内会拒绝。 |
| `readState(client, sessionId)` | 原生 cursor、active、running、完整消息队列和待人工输入类别；缺少 live Agent 时队列可为 null。 |
| `readProjections(client, sessionId, keys?)` | 原生 sequenced／migration-required 及 asOfSeq；可只保留指定投影。不存在的会话返回 null；不存在的 key 不凭空补值。 |
| `readTasks(client, rootSessionId)` | 根会话的原生 agentTeam 投影，含任务状态、ownerId、blockedBy、writeScopes 和原生诊断。空任务板不代表没有子 Agent 工作，主控可能未使用任务板。 |
| `readUsage(client, sessionId)` | 原生 tokenUsage、subagentTiming、modelSelection；缓存读取与非缓存输入分开保留，不自行换算费用、推断卡死或累计整树用量。 |
| `readActivity(client, sessionId, {beforeSeq?, throughSeq?, maxMessages?})` | 有界、向前翻页的原生事件 records、cursor、hasMore。maxMessages 限制消息数量，期间工具等事件也保留。不会推进绑定游标；首次 cursor 可作为后续 throughSeq 固定观察窗口，下一页 beforeSeq 用本页最小 seq。 |
| `summarizeActivity(page)` | 只投影事件 seq／time／type，保留 hasMore、cursor、nextBeforeSeq。需要正文时读取原 page.records，不把元数据视图当完整内容。 |
| `sendAgentMessage(client, {rootSessionId, target, text, delivery?, requestId?, clientTimeZone?})` | 在已核对的子树中，向 continuable 子 Agent 的原生 `subagents/prompt` 投递。默认 steer，queue 留待后续轮次；返回原生 messageId 与请求身份。不投根会话、不创建绑定、不改任务板、不自动通知主控、不重试。 |

## 自由组合

```js
const { DshClient } = await import('/absolute/skill/scripts/dsh.mjs');
const { listAgents, readState, readUsage } = await import('/absolute/skill/scripts/session.mjs');
const client = await new DshClient().connect();
try {
  const agents = await listAgents(client, rootSessionId);
  // 谁需要深入、读什么、并行多少，由当前判断决定，不固定扫描全树正文。
  const target = agents.find(agent => agent.path === 'investigator');
  if (target) {
    const [state, usage] = await Promise.all([
      readState(client, target.sessionId), readUsage(client, target.sessionId),
    ]);
    console.log(JSON.stringify({ agent: target.path, state, usage }));
  }
} finally { await client.close(); }
```

同样可以只用 CLI 和 `jq`，无需先执行 status：

```sh
D="$HOME/.agents/skills/codex-dsh/scripts/dsh.mjs"
node "$D" agents --session ROOT_ID
node "$D" state --session ROOT_ID --agent investigator
node "$D" tasks --session ROOT_ID
node "$D" usage --session ROOT_ID --agent investigator
node "$D" projections --session ROOT_ID --keys plan,inbox
node "$D" activity --session ROOT_ID --agent investigator --max-messages 3
node "$D" activity --session ROOT_ID --agent investigator --max-messages 3 --detail full
```

这些命令有 `--session` 时只按指定 ID 查询；省略时使用当前 Codex 绑定的主控。`--agent` 是相对所选根的完整路径或精确 ID；任务板在根上查询，再自行按 ownerId 筛选。activity 默认只显示元数据，用 `--before`／`--through` 翻页和固定窗口；`--detail full` 返回该页完整原生事件，可能含较长工具结果，应先保存或在管道中选材。

获得当前任务所需授权后，可将局部、明确的指导直接投递原负责者：

```sh
node "$D" send-agent --session ROOT_ID --agent investigator \
  --file /absolute/guidance.md --mode steer --request-id GUIDANCE_UUID
```

CLI 在投递前把 requestId 打到 stderr，stdout 是结果 JSON。函数调用者可以预先生成并保存 requestId；原生接口报错保留 code／details，超时等不确定结果不可推断为未送达，也不应换 ID 盲发。返回 messageId 只证明接受，是否读取、执行和取得结果仍需按队列、历史和实际交付判断。

消息正文会标识 Codex 协作方及所属主控，不冒充新增用户授权。局部指导可直达，跨模块合同、范围、顺序和写入责任由主控统筹；必要时单独用 send 告知主控，由调用方决定时机，不自动双发。子 Agent 继续向原主控交付。某一会话或工具限制直接联系子 Agent 时遵守该限制，不因工具可用绕过边界。

## 证据与使用范围

运行状态、投影、任务板、用量、子目录及历史读取已在本机 DSH 验证。投递合同按本机 DSH 源码实现，并以本地 HTTP 替身验证目标归属拒绝、请求身份、原生回执和拒绝后不重试；没有向现有工程子 Agent 发送试验消息，不能把替身通过宣称为真实子 Agent 已接收。被动读取不激活 Agent；运行快照和不同投影的采样不构成全系统同一事务。
