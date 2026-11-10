---
name: lah
description: 操作与调度 lark-a2a-hub (lah) 多 Agent 协作中台：查询在册节点与能力名片、派发跨节点异步任务、接收原路返回的结果队列、答复追问、查看任务状态与产物。当用户想要让其他机器/Agent干活、跨终端分发任务、调度中台能力或查询中台任务时使用。
---

# `lah` 多 Agent 协作中台调度指南

`lah`（`lark-a2a-hub`）是以飞书多维表格为共享总线的多 Agent 调度中台。任何入网终端或 Agent 都可以通过 `lah` 派发任务给其他节点，并按「谁发起、回给谁」的原路机制接收执行结果。

---

## 核心原则

1. **原路返回，飞书静默**：
   - 任务发起方（`From_Node`）派出的任务，在执行节点产出结果后，回执消息 `To_Node` 原路指向发起方，由本机的 `lah daemon` 自动写入本地 `~/.hub-node/present_queue.jsonl`；
   - 飞书端不再发送文本消息刷屏，仅在涉及敏感操作时由主枢纽发送交互式审批卡片。
2. **状态八态与生命周期**：
   - `submitted`（已入队）→ `working`（执行中）→ `completed` / `failed` / `canceled` / `rejected`；
   - 中断态 `input-required`（提问待答）：必须在原任务通过 `lah task reply` 答复，目标节点自动续跑，禁止为答复新开任务。
3. **审批拦截**：
   - 若任务涉及关键操作（对外发消息、删改数据、花钱等），会自动转入 `auth-required`。主枢纽会在飞书向机主推送卡片，机主点击批准后自动恢复执行，无需终端干预。

---

## 常用 CLI 命令

### 1. 派发跨节点任务 (`lah task create`)
向指定节点的指定能力派发异步任务：
```bash
lah task create --to <Target_Node> [--worker <Worker>] [--cap/--skill <Skill_ID>] --text "<指令说明>" [--params '<JSON字符串或@文件>']
```
- 默认以本机节点名作为 `From_Node` 与 `Source`；
- 寻址是三层：节点（`--to`）、Worker（`--worker`，节点上的某个 Agent）、技能（`--cap`）。名片一行就是「节点 × Worker × 技能」，Worker 为空表示节点本尊直接执行；
- `--worker` 是硬约束：目标节点没有这个 Worker 或它不会这项技能，建单直接报错。只给 `--worker` 不给 `--cap` 时用该 Worker 的通用技能 `agent`；
- `--worker` 可省略：按技能名派单时由目标节点取默认 Worker；
- `--cap`（或 `--skill`）可省略：系统会自动从目标节点的 `AgentCards` 中挑选首选通用能力（技能 `agent`）；
- 若直接指定已知的 `CAP-...`，甚至可省略 `--to`（自动反查归属节点）；
- 命令成功后输出生成的 `Task_ID`（如 `TASK-20261107-a1b2c3`）。

示例：
```bash
# 让工作机 mba 执行任务（自动挑选 mba 的首选 Agent）
lah task create --to mba --text "检查生产数据库磁盘剩余空间与连接数"

# 指定由 mba 上的 agy 这个 Worker 来做（用它的通用技能 agent）
lah task create --to mba --worker agy --text "检查磁盘剩余空间" --params '{"path":"/"}'

# 指定 Worker 与专长技能（Worker、Skill_ID 都取自 AgentCards）
lah task create --to mba --worker agy --cap ops-check --text "巡检一遍"'
```

### 2. 消费原路返回的结果队列 (`lah present --pop`)
从本机读取并消费属于当前节点发起的任务回执：
```bash
lah present --pop
```
- 如果队列为空，命令无输出并干净退出；
- 如果队列有回执，输出 JSON Lines（NDJSON），每行包含：
  - `task_id`：任务编号
  - `status`：状态（`completed` / `failed` / `rejected` / `input-required`）
  - `title`：任务标题
  - `target_node`：执行节点
  - `message`：节点输出的最新说明
  - `outcome`：执行结果摘要
  - `error`：错误日志（若失败）
  - `text`：中台格式化的易读摘要
- `--pop` 参数表示读取后从队列移除已读项，适合 Agent 轮询消费并直接向用户汇报。

### 3. 答复任务追问 (`lah task reply`)
当 `present_queue` 中收到某任务处于 `input-required` 时，使用原任务答复，促使目标节点原位恢复执行：
```bash
lah task reply --task <Task_ID> --text "<补充的信息或答复>"
```
示例：
```bash
lah task reply --task TASK-20261107-a1b2c3 --text "已确认，允许继续执行数据导出"
```

### 4. 查看任务详情与产物 (`lah task show`)
实时查看任务的当前状态、最后一条消息与关联的产物（Artifacts）：
```bash
lah task show <Task_ID>
```
输出包含：
- 任务标题、状态、目标节点、认领者、重试次数；
- 最新一条消息的正文内容；
- 产物列表（`Artifact_ID`、产物名称与描述）。

### 5. 查看任务全链时间线与排障溯源 (`lah task why`)
当任务执行异常、需要审计或排查来龙去脉时，使用 `lah task why` 将 Tasks 状态、Messages 多轮对话与审批链、Runs 执行台账、Artifacts 产物及本地待补交队列拼装为时间线：
```bash
lah task why <Task_ID> [--json]
```
- 汇总 Tasks 状态、认领节点（`Claimed_By`）、重试次数（`Retry_Count`）、提问/待批消息（`Status_Msg`）、跳数（`Hop_Count`）；
- 按时间顺序梳理多轮 Messages（`instruction`、`question`、`answer`、`auth_request`、`auth_decision`、`result`、`notice`），标注发件方向 `From_Node → To_Node`；
- 正文截断至 200 字符；`DataPart` 结构化参数只展示键名，绝不输出敏感值；
- 聚合 Runs 起止时间与执行结果（`succeeded` / `failed` / `paused`）及 Artifacts 交付物指针；
- 核对本地配置目录下是否存在未完成的 `outbox` 或 `inbox-outbox` 待补交条目；
- 支持 `--json` 输出结构化数据，适合 Agent 程序化解析与排障诊断。

取消尚未终态的任务：`lah task cancel --task <Task_ID> [--text <说明>]`（node 角色只撤本节点发起的单，hub 角色可撤任意单；working 只保证状态终结；终态报错且不写）。

### 6. 独立 Agent 收件箱接单与回执 (`lah inbox`)

当本节点作为独立 Agent（`kind=agent`，如 Muse、本地 Agent 会话或常驻 Agent 容器等具有常驻守护进程或定期交互能力的实体）运行时，中台将任务投递至本尊收件箱。Agent 本尊通过以下命令与中台闭环交互：

> [!NOTE]
> **适用场景界限**：
> - `kind=agent` + `inbox` **仅适用于有常驻守护进程或能定期/在主循环中调用 `lah inbox` 的 Agent**；
> - 没有常驻进程的云端外部 Agent（如 Grok Bot）应通过**协议接入型节点（Receive_Mode=automation）＋飞书自动化 webhook** 接入，**不能走 inbox**。因为飞书自动化 webhook 发送至外部 HTTP 端点，**不会读取本机收件箱，收件箱也绝不会被平台 webhook 唤醒**。

#### 5.1 查看与提取新任务 (`lah inbox`)
```bash
lah inbox --pop [--json]
```
- `--pop`：提取待办任务并将状态标记为 `acked`（已认领接单）；若无新任务则干净退出；
- 输出字段：`task_id`、`from_node`（任务发起方）、`title`、`text`（指令说明）、`params`（结构化参数）、`turns`（历史多轮问答）；
- Agent 本尊拿到指令后在自身环境内执行。

#### 5.2 任务完成并原路交付 (`lah inbox done`)
执行完毕后，提交最终结果并关单，中台将自动原路回传给发起方：
```bash
lah inbox done --task <Task_ID> --text "<执行总结与交付内容>" [--artifact <产物路径或URL>]
```

#### 5.3 任务追问与补充输入 (`lah inbox ask`)
若执行中需要发起方澄清或提供更多参数，发起追问并将任务置入 `input-required`：
```bash
lah inbox ask --task <Task_ID> --text "<需要发起方回答的问题>"
```
发起方通过 `lah task reply` 答复后，中台会自动将该任务连同最新答复重新注入本尊的 `lah inbox`（状态恢复为 `pending`），本尊直接续跑。

#### 5.4 标记任务失败 (`lah inbox fail`)
若任务无法完成或环境异常，终止任务并通知发起方：
```bash
lah inbox fail --task <Task_ID> --text "<失败原因说明>"
```

---

## 独立 Agent 节点的推荐执行工作流

独立 Agent 建议在每轮对话、定时轮询或平台启动 Hook 中执行「双向收割」：
1. **收结果**：运行 `lah present --pop`，看自己之前派给其他节点（如爬虫节点、运维节点）的任务是否有产出；
2. **接新活**：运行 `lah inbox --pop`，看中台是否有其他节点指派给自己的新任务；
3. **处理并交付**：执行完新任务后，运行 `lah inbox done --task <Task_ID> --text "..."`。

---

### 7. 本地定时调度与 Agent 触发 (`lah schedule` / `lah task begin`)

节点本地拥有独立时钟（`schedules.json`）。针对自带 cron 定时器的 Agent（如 Muse、Grok），通过双时钟机制协同：

#### 7.1 查看与配置本机计划 (`lah schedule`)
- 查看计划：`lah schedule ls [--json]`
- 添加计划：`lah schedule add --id <id> --cron "<五段>" --cap <cap_id> --text "<指令>"`
- 删除/启用/停用：`lah schedule rm <id>` / `lah schedule enable <id>` / `lah schedule disable <id>`
- 仅登记观察镜像：`lah schedule register --id <id> --cron "<五段>" --cap <cap_id> [--text "<指令>"]`（Agent 类向 Rules 镜像同步计划展示，不写入本机 schedules.json）

#### 7.2 Agent 定时器到点触发 (`lah task begin`)
当 Agent 自带定时器到点时，调用此命令生成调度任务：
```bash
lah task begin --schedule <id> [--period <期次键>] [--cap <cap_id>] --text "<指令>"
```
- 命令在总线生成 `Status=submitted`、`Source=cron` 的任务，并输出 `Task_ID`；已存在同键任务时直接输出已有 ID，不重复建单；
- 本机 `lah daemon` 自动认领该任务并写入 `agent_inbox.jsonl`；
- Agent 在执行完成后调用 `lah inbox done --task <Task_ID> --text "..."`（或 `ask`/`fail`）完成闭环交付。

---

### 8. 检查节点与总线状态 (`lah doctor`)
查看当前环境、配置凭据、长连接状态以及本节点和全网在册的 Agent 能力：
```bash
lah doctor
```

### 9. 协议节点单次对账与只读盘点
无法长驻 daemon 的外部节点（例如 Grok Bot）收到 webhook 门铃后，或每 15 分钟兜底时，跑一次：
```bash
lah reconcile
```
它会复用内核扫表：认领 `submitted` 任务、续跑 `input-required`、刷新心跳，然后退出，不长驻。`--once` 可写可不写，行为相同。单次对账**不会**把命令表里没有的手工名片写成停派，也**不会**把名片标成 offline，避免下一单被建单侧拒绝。协议节点要 `Receive_Mode=automation`，只能手工登记名片；setup 不会产出 automation。

查看本节点名片与任务是否和本地配置偏离（只读，不写入）：
```bash
lah inventory
```

非交互安装可选唤醒方式：
```bash
lah setup --yes --wake sweep
```
`sweep` 把 `pollSec` 设为不超过 900 秒，名片 `Receive_Mode` 登记为 `poll`。`automation` 不是合法的 `--wake` 值。
