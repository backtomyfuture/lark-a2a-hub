# 多 Agent 中台标准（A2A 数据模型版，形态 B）

> 现行标准，版本 v3.8。来源：A2A（Agent2Agent）协议 v1.0 数据模型
> （Google 牵头、Linux Foundation 托管）＋生产实测经验汇总。
> 表结构见 [Base 结构](base-schema.md)；系统设计见 [架构](architecture.md)。

## 0. 总原则

1. **借 A2A 的数据模型，不借它的通信方式**：不要求每个 Agent 对外开 HTTP 接口互调；飞书多维表格本身就是共用的消息总线，节点出站读写表即完成通信。唤醒方式只有 ws / poll / webhook（专指飞书自动化出站通知）三种，见 §10.3。
2. **三层分离**（v2 的核心修正）：沟通归 Messages、状态与成果归 Tasks/Artifacts、执行细节归 Runs。任何一层不许再兼另一层的职。
3. **只出不进**：节点与 hub 角色只发起出站连接（飞书 API、长连接），不开监听端口、不做端口映射与反向隧道、不暴露所在局域网。本标准中的 webhook 只指出站通知：由飞书多维表格自动化在 Tasks 行写入后向协议接入型节点自有平台托管的端点 POST；本项目任何进程都不开监听端口、也不主动推送（§10.3）。
4. **机主审批红线**：涉及对外发消息、删改数据、花钱、提交表单、改权限的动作，最终只认机主本人在聊天里的亲口确认；表中标记仅作参考（auth-required 流程见 §8.3）。
5. **凭据与敏感原文不入表、不进载荷**；结果回传统一「摘要＋指针」。
6. **hub 是 node 的单进程超集**：枢纽（hub）是一组逻辑职责，也是普通执行节点（node）的超集——单进程、单配置目录即可同时承载，无需再拆两个进程。由 `lah daemon --role node|hub`（兼容 `hub-node`）承载；省略 `--role` 时读该配置目录 `node.json` 的 `role`，缺省 node。`role=hub` 既像普通节点一样读取 `commands.json`、登记 `AgentCards`、认领并执行指派给自己的任务（含定时任务），又强制开启长连接（`ws`）并额外承担全网 `auth-required` 审批发卡与 `card.action.trigger` 回调处理、结果呈递、以及 `stale` 超时告警。凡本标准归给枢纽的约束，由承担 hub 角色的一方遵守（§10.1）。
7. **发起方身份与回执原路返回**：任何节点或 Agent 都可以作为任务入口。`lah task create` 默认以发起节点作为首条 `instruction` 消息的 `From_Node` 与 `Tasks.Source`。执行节点写回执消息（`result`、`question`、`notice` 等）时，`To_Node` 原路指向该任务首条 `instruction` 消息的 `From_Node`（回退 `Source` || `"hub"`）；唯独 `auth_request` 的 `To_Node` 固定为 `"hub"`（统一由主节点发飞书审批卡）。结果呈递按「谁发起、回给谁」原则落入发起节点的本地 `present_queue.jsonl`，飞书端只发审批卡，不再刷屏纯文本（§8.5）。

8. **三层寻址：Node / Worker / Skill**（v3.7）：Node 是工作节点（一台机器上的一个守护进程，管网络位置、凭据、认领租约与心跳）；Worker 是节点上的执行者（一个 Agent CLI，管启动模板、续接命令、执行语境与无头权限）；Skill 是这个 Worker 能做的一类任务（管名称、说明、副作用等级与审批下限）。任务行用 `Target_Node` / `Worker_Hint` / `Skill_ID` 三列寻址，名片一行是 Node × Worker × Skill。Worker 留空表示由节点本尊直接执行：脚本类能力由守护进程直接拉起，独立 Agent 节点（§10.4）的本尊即 Worker。三层的名字都只是本机 `commands.json` 白名单里的选择键，不携带命令内容（§9）。v3.8：名册里每个 Worker 有且只有一张 **Worker 名片**（`Skill_ID=agent` 的那一行），代表该 Worker 在册及其通用执行，不是一项技能；Worker 的专长技能各占一行，挂在它的名片下。

## 1. 对象总览（七表，形态 B：A2A 主干＋本地扩展列）

字段分两类：**A2A 原生**字段按协议原义使用；**本地扩展**字段是共享总线运营所必需、A2A 点对点模型不建模的部分（寻址、认领租约、熔断、幂等、呈递），在各表规范中以（扩展）标明。除此之外的本地需求一律进原生 Metadata 字段，不再新增列。

| 表 | 对应 A2A 对象 | 职责 |
|---|---|---|
| Tasks | Task | 一件工作的信封与状态机：一行一任务 |
| Messages | Message（挂在 Task.history 上） | 任务内全部对话轮次：只追加，一行一消息（正文在 Parts） |
| Parts（v3 新增） | Part | 消息与产物的内容块：一行一块，text/file/data 三型 |
| Runs | （A2A 不建模，本地表） | 每次执行的起止、结果、报错 |
| Artifacts | Artifact | 交付物登记：内容为其 FilePart，修订＝同名新 ID |
| AgentCards（原 Nodes_能力注册） | AgentCard（规范化展开） | 一行是一张 Worker 名片或一项技能：节点、技能、名片元数据、接收方式 |
| Rules_路由规则 | （本地表） | 路由与审批策略的唯一现行来源，派活前先查 |

## 2. Tasks 规范

字段（在 v1 基础上变更的标 ★）：

- Task_ID：业务编号，唯一，人可读；发起方生成后不变。
- ★ Context_ID：会话键，**取代 Session_Handle**。同一件事的全部任务共享一个 Context_ID；任务内对话靠 Task_ID 定位，Context_ID 负责把「同一件事」的多个任务串起来。
- Status：状态机见下。
- ★ Status_Msg（扩展）：当前状态附带的消息指针（进入 input-required / auth-required 时，指向提问/待批的那条 Messages 的 Msg_ID）——A2A 中为 TaskStatus 内嵌 message，表形态以指针等价实现。
- ★ Metadata：A2A 原生自由字段（JSON）；非核心本地信息放这里，不再新增列。
- **任务参数不在 Tasks 上**（v3 删除 Payload）：初始指令与参数写首条 instruction 消息，其 DataPart（Kind=data）承载参数 JSON（A2A 原生形态）。
- （扩展）Target_Node / Worker_Hint / Skill_ID / Title / Source / Approval_Class / Hop_Count / Idempotency_Key / Claimed_By / Heartbeat_At / Retry_Count / Latest_Run / Presented：总线运营字段，定义沿用 v1/v2（守护进程与呈递管线维护其中一部分）。Worktree 已于 v3.5 删除（执行环境私事不入总线）；Presented 为过渡遗留，代码切换为只读 Tasks.Metadata 的呈递键后删除（见 §10.2）。
- ★ Worker_Hint（扩展，v3.7 定义语义，文本）：指定由目标节点上的哪个 Worker 执行。**写了就是硬约束**：目标节点没有登记「该 Worker × 该 Skill」这项能力时，任务置 rejected＋notice，不换别的 Worker 代跑（失败要响）。留空表示由节点取默认：该 Skill 有节点本尊直接执行的条目时用它，否则取本机 `commands.json` 里第一个登记了该 Skill 的 Worker。节点认领时把实际选中的 Worker 回填到本列，此后的失败重试、心跳回收重跑与问答续跑都钉在同一个 Worker 上；节点本尊直接执行时保持留空。列名沿用 Worker_Hint，语义以本条为准。
- 任务派生关联写 Messages.Ref_Task_IDs（v3 起 Tasks 侧删除该列，见 §3）。

### 状态机（A2A 八态）

`submitted → working → (completed | failed | canceled | rejected)`，中断态 `input-required` 可与 working 多次往返；`auth-required` 由 submitted 直接进入（不经认领），批准后回 submitted 重新认领（§8.3）。

| 状态 | 含义 | 进入条件 |
|---|---|---|
| submitted | 已建单未认领 | 建单初始态（代 v1 Pending） |
| working | 执行中 | 认领后（代 v1 Running） |
| input-required | 等发起方/机主补信息或答复 | 执行方在 Messages 写了 question 后置此态（代 v1 Blocked 的提问用法） |
| auth-required | 等机主批准 | 生效审批级别为 approve 的任务在认领前由 submitted 置此态（§8.3；代 v1 Blocked 的审批用法与 Review） |
| completed | 完成 | 成果已登记 Artifacts 或在 result 消息中给出（代 v1 Done） |
| failed | 执行失败且不再重试 | （代 v1 Failed） |
| canceled | 发起方取消 | 只由发起方显式执行 `lah task cancel`（仅自己发起的单）或 hub 角色写入。守护进程的 node 角色代码路径不写（§10.1；代 v1 Cancelled；拼写从 A2A 用单 l） |
| rejected | 目标节点拒收（无能力/不合规） | 拒收须在 Messages 写 notice 说明原因 |

规则：
- **终态（completed/failed/canceled/rejected）不可变、不可重启**。终态后要继续做：同 Context_ID 新开任务，新任务首条消息的 Ref_Task_IDs 指回前任（A2A refinement 模式）。
- **中断态不是结束**：答复走 Messages 追加（§8.1），任务回 working，禁止为答一个问题新开任务。
- 状态变更必须与消息配套：进 input-required 必有 question 消息；进 auth-required 必有 auth_request 消息；进终态必有 result/notice 消息或 Artifact 登记。

## 3. Messages 规范（v2 新增表）

一行一条消息，只追加、永不修改删除。字段：

- Msg_ID：主键，发送方生成，全局唯一，**同时是幂等键**（重复投递靠它去重）。
- Task_ID：所属任务（必填）。
- Context_ID：冗余会话键，便于按会话整串读取。
- From_Node / To_Node：发送方与接收方节点名（To_Node 可为机主 hub 的逻辑名 `hub`，或广播 `all`——广播仅限 notice）。
- Role：`user`（发起方→执行方）/ `agent`（执行方→发起方），沿 A2A 两值语义。
- Kind：消息类型枚举：
  - `instruction` 指令/补充要求（user）
  - `question` 提问、请求补信息（agent）——发出后任务置 input-required
  - `answer` 答复（user）——任务回 working
  - `auth_request` 待批说明（agent）——发出后任务置 auth-required
  - `auth_decision` 批准/驳回的落表记录（hub）——批准后任务回 submitted/working（见 §8.3）
  - `progress` 进展通报（agent，不改状态）
  - `result` 结果交付（agent，配合 Artifacts 指针，随后任务置 completed）
  - `notice` 告知/拒收说明（双向）
- 正文不在 Messages 上（v3 删除 Content / Content_Type）：一条消息的内容＝其 Parts 行集合（见本节 Parts 规范）。读消息＝按 Parent_ID 取 Parts 按 Seq 拼接。
- Ref_Task_IDs：A2A 原生 referenceTaskIds——本消息关联/派生的前任 Task_ID 列表（refinement 在消息级表达）。
- Metadata：A2A 原生自由字段（JSON）。
- Artifact_Ref（扩展）：关联的 Artifact_ID（可空）。
- In_Reply_To（扩展）：所回复的 Msg_ID（可空），构成对话链。
- Created_At：发送时间。

### Parts 规范（v3 新增表）

一行一个内容块，消息与产物共用：

- Part_ID：`父ID-P序号`。
- Parent_ID / Parent_Type：所属消息 Msg_ID 或产物 Artifact_ID；类型 `message` / `artifact`。
- Seq：块顺序，从 1 递增。
- Kind：`text` / `file` / `data`（A2A TextPart / FilePart / DataPart）。
- Text：text 块正文（长内容只放指针，本体进飞书文档）。
- File_URI / File_Name / Mime_Type：file 块三要素。
- Data：data 块的 JSON（任务参数、审批决定 {"decision": "approve"} 等结构化内容走这里）。
- Metadata：块级自由字段。

唤醒语义：消息即唤醒信号。各节点按自己的接收方式（§10.3）消费「To_Node=本节点且未读」的消息：守护进程型节点由 ws 长连接事件或 poll 轮询唤醒；协议接入型节点由 webhook 通知唤醒（飞书多维表格自动化在 Tasks 行写入后 POST 其端点，只带 ID）；hub 角色强制以 ws 长连接唤醒（审批卡回调只能经长连接送达），并保留低频对账兜底，同时驱动呈递与审批。三种方式都保留低频对账兜底。节点本地保存已读水位（last-seen Msg_ID），表侧不设已读标记，避免多方写冲突。

## 4. Runs 规范（瘦身）

只记执行台账，**不再承担回执与回复正文**：

- Run_ID / Task_Ref / Node / Started_At / Finished_At：沿用。
- ★ Worker（v3.7 定义语义）：本次执行实际使用的 Worker 名，取认领时回填后的 Tasks.Worker_Hint；节点本尊直接执行（脚本、inbox）记 `daemon`。
- ★ Outcome：`succeeded` / `failed` / `paused`（paused＝本次执行段因等补信息而暂停，配合 input-required，不计失败）。
- Error_Log：失败信息。
- ~~Receipt~~：**删除**。resolve/ask/notice/later 的沟通语义由 Tasks 状态＋Messages 承担；执行方要说话，去 Messages 写。
- ~~Summary~~：**删除**。执行内部备注如需保留，写 Run 的 Error_Log 或本机日志，不进中台。
- **用量不在本表**。Runs 没有 Metadata，也不为此加列。执行者可选上报的用量累加在 Tasks.Metadata 的 `usage` 键（§9）；没上报就是没上报，节点不估算。
- 重试沿用 v1：执行失败且 Retry_Count<2 回 submitted 重认领；心跳超时回收与执行失败共用同一 Retry_Count 预算（§8.4）。
- **节点私有重试水位（不是协议字段）**：执行失败或心跳超时回收、且未达重试上限、即将回到 submitted 时，执行节点先在本机配置目录写入 `retry_state.json`（权限 0600，仅本节点可读）。文件按 Task_ID 记录 `not_before`：从 60 秒起按 2 的幂增加，上限 10 分钟。本节点在 `not_before` 之前不认领该任务，也不增加 Retry_Count。水位不进总线、不加 Tasks 列、不写 Metadata。文件缺失或损坏时按没有水位处理，只记日志，守护进程不因此退出。任务成功、进入终态或已达重试上限时删掉对应条目。回执无效仍直接 failed，不写这条水位，也不重试。
- **执行与提交分开算**：计入重试的「执行失败」只指执行本身失败（命令非零退出、超时）。以下情况不计入重试、不重新执行、不重做副作用：
  - 回执无效（无法按 §9 回执约定解析）：直接 Status=failed＋notice 说明原因（附原始输出摘要），Runs 记 failed；
  - 提交失败（向总线登记产物、写 Runs、写消息或改状态中途失败）：只补齐未完成的提交，已写入的行按其 ID 查重、不重复追加；补齐完成后按原回执进入应有状态；
  - 独立 Agent 宣告失败（`lah inbox fail`，见 §10.4）：由 Agent 本尊明确做出无法完成的判断，直接 Status=failed＋notice，Runs 记 failed，不重试、不回 submitted。
- **在途执行账本与单并发（不是协议字段；只覆盖 `context=direct` 的 json/agent 命令）**：carrier 语境与 inbox 模式不在此列，仍按各自现行路径执行（carrier 同步代跑、inbox 只入队）。direct 命令在 spawn 之前把账本写到执行节点配置目录 `runs/<Task_ID>/entry.json`（权限 0600，先写临时文件再改名）。账本只记任务号、尝试次数（当时的 Retry_Count）、状态（`launching` / `running` / `exited`）、pid / 进程组、启动时间、超时秒数、stdout / stderr / 退出码文件路径，以及用于辨别 pid 复用的进程启动时间戳；取不到启动时间戳就记 null。账本不进总线、不加列、不写 Metadata，也不放凭据或指令正文。子进程的标准输出与标准错误写入该目录下的文件，由一层包装在进程结束时把退出码原子写入退出码文件，避免守护进程消失后管道断裂把子进程打死。读取输出时仍只保留头部 64KiB 与尾部 1MiB。超时从账本里的启动时间接着算，到点由守护进程向该进程组先发 SIGTERM，宽限后再 SIGKILL，不因守护重启把超时重新算满。
  - 同一节点同一时刻只跑一条 direct 命令。已有在途命令时，本轮不再认领新任务；inbox 心跳、续跑检查和 hub 的审批、呈递、陈旧回收、定时建单照常进行。命令的结果（outbox、Artifacts、Runs、Messages/Parts、Tasks 状态）只在扫表的收口阶段串行写入。
  - 重启或下一轮扫表时，对本节点 `Claimed_By` 且仍为 working 的任务：账本在且进程组仍存活，只续 `Heartbeat_At`，不第二次 spawn，不加 Retry_Count，结束后按 §9 解析回执并提交；账本在、进程已结束且退出码文件在，直接读输出提交，不重跑；账本在、进程已确认死亡且没有退出码文件，按执行失败处理（计入 Retry_Count 与重试水位，达上限则 failed＋notice），不得当成成功；无法确认进程组是否已死时，不得认定死亡后重跑，保持 working 并继续续心跳，直到按账本启动时间走到超时，由超时机制收口；没有账本的旧 working 任务仍按 §8.4 心跳回收。有存活在途账本的任务，心跳回收不得把它送回 submitted。成功落总线之后删掉该任务账本目录里的输出文件，`input.json` 仍按 §9 保留。
  - **局限**：pid 在进程退出后可能被系统复用。账本用进程启动时间戳区分；对不上就不当作仍在跑的那一次，也不向复用后的新进程发信号。启动时间戳取不到（记 null）时无法做这层区分，宁可继续当作在途并等到超时，也不在无法确认时重跑。超时信号仍发往账本记录的进程组；若该组号已被无关进程占用，存在误伤可能，此情况下不得改成重跑。

## 5. Artifacts 规范（v2 新增表）

- Artifact_ID：任务内唯一即可，全局建议 `任务ID-A序号`。
- Task_ID / Context_ID：归属。
- Name：产物名。**同名再交付即新版本**（沿 A2A：修订=新 artifactId、同 name，版本谱系由登记顺序表达；v3 已删除 Version 列）。
- Description：产物一句话说明（A2A 原生）。
- Metadata：A2A 原生自由字段（JSON）。
- 内容不在本表（v3 删除 Type / Pointer）：产物的内容＝其 FilePart（Parent_Type=artifact，File_URI 放链接或路径、File_Name 放名称；大文件只放指针，不入库本体）。
- Is_Final（扩展）：是否终稿（Yes/No）。
- Created_By / Created_At（扩展）：登记方与时间。

## 6. AgentCards 规范（原 Nodes 表，v3 更名）

沿用「一行一项能力」的规范化结构（等价于把 AgentCard 的 skills[] 拆成行）。v3.7 起一行是 **Node × Worker × Skill**：一份 A2A 名片对应「某节点上的某个 Worker」，它的 skills[] 拆成多行；Worker 留空的行是节点本尊直接提供的能力。A2A 原生字段：

- Node（卡片 name 的节点部分）/ Node_Desc（卡片 description）/ Daemon_Version（卡片 version）。
- Skill_ID（skill.id）/ Skill_Name（skill.name）/ Description（skill.description，v3 由 Capability 改名）/ Input_Modes / Output_Modes（skill 级元数据）。
- Default_Input_Modes / Default_Output_Modes（卡片级默认模式）。
- Cap_Streaming / Cap_Push / Cap_State_History（卡片 capabilities 三开关；Cap_Push＝支持推送通知，相当于声明有 PushNotification 通道）。
- Metadata：A2A 原生自由字段（文本，JSON 字符串）。内核登记名片时写入 `kind` 与 `mode`（节点类型与执行模式，见 §10.4 与 §9），供建单侧识别该能力；协议节点手工登记的名片，以及尚未填写的旧名片，可以留空。
- **v3.5 收拢方向**：Tags / Examples / Required_Assets 已删（无消费者）；Input_Modes / Output_Modes / Default_Input_Modes / Default_Output_Modes / Cap_Streaming / Cap_Push / Cap_State_History 与本地扩展 Zone、Skill_Name 将收拢进 Metadata 的 `a2a` 子对象（一份 A2A 名片本就是一个 JSON 文档，Modes 与 capabilities 是它的原生组成部分，不另占列）；代码先行改写为写 JSON，列在观察一个登记周期后删除。Side_Effect 与审批下限相关，保留独立列与选项约束。

本地扩展字段：Cap_ID（行主键）、Worker（v3.7 新增列，文本；该能力由哪个 Worker 执行，留空＝节点本尊。它与 Node、Skill_ID 同为路由键，所以单独占列而不进 Metadata）、Zone、Side_Effect、Availability、Dispatchable、Receive_Mode（唤醒方式，与 §10.3 三种传输方式对应：`event`＝ws 长连接事件 / `poll` 轮询 / `automation`＝webhook 通知（飞书自动化 POST）。`automation` 只用于协议接入型节点，其端点由对方平台托管；守护进程型节点只取 `event` 或 `poll`，本标准的实现不开监听端口。表中另有遗留选项 `webhook`，不再赋予含义，登记一律用 `automation`）。

Cap_ID 推导口径（守护进程登记时）：节点本尊的能力为条目显式 `cap_id`，否则 `CAP-<capPrefix>-<Skill_ID>`；Worker 的能力固定为 `CAP-<capPrefix>-<Worker>-<Skill_ID>`，不接受显式 `cap_id`。同一节点内 Cap_ID 不得重复，重复时后一项不登记并记日志，`lah doctor` 同时报出。

路由规则不变：只接自己登记且 Dispatchable=Yes 的能力（v3.7 起按 Worker × Skill 匹配）；表外任务置 rejected＋notice 说明缺口。

### Worker 名片与名册口径（v3.8）

**判定规则**（只读 `Node`、`Worker`、`Skill_ID` 三列，不读 Metadata；v3.7 写出的行同样适用）：

1. `Skill_ID = agent` 且 `Worker` 非空：这是 Worker `<Worker>` 的名片。
2. `Skill_ID = agent` 且 `Worker` 为空：这是节点本尊的 Worker 名片，即「本尊即 Worker」（独立 Agent 节点，§10.4）。展示名取 `Node`，`Skill_Name` 不是 `agent` 时可作副标题。host 节点上本尊执行的 `agent` 条目也按此判定，`lah doctor` 会提示迁到 `workers`。
3. `Skill_ID ≠ agent` 且 `Worker = W`：这是 W 的专长技能，挂在同一 `Node` 下 `Worker=W, Skill_ID=agent` 的名片之下。守护进程保证这张名片存在（Cap_ID 重复导致名片未登记的情形除外，此时 `lah doctor` 会把 Cap_ID 重复报为问题）。
4. `Skill_ID ≠ agent` 且 `Worker` 为空：这是节点本尊技能（确定性脚本等）。它不是 Worker，不得画成 Worker。

分组键是 `(Node, Worker)`。`Dispatchable=No` 的行按停派展示还是隐藏，由展示方决定。

**名称来源**：

- Worker 名片的 `Skill_Name` / `Description` 取 Worker 条目的 `name` / `desc`；显式写了 `agent` 技能条目且带了这两项的，以条目为准。`Skill_Name` 缺省为 Worker 名。
- 本尊 Worker 名片的 `Skill_Name` 取条目的 `name`，缺省 `agent`；`Description` 缺省为「<节点> 独立 Agent 本尊」。
- 专长技能行只取技能条目的 `name` / `desc`，不借 Worker 的。

**名片同时是地址**：

- Worker 名片的 Cap_ID 是 `CAP-<capPrefix>-<W>-agent`。用 `Skill_ID=agent` 加 `Worker_Hint=W` 寻址它的通用执行。
- 本地计划、later 复查、`lah task create` 的 `--worker` 校验和自动挑选，都引用这张名片，所以守护进程不得省略它。
- **`Worker` 列是路由键**：内核用它拼能力键，建单时它会被写进 `Worker_Hint`。只能填本机 `commands.json` 里 `workers` 下的名字，不得写展示名或别名。独立 Agent 节点想要展示名，就写它 `agent` 条目的 `name`。

**不加 Metadata 标记的理由**：判定所需的信息已经在路由键三列里；再加标记就多了一个可能和路由键不一致的事实来源，v3.7 节点也不会写它，展示方无论如何都要实现按列判定。

`Skill_ID` 值 `agent` 保留给 Worker 名片。

## 7. Rules 规范

沿用 v1：Rule_ID、Match_Type、Skill_ID、Target_Node、Worker_Hint、Approval_Class、Priority、Enabled、Note。路由按 Skill_ID＋tags 匹配能力行（v2 起 Skill_ID 视为技能 id，与 Nodes.Skill_ID 对齐）。规则变更只改表。

**定时调度（v3.6 节点本地调度与 Rules 观察镜像）**：定时调度下沉至节点本地驱动（时钟不再由 hub 独占）；Rules 表中的调度列降级为各节点单向写入的只读观察镜像，供全网总览页查看。

- **双时钟来源**：
  1. 终端类节点（`kind: host` 与 hub 所在机）：由 `lah daemon` 内置的分钟定时器驱动，读取配置目录下的 `schedules.json`（权限 0600，不进仓库、不进总线）；
  2. Agent 类节点（`kind: agent`，如 Muse、Grok 等自带 cron 定时器的独立 Agent）：由 Agent 自身时钟到点调用 `lah task begin` 触发。
- **本地计划定义（`schedules.json`）**：结构为 `{"schedules": [{id, enabled, cron, cap, text, approval_class?}]}`。
  - 文件缺失视为无计划；文件损坏则本地调度整体停用并记日志（§10.5），守护进程不退出；
  - 单条计划缺少必填字段、cron 不可解析、或 `cap` 在本机 `commands.json` 中不存在时，仅停用该条并记日志；
  - 计划定义中出现 `command` / `cwd` / `context` / `agent` / `mode` 等执行控制键时，整条拒收。
- **时区与期次键**：按节点本地 `node.json` 的 `tz`（IANA 时区名，缺省 `Asia/Shanghai`）墙钟计算期次，与宿主机时区及系统 `TZ` 环境变量无关。非法 `tz` 记日志并停用本地调度，不回退宿主机时区。期次键格式沿用带时区偏移的分钟级文本：`YYYY-MM-DDThh:mm:ss±HHMM`（如 `2026-11-09T08:50:00+0800`，偏移不带冒号）。期次搜索窗口 8 天。
- **状态与基线（`schedule_local_state.json`，权限 0600）**：记录每条计划的 `{cron, last_fired, last_task}` 及 `mirrored_ids`。**基线优先于补期**：新建计划、修改 `cron` 表达式、状态文件缺失或损坏时，首次扫描仅将水位线锚定在最近一期，不建单；从下一期起才触发。状态文件写失败本轮不建单。
- **触发与补期语义**：已有基线且 `last_fired` 不等于最近一期期次键时触发；停机或错过多期时只补最近一期。节点关机或睡眠期间未执行的期次不做代偿。
- **建单与认领流转（严禁直写 working）**：
  - 到点建单走标准建单写序（首条 instruction 消息 → Parts → Tasks 行），`Status=submitted`，`Source=cron`，`From_Node`＝`Target_Node`＝本节点；
  - `Approval_Class` 取计划配置与本机 `commands.json` 对应能力的 `approval_class` 下限中更严者（只收紧不放宽）；
  - 建单成功后立即置本进程唤醒标志（`_wakeFlag = true`），由本节点现有认领链路接管并流转到 `working`（若生效审批级别为 `approve` 则认领前由节点置 `auth-required`）。严禁跳过 submitted 直写 `working`，以保证在途执行账本、心跳、单并发管控、重试退避与机主审批红线完整生效；
  - 多节点配置相同 Schedule_ID 时，各自独立建单并独立执行一份；
  - 已知限制：本地定时任务的发起方是本节点，执行中提问（`input-required`）的 `question` 原路回给本节点，须由本机 Agent 经 `lah task reply` 答复；§10.1 第 6 条的陈旧告警不覆盖 `input-required`，无人值守的计划应选择不会提问的能力。
- **幂等与防重**：幂等键格式为 `sched:<Node_ID>:<Schedule_ID>:<期次键>`。触发建单前先按幂等键查验总线 Tasks 表，已有同键任务则只补写本地状态水位线、不重复建单（双保险防重）。
- **Agent 类自带时钟与 `lah task begin`**：Agent 定时器到点调用 `lah task begin --schedule <id> [--period <期次键>] [--cap <cap>] --text <指令>`。默认 `--cap agent`、`--from`＝`--to`＝本节点、`Source=cron`，生成同格式幂等键建单为 `submitted`，由本节点守护进程认领进入收件箱（`agent_inbox.jsonl`），Agent 处理完后调用 `lah inbox done|ask|fail` 交付结果。同键重复调用输出已有 Task_ID，不重复建单。
- **Rules 观察镜像**：Rules 表中的 `Schedule`、`Text`、`Last_Fired` 等列降级为「节点单向写入的只读观察镜像」，仅供全网总览页展示：
  - 节点将本机每条计划镜像为 Rules 一行：`Rule_ID` 固定为 `<Node_ID>:<Schedule_ID>`；`Target_Node` 为本节点；`Skill_ID` 为 cap；`Schedule` 为 cron；`Text` 为指令；`Enabled`（Yes/No）反映本机计划启用状态；`Last_Fired` 记录最近期次键；`Note` 记录上次运行任务与状态及「同步于 <时间戳>」；
  - 节点严格只写属于自己的镜像行（`Rule_ID` 以 `<本节点>:` 开头），不读也不改其他节点的镜像行；
  - **任何节点不从 Rules 读计划来触发**；在飞书多维表格 Base 里手动修改 Rules 的任何字段，绝不影响各节点本地计划的实际执行；
  - 独立 Agent 类节点可通过 `lah schedule register` 登记镜像行（仅写 Rules 镜像，不写入本机 schedules.json，不触发任务）；
  - 同步时机：守护启动、计划变更、触发建单、上次任务收口终态，以及每 15 分钟对账周期刷新一次「同步于」。若 Base 缺少 `tables.rules` 映射，跳过镜像并记日志，不影响调度。

## 8. 通信协议（标准往返）

### 8.1 一件多轮任务的标准时序

1. 发起方建单：Tasks 一行（submitted、Context_ID 新生成或沿用）＋Messages 一条 instruction（任务参数放该消息的 DataPart）。
2. 目标节点认领：Status=submitted→working，写 Claimed_By/心跳；Runs 开一行。
3. 执行中要补信息：Messages 写 question → Status=input-required（Status_Msg 指向该消息）。**到此执行方停手，不算失败。**
4. 发起方/机主答复：Messages 追加 answer（In_Reply_To=question 的 Msg_ID）→ Status 回 working，执行方续跑。**不许新开任务答问题。**
5. 交付：产物登记 Artifacts → Messages 写 result（Artifact_Ref 指向产物）→ Status=completed，Runs 关行（Outcome=succeeded）。这一串提交中途失败的，只补齐缺失的部分，不重新执行（§4）。
6. 失败（仅指执行本身失败，§4）：Runs 关行（Outcome=failed＋Error_Log）；未达重试上限回 submitted 重认领，达上限 Status=failed＋Messages 写 notice 说明。

### 8.2 派生与熔断

- 子任务 Hop_Count＝父任务＋1；**Hop_Count>8 熔断**（全局统一口径；各节点原有更严口径的归并须经其操作者确认后生效）。
- 派生任务共享 Context_ID，来源以首条 instruction 消息的 Ref_Task_IDs 注明（v3 起写消息级）。未显式给出 `--context` 时，单个父任务默认继承该父任务的 Context_ID；多个父任务的 Context_ID 一致时继承该值，不一致时建单入口在第一笔写之前拒绝，并要求显式 `--context`。显式 `--context` 以调用方给出的值为准。

### 8.3 审批（auth-required）

- **生效审批级别**＝任务行 Approval_Class 与节点本地下限中更严格者（auto < notify < approve）。节点可在本机 commands.json 的能力条目用 `approval_class` 声明下限；v3.7 起 Worker 条目与 Skill 条目都可以声明，本地下限取二者中更严者（不同 Worker 的无头权限差别很大，Worker 的下限不能被 Skill 放松）；本地下限只收紧、不放宽，任务行未标或标得更松时按下限办。本地下限只存在于执行节点本机，hub 角色看不见，仍只在该节点认领时触发，不能由 hub 提前代写。
- **行级 approve 的提前审批**：任务行 `Approval_Class=approve`（只看行级，不含本机 `approval_class`）时，hub 角色在任务仍为 submitted、且 Claimed_By 为空时就写 auth_request、把 Status 置为 auth-required（Status_Msg 指向该消息）并向机主发卡，不等目标节点认领。auth_request 的 To_Node 仍为 `hub`；From_Node 与执行节点自己写时一致，即目标节点名（节点写出的消息 From_Node 是本节点名，不是 hub 的节点名）。写之前必须回读任务行，确认仍是 submitted 且 Claimed_By 为空。若消息已经写下、但任务在改状态前已被认领为 working，不得把 working 改回 auth-required。同一任务全程只有一条 auth_request；hub 重启或多轮扫描不得再写一条，也不得再发一张卡。节点日后认领时按这条既有 auth_request 收敛：已有满足下文四条的 approve 决定则直接执行；尚无决定则保持 auth-required，不另写 auth_request、不另发卡。驳回由 hub 置 canceled，节点不会认领。
- 生效审批级别为 approve、但还没有 auth_request 的任务（只有本机 `approval_class` 收紧到 approve，或 hub 尚未扫到该行）：执行方在认领前（任务仍为 submitted）先 Messages 写 auth_request → Status 由 submitted 置 auth-required（Status_Msg 指向该 auth_request），停手；不经 working。已有 auth_request 时执行方不重复写：已有 approve 决定则继续执行，尚无决定则停在 auth-required。
- 枢纽（hub 角色，§10.1）呈递审批卡给机主；机主点击（或在聊天里亲口确认）后，枢纽写 auth_decision 消息（决定值放其 DataPart：{"decision": "approve"} 或 {"decision": "reject"}，In_Reply_To 指向所批的 auth_request）；批准则把 Status 置回 submitted，且保留 Status_Msg 不清，供节点认领时核对（v3 起只认 auth_decision 消息，Payload 注入做法已废止）。
- **回调鉴权**：枢纽处理审批回调时必须校验操作者是机主本人；非机主的操作不写 auth_decision、不改任务状态。卡片只发给机主不能代替这一校验。auth_decision 与随之而来的 submitted / canceled 流转只由 hub 角色的代码路径写，node 角色从不写（§10.1）。
- **有效决定**：节点续跑前、枢纽流转状态前都只认同时满足下列条件的 auth_decision：
  1. From_Node=hub、Role=user；
  2. In_Reply_To 等于任务当前 Status_Msg（指向旧 auth_request 的决定一律作废）；
  3. 决定值只读其 DataPart 的 decision，TextPart 文字与任务行上的任何标记都不作数；
  4. 同一 auth_request 下有多条有效决定时，以最新一条为准；
  5. （v3.7）节点在本机 `node.json` 配了 `hubPublicKey` 时，决定的 DataPart 还必须带对得上的签名：`{"decision": "approve", "alg": "ed25519", "sig": "<base64>"}`，签名内容为 `lah-auth-decision-v1`、Task_ID、所批 auth_request 的 Msg_ID、decision 四行文本。签名缺失或对不上的决定当作不存在（不参与「最新一条」的比较），节点记日志并停在 auth-required。
- **为什么要签名**：前四条校验的都是行上自报的字段。总线不认证写入者，任何能写 Messages 的身份（包括被提示注入后读到本机凭据的 Agent）都能写出一行 From_Node=hub 的决定。hub 的签名私钥只在 hub 的配置目录（`approval_key.pem`，权限 0600），不进总线；hub 角色写 auth_decision 时一律签名，自己认领任务时也按同一把公钥验签。公钥由操作者带外放进各节点的 `node.json`，不从总线读取（从总线读公钥等于让冒写者自己发钥匙）。节点没配 `hubPublicKey` 时只做前四条校验，`lah doctor` 会提示这一点。
- **签名管不到的地方**：hub 那台机器上的 Agent 与 hub 守护进程同一系统用户时读得到私钥；任务行的 `Approval_Class` 本身也在总线上，能写总线者可以把它改松。真正改不动的边界是执行节点本机 `commands.json` 里的 `approval_class` 下限，高风险能力应在本机声明 `approve`，不要只靠任务行。
- **各节点的自有红线优先于表中标记**：如某些协议接入型节点对高风险动作只认操作者在其自有渠道里的亲口确认——中台把「派给该节点的 approve 类任务天然带其二次确认」当作已知行为，不视为流程冲突。
- **驳回与拒收**：审批驳回（任务被认领执行之前）由 hub 写明驳回的 auth_decision，并把 Status 置为 canceled。`rejected` 仅用于节点侧拒收（能力不存在、幂等重复、配置取值非法等），不用于审批驳回。

### 8.4 幂等与并发

- 建单靠 Idempotency_Key、消息靠 Msg_ID、认领靠 Claimed_By＋心跳回收（20 分钟无心跳视为放弃）——沿 v1。
- **Idempotency_Key 语义**：同一 Idempotency_Key 在状态非 failed/canceled 的任务中只执行一次。节点认领前查重：已有同键任务处于其他任一状态（含进行中、中断态、completed、rejected）的，新任务置 rejected＋notice，notice 写明原任务的 Task_ID 并以 Ref_Task_IDs 指向它；同键任务全部为 failed/canceled 时可以执行。Idempotency_Key 为空的任务不查重。同键多单的执行者以先被目标守护进程处理到的那一单为准，不保证与建单顺序一致。客户端用同一 Idempotency_Key 重试必须保证指令文本一致；同键不同文本视为客户端错误，执行结果不作保证。
- **心跳回收计入重试**：working 任务超过 20 分钟无心跳即回收，每回收一次 Retry_Count 加一，与执行失败共用 §4 的重试上限；未达上限回 submitted 重认领，已达上限则 Status=failed＋Messages 写 notice 说明（Runs 记 failed），不再回收为 submitted。本节点 direct 在途账本仍可能对应活进程（进程组还在，或无法确认已死）时，不得按本条送回 submitted，只续心跳，规则见 §4。
- 同表写接口不支持并发：一切写操作串行＋退避重试；Messages 只追加不修改，天然避开大半写冲突。

### 8.5 通知与呈递

**附则（automation 唤醒型节点，2026-11-04 P3 实测补充）**：某些 automation 型节点目前只有「Tasks 表新增记录」才能唤醒，Messages 新增唤不醒它。在 Messages 表自动化（新增记录→调其 webhook）就绪前，枢纽给这类节点的 answer 采取双写：Messages 写正文，另建一条轻量 Tasks 信号行（新任务形态、标题注明「答复信号」并指向 Msg_ID 与原 Task_ID）仅作唤醒，信号行不承载内容、接收方勿当新任务执行。自动化就绪后本附则自动失效。

- 通知只报「哪个任务、什么新状态、哪条新消息」，内容由接收方回表拉全量（沿 A2A Push 语义）。
- **结果呈递原路落盘唤醒 Agent，飞书端只发审批卡**：
  - 飞书端只由 `role=hub` 发送 `auth-required` 交互式审批卡（以及可选的 `stale` 告警），不再往飞书发送大段纯文本结果刷屏。
  - 结果呈递遵循「谁发起、回给谁」原则：节点在收到 WebSocket 变更事件或对账扫表时，将属于本节点发起的任务结果（`completed`、`failed`、`rejected`、`input-required`）写入本机配置目录的 `present_queue.jsonl`，供本机 Agent / Hook 消费并在当前对话界面中直接回复用户。去重键记在 `present_state.json` 与线上的 `Tasks.Metadata.presented_keys`（过渡期同时标记 `Presented="Yes"`；v3.5 起代码只读 Metadata 的键，Presented 列随后删除——线上键必须保留，本地状态丢失时靠它防历史回执重放）。
  - 归属与过滤：节点发起的定时任务（`From_Node` 为本节点、`Source=cron`）由本节点收入其 `present_queue.jsonl` 原路呈递；`role=hub` 的主节点仅接收发起方为空、为 `"hub"`、或发起方字面为 `"cron"` 的任务结果，不再因 `Source=cron` 截留其他节点发起的任务。
- **呈递去重**按「任务＋当前 Status_Msg」即 (Task_ID, Status_Msg) 计，终态再带上 Status。同一任务每出现一条新的 question / auth_request 都是新的呈递项，答复续跑或批准后到达的终态结果也要再呈递一次。已呈递的 Msg_ID 记在 Tasks.Metadata；Presented 列自 v3.5 起废弃（其信息与 presented_keys 重复），不再作为去重依据，代码切换后删列。对 Tasks.Metadata 的写入一律先读再合并（总线无 CAS，整段覆盖会互相吞键）。初次装机或初次启动时，若本地呈递状态不存在，自动以线上存量终态或已呈递任务建立装机水位线（Baseline），避免向本地队列倾倒全部历史已完成任务。

## 修订记录

**v3.8（2026-11-11，Worker 名片）**：
- 动机：总览把 Agent 画在了技能层，名册对「哪一行代表 Worker」没有成文口径。
- 定义：名册里每个 Worker 有且只有一张 **Worker 名片**（`Skill_ID=agent`），代表该 Worker 在册及其通用执行，不是一项技能；Worker 的专长技能各占一行，挂在名片下。判定只读 `Node` / `Worker` / `Skill_ID` 三列，口径见 §6「Worker 名片与名册口径」。表结构不变，登记哪些行、怎么寻址都不变；只有 Worker 名片的名称说明口径有调整（见 §6「名称来源」），升级后对账会原地更新一次这些字段。
- 否决的做法：
  - 「通用能力降为 Worker 属性、不登记名片」。名册失去 Worker 这一事实后，本地计划、later 复查、自动挑选、只有 Worker 的节点的 `--to` 校验都会断。
  - 「独立 Agent 节点把名字写进 `Worker` 列」。`Worker` 列是路由键，写展示名会让认领集合与本机能力表对不上，任务全部被拒收。
- 迁移与兼容：旧平表语义不变，由 `lah doctor` 提示迁移（§9「旧平表迁移」）。先升级守护进程再迁 `commands.json`。
- 更正：顺带更正 §10.5 中关于重复 Cap_ID 的表述，使之与 §6、§9 及实现一致（行为未变）。

**v3.7 同版：审批决定签名**：§8.3 有效决定增加第 5 条。hub 用本机 ed25519 私钥给 auth_decision 签名，节点配了 `hubPublicKey` 时验签，签名对不上的决定当作不存在。此前四条判定全是行上自报字段，任何总线写入方都能冒写批准。表结构不变（签名放在既有 DataPart 里）。

**v3.7（2026-11-10，恢复 Worker 层级：Node / Worker / Skill 三层寻址）**：
- 动机：最初的设计是 Node＝工作节点、Worker＝节点上的 Agent、Skill＝该 Worker 能做的事。实现过程中 Worker 一层丢了：装机向导把 Agent 登记成名叫 `claude-agent`、`agy-agent` 的「技能」，Tasks.Worker_Hint 没有任何代码写入，Runs.Worker 恒为 `daemon`，「指定 Agent 执行指定 Skill」无从表达。
- §0 新增第 8 条三层寻址。§2 定义 Worker_Hint：写了是硬约束，留空由节点取默认并在认领时回填。§4 定义 Runs.Worker 为实际执行者。§6 名片一行改为 Node × Worker × Skill，新增 Worker 列，给出 Cap_ID 推导口径。§8.3 本地审批下限取 Worker 与 Skill 中更严者。§9 重写能力模型：`commands.json` 根上的保留键 `workers` 定义 Worker，技能条目用 `workers` 数组绑定，每个 Worker 自带通用技能 `agent`；任务参数的执行控制键增加 `worker`。§10.1 建单入口增加 `--worker`，later 复查继承 Worker_Hint。
- 表结构变更：AgentCards 新增文本列 Worker；Tasks.Worker_Hint 由单选改为文本（Worker 名由各节点本机定义，不是全网枚举）。这是「本地需求进 Metadata、不加列」原则的一次例外，理由是 Worker 与 Node、Skill_ID 同为路由键。
- 兼容：没有 `workers` 键的旧 `commands.json` 含义不变，每个条目都是节点本尊的能力，Cap_ID 不变。把旧条目 `<x>-agent` 改写成 Worker `<x>` 后，其通用技能的 Cap_ID 仍是 `CAP-<capPrefix>-<x>-agent`，引用该 Cap_ID 的本地计划不用改。

**v3.6（2026-11-09，节点本地调度、双时钟与 Rules 观察镜像）**：
- 动机：v3.5.2 的 hub 集中调度存在延时链长（hub 扫表建单 → 节点长连接/轮询唤醒认领）与单点时钟错位风险；改为各节点本地调度（§7）。
- 双时钟架构：终端类节点（`kind: host`）由 `lah daemon` 本地内置分钟级时钟读取 `schedules.json` 触发；独立 Agent 类节点（`kind: agent`，如 Muse / Grok）由 Agent 自身时钟到点调用 `lah task begin` 触发。
- 状态机统一：本地调度触发的任务一律以 `Status=submitted` 建单入总线，`From_Node`＝`Target_Node`＝本节点，`Source=cron`，并立刻唤醒本进程走统一认领链路（在途账本、心跳、单并发、审批下限对齐）。严禁直接写 `working`。
- 幂等键格式升级：升级为 `sched:<Node_ID>:<Schedule_ID>:<期次键>`，旧键 `sched:<Rule_ID>:<期次>` 废止。基线优先于补期，只补最近一期，节点关机睡眠不代偿。
- Rules 角色降为观察镜像：节点将本机计划摘要单向同步至 Rules 表（`Rule_ID=<Node_ID>:<Schedule_ID>`），供全网总览页面查看；任何节点不读 Rules 触发任务，Base 中改动 Rules 不影响本地执行。Agent 类可用 `lah schedule register` 登记镜像。
- 呈递归属变更（§8.5）：遵循「谁发起、回给谁」，节点发起的定时任务结果由节点自身收进 `present_queue.jsonl`；hub 仅接收发起方为空、为 `hub` 或发起方字面为 `cron` 的单。
- 职责调整：hub（§10.1 第 7 条）不再按 Rules 扫表建单，仅保留事项级 `later` 预约复查建单。表结构完全不变（不加列）。
- 部署与迁移顺序：必须**先升级 hub、再升级各执行节点**，防止旧 hub 扫描到新节点写入的 Rules 镜像行造成双跑误触发。

**v3.5.7（2026-11-08，事项级 later 复查）**：§9 回执增加可选 `LATER` / `later`。只在完成回执上生效，写入 `Tasks.Metadata.later`，不加列。§10.1 第 7 条：到点由 hub 在同一 `Context_ID` 下新建复查任务；纯 node 没有时钟，不建复查任务。终态任务不重启。

**v3.5.6（2026-11-08，可选用量与 direct 会话续接）**：§9 回执增加可选 `usage` 与 `session`。用量累加到 Tasks.Metadata.usage（Runs 不加列），缺报不估算；`lah task why` 显示汇总与未上报轮数。session 只留在执行节点 `runs/<Task_ID>/session.json`，不进总线。仅 direct 的 json/agent 在问答续跑、本机已有 session、且条目写了 `resume_command` 时替换命令；首次执行、失败重试、心跳回收重跑不用。carrier 与 inbox 不续接。

**v3.5.5（2026-11-08，direct 在途账本；同版收入第二轮生产测试的五项与重试、回执收紧）**：同版另有——§4 失败重试退避（节点私有 `retry_state.json`，非协议字段）；§9 回执只认最后一个完整 `agent-ask` 围栏与围栏外整行，输出头尾截断；§8.3 行级 `approve` 由 hub 在 `submitted` 阶段提前写 `auth_request` 并发卡、节点认领时按既有请求收敛，并写明审批驳回由 hub 置 `canceled`、`rejected` 仅用于节点侧拒收；§8.4 Idempotency_Key 同键多单以先被目标守护处理者为准、同键不同文本视为客户端错误；§10.1 `lah task cancel` 的发起方例外；§10.5 本地配置损坏降级语义；建单按名册校验目标存在性。以下为 direct 在途账本：§4 增加执行恢复与单并发。`context=direct` 的 json/agent 命令在 spawn 前把账本写在配置目录 `runs/<Task_ID>/entry.json`，输出落文件；守护重启后续租或按退出码收口，不把仍在跑的副作用命令再执行一次。同一时刻只跑一条 direct 命令，扫表不再被这条命令堵住。carrier 与 inbox 不在范围内。§8.4 心跳回收对存活在途账本让路。不新增 Tasks 状态，不把 pid 写入总线。

**v3.5.4（2026-11-08，定时调度时区与基线）**：§7 与 §10.1 第 7 条修订。期次按 hub 配置时区（`node.json` 的 `tz`，IANA 名，缺省 Asia/Shanghai）计算，与宿主机时区无关；期次键偏移与 v3.5 时间文本同为 `±HHMM`（不带冒号）。新建计划、`Schedule` 文本变化，或本地基线缺失/损坏时，首次扫描只回写 `Last_Fired` 水位线、不建单，从下一期起触发。基线键＝Rule_ID＋Schedule 文本，落在配置目录 `schedule_state.json`，不新增列。背景是生产上 UTC 宿主把按北京时间书写的 cron 错位 8 小时，以及 `Last_Fired` 为空或表达式变更时补发了已过去的期次。

**v3.5.3（2026-11-08，能力模板的执行主体与无头权限）**：§9 补两条。编排型 CLI 模板必须显式带默认执行主体（用户选择优先，未选给默认）；agent 型 CLI 模板必须显式处理无头权限。背景是 Paseo 不带 `--provider` 时运行必失败，以及多家无头 CLI 在默认权限下写任务失败或 soft-deny 假成功。定版命令、三类权限语义与已知坑见 [能力模板库](agent-templates.md)。

**v3.5.2（2026-11-08，定时调度）**：机主拍板「时钟放 hub、计划存 Rules」。§7 扩展：Rules 加 Schedule / Text / Last_Fired 三列兼作计划表（字段 85→88），计划行＝Enabled=Yes 且 Schedule 非空；触发只补最近一期、水位线＋幂等键双保险、目标解析顺序定为计划行→路由行→名片解析。§10.1 新增第 7 条 hub 调度职责。此前中台没有任何时钟组件，周期任务只能靠外部 cron 建单（标准仅预留 Source=cron 的呈递归属）；本次把时钟收进 hub，节点侧零改动。

**v3.5.1（2026-11-08，陈旧回收）**：§10.1 第 6 条由「只告警、不回收」改为两段式（机主 2026-11-08 拍板）：working 心跳超时 20 分钟先告警，告警后宽限 30 分钟，心跳恢复即撤销告警；届满仍无心跳，hub 置 failed 回收（清认领、关 Run、写 notice），迟到回执按终态守卫拒绝。submitted 无人认领仍只告警。此前口径下陈旧任务会无限期挂在 working（2026-11-07 R2 实测），本次补齐回收段。

**v3.5（2026-11-07，字段瘦身与总线契约）**：原则：A2A 字段够用就不加扩展列；删改字段走「先改标准 → 通知节点停写 → 观察 → 快照 → 删列」的迁移顺序（本版首批删除在授权下先行落表，标准随即对齐，后续批次严格按序）。
- 删除无消费者字段：Tasks.Worktree、AgentCards.Required_Assets / Tags / Examples、Messages.Metadata、Parts.Metadata（Parts 与 Messages 的 Metadata 从未被写入或读取；Tasks 与 AgentCards 的 Metadata 有真实消费者，不在此列）。
- AgentCards 的 Modes 与 capabilities 三开关、Zone、Skill_Name 收拢进名片 Metadata 的 `a2a` 子对象（见 §6）；列保留至代码切换与一个登记周期观察后删除。Side_Effect 保留独立列。
- Tasks.Presented 列废弃：呈递去重只认本地 present_state.json ＋线上 Tasks.Metadata.presented_keys（线上键保留，防本地状态丢失后历史回执重放）；Tasks.Metadata 写入一律先读再合并（见 §10.2）。
- doctor 新增总线契约检查：schema 与标准声明的字段、代码实际写入的选项值必须在线上登记，缺列缺选项在装机自检阶段即报出（针对 2026-11-07 两次「代码写了 Base 没有的列」瘫痪）。
- `lah task create` 新增 `--idempotency-key`：调用方传入原值时节点侧重复拒收才可命中；此前 CLI 恒生成随机键，幂等只在手工落单路径成立。
- schema 生成改为忠实快照：不再手工过滤选项，default_value 非空时如实记录；选项污染在 Base 本体清洗。
- 时间文本统一口径：Created_At / Started_At / Finished_At / Heartbeat_At 一律写本地时间 ISO 8601 带时区偏移（与 Runs 既有口径一致）。此前 Messages 的 Created_At 是无偏移的分钟级本地时间，各节点时区不同（如枢纽容器 UTC 与节点本地 UTC+8）混写会让同一任务的时间线乱序；读侧排序以 Msg_ID 序为主、Created_At 为辅，旧格式存量行仍可读。

**v3.4.1（2026-11-07，AgentCards.Metadata、建单拒派与派生会话）**：
- §6 增加 AgentCards.Metadata：A2A 原生自由字段，文本，存 JSON 字符串；内核登记时写入 `kind` 与 `mode`，手工名片与旧名片可留空。表结构因此新增一列；线上 Base 加列后重新生成 schema，不手改生成物。
- §10.1：`lah task create` 在自动挑选能力，以及显式指定 Cap_ID 或 Skill_ID 时，拒绝 `Dispatchable=No` 或 `Availability=offline` 的名片；没有可用能力同样拒绝。拒绝发生在第一笔写之前，并给出明确错误。
- §8.2：未显式给出 `--context` 时，单父派生默认继承父 Context_ID；多个父任务的 Context_ID 不一致时，建单入口在第一笔写之前拒绝，并要求显式 `--context`。
- §10.4 补充 inbox fail 语义：明确 `lah inbox fail` 是 Agent 本尊宣告无法完成，属于判断而非临时故障，直接置 failed 并写 notice、关账 Runs，不重试、不回 submitted、不计入 Retry_Count，与内核命令重试严格区分。

**v3.4（2026-11-07，节点类型区分 host 与 agent、异步 inbox 执行模式）**：
- 节点配置 `node.json` 引入 `kind: "host" | "agent"`（缺省 host，向下兼容）。
- **`kind: host`（电脑宿主）**：保持现行模式，setup 自动扫描发现本机已安装的终端 Agent CLI（如 Claude Code / Codex / agy / Paseo 等）并生成命令模板，由守护进程拉起子进程干活。
- **`kind: agent`（独立 Agent 实体，如 Muse / Grok Bot）**：本身即是 Agent。setup 绝不扫描 PATH、不注册任何外部 CLI；唯一登记的能力为 `agent`，执行模式为 `inbox`。
- **新增 `mode: "inbox"` 执行模式**：
  - 守护进程认领任务后，将任务数据写入本机 `agent_inbox.jsonl`，保持 `working` 状态且不起子进程；
  - 守护进程负责持续刷新 `Heartbeat_At` 保活，支持配置 `inbox_timeout_sec`（缺省 86400 秒，超时置 failed + notice）；
  - 提供 `lah inbox [--pop]`、`lah inbox done`、`lah inbox ask`、`lah inbox fail` 供 Agent 本尊在每轮交互中消费与回执；发起方答复后自动恢复至 inbox 条目供本尊继续执行。
- 任务派发对齐：`lah task create` 省略 `--cap` 时若目标节点为 agent 类型，直接对准其 `agent` 能力。

**v3.3（2026-11-07，容器与无 TTY 适配、呈递水位线 Baseline、通用 Agent 收件箱）**：
- 增强容器、Agent VM 与无 TTY 部署能力：systemd 服务在缺少 user session 时回退系统级 unit 或脱机后台拉起；应用缺少 app.info 权限时事件自检放行，优先读取环境变量凭据。
- 呈递水位线（Baseline）：首次启动或 setup 完成时自动将存量历史终态任务写入 present_state.json，彻底防止存量 Base 历史刷屏。
- 区分独立 Agent 节点与编排宿主：增加 paseo 与 orca 探测；`lah task create` 支持 `--skill` 并支持省略 `--cap` 自动挑选目标节点首选能力。

**v3.2（2026-11-07，原路返回与本地队列呈递，飞书仅发审批卡）**：
- 明确任何节点均可作为任务发起入口，`lah task create` 默认以本机为 `From_Node` 与 `Tasks.Source`。
- 执行节点写回执消息时，`To_Node` 原路指向任务首条 `instruction` 的 `From_Node`（回退 `Source` || `"hub"`）；唯独 `auth_request` 消息的 `To_Node` 固定为 `"hub"`（统一由主节点发飞书卡片）。
- 结果呈递（`completed`、`failed`、`rejected`、`input-required`）按「谁发起、回给谁」落入本地 `present_queue.jsonl`，飞书端不再发送文本消息刷屏，实现安静协作与本地 Agent 闭环消费。
- 新增 `lah task reply`（原任务答复续跑）、`lah task show` 与 `lah present --pop` 子命令，并内置自动分发 `lah` Skill。

**v3.0（2026-11-04 晚，机主选定形态 B：A2A 原生主干＋本地扩展列）**：在 v2.2 基础上完成 A2A 完全体对齐——新增 Parts 表（消息与产物的内容块，text/file/data 三型）；Tasks 删除 Payload（参数迁首条 instruction 的 DataPart）与 Tasks 级 Ref_Task_IDs（迁 Messages 级，原生 referenceTaskIds），新增原生 Metadata；Messages 删除 Content/Content_Type（正文全量走 Parts）；Artifacts 删除 Type/Pointer/Version（内容走 FilePart，修订＝同名新 ID），新增原生 Description/Metadata；Nodes 表更名 AgentCards，Capability 改名 Description，补齐名片字段（Skill_Name、Tags、Examples、Input_Modes、Output_Modes、Default_Input/Output_Modes、Cap_Streaming/Cap_Push/Cap_State_History），存量三行已回填。七项总线运营字段（Target_Node、认领租约 Claimed_By/Heartbeat_At、Hop_Count、Retry_Count、任务级 Idempotency_Key、Presented、Source 及同类）经缺口分析确认为 A2A 点对点模型不建模的部分，以本地扩展列形式保留并逐项标注；其余本地需求一律进 Metadata。代码全量同步：守护进程 worker-3.0.0、呈递管线（Parts 拼接正文）、审批卡（上下文展示）、审批回调（auth_decision 写 TextPart＋DataPart）。TASK-HUB-V2-CUTOVER-001 已关单，切换通知改发 TASK-HUB-V3-NOTICE-001。


**v3.0 补订（2026-11-05，第二评审收敛，表结构不变）**：§4/§8.1 区分执行失败与回执无效/提交失败，后两者不计重试、不重做副作用，提交可补齐；§8.3 审批改为认领前 submitted→auth-required（与实现对齐），新增生效审批级别（任务行与节点本地 approval_class 取严）、回调须校验操作者是机主、有效 auth_decision 四条判定；§8.4 新增 Idempotency_Key 语义与心跳回收计入 Retry_Count；§8.5 新增按 (Task_ID, Status_Msg) 呈递去重；§9 新增 agent 输入约定（经 input.json 隔离指令与数据）。

**v3.1（2026-11-06，hub 与 node 合一、统一传输方式，表结构不变）**：§0 新增第 6 条，hub 改为逻辑角色；§0 第 3 条写明 webhook 只指出站通知（发起 POST 的是飞书自动化），与 §6 Receive_Mode 枚举对齐。新增 §10：§10.1 定义 node / hub 两个角色与 hub 职责（建单、审批卡与机主校验、auth_decision、canceled、呈递、陈旧告警），规定 auth_decision 与 canceled 只能由 hub 角色代码路径写、node 角色从不写（hub 是唯一写方）；角色只有 `--role node|hub` 两种，一台机器要同时承担两角色就起两个守护进程、各用一个配置目录；hub 角色强制长连接（审批卡回调只能经长连接送达），node 角色可选 ws / poll。§10.2 应用身份默认两个应用、可共用一个并写明代价；§10.3 传输方式定为 ws / poll / webhook（专指飞书自动化 POST，Receive_Mode=automation）三种，均保留 15 分钟对账兜底。§2 canceled、§3 唤醒语义、§6 Receive_Mode、§8.3 写入方、§9 节点传输随之改写。原有枢纽约束（canceled 只由枢纽写、审批只认 hub 写的 auth_decision、机主校验、建单顺序）不变，改由 hub 角色承担。同日补充：仓库去掉 Python 版 `hub/`，只保留 Node。省略 `--role` 时 daemon 与 doctor、service 一样回退读 `node.json` 的 `role`，缺省 node。`hub-node task create` 为现行建单入口；Rules 自动路由仍为计划。§8.5 呈递改为长连接叫醒加对账扫表、直接发机主私聊，不再描述呈递队列文件。

---

## 9. 附则：执行层与传输层修订（表结构不变）

- **能力模型（v3.7：Node / Worker / Skill）**：守护进程为薄壳，不内嵌任何执行器；能力全部来自节点本地 `commands.json`，守护进程按配置自动登记 AgentCards，新增能力不改守护进程代码。定版命令见 [能力模板库](agent-templates.md)。
  - **Worker** 写在根上的保留键 `workers` 里：`{"workers": {"<worker>": {command, resume_command?, mode?, context?, cwd?, timeout_sec?, approval_class?, name?, desc?}}}`。`command` 是这个 Agent CLI 的无头启动模板（如 `agy --dangerously-skip-permissions --print {prompt}`）。Worker 名只含字母、数字、`.`、`_`、`-`。Worker 的 `mode` 只取 `agent` 或 `json`。
  - **Skill** 是根上的其余键。两种写法：自带 `command`（或 `mode: inbox`）的条目由节点本尊直接执行，Worker 为空（确定性脚本、独立 Agent 的收件箱）；写 `workers: ["<worker>", …]` 的条目是这些 Worker 的专长技能，启动方式取自 Worker，条目只提供 `name` / `desc` / `side_effect` / `approval_class` / `timeout_sec` 等技能属性。同一条目不得同时写 `command` 与 `workers`。
  - **Worker 名片与通用执行**：每个 Worker 自动登记一张 Worker 名片（`Skill_ID=agent`），代表它在册并按自然语言指令现场发挥，无须另写条目。名片的名称与说明取 Worker 条目的 `name` / `desc`。显式写 `agent` 条目只用来调整这项通用执行的属性（审批下限、超时等）。独立 Agent 节点的 `agent`（inbox）就是本尊的 Worker 名片，只是 Worker 为空。
  - **默认 Worker**：任务未指定 Worker 时的取法见 §2 Worker_Hint。专长技能按其 `workers` 数组的顺序，通用执行（Worker 名片）按 `workers` 对象里的书写顺序。
  - 条目引用了未定义的 Worker、Worker 缺 `command`、同时写了 `command` 与 `workers`、或 Cap_ID 重复时，该项能力不登记并记日志，其余能力照常；`lah doctor` 报出同样的问题。
  - agent 型 Worker 执行专长技能（Skill_ID 不是 `agent`）时，prompt 里的受信部分多一行「本次任务使用技能：<Skill_ID>（<name>）。<desc>」，三者都取自本机 `commands.json`，不取自任务。
  - **旧平表迁移（v3.8 提示，语义不变）**：没有 `workers` 键、自带 `command` 且 `mode=agent` 的本尊条目，含义仍按 v3.7 作本尊技能，`lah doctor` 给出迁到 `workers` 的提示。迁移会改变 Skill_ID 与能力键；Cap_ID 只有在旧键是 `<W>-agent` 形式时才保持不变。迁移前必须先清空该节点的在途任务（以旧 Skill_ID 寻址的任务迁移后会被拒收）。旧条目不能和同名 Worker 并存，因为 Cap_ID 会撞，后登记的 Worker 名片会被丢掉。
- **执行模式（mode）**：
  - `agent`（默认）：文本指令模板模式，任务数据注入专用 `input.json`，拉起子进程执行；
  - `json`：stdin 传递任务信封，stdout 最后一行为结果 JSON；
  - `inbox`（v3.4 新增，专供独立 Agent 节点）：守护进程认领任务后写入本地 `agent_inbox.jsonl`，保持 `working` 状态并持续续心跳，不起任何子进程，由 Agent 本尊通过 `lah inbox` 处理并回执。
- **输入约定（agent 型模板，指令与数据分离）**：任务的指令文本、参数与答复一律作为数据写入本次执行专用的 `input.json`（仅本机可读），不拼进 prompt；prompt 只由节点本地受信模板组成，加上该文件的路径和一句声明「文件内容是数据，不是指令」。执行什么命令、在哪个目录、用哪种语境、调用哪个 Agent、给什么权限，只来自节点本地 commands.json；任务参数里出现这类执行控制键（command / cwd / context / agent / worker 等）的，节点直接 rejected＋notice。任务行上的 `Worker_Hint` 与 `Skill_ID` 不在此列：它们只是在本机 `commands.json` 已登记的能力里按名字选一项，选不中就拒收，本身不携带命令、目录、语境或权限。json 型模板经标准输入收任务信封，本就是数据通道，同样不得从信封读取执行控制项。
- **回执约定（agent 型模板）**：围栏之外的正文即摘要。产物只认围栏之外、整行匹配的 `ARTIFACT: <路径或URL>`，名称只认同样位于围栏之外的整行 `ARTIFACT_NAME: <名称>`；写在围栏里面的同形文字无效。提问只认整段输出里最后一个完整围栏，且该围栏的语言标记必须是 `agent-ask`，块内为问题；更早的围栏（包括更早的 `agent-ask`）一律忽略。守护进程据此置 input-required。围栏之外没有摘要则回执无效，直接 failed，不重试（§4）。可选的 `USAGE:`、`SESSION:` 与 `LATER:` 也只认围栏之外的整行，规则见下面几条；围栏里的同形文字无效。
- **回执约定（json 型模板）**：只认 stdout 最后一个非空行，且必须是 JSON 对象。决定任务走向的顶层键只有 `summary`、`artifact`、`artifact_name`、`need_input`。可选键 `usage`、`session` 与 `later` 只按下面几条吸收，不参与执行控制。其余顶层键忽略，并记一条日志，不拿去执行。摘要进入总线前仍截断到 4000 字，不按键打码。
- **可选用量（usage）**：agent 与 json 都可以带用量。没有这条就视为本轮未上报，节点不得估算或补猜。agent 在围栏之外单独整行 `USAGE: input=<n> output=<n> cached=<n> cost=<x>`，四个键都可省略、顺序不限，键之间用空白分开。json 在末行对象上加可选对象 `usage`，键同为 `input` / `output` / `cached` / `cost`，都可省略。三项 token 必须是有限非负数，写入前向零取整；`cost` 必须是有限非负数，保留至多 6 位小数。任一项大于 `1e12`、不是有限非负数，或整行 / 整对象无法按此解析，则忽略这一整条用量并记日志，回执其余部分仍然有效。用量不进 Runs（该表没有 Metadata，也不为此加列），由执行节点累加到 `Tasks.Metadata.usage`：`{input,output,cached,cost,runs,reported}`。同一任务上的重试与问答续跑都累加。`runs` 是已收口的执行轮数，`reported` 是其中带了合法用量的轮数，二者之差就是未上报轮数。写入沿用先读后合并，不覆盖 Metadata 里的其它键（如 `presented_keys`）。写在该轮任务收口的那次 Tasks 更新之后；Metadata 写失败只记日志，不得使回执提交失败。`lah task why` 的文本与 `--json` 都显示这份汇总和未上报轮数。
- **可选会话（session）与问答续接**：只覆盖 `context=direct` 的 json / agent。carrier 与 inbox 不保存 session，也不读 `resume_command`。agent 在围栏之外单独整行 `SESSION: <id>`；json 末行对象可选字符串 `session`。`id` 必须匹配 `^[A-Za-z0-9._:-]{1,128}$`，否则整条忽略并记日志，不影响回执是否有效。这是执行者自报的数据，只写执行节点配置目录 `runs/<Task_ID>/session.json`（权限 0600），不进总线，不写 Tasks.Metadata。任务进入终态后与在途账本的输出文件一起删掉；`input.json` 仍按上面的输入约定保留。`commands.json` 条目可以另写可选 `resume_command`，可信等级与 `command` 相同，只来自本机文件，不得从任务参数、消息正文或总线读取。仅当三件同时成立时，用 `resume_command` 替换 `command`：（1）本次是问答续跑（同一任务处于 input-required，收到 answer 后再次执行）；（2）本机已存有该任务的 session id；（3）条目配置了 `resume_command`。首次执行、执行失败后的重试、心跳回收后的重跑，都不用 `resume_command`。`{session}` 与 `{prompt}` 都只替换一轮，替换值用单引号包裹并转义其中的单引号，避免二次展开。agent 的 `resume_command` 使用 `{prompt}` 与 `{session}`；json 只需 `{session}`。续接不改输入约定：agent 仍把全量指令、参数与问答写入 `input.json`，json 仍经标准输入交付完整信封。`lah doctor` 在配置了 `resume_command` 但其中没有 `{session}` 时报问题。
- **可选复查（later）**：终态任务不可重启。agent 在围栏之外单独整行 `LATER: <ISO8601 时刻> | <about>`；json 在末行对象上加可选对象 `later`，形如 `{at, about}`。每次回执最多一条，多条只取最后一条并记日志；围栏里的同形文字无效。`at` 必须是真实日历时间（含闰年与每月天数），并带 `Z` 或数字时区偏移（`±HH:MM` 或 `±HHMM`）；不带时区、日期不存在（如 `2027-02-29`）、早于「现在加 1 分钟」或晚于「现在加 30 天」都整条忽略。`about` 是纯文本，含控制字符或超过 200 字则整条忽略，不删字符后收下，也不截断。不合法只记日志，回执其余部分仍然有效。只有本轮收口为 completed（result）才把 `{at, about}` 读-合并-写进该任务 `Tasks.Metadata.later`，不覆盖其它键，不加列；写失败只记日志，任务仍为 completed。failed（含执行失败与回执无效）和 input-required 上的 later 忽略并记日志，不写入。到点建单只由 hub 的时钟做（§10.1 第 7 条）。`lah task why` 显示待触发，或已触发及新任务 ID。
- **编排型 CLI 的默认执行主体**：编排型命令（如 Paseo、Orca）的模板必须显式带上默认执行主体。用户在 `lah setup` 交互里的选择优先；未选时写入该模板的默认值（Paseo 默认 `--provider antigravity`）。模型 slug 只钉在节点本地 `commands.json`，不进总线。详见 [能力模板库](agent-templates.md)。
- **agent 型 CLI 的无头权限**：agent 型无头模板必须显式处理权限，不能依赖有人在终端里点确认。软拒绝型（agy / gemini / claude）、沙箱档位型（codex / droid）与全批准开关型（amp / opencode）的定版写法见 [能力模板库](agent-templates.md)。
- **节点传输**（v3.1 起以 §10.3 为准）：守护进程型节点默认用 ws 长连接接收记录变更事件，落盘 events.log 作门铃，被唤醒后回表拉取处理；无法订阅事件时用 poll；两者都保留 15 分钟对账扫表兜底（事件断线不补发），events.log 不存在时自动退回轮询。hub 角色强制 ws 长连接（审批卡回调只能经长连接送达，不允许纯轮询），同样保留 15 分钟对账兜底。事件订阅注册要求见 §10.3。

## 10. 附则：角色与传输（v3.1，表结构不变）

### 10.1 hub 是逻辑角色，且为 node 的单进程超集

- 中台只有两个逻辑角色：**node**（认领、执行、回执，可做的状态迁移见 §2、§4、§8）与 **hub**（枢纽）。本标准中凡写「枢纽」「hub」处，均指承担 hub 角色的一方；hub 是 node 角色的单进程超集，既是普通执行节点，又承担中台枢纽服务。
- 实现是 Node 版 `lah daemon --role node|hub`（命令 `hub-node` 兼容别名可用）。省略 `--role` 时读该进程配置目录里 `node.json` 的 `role`，缺省为 node。单进程、单配置目录即可同时承载干活与枢纽职责，无需再拆两个进程与配置目录。
- hub 角色的职责：
  1. 节点能力与任务执行：像普通 node 一样读取 `commands.json`、自动登记 `AgentCards`、认领并执行 `Target_Node === 本节点` 的任务（含定时任务）；
  2. 建单与路由：按 Rules 与 AgentCards 选目标（Rules 自动路由仍为计划）；建单严格按「instruction 消息 → Parts → Tasks 行」顺序写，Tasks 行最后写、即触发信号（入口为 `lah task create`，由调用方指定目标节点与技能，可用 `--worker` 指定 Worker：只给 `--worker` 不给技能时取该 Worker 的名片（通用执行，`Skill_ID=agent`）；按 Cap_ID 指定能力时 Worker 取自该名片；按 Skill_ID 指定且未给 `--worker` 时 Worker_Hint 留空，由目标节点取默认。省略技能时由中台按目标节点在 AgentCards 登记的名片自动挑选首选名片：优先 Worker 名片与本尊 Worker 名片，亦可通过 --cap 反查目标节点）。建单在写任何行之前先按 AgentCards 名册校验目标存在性（显式 `--to` 须在名册有名片，显式 `--cap` 须在目标节点名片中存在对应技能；只校验存在性与 Dispatchable=Yes，不校验 Availability，目标离线仍可建单入队），校验失败报错退出且不落表；自动挑选与显式指定 Cap_ID 或 Skill_ID 时，命中 `Dispatchable=No` 或没有可用能力时，必须在第一笔写之前拒绝，并给出明确错误；节点守护可按同一写序给自己建计划任务（From_Node=To_Node=本节点、Source=cron），仍不写 auth_decision 与 canceled；
  3. 审批中继：给机主发审批卡；处理卡片回调时校验操作者是机主本人；通过后写 auth_decision（From_Node=hub、Role=user、In_Reply_To=任务当前 Status_Msg），并按决定把任务置回 submitted 或置 canceled（§8.3）；
  4. 取消：审批驳回时写 canceled；hub 角色也可执行 `lah task cancel` 取消任意任务。发起方只能在本机显式执行 `lah task cancel` 取消自己发起的任务。这是 CLI 动作，不是守护进程扫表路径；
  5. 结果呈递：将本节点或主节点归属的任务结果（终态、input-required、rejected）落入本地 `present_queue.jsonl`，去重按 §8.5；飞书端只发审批卡，不发大段文本刷屏；
  6. 陈旧任务告警与回收：working 且心跳超时（20 分钟）的任务先告警机主；告警后宽限 30 分钟，心跳恢复则撤销告警、不留痕迹；宽限届满仍无心跳，由 hub 将任务置 `failed`、清空认领、关账未结束的 Run，并写一条 notice 说明回收原因（原节点事后恢复时，其迟到回执按终态守卫处理）。这是 hub 唯一可代写的任务终态——与 `canceled`（机主/发起方意愿）严格区分，语义为「执行方失联」。它也区别于节点对本机认领的超时回收（§4：回 submitted 重试并计 Retry_Count）——节点复活时自会处理本机认领；hub 回收针对的是执行节点整体失联（告警＋宽限共 50 分钟无任何心跳），此时回 submitted 只是把任务放回无人区，直接终局更诚实。submitted 无人认领的任务只告警、不回收。
  7. 账本派生职责（事项级 later 复查）：定时调度已下沉至各节点本地（§7），hub 不再从 Rules 扫表建计划任务。hub 的时钟保留处理事项级复查（§9）：每轮扫表找出 `Status=completed`、`Metadata.later` 已到点、且还没有 `later_fired` 的任务，经现行建单在同一 `Context_ID` 下新建复查任务。`Target_Node`、`Worker_Hint` 与 `Skill_ID` 取前任任务行，首条 instruction 的 `Ref_Task_IDs` 指回前任，`Hop_Count` 为前任加一，`Approval_Class` 继承前任（只收紧不放宽），`Source=cron`，幂等键 `later:<前任 Task_ID>`，指令正文为「复查：<about>（承接任务 <前任 Task_ID>）」。`about` 只作为数据进入指令正文，不进入命令路径。建单前先按幂等键查重，已有则只补写 `later_fired`（新任务 ID 与触发时间）。目标名片暂缺时记日志，下一轮重试，不写标记。再加一跳会超过跳数上限时不建单，记日志并写 `later_fired`，避免每轮重试。逾期再久也只补这一次。纯 node 部署不处理这只时钟，later 只留在 Metadata，直到有 hub 扫表；node 角色守护进程不建复查任务。
- **角色边界**：auth_decision 消息只能由 hub 角色的代码路径写入；node 角色的守护进程与 inbox 回执从不写。canceled 同样不能由守护进程的 node 角色代码路径写入（`kernel` 认领/回执与 `inbox` 回执均不写）。唯一例外：发起方在本机显式执行 `lah task cancel`，且仅能取消自己发起的任务。发起方按首条 instruction 的 From_Node，否则 Tasks.Source，再否则 `hub`（与回执原路同一口径）；Tasks 表没有 From_Node 列。hub 角色可取消任意任务，审批驳回时写 canceled 仍只走 hub 守护进程。除此之外没有写 canceled 的入口，命令行 `--role` 不能把 node 提升成 hub。
- From_Node=hub 是 hub 角色的逻辑名，与它跑在哪台机器无关；node 角色写出的消息，From_Node 仍是本节点名。
- §8.3 的「有效决定」四条判定、回调鉴权与「终态不可变」等约束不因角色合并而放宽。

### 10.2 应用身份

- **默认：两个应用，身份隔离**。hub 角色用一个自建应用（读写总线、事件长连接、发审批卡，另需 im 发消息权限）；node 角色每台机器一个应用。表上的写入记录与审计日志能区分 hub 与各节点，单台机器凭据泄露或吊销不波及 hub。
- **简化：hub 与 node 共用一个应用**（适合单机部署或试用）。代价须由操作者知情接受：
  - 身份不隔离：总线上 hub 与 node 的写入在平台层面是同一身份，审计日志无法区分是谁写的；
  - 权限按并集开：node 也持有发消息等 hub 才需要的权限；
  - 凭据泄露面合一：拿到这台机器凭据的人可以以同一身份写出 From_Node=hub 的 auth_decision，平台层面无从事后区分；
  - 吊销联动：停用该应用会同时停掉 hub 与 node。
- 协议接入型节点用其自有平台的身份，不在本节范围。

### 10.3 传输方式（唤醒）

唤醒与传输只有三种方式，均不改变「表是唯一的消息面」：通知只是门铃，内容一律由接收方回表拉取。

| 方式 | 机制 | 适用 | Receive_Mode 取值 |
|---|---|---|---|
| ws | 飞书官方 SDK 长连接订阅记录变更事件（`drive.file.bitable_record_changed_v1`），由本方发起出站连接；事件只当门铃，不解析内容 | 守护进程型节点；hub 角色强制使用（审批卡回调只能经长连接送达） | `event` |
| poll | 按固定间隔扫表，默认 45 秒 | 守护进程型节点；无法订阅事件时 | `poll` |
| webhook | 飞书多维表格自动化在 Tasks 行新增或变更后，向协议接入型节点的端点 POST，只带 ID（Task_ID、状态、Msg_ID），不带正文；发起 POST 的是飞书自动化，本项目任何进程不主动推送 | 协议接入型节点（无法建长连接但有固定接收地址的外部节点，如 Grok bot） | `automation` |

- **对账兜底**：三种方式都必须保留低频对账扫表，默认 15 分钟（900 秒）。事件断线不补发、出站通知可能丢失，对账是安全网，不是心跳。poll 方式的轮询间隔不得长于对账周期；协议接入型节点按其运行手册定期回表核对。
- **webhook 在本标准中只指出站通知**：发起 POST 的是飞书多维表格自动化，接收端点由协议接入型节点自有平台托管；本标准的实现绝不开监听端口、不做端口映射或隧道，也不主动 POST（§0 第 3 条）。接入步骤：在 Base 配置自动化（Tasks 行新增或变更时 → 发送 webhook 到节点地址，只带 ID），节点收到后经 REST 读表处理。因此守护进程型节点登记的 Receive_Mode 只取 `event` 或 `poll`；`automation` 只用于登记协议接入型节点，表中遗留选项 `webhook` 不再使用。
- Receive_Mode 沿用表中现有选项（表结构不变），ws 方式在表中记为 `event`。
- 审批卡回调同样经长连接接收，不开回调地址。
- 事件订阅注册：Base 的云文档事件订阅只能以用户身份注册，且用户令牌按应用签发，须在本机交互终端以该应用完成 `auth login`（含 docs:event:subscribe scope）后调 drive subscribe 接口；注册一次即可，之后长连接以应用身份收事件。

### 10.4 节点类型（Kind）：宿主（host）vs 独立 Agent（agent）

节点通过配置 `node.json` 中的 `kind` 字段区分：

1. **`kind: host`（电脑宿主，缺省）**：
   - 机器是一台开发机、工作电脑或服务器；
   - 守护进程读取 `commands.json`，按本地命令模板拉起本机已安装的 Agent CLI（如 Claude Code / Codex / agy / Paseo / Orca 等）或本地脚本处理任务；
   - `lah setup` 在装机时自动探测系统 PATH 中已安装的终端 Agent，自动生成对应 commands 条目。

2. **`kind: agent`（独立 Agent 实体，如 Muse / Grok Bot / 独立 Agent 容器）**：
   - 节点本身即为一个自闭环运行的 Agent 实体；
   - `lah setup` **绝不扫描 PATH、不注册任何外部 CLI**，只登记一张本尊 Worker 名片（`Skill_ID=agent`，`Worker` 留空，`mode: inbox`；v3.8 起称名片，不再称专属能力）；名片的 `Worker` 列不写名字（理由同 §6，它是路由键），展示名取 `Node`，或该条目的 `name`；
   - **收件箱（inbox）工作流**：
     - 守护进程认领任务（置 `working`，`Claimed_By` 为本节点）后，将任务数据（Task_ID、Title、From_Node、指令正文、params、历史问答）写入本地 `agent_inbox.jsonl`（600 权限），**任务保持 `working` 状态，不关闭、不起子进程**；
     - 守护进程负责持续刷新 `Heartbeat_At`，避免 20 分钟租约超时；可配置 `inbox_timeout_sec`（缺省 86400 秒），超时自动置 `failed` + notice「本尊超时未处理」；
     - Agent 本尊在每轮循环或启动时调用 `lah inbox [--pop]` 读取待办；处理完成后调用 `lah inbox done`（完成并原路回执）、`lah inbox ask`（提问待答）或 `lah inbox fail`；
     - **`lah inbox fail` 语义与失败终态**：
       - `lah inbox fail --task <ID> --text <原因>` 表示 Agent 本尊明确宣告无法完成该任务。参数 `--text <原因>` 为必填；执行后向 Messages 追加一条 `Role=agent` 的 `notice` 消息（正文记录失败原因，`To_Node` 原路指向发起方首条 instruction 的 `From_Node`，回退 `Source` || `"hub"`），当前 Runs 以 `Outcome=failed`、`Finished_At`、`Error_Log` 关账，任务状态直接置为 `failed`；**不重试**，不回 `submitted`，不计入 `Retry_Count`；
       - **与内核命令失败重试的区别**：内核（host 模式）拉起本地命令时，命令崩溃/进程非零退出、执行超时或无心跳被回收属于偶发临时故障，在 `MAX_RETRIES`（默认 2 次）上限内会清空 `Claimed_By` 并重置为 `submitted` 供重新认领重试；而 `lah inbox fail` 是由 Agent 本尊根据任务内容、自身能力边界或外部约束做出的业务与能力判断，属于确定性结论而非临时故障，重试无法改变结果，故直接进入终态；
       - **区分提问（ask）与失败（fail）**：Agent 若因缺少必要信息、需要机主确认或参数模糊而暂时无法继续，应使用 `lah inbox ask` 转入 `input-required` 等待答复续跑，而不是使用 `fail`；一旦调用 `fail`，任务进入不可逆终态（A2A 终态不可变，禁止重开）。若发起方想在失败后调整要求重新尝试，必须在同一 `Context_ID` 下新建任务，新任务首条 instruction 的 `Ref_Task_IDs` 指回原任务；
       - **超时未处理**：若任务进入 inbox 后超过 `inbox_timeout_sec`（缺省 86400 秒）未被 Agent 本尊处理，守护进程负责超时关账，直接将任务置为 `failed` 并写 `notice`「本尊超时未处理」，Runs 记 `failed`，同样不计入重试；
     - 发起方答复后，中台自动将任务重新放回本地 inbox（状态变回 `pending`，追加最新 answer），本尊即可续跑。
   - **双向对称**：作为发起方时，结果仍经 `present_queue.jsonl` 原路返回；独立 Agent 节点只需在交互开头跑 `lah present --pop`（收自己派出去的结果）和 `lah inbox --pop`（接派给自己的活）。

### 10.5 本地配置损坏的降级语义（表结构不变）

本节约束守护进程在本机 `commands.json` / `node.json` 被改坏（语法错误、根不是对象、文件缺失或不可读）时的行为。总纲是「失败要响」：不静默换路径，也不把在途任务误拒成终态。

**现状（以 `src/kernel.mjs` / `bin/lah.mjs` 为准）**：

- `commands.json` **运行期热加载**：每轮扫表前按 mtime＋size 检查，变化即重读。
  - 运行期解析失败：内存中保留上一份有效能力表（不清空，否则预检会把任务拒成 `rejected`），每轮记一条错误日志；能力名片保持上一次登记的样子；**暂停认领新的 `submitted` 任务**，`input-required` 任务的续跑检查照常进行。
  - 文件恢复后，下一轮扫表自动接回：内容有变则先对账名片，再恢复派发。
  - 启动期没有有效 `commands.json`：只记日志，进主循环每轮重试；能力名片登记成功前不处理任务（§9、DESIGN §4 常驻韧性）。
- `node.json` **只在启动时读一次**（含 hub 的 `ownerOpenId`），运行期改动（改好或改坏）都要重启才生效，在跑的进程不受影响。启动期 `node.json` 无效时，守护进程记一条错误、退避（默认 5 秒）后以非零状态退出，由 launchd / systemd 的保活拉起重试；修好前不会接单。
- 条目级字段不合法时：未知 `mode` / `context` 在认领预检阶段直接拒收（`rejected` + notice 说明是本机配置取值非法），不再静默按 `agent` / `direct` 处理，以免拼错的 `carrier` 绕过离线拒收；非法 `timeout_sec` 仍回退 600 秒，重复 Cap_ID 时后一项不登记并记日志（同 §9）。这类问题同时由 `lah doctor` 提前拦截：检查两份文件可解析、必填字段齐全，`mode ∈ {agent, json, inbox}`、`context ∈ {direct, carrier}`、`timeout_sec` 为正数，Cap_ID（`cap_id` 或 `CAP-<capPrefix>-<能力名>`；Worker 的能力为 `CAP-<capPrefix>-<Worker>-<Skill_ID>`）不重复，`workers` 里每个 Worker 有 `command`，技能条目引用的 Worker 都已定义；对旧平表中由节点本尊执行的 agent 型条目给出迁到 `workers` 的提示（info，不计入问题）；不打印任何凭据。

**建议（尚未实现，落地前先改本节）**：

- 运行期 `commands.json` 解析失败时，继续用内存中的上一份有效能力表接单，只记一条错误日志并在恢复时记一条恢复日志，不必每轮重复刷屏；能力名片不动。这与现状「暂停接新单」相比，可用性更好，代价是操作者编辑到一半的意图无从得知；采纳与否由负责人定。
- 条目级非法值改为在内核加载时逐条校验：非法条目不登记名片（或标 `Availability=offline`）并记错误日志，使任务在路由阶段就看得到该能力不可用，而不是等认领后才被拒收。
- 启动期 `node.json` 无效时改为进程内退避重试、不退出，与 `commands.json` 的启动期语义对齐，不依赖外部保活。

