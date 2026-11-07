# Base 结构（七表字段级）

本文件由 `schema/generate_schema.py` 从一张运行中的 Base 生成：字段名、
类型与单选选项均为线上事实（个别一次性测试值已略）；「说明」列为文档层语义，完整规范见
[中台标准](standard.md)。照此结构在飞书多维表格里建表（或用字段 API
批量创建），即可得到一张可用的中台 Base。

## Tasks

Task：一件工作的信封与状态机，一行一任务

| 字段 | 类型 | 说明 |
|---|---|---|
| Title | Text | 主字段 |
| Task_ID | Text | 业务编号，唯一、人可读，发起方生成后不变 |
| Source | SingleSelect | （扩展）任务来源：hub / cron / manual / agent-derived 等（选项：muse / cron / manual / agent-derived / hub） |
| Target_Node | SingleSelect | （扩展）目标节点名，与 AgentCards.Node 对应（选项：home-mini / ipad / nas / grokbot / work-mba / Workbuddy-cloud / workbuddy / jarod-macbook-air / mba / hub） |
| Worker_Hint | SingleSelect | 选项：amp / agy / droid / grok-cli / hermes / local-skill / other |
| Skill_ID | Text | （扩展）要调用的技能 id，与 AgentCards.Skill_ID 对应 |
| Status | SingleSelect | A2A 八态状态机，见标准 §2；终态不可变（选项：submitted / working / input-required / auth-required / completed / failed / canceled / rejected） |
| Approval_Class | SingleSelect | （扩展）auto / notify / approve，approve 类须走审批流（标准 §8.3）（选项：auto / notify / approve） |
| Hop_Count | Number | （扩展）派生层数，>8 熔断 |
| Idempotency_Key | Text | （扩展）建单幂等键：来源+业务键 |
| Latest_Run | Text | （扩展）最新一条 Run 的 Run_ID |
| Presented | SingleSelect | （扩展）结果是否已呈递给操作者（Yes/No）（选项：Yes / No） |
| Claimed_By | Text | （扩展）认领租约：当前持有节点 |
| Heartbeat_At | Text | （扩展）认领心跳；20 分钟无心跳视为放弃、可回收 |
| Retry_Count | Number | （扩展）失败重试计数，上限 2 |
| Context_ID | Text | 会话键（A2A contextId）：同一件事的全部任务共享 |
| Status_Msg | Text | （扩展）指向当前提问/待批消息的 Msg_ID |
| Metadata | Text | A2A 原生自由字段（JSON）；非核心本地信息放这里，不新增列 |

## Messages

Message：任务内全部对话轮次，只追加，一行一消息（正文在 Parts）

| 字段 | 类型 | 说明 |
|---|---|---|
| Msg_ID | Text | 主字段。主键，同时是幂等键（重复投递靠它去重） |
| Task_ID | Text |  |
| Context_ID | Text |  |
| From_Node | Text |  |
| To_Node | Text |  |
| Role | SingleSelect | user（发起方→执行方）/ agent（执行方→发起方）（选项：user / agent） |
| Kind | SingleSelect | instruction / question / answer / auth_request / auth_decision / progress / result / notice（选项：instruction / question / answer / auth_request / auth_decision / progress / result / notice） |
| Artifact_Ref | Text | （扩展）关联的 Artifact_ID（result 消息用） |
| In_Reply_To | Text | （扩展）所回复消息的 Msg_ID，构成对话链 |
| Created_At | Text |  |
| Ref_Task_IDs | Text | A2A referenceTaskIds：本消息关联/派生的前任任务 |

## Parts

Part：消息与产物的内容块，一行一块，text/file/data 三型

| 字段 | 类型 | 说明 |
|---|---|---|
| Part_ID | Text | 主字段 |
| Parent_ID | Text | 所属消息 Msg_ID 或产物 Artifact_ID |
| Parent_Type | SingleSelect | message / artifact（选项：message / artifact） |
| Seq | Number |  |
| Kind | SingleSelect | text / file / data（A2A TextPart / FilePart / DataPart）（选项：text / file / data） |
| Text | Text | text 块正文；长内容只放指针，本体进飞书文档 |
| File_URI | Text |  |
| File_Name | Text |  |
| Mime_Type | Text |  |
| Data | Text | data 块的 JSON：任务参数、审批决定 {"decision": "approve"} 等走这里 |

## Runs

（本地表）每次执行的起止、结果与报错

| 字段 | 类型 | 说明 |
|---|---|---|
| Run_ID | Text | 主字段。形如 <Task_ID>-R<序号> |
| Task_Ref | Text |  |
| Node | Text |  |
| Worker | Text |  |
| Error_Log | Text | 失败信息；沟通内容不写这里，去 Messages |
| Started_At | Text |  |
| Finished_At | Text |  |
| Outcome | SingleSelect | succeeded / failed / paused（paused＝等补信息暂停，不计失败）（选项：succeeded / failed / paused / probe-ok） |

## Artifacts

Artifact：交付物登记，内容为其 FilePart，修订＝同名新 ID

| 字段 | 类型 | 说明 |
|---|---|---|
| Artifact_ID | Text | 主字段。建议 <Task_ID>-A<序号> |
| Task_ID | Text |  |
| Context_ID | Text |  |
| Name | Text | 产物名；同名再交付即新版本（修订＝同名新 ID） |
| Is_Final | SingleSelect | （扩展）是否终稿（Yes/No）（选项：Yes / No） |
| Created_By | Text |  |
| Created_At | Text |  |
| Description | Text |  |
| Metadata | Text |  |

## AgentCards

AgentCard 规范化展开：一行一项能力

| 字段 | 类型 | 说明 |
|---|---|---|
| Cap_ID | Text | 主字段。（扩展）行主键：CAP-<节点前缀>-<技能> |
| Node | SingleSelect | 节点名（AgentCard name 的节点部分）（选项：home-mini / ipad / nas / work-mba / work-5070ti / grokbot / node-dev / m3test / setuptest / Workbuddy-cloud / workbuddy / jarod-macbook-air / mba / hub） |
| Zone | SingleSelect | 选项：personal / unit / home / test / work |
| Description | Text | 技能说明（skill.description） |
| Skill_ID | Text | 技能 id（skill.id） |
| Side_Effect | SingleSelect | （扩展）read / write / external，决定默认审批等级（选项：read-only / write / external / read） |
| Availability | SingleSelect | （扩展）online / work-hours / offline 等在册状态（选项：24x7 / work-hours / on-demand / online / offline） |
| Dispatchable | SingleSelect | （扩展）Yes 才可派发（选项：Yes / No） |
| Daemon_Version | Text |  |
| Node_Desc | Text |  |
| Receive_Mode | SingleSelect | （扩展）唤醒方式：event / poll / automation / webhook（选项：poll / automation / webhook / event） |
| Skill_Name | Text |  |
| Input_Modes | Text |  |
| Output_Modes | Text |  |
| Default_Input_Modes | Text |  |
| Default_Output_Modes | Text |  |
| Cap_Streaming | SingleSelect | 选项：Yes / No |
| Cap_Push | SingleSelect | 选项：Yes / No |
| Cap_State_History | SingleSelect | 选项：Yes / No |
| Metadata | Text | A2A 原生自由字段（JSON）；内核登记写入 {kind, mode}，可为空 |

## Rules_路由规则

（本地表）路由与审批策略的唯一现行来源

| 字段 | 类型 | 说明 |
|---|---|---|
| Rule_ID | Text | 主字段 |
| Match_Type | Text | 按 Skill_ID 或标签匹配 |
| Target_Node | SingleSelect | 选项：home-mini / ipad / nas / grokbot |
| Worker_Hint | Text |  |
| Skill_ID | Text |  |
| Approval_Class | SingleSelect | 选项：auto / notify / approve |
| Priority | Number | 多规则命中时按优先级取一 |
| Enabled | SingleSelect | 是否生效（Yes/No）（选项：Yes / No） |
| Note | Text |  |
