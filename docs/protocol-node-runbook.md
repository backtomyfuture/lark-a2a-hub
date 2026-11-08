# 协议接入型节点运行手册

配套标准：[中台标准 v3.1](standard.md)（形态 B：A2A 原生主干＋本地扩展列）。

本手册写给**协议接入型节点**：没有守护进程、靠平台自动化/webhook 被唤醒、
按文字规则盯表的 Agent（例如某些云端 Agent 平台）。守护进程型节点以
lark-a2a-hub 的 Node 实现为准（node 角色 `lah daemon --role node`，
枢纽侧 `lah daemon --role hub`，向下兼容 `hub-node` 别名），协议与本手册完全一致——区别只是
纪律由代码机械强制，还是由本手册的规则自觉遵守（枢纽侧会按 ID 对账去重兜底）。

## 一、七张表

字段分两类：A2A 原生字段按协议原义用；标（扩展）的是共享总线运营字段（寻址/认领/熔断/幂等/呈递），A2A 点对点模型不建模、我们保留为并列列。

| 表 | 职责 | 字段 |
|---|---|---|
| Tasks | 一行一任务：信封＋状态机 | Task_ID、Context_ID、Status（八态）、Status_Msg（扩展）、Metadata；扩展：Title、Source、Target_Node、Worker_Hint、Skill_ID、Approval_Class、Hop_Count、Idempotency_Key、Worktree、Latest_Run、Presented、Claimed_By、Heartbeat_At、Retry_Count。**无 Payload**：任务参数在首条 instruction 消息的 DataPart 里 |
| Messages | 任务内对话，只追加 | Msg_ID、Task_ID、Context_ID、Role（user/agent）、Kind（扩展：instruction/question/answer/auth_request/auth_decision/progress/result/notice）、Ref_Task_IDs（消息级派生关联）、Metadata、Created_At；扩展：From_Node、To_Node、Artifact_Ref、In_Reply_To。**无 Content**：正文在 Parts |
| Parts | 内容块，消息与产物共用 | Part_ID、Parent_ID、Parent_Type（message/artifact）、Seq、Kind（text/file/data）、Text、File_URI、File_Name、Mime_Type、Data、Metadata |
| Runs | 执行台账（本地表） | Run_ID、Task_Ref、Node、Worker、Started_At、Finished_At、Outcome（succeeded/failed/paused）、Error_Log |
| Artifacts | 成果登记册（本体在飞书文档/云盘） | Artifact_ID、Task_ID、Context_ID、Name、Description、Metadata；扩展：Is_Final、Created_By、Created_At。内容＝其 FilePart（Parent_Type=artifact）；修订＝同名新 Artifact_ID，**无版本字段** |
| AgentCards（原 Nodes） | 能力注册（AgentCard 展开） | 原生：Node、Node_Desc、Daemon_Version、Skill_ID、Skill_Name、Description、Tags、Examples、Input_Modes、Output_Modes、Default_Input_Modes、Default_Output_Modes、Cap_Streaming、Cap_Push、Cap_State_History；扩展：Cap_ID、Zone、Required_Assets、Side_Effect、Availability、Dispatchable、Receive_Mode |
| Rules_路由规则 | 路由规则（派活方用，本地表） | Rule_ID、Match_Type、Skill_ID、Target_Node、Worker_Hint、Approval_Class、Priority、Enabled、Note |

## 二、盯表矩阵与唤醒配置

现实前提：协议接入型节点通常只有「新增记录」能唤醒（其集成方式决定），「变更」感知不到。因此变更类信息一律由枢纽转成新增事件（信号行/Messages 新行）推送；Messages 自动化就绪前，answer 靠枢纽双写的轻量信号行唤醒（标准 §8.5 附则，就绪后自动失效）。

### 1. 唤醒通道（Receive_Mode=automation）

由中台操作者在 Base 配置飞书自动化——Tasks 行新增（或变更且 `Target_Node=本节点`）时向节点地址发送 webhook POST，**只带 ID，不带任务正文、参数与敏感数据**。典型例子：Grok bot 这类无法建立长连接、但有固定接收地址的外部节点。

可复制的 webhook 请求体样例（飞书自动化出站 POST）：
```json
{
  "task_id": "TASK-20261107-a1b2c3",
  "event_type": "task_assigned",
  "status": "submitted",
  "target_node": "grokbot"
}
```
节点收到该门铃后，必须使用自身配置的飞书应用凭据调用 REST API 回查 Tasks 行，并读取该任务首条 `instruction` 消息的 DataPart 获取结构化参数。

### 2. 15 分钟对账如何配置

webhook 通知可能因网络抖动、自动化重试超时等出现丢失，因此必须保留 15 分钟（900 秒）低频对账扫表作为安全网。
> [!IMPORTANT]
> **重要配置注意**：飞书多维表格自动化中，「Tasks 新增记录」这类事件触发器与「定时触发（每 15 分钟）」**不能写在同一个自动化流程里**。

收到 webhook 门铃后，以及 15 分钟对账时，官方入口是 `lah reconcile`（可写 `lah reconcile --once`）。它复用内核 `sweepOnce()`：回表认领、心跳、入箱或执行，然后退出，不长驻。一次性对账不会把命令表里没有的手工名片写成 `Dispatchable=No`，也不会改写这些名片。协议节点的 `Receive_Mode=automation` 只能手工登记；`lah setup --wake sweep` 配的是守护进程，名片登记 `poll`，轮询间隔不超过对账周期 900 秒（标准 §6、§10.3）。

对账必须通过独立例行配置：
- **方案 A（节点端定时例行，推荐）**：协议节点在其运行环境配置独立的定时任务（如 cron 每 15 分钟执行一次 `lah reconcile`），主动回表拉取 `Target_Node=本节点` 且 `Status=submitted` 的存量任务，以及 `Status=input-required` 下已追加 `answer` 消息的任务，补齐漏唤醒的单；
- **方案 B（飞书端独立自动化）**：在 Base 另建一条独立的飞书自动化流程，触发器设为「定时触发（间隔 15 分钟）」，动作为「查找记录」匹配本节点未完成任务，再向协议节点的专用对账 webhook 端点 POST 任务 ID 列表。

### 3. 盯表矩阵

| 表 | 盯什么 | 触发 | 看哪些字段 | 动作 |
|---|---|---|---|---|
| Tasks | **新增** | Target_Node=本节点名 且 Status=submitted | Task_ID、Title、Skill_ID、Approval_Class、Context_ID、Idempotency_Key、Hop_Count | 查重（Idempotency_Key）：若已有同键非 failed/canceled 任务，直接置 `rejected` 并写 `notice`；否则去 Messages 读首条 instruction 的 DataPart 取参数 → 按第三节认领 |
| Tasks | **新增（信号行）** | Title 以「答复信号」开头 | 行内注明的原 Task_ID 与 Msg_ID | 按 Msg_ID 去 Messages 读 answer（正文在其 Parts），回原任务续跑；信号行本身不执行、不回执 |
| Tasks | **变更（状态取消）** | Status 变为 `canceled` | Status、Status_Msg | `canceled` 只能由 hub 角色或发起方写入。节点一旦看到任务置为 `canceled`，**立即终止本地执行并释放资源**，不再写回执 |
| Messages | **新增**（自动化就绪后） | To_Node=本节点名 | Kind、Task_ID、In_Reply_To、Artifact_Ref；正文读其 Parts | answer→续跑；auth_decision→进行四项判定核验，合格后读 DataPart 的 decision 执行/关单；instruction→并入原任务执行；notice→知悉 |
| AgentCards | 读（认领前） | — | 本节点行：Skill_ID、Dispatchable、Availability | 确认能力在册且可派发；能力增减/上下线时自己增改行 |
| Artifacts | 写为主 | 交付时 | — | 先登记行＋FilePart，再在 result 消息里引用 |
| Rules | 只读参考 | — | Skill_ID→Target_Node 映射 | 知悉路由口径即可，不据此改行为 |
| Runs | 只写 | 每个执行段 | — | 开行/关行写 Outcome，不读不改他人行 |

## 三、回复规矩（标准往返）

1. **认领与幂等**：
   - 认领：Status=submitted→working，Claimed_By=本节点名，写入 Heartbeat_At，Runs 开一行（Started_At）。
   - **同 Idempotency_Key 语义（标准 §8.4）**：同一 Idempotency_Key 在状态非 failed/canceled 的任务中只执行一次。节点认领前查重：已有同键任务处于其他任一状态（含进行中、中断态、completed、rejected）的，**新任务直接置 `Status=rejected`，并在 Messages 写 notice 说明重复**（notice 须写明原任务的 Task_ID 并以 `Ref_Task_IDs` 指向它）；同键任务全部为 failed/canceled 时可以执行。Idempotency_Key 为空的任务不查重。
2. **执行**：只接 AgentCards 里自己登记且 Dispatchable=Yes 的 Skill_ID；没有的能力 → Status=rejected＋Messages 写 notice 说明缺口，不硬接。
3. **提问**：Messages 写 question 消息（正文写其 TextPart）→ Tasks 置 input-required 且 Status_Msg=该 Msg_ID → Runs 关行 Outcome=paused。停手，不算失败。
4. **续跑**：收到 answer（信号行/Messages 新增）后按 In_Reply_To 对上自己的 question → Status 回 working → 续跑，答复内容从 answer 的 Parts 读，不要求对方另开任务。
5. **审批与取消**：
   - Approval_Class=approve 的任务，先写 auth_request 消息＋置 auth-required（Status_Msg 指向该 auth_request）再停手，不经 working。
   - **auth_decision 的四项鉴别（标准 §8.3）**：节点在续跑前，必须严格核验该决定同时满足下列四项条件：
     1. `From_Node=hub`、`Role=user`；
     2. `In_Reply_To` 等于任务当前 `Status_Msg`（指向旧 auth_request 的决定一律作废）；
     3. 决定值只读其 DataPart 的 `decision`（`{"decision": "approve"}` 或 `{"decision": "reject"}`），TextPart 文字与任务行上的任何标记都不作数；
     4. 同一 auth_request 下有多条有效决定时，以最新一条为准。
   - **hub 独占 canceled 与节点动作**：`canceled` 状态与 `auth_decision` 只能由 hub 角色的代码路径写入，协议节点自身绝不写这两样。当任务被置为 `canceled`（审批驳回或发起方取消）时，节点必须立即终止本地执行并释放资源，不再向总线写回执或流转状态。
   - **节点自有红线优先**：对外发消息、删改数据、花钱、提交表单、改权限，只认操作者在与该节点的自有渠道里亲口确认，表中 approved 仅参考——此行为中台已知悉，不算流程冲突。
6. **交付**：文档类成果先存飞书文档 → Artifacts 登记一行＋一条 FilePart（File_URI=文档链接、File_Name=名称）→ Messages 写 result（Artifact_Ref=登记号，正文 TextPart 写摘要）→ Status=completed、Runs 关行 Outcome=succeeded。
7. **失败**：Runs 关行 Outcome=failed＋Error_Log 写原因；可重试 → Status 回 submitted、Retry_Count+1；不可重试 → Status=failed＋Messages 写 notice。
8. **派生**：需要子任务时新建 Tasks 行＋其首条 instruction 消息（Ref_Task_IDs 指回父任务、DataPart 放参数），Hop_Count=父+1、共享 Context_ID；**Hop_Count>8 熔断**，不再派生。
9. **纪律、状态持久化与串行锁**：
   - **状态持久化与水位记录**：协议节点需在本地持久化记录已处理过的任务水位（例如已读取的最大 `Msg_ID` 或已认领的 `Task_ID` 清单），避免节点重启或重复 webhook 导致重复消费；
   - **写操作严格串行锁**：飞书多维表格同表不支持并发写，并发写入极易触发 1254291 冲突。协议节点在向 Tasks、Messages、Parts、Runs、Artifacts 写数据时，**必须加本地串行锁（互斥锁/串行队列）确保写操作严格串行**，并对 1254291 与 429/5xx 错误实现指数退避重试（建议至少退避重试 3 次）；
   - **凭据与消息只追加**：凭据与敏感原文不入表；长内容只放指针；Messages 与 Parts 只追加，永不改删；节点不开任何入站端口。
10. **排障与全链排查**：
   - 协议节点在联调或排查异常时，可使用只读命令 `lah task why <Task_ID> [--config <dir>] [--json]` 查阅该任务在总线上的完整时间线（Tasks 状态迁移、多轮消息问答与审批链、Runs 执行台账、Artifacts 成果指针与本地待补交队列），快速定位认领、中断或回执异常；
   - 亦可使用 `lah task show <Task_ID>` 查看当前状态与最新消息。
