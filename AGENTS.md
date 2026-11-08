# AGENTS.md — lark-a2a-hub

lark-a2a-hub：以飞书多维表格为共享总线、按 A2A 数据模型调度多 Agent 的中台。
本仓库只有 Node 实现：`lah`（主入口）与 `hub-node`（兼容别名）同时承载 node 与 hub 两个逻辑角色，另有中台标准文档。
方向（标准 v3.1 §10）：hub 角色是 node 角色的单进程超集；由 `lah daemon --role node|hub` 承载。省略 `--role` 时读该配置目录 `node.json` 的 `role`，缺省 node。`role=hub` 既像普通节点一样读取 `commands.json` 登记能力接单干活，又负责全网审批发卡、结果呈递与告警，单进程单配置目录即可搞定，无需拆两个进程。下文标「计划」的项尚未实现（目前只剩 Rules 自动路由）。

## 目录与职责

- `bin/lah.mjs` / `bin/hub-node.mjs`：CLI 分发 `setup | daemon | doctor | service | host | task (create|reply|show|why|cancel) | present`（支持 `--role node|hub`；省略时 daemon / doctor / service 读 `node.json` 的 role，缺省 node）；配置目录取 `--config <dir>` > `HUB_NODE_HOME` > `~/.hub-node`（内含 `node.json` 与 `commands.json`）。
- `src/kernel.mjs`：状态机骨架（构造、`sweepOnce`/`run` 主循环与状态迁移），唯一写任务状态的节点代码。辅助拆在 `receipt.mjs`（回执与命令模板）、`retry-state.mjs`（退避水位）、`session-store.mjs`（session.json）、`config.mjs`（配置与控制键）、`kernel-util.mjs`（日志与小工具），以及原型混入的 `kernel-direct.mjs`、`kernel-approval.mjs`、`kernel-outbox.mjs`、`kernel-metadata.mjs`。常量 `DAEMON_VERSION`、`HOP_LIMIT=8`、`MAX_RETRIES=2`、`STALE_MIN=20`（无心跳 20 分钟回收）留在本文件。写回执（result/question/notice）时 `To_Node` 原路指向发起方 `From_Node`（auth_request 除外，指向 hub）。node 与 hub 角色在扫表与事件唤醒时均通过 `PresentService` 将属于本节点发起的任务回执落入本地 `present_queue.jsonl` 原路唤醒 Agent。`context=direct` 的 json/agent 命令在 spawn 前把在途账本写到配置目录 `runs/<Task_ID>/entry.json`（不进总线）；扫表认领并 spawn 后立即返回，同一时刻只保留一条 direct 命令，结果在下一轮收口时串行写回。carrier 与 inbox 仍走同步路径。
- `src/bus/feishu.mjs`：Bitable REST 客户端（全局 `fetch`）；对 1254291 写冲突与 429/5xx 退避重试；`f1()` 把单元素数组字段取成标量。
- `src/bus/feishu-events.mjs`：长连接订阅 `drive.file.bitable_record_changed_v1`，只当门铃叫醒内核，不解析事件内容。
- `src/carrier.mjs`：carrier 语境（unix socket 上的 NDJSON，`ping` / `exec` 两种帧）。
- `src/setup.mjs` / `src/doctor.mjs` / `src/service.mjs`：装机向导、只读自检、LaunchAgent/systemd 用户级自启（均支持 `--role node|hub` 与 `--kind host|agent`）；自动安装 `lah` Agent Skill。
- `src/inbox.mjs`：独立 Agent 收件箱操作库，承载 `agent_inbox.jsonl` 的读写、心跳核验与 `lah inbox (done|ask|fail)` 总线回执。
- `src/executors/echo.mjs`：json 模式示例执行器（stdin 读信封，stdout 回显）。
- `src/hub/`：hub 角色——单进程超集（每轮扫表先由 `Kernel` 认领执行任务并登记能力，再由 `approval` 审批发卡、回调校验机主写 `auth_decision`、写 `canceled`、`present` 结果呈递到本地队列、`stale` 陈旧任务告警）。建单入口为 `lah task create`（写表前按 AgentCards 名册校验 `--to` / `--cap` 存在性），撤单入口为 `lah task cancel`，只读排障入口为 `lah task why`；`schedule` 服务除 cron 外还负责触发已完成任务的 `later` 复查。Rules 自动路由仍为计划。守护进程的 node 角色代码路径从不写 `auth_decision` 与 `canceled`；仅发起方显式执行的 `lah task cancel` 可撤自己发起的单。飞书端仅发审批交互卡，不发大段纯文本刷屏。
- `src/transport/`：唤醒工厂（`createWaker`），支持 `ws`（长连接门铃 + 卡片回调）与 `poll`（默认 45 秒）两种入站唤醒，外加 15 分钟对账定时兜底；webhook 专指飞书自动化出站 POST，本项目不主动推送。hub 角色强制 ws。
- `docs/standard.md`：**中台标准，权威**。`docs/base-schema.md` 与 `schema/base-schema.json` 是生成物，由 `schema/generate_schema.mjs` 产出。
- `config/*.example.json`：配置样例，只放占位符。
- `tests/`：`node:test` 测试（`tests/*.test.mjs`）与内存总线 `tests/mocks/`。不连真实 Base，状态只写临时目录。

## 命令（仓库里有这些；另有 npm test，基于 Node 内置 node:test，没有第三方测试框架，也没有 lint）

```sh
npm install --omit=dev                     # 唯一运行时依赖 @larksuiteoapi/node-sdk；未安装时连 -v 都会报模块缺失
# 语法检查：node --check 只检查第一个文件参数，必须逐个跑；src/**/*.mjs 在默认 shell 里会漏掉 src/*.mjs
for f in bin/*.mjs src/*.mjs src/*/*.mjs schema/*.mjs; do node --check "$f" || exit 1; done
echo '{"k":1,"_hub":{"task_id":"TASK-X"}}' | node src/executors/echo.mjs   # json 回执冒烟
node bin/lah.mjs doctor  --config <dir> [--role node|hub]   # 示例配置与真实配置各跑一遍
node bin/lah.mjs daemon  --config <dir> [--role node|hub]
node bin/lah.mjs host    --config <dir>   # carrier，只能由用户在终端里启动
node bin/lah.mjs setup   --config <dir> [--role node|hub] [--yes --base … --node … --zone … --prefix … --owner …]
node bin/lah.mjs service --config <dir> [--role node|hub] [--remove]
node bin/lah.mjs task create --config <dir> --to <node> --cap <cap_id> [--text <指令>] [--from <node>]
node bin/lah.mjs task reply --config <dir> --task <Task_ID> --text <答复内容>
node bin/lah.mjs task show <Task_ID> [--config <dir>]
node bin/lah.mjs task why <Task_ID> [--config <dir>] [--json]
node bin/lah.mjs task cancel --config <dir> --task <Task_ID> [--text <说明>]
node bin/lah.mjs present [--pop] [--config <dir>]
node bin/lah.mjs inbox [--pop] [--json] [--config <dir>]
node bin/lah.mjs inbox done --task <Task_ID> --text <结果> [--artifact <路径或URL>]
node bin/lah.mjs inbox ask  --task <Task_ID> --text <问题>
node bin/lah.mjs inbox fail --task <Task_ID> --text <原因>
APP_ID=… APP_SECRET=… HUB_BASE_TOKEN=… node schema/generate_schema.mjs   # 改表后同步 schema 文档
```

测试用 `npm test`（Node 内置 `node:test` 与 `node:assert`，仅此一种）。不要引入第三方测试框架或断言库。

## 代码约定

- Node >= 20，ESM `.mjs`，HTTP 只用全局 `fetch`。新增运行时依赖须有充分理由。
- 内核是薄壳：新能力 = `commands.json` 一条模板（`command`、`mode: agent|json|inbox`（默认 agent）、`context: direct|carrier`、`timeout_sec`（默认 600）、`cwd`（默认配置目录）、`side_effect`、`cap_id`、`name`、`desc`、可选 `resume_command`（含 `{session}` 与 `{prompt}`，仅 direct 问答续跑且本机已有 session 时替换 `command`）），启动时自动登记 AgentCards。`context`、`mode` 取值非法时认领预检直接 `rejected`，不静默降级。不往内核里塞执行器或某个 Agent 的专用代码。host 节点能力来自 commands.json 的本机命令模板；agent 节点能力只有 `agent`（inbox 模式），执行主体是节点本尊，守护进程不替它拉起任何外部 Agent。
- 读写总线一律经 `FeishuBus`，读字段用 `f1()`；写操作逐条 `await`，不对同表并发写（不用 `Promise.all` 批量写）。
- 常驻韧性：启动期任何失败都只记日志、进主循环重试，进程不退出；能力登记成功前不处理任务。
- 唤醒标志在 `run()` 扫表前清零，不在 `waitWake()` 里清（ECHO-004 竞态）；事件只是门铃，15 分钟对账扫表是兜底。
- 注释用中文，写「为什么」，沿用现有风格。
- 标准优先：实现与 `docs/standard.md` 冲突时先改标准、再改实现，并在 `CHANGELOG.md` 记一笔。
- 改表结构：先改线上 Base，再跑 `schema/generate_schema.mjs`，把生成物与代码一起提交；不手改生成物。
- 发版：同步 bump `package.json`、`package-lock.json`、`src/kernel.mjs` 的 `DAEMON_VERSION`，并在 CHANGELOG 顶部加条目。

## A2A 约束（本项目用到的部分）

- 只借数据模型，不借通信：不实现 JSON-RPC / gRPC / HTTP+JSON / SSE，不实现入站 webhook，节点只读写表。出站通知：webhook 专指飞书多维表格自动化在 Tasks 行写入后向协议接入型节点的端点 POST，只带 ID 不带正文；本项目任何进程不主动推送（标准 §10.3）。
- 状态八态，拼写固定：`submitted`、`working`、`input-required`、`auth-required`、`completed`、`failed`、`canceled`（单 l）、`rejected`。
- 节点允许的迁移：`submitted→working`（写 `Claimed_By`、`Heartbeat_At`，认领后回读校验，丢了就放手）；`working→completed | input-required | failed`；执行失败未达 `MAX_RETRIES` 或心跳超时回收时回 `submitted`（回收计入 `Retry_Count`、与执行失败共用上限，超限置 `failed` + notice；回 `submitted` 前在本机 `retry_state.json` 记退避水位，60 秒起翻倍、上限 10 分钟，水位未到本节点跳过认领、不耗重试次数）；守护重启后，在途账本显示命令进程仍在则只续心跳、不二次执行；执行成功但回执无效直接 `failed` + notice，提交总线中途失败只补齐提交，二者都不计重试、不重跑（标准 §4）；`submitted→auth-required | rejected | failed`（熔断；行级 `Approval_Class=approve` 的 `auth-required` 也可由 hub 在 `submitted` 阶段提前写 `auth_request` 并发卡，节点认领时按既有请求收敛，全程只有一条 `auth_request`，标准 §8.3）；已有 `result` 消息的 `submitted` 任务对账为 `completed`。`canceled` 只由发起方/hub 角色写。
- 终态不可变、不可重启：终态任务不得改回非终态。后续工作在同一 `Context_ID` 下新建任务，新任务首条 instruction 消息的 `Ref_Task_IDs` 指回前任。
- 中断态在原任务续跑：`question` 之后出现 `answer` 就在同一任务继续（`resumeCheck`），禁止为答问题新开任务。
- 状态与消息配套：`input-required` ↔ `question`，`auth-required` ↔ `auth_request`（`Status_Msg` 指向该 Msg_ID），`completed` ↔ `result`（有产物先登记 Artifacts），`failed` / `rejected` ↔ `notice` 说明原因。
- 审批只认 `auth_decision` 消息的 DataPart（`{"decision":"approve"}`），且须 `From_Node=hub`、`Role=user`、`In_Reply_To` 等于任务当前 `Status_Msg`，同一请求多条决定以最新一条为准；不认 TextPart 文字和任务行上的标记（标准 §8.3）。
- Messages、Parts 只追加，永不修改或删除。消息正文全在 Parts（`text` / `file` / `data` 三型，按 `Seq` 拼接）；任务参数在首条 instruction 消息的 DataPart，Tasks 表不存参数。
- ID 形态：`MSG-<任务号>-NN`、`<父ID>-P<序号>`、`<任务ID>-A<序号>`、`<任务ID>-R<序号>`。`Role` 只有 `user` / `agent`。
- 产物修订 = 同 `Name` 的新 `Artifact_ID`；内容是 FilePart 指针，大文件本体不入表。
- 本地新需求放原生 `Metadata` 字段，不新增列。

## 安全红线（借鉴 agent-autoloop，已实现或标准明确要求）

- 跳数熔断：`Hop_Count > 8` 时只写 Runs(failed) + notice 并置 `failed`，不执行。派生子任务 `Hop_Count = 父 + 1`，累加不清零（问人也不清）。
- 结构化回执，不猜自然语言：agent 模式只认输出中最后一个完整的 ```` ```agent-ask ```` 围栏（→ input-required），以及围栏外整行的 `ARTIFACT:` / `ARTIFACT_NAME:` / `USAGE:` / `SESSION:` / `LATER:`；json 模式只认 stdout 最后一行 JSON（`summary`、`artifact`、`artifact_name`、`need_input`，可选 `usage`、`session`、`later`），未知顶层键忽略并记日志。围栏内伪造的行不生效。`usage` 累计到 `Tasks.Metadata.usage`；`session` 只存本机 `runs/<Task_ID>/session.json`，不进总线，仅供同一任务问答续跑时配合本机 `resume_command` 使用；`later`（只在 completed 时生效）写入 `Tasks.Metadata.later`，由 hub 当时钟到期后在同一 `Context_ID` 新建复查任务（`Hop_Count+1`）。扩展回执语法须同时改 `buildPrompt`、`parseAgentReceipt` / `parseJsonReceipt` 与标准 §9。
- 指令与数据分离：要执行什么命令、在哪个目录、用哪个语境，只来自本机 `commands.json`。不得新增从任务参数或消息正文读取 command / cwd / context / Agent / 权限的路径；现存唯一例外是 `params.timeout_sec`，不要扩大。标准 §9 的 agent 输入约定已实现：`kernel.mjs` 把指令文本、参数、问答与 FilePart 写进本次执行的 `input.json`（600 权限），`buildPrompt` 只拼受信模板与该文件路径；参数带执行控制键（command / cwd / context / agent 等）由 `controlKeysIn` 检出后直接拒收。不得回退：不要再把指令文本、参数 JSON 或答复拼进 prompt，也不要放宽控制键拒收。
- 失败要响：carrier 离线时对应能力标 `Availability=offline`、任务置 `rejected` + notice，绝不静默改走直跑；守护进程只连接 carrier，从不拉起它。
- 只出不进：不开监听端口（carrier 的 unix socket 除外）、不做端口映射或隧道。这条对 node、hub 一律适用；webhook 只指飞书自动化出站 POST（本项目不主动推送），卡片回调同样走长连接，任何角色都不提供入站端点。
- 凭据不入仓库、不入总线、不进日志：示例只用占位符；真实值在 600 权限的 env 文件里；setup 与 doctor 不打印凭据明文。
- 角色边界：`auth_decision` 只由 hub 角色的代码路径写。`canceled`：守护进程的 node 角色代码路径从不写；仅发起方显式执行的 `lah task cancel` 可撤自己发起的单。hub 角色可撤任意单，审批驳回仍由 hub 守护进程写 `canceled`。`kernel.mjs` 与 `inbox.mjs` 不写 `canceled`。
- 建单顺序（hub 角色）：先写 instruction 消息与 Parts，最后写 Tasks 行；Tasks 行是触发信号。
- 机主审批红线：对外发消息、删改数据、花钱、提交表单、改权限的动作走 `Approval_Class=approve` 与 auth-required 流程；生效级别取任务行 `Approval_Class` 与本机 `commands.json` 的 `approval_class` 下限中更严者，本地下限只收紧不放宽。hub 角色的审批回调必须校验操作者是机主。

## 禁止事项

- 不要提交 `app.env`、`.hub-node/`，也不要提交配置目录里的 `approval_state.json`、`present_state.json`、`stale_state.json`、`schedule_state.json`、`retry_state.json`、`runs/`（在途账本、输入与命令输出），以及真实 Base token、table_id、open_id。配置目录默认是 `~/.hub-node`，也可以是 `--config` 指向的目录。
- 不要修改或删除 Messages / Parts 行，不要重开终态任务，不要给 Tasks 加参数列。
- 不要让守护进程因启动期或单轮错误退出，不要吞掉错误后假装成功。
- 不要手改 `schema/base-schema.json`、`docs/base-schema.md`。
- 不要在节点里实现 A2A HTTP 端点或任何入站服务。
- 未经要求不要提交、推送或发版。
