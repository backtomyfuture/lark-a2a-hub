# Changelog

本项目的主要变更记录如下。节点适配器版本号见 `package.json` /
`hub-node --version`；中台标准版本独立编号（现行 v3.5.1）。

## [Unreleased]

- **陈旧回收（标准 v3.5.1）**：hub 的 stale 服务由「只告警」升级为两段式——working 心跳超时 20 分钟先告警（文案同步），告警后宽限 30 分钟，心跳恢复自动撤销告警；届满仍无心跳则由 hub 置 `failed` 回收：写 notice 原路通知发起方、关未结束的 Run、清认领。回收前回读再验状态与心跳防抢写；失败保留告警记录下一轮重试，notice 复用不叠写。submitted 无人认领仍只告警。

## [0.6.0] - 2026-11-07（中台标准 v3.5：字段瘦身与总线契约）

- doctor 新增**总线契约检查**：schema/标准声明的字段、代码实际写入的单选值、本节点名必须在线上 Base 登记，缺列缺选项在自检阶段报出（针对「代码写了 Base 没有的列」类装机瘫痪）；线上多出字段、废弃选项残留、非空 default_value 只警告列出。
- 字段瘦身（标准 v3.5）：删除 Tasks.Worktree、AgentCards.Required_Assets/Tags/Examples、Messages.Metadata、Parts.Metadata；名片 Modes/capabilities/Zone/Skill_Name 收拢进 Metadata 的 `a2a` 子对象（本版双写，列观察后删）；Side_Effect 保留独立列。
- Tasks.Presented 列废弃并全面停写停读：呈递去重只认本地 present_state.json ＋线上 Tasks.Metadata.presented_keys，装机水位线改看 presented_keys；Metadata 写入先读再合并。
- `lah task create` 新增 `--idempotency-key`：调用方传入原值时节点侧重复拒收才可命中（此前 CLI 恒生成随机键）。内核幂等经双单实测：同键第二单 rejected＋notice 且不执行。
- 时间文本统一 ISO 8601 带时区偏移（Created_At 与 Runs/Heartbeat 同口径），修复跨时区节点混写导致的时间线乱序。
- 呈递门铃：present 本轮有新回执落盘时刷新配置目录 `present_bell`（mtime 即信号），供本机 Agent 以 hook/短轮询低成本感知，队列仍是唯一真相。
- schema 生成改为忠实快照：不再手工过滤选项，default_value 非空如实记录；选项污染在 Base 本体清洗、由 doctor 盯住。
- 双语 README（README.en.md）、徽章与 Issue 模板补齐。

- 评审修复（标准 §6、§10.3，不改标准）：
  - `lah reconcile` 单次对账不把命令表外的手工名片写成 `Dispatchable=No`，也不改写它们；常驻 daemon 仍停派已从命令表删除的能力；
  - 守护进程的 Receive_Mode 只有 event 或 poll。`lah setup --wake sweep` 登记 poll，轮询间隔不超过对账周期 900 秒。协议节点的 automation 只能手工登记名片；
  - 信号监听器与移除使用同一具名函数，第二次信号直接退出。hub 角色收到信号记日志并关闭长连接。`markOffline` 单张名片失败继续处理其余。停止请求早于唤醒器启动时不留长连接；
  - `lah setup --wake` 缺值或非法值在读凭据前退出 2。hub 的 `lah reconcile` 在 loadConfig 之前拒绝并退出 2。

- 已完成（中台标准 v3.4.1）：
  - inbox B01–B04：回执字段对齐 Runs schema，产物写入 file Part，ask 以 Outcome=paused 关账，重试复用 inbox-outbox 固定 ID，避免重复写 result；
  - inbox fail 语义写入标准与实现：Agent 本尊宣告无法完成时不重试，直接 failed + notice，不回 submitted、不计入 Retry_Count；
  - AgentCards.Metadata 入标准：文本、JSON 字符串，内核登记写入 `{kind, mode}`，可为空；
  - 建单过滤停派（`Dispatchable=No`）与 `Availability=offline` 的名片，自动挑选与显式 Cap_ID / Skill_ID 都在第一笔写之前拒绝；派生任务继承父 Context_ID，多个父任务不一致时拒绝并要求显式 `--context`（B08、B09）；
  - setup 修复 pollSec 被硬编码覆盖，并新增 `--skip-skill`（`lah setup` 与 `install.sh`，B10、B11）；
  - doctor：轮询/协议节点（events 关闭）缺 lark-cli 降为提示；hub 与开启事件订阅的节点仍计为问题（B06）；
  - 接入文档、协议节点手册与 lah Skill 对齐现行标准（B07）。
  - 发布 schema 补齐 AgentCards.Metadata（B05）；
  - setup 新增非交互 `--wake poll|event|sweep`；
  - 新增只读 `lah inventory` 盘点名片与任务，不做自动清库或迁移；
  - 新增 `lah reconcile` 单次回表后退出，供 webhook 或 15 分钟对账使用（B12）；
  - 重配时覆盖已有 Node_Desc，避免留下错误模式描述（B13）；
  - 常驻 daemon 收到 SIGINT/SIGTERM 时先把本节点名片 Availability 置为 offline 再退出；`lah reconcile` 单次退出不离线（B14）；
  - `lah setup --help` 打印帮助并退出，不进向导、不读凭据（B15）；
  - 锁文件补齐 `lah` bin 映射；`install.sh` 在有 package-lock.json 时改用 `npm ci`（B16）；
  - 内核提交 result/notice 时 To_Node 走 initiatorOf（首条 instruction.From_Node，否则 Source，否则 hub），不再写死 hub。
- 已知后续：线上 Base 的 Runs 漂移已清理；节点名单选项枚举的生成脚本调整仍待下一轮。审批卡批准后置回 submitted 是现行协议，本轮未改状态机。

- host 节点能力表去掉预置占位能力：
  - `lah setup` 不再种入 `echo-test`，也不再用首个 Agent 自动派生重复的 `ops-agent`；host 节点的能力只来自用户选定的本机 CLI Agent，一个 Agent 对应一项能力。未扫描到任何 Agent 时 `commands.json` 为空，`lah doctor` 给出提示；
  - `lah task create` 省略 `--cap` 时的选择规则：独立 Agent 的 `agent` 优先，其次是 `*-agent` 类能力；
  - 已有节点的存量 `commands.json` 不会被改写，需要的话手工删除对应条目，重启后其名片会被置为 `Dispatchable=No`。

- 节点类型区分（host 电脑宿主 vs agent 独立 Agent）与异步收件箱 inbox 模式（中台标准 v3.4）：
  - **`node.json` 新增 `kind: "host" | "agent"`（缺省 host，向下兼容）**：
    - `lah setup` 新增 `--kind host|agent` 参数，交互模式下提示选择电脑宿主（1=host）或独立 Agent 本尊（2=agent）；
    - **`kind: agent` 纯净独立能力注册**：setup 阶段**绝不调用 `discoverLocalAgents()`**，不扫描 PATH、不注册任何外部 CLI；唯一注册能力为 `agent`（`name` 为节点名，`mode: "inbox"`，`inbox_timeout_sec: 86400`）；
    - `kind: host` 保持现行电脑宿主行为（自动探测本机 CLI Agent，移除 `agent-inbox` 占位）；
    - `lah doctor` 与 `AgentCards` 登记按 kind 清晰展示节点类型；
    - `lah task create` 省略 `--cap` 派发给 agent 类型节点时，自动直达其 `agent` 能力；
  - **新增 `mode: "inbox"` 异步接单执行模式**：
    - 内核认领 inbox 能力任务后，将任务数据（Task_ID、Title、From_Node、指令正文、params、历史多轮问答）写入配置目录 `agent_inbox.jsonl`（600 权限），**任务保持 working 状态，不起子进程，不提前关单**；
    - 内核每轮循环对未超时的 inbox working 任务持续刷新 `Heartbeat_At`，避免 20 分钟被中台回收；支持配置 `inbox_timeout_sec`（缺省 86400 秒），超时自动置 `failed` + notice「本尊超时未处理」；
    - 中断态续跑支持：发起方调用 `lah task reply` 答复追问后，内核自动将原任务重新以 `status: "pending"` 注入 inbox，追加最新答复供 Agent 本尊继续执行；
  - **CLI 新增 `lah inbox` 全套操作命令**：
    - `lah inbox [--pop] [--json]`：读取并确认当前未处理的任务；
    - `lah inbox done --task <Task_ID> --text <结果> [--artifact <路径或URL>]`：关闭 Runs、写 result 消息原路回传发起方、关联产物，将任务标为 completed；
    - `lah inbox ask --task <Task_ID> --text <问题>`：发起追问，写 question 消息原路回传，任务转入 input-required；
    - `lah inbox fail --task <Task_ID> --text <原因>`：关闭 Runs、写 notice 消息原路回传，任务标为 failed；
    - 严格遵循红线：只能操作归属本节点且处于 working 状态的任务；node 角色不写 auth_decision 与 canceled；
  - **双向对称闭环**：
    - 独立 Agent 节点通过 `lah present --pop` 收取自己派出的任务成果，通过 `lah inbox --pop` 提取派给自己的新活，实现无缝多 Agent 双向协同。


- 容器与无 TTY 环境加固、存量任务呈递基线与通用 Agent 收件箱（中台标准 v3.3）：
  - **无 TTY / 容器与云端环境安装及服务加固**：
    - `src/service.mjs`：
      - 去掉 `WorkingDirectory=` 外层双引号包裹，避免 systemd 误判为非法相对路径而拒绝启动；
      - 自动透传当前进程 `PATH` 与网络代理环境变量（`HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy`、`ALL_PROXY`、`all_proxy`、`NO_PROXY`、`no_proxy`、`NODE_EXTRA_CA_CERTS`）至 systemd unit 与 macOS LaunchAgent plist，确保代理出站 VM 环境开机自启后直接正常连通飞书；
      - 增加启动后 `systemctl is-active` 存活核验：在 `enable --now` 后等待 800ms 校验服务状态，若未处于 active 提取 status 摘要打印告警并回退，绝不盲目报启动成功；
      - 修复 Linux 无 `systemd --user` 会话（如 Docker 容器、Agent VM 报 `No medium found` / 无 D-Bus 会话）时导致 `lah service` 报错崩溃退出；支持探测 user 会话，不可用时自动尝试写入系统级 `/etc/systemd/system/` 服务（root 或免密 sudo），若均无权限则以后台进程脱机拉起守护并输出 systemd 配置说明，返回 0 不阻断 setup；
    - `src/doctor.mjs` 与 `src/setup.mjs`：修复应用缺少 `app.info` 权限时 `checkAppEventSubscribed` 查不了静态事件订阅状态却误报「✗ 未订阅」增加 problems；细化为三态（`subscribed` / `unsubscribed` / `unknown`），`unknown` 只提示跳过静态核对不报 `✗` 不增计数，以实际长连接状态为准；
    - `src/setup.mjs`：
      - 扩充 `readLarkConfig`、`loadMasterKey` 与 `decryptLarkCliSecret` 的目录候选列表（全面纳入 `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`~/.config/lark-cli`、`~/.local/share/lark-cli`、`~/.lark-cli`、macOS Library 等）；
      - 支持 Linux 下通过 `secret-tool` 读取 `master.key`；
      - 凭据解析优先读取环境变量（`HUB_APP_SECRET`、`APP_SECRET`、`FEISHU_APP_SECRET`、`LARK_APP_SECRET` 及对应 APP_ID）或已有 `app.env`，在容器或无交互脚本中免除 `lark-cli` 交互；
      - `findLarkCliBin()` 补全全路径探测与自动调用。
  - **存量 Base 首次启动建立结果呈递水位线（Baseline）**：
    - `src/setup.mjs` 与 `src/hub/present.mjs`：存量 Base 在新节点或 Hub 首次启动时建立装机水位线（baseline），将已有终态任务（`completed` / `failed` / `rejected` / `canceled`）或已标记 `Presented="Yes"` 的存量任务 `presentKey` 初始化写入 `present_state.json`，彻底避免首启将历史已完成任务全量倾倒入 `present_queue.jsonl` 造成刷屏。
  - **区分独立 Agent 节点与编排宿主，智能能力解析**：
    - `src/setup.mjs`：`KNOWN_AGENTS` 新增 `paseo`（Paseo Agent）与 `orca`（Orca Agent）CLI 自动探测与 Agent 命令模板生成，支持本地多 Agent 编排；
    - `src/executors/agent-inbox.mjs`：新增内置通用收件箱执行器，兼具 JSON 与 Agent 两种模式，可将任务结构化记录追加至本地 `agent_inbox.jsonl` 供独立 Agent 或宿主排队消费；
    - `src/hub/create.mjs` 与 `bin/lah.mjs`：
      - `parseCreateArgv` 支持 `--skill` 作为 `--cap` 的别名；
      - `createTask` 允许传 `CAP-...` 自动反查解析为 `Skill_ID`，未指定 `--to` 时若传了 `CAP-...` 自动反查对应节点；
      - 允许省略 `--cap`：根据 `--to <node>` 自动从 `AgentCards` 挑选该节点的首选技能（优先 `ops-agent`、`agent`、非 `echo-test` 技能）。


- 按发起方原路返回结果、飞书仅发审批卡、内置并自动安装 lah Skill（中台标准 v3.2）：
  - **发起方身份与回执原路指向**：
    - 任何节点与 Agent 均可作为任务入口，`lah task create` 默认以本机为首条 `instruction` 的 `From_Node` 及 `Tasks.Source`（亦可通过 `--from` / `--source` 显式指定）；
    - `src/kernel.mjs` 新增 `initiatorOf(task)`，执行节点写回执消息（`result` / `question` / `notice`）时，`To_Node` 原路指向发起方 `From_Node`（回退 `Source` || `"hub"`）；唯独 `auth_request` 的 `To_Node` 固定为 `"hub"`（统一由主节点发飞书卡片）；
  - **结果呈递原路落盘，飞书保持静默**：
    - 飞书端只由 `role=hub` 发送 `auth-required` 交互式审批卡（以及可选的 `stale` 告警），不再往飞书发送大段纯文本结果刷屏；
    - `src/hub/present.mjs` 结果呈递按「谁发起、回给谁」原则，在收到 WebSocket 事件或对账扫表时，将属于本节点发起的任务回执（`completed` / `failed` / `rejected` / `input-required`）写入本机配置目录的 `present_queue.jsonl`（600 权限），供本机 Agent / Hook 消费并在当前对话界面直接回复用户；
    - 特殊归属：`Source="hub"` 或 `"cron"`（定时任务）的任务统一由 `role=hub` 的主节点收入其 `present_queue.jsonl`，交由主节点 Agent 汇报；
    - `Tasks` 线上状态与 `Metadata.presented_keys` 同步标记；
  - **CLI 补充多 Agent 调度子命令**：
    - `lah task create`：默认以本机为发起方；
    - `lah task reply --task <Task_ID> --text <答复内容>`：原任务追加 `answer` 消息，目标节点原位自动续跑；
    - `lah task show <Task_ID>`：输出任务状态、最新消息正文与产物列表；
    - `lah present [--pop]`：读取本机回执队列（`--pop` 读后清空），方便 Agent 轮询消费；
  - **内置并自动安装 lah Skill**：
    - 新增 `skills/lah/SKILL.md`，提供完整的多 Agent 跨节点调度标准操作指引；
    - `install.sh` 与 `src/setup.mjs` 在安装/配置时自动安装至 `~/.agents/skills/lah/SKILL.md`，终端 Agent 装完立即可用；
  - **标准与文档全面同步**：
    - 更新 `docs/standard.md`（§0、§8.5、§10.1 及修订记录 v3.2）、`docs/hub-integration.md`、`AGENTS.md`、`README.md`。

- 修复审批卡回调重复处理与空壳载荷误报问题：
  - `src/transport/ws.mjs`：
    - 禁止 `bus.log` 文本监控触发 `extraHandlers`：`_startBusLogMonitor` 与 `_dispatchBusEvent` 仅用于 `EVENT_TYPE`（多维表格变更门铃唤醒），彻底杜绝从纯文本日志产生无载荷空壳事件分发给 `card.action.trigger`；
    - 启动直连 `_startWsClient()` 前强制清理本地总线 socket 并置 `usingLocalBus = false`，保证直连 WS 与本地总线严格互斥；
    - 新增 `normalizeBusEvent()` 归一化本地总线帧，提取标准 `{ event: { operator, action }, header, _source: "bus" }` 结构，并在直连 WS 载荷中注入 `_source: "ws"`；
  - `src/hub/approval.mjs`：
    - 增强 `operatorOpenId()` 与 `actionValue()` 提取兼容性，支持多层嵌套及顶层属性提取；
    - 新增短窗口去重缓存（60s TTL）：提取 `event_id` / `decisionKey` 与已裁决卡片 `_decidedCards`，对重试投递与刚裁决卡片的重复点击静默 no-op 返回已处理，不再重复落库与误报 `stale card`；
    - 完善非机主与空载荷拒绝日志格式，输出 `source` 与 `operator_empty` 诊断字段（不打印明文 open_id）；真正过期或已被篡改的任务依然严格由 `readFresh()` 拦截并记录警告。

- CLI 重命名为 `lah` 与 Hub 角色单进程超集升级：
  - 推出统一 CLI 主入口 `lah`（`lark-a2a-hub` 缩写，`bin/lah.mjs`），`bin/hub-node.mjs` 保留并重导出 `lah` 作为 100% 向下兼容别名；`package.json` 与 `install.sh` 同步更新支持 `lah` 与 `hub-node` 双命令软链接；
  - `hub` 角色升级为 `node` 角色的**单进程超集**：
    - `src/hub/index.mjs` 内置 `Kernel` 实例，在同一事件循环中先调度执行本节点任务扫描与能力名片登记，再顺序执行审批发卡、结果呈递与陈旧任务告警；
    - 单一进程、单一配置目录（默认 `~/.hub-node`）即可兼任 Hub 枢纽与普通 Node 执行节点，彻底消除单机自建中台需维护双进程与双配置目录（`~/.hub-node-hub` 与 `~/.hub-node`）的复杂性；
    - `lah setup --role hub` 统一支持本地终端 Agent 自动扫描、`commands.json` 生成与自启服务注册；
    - 中台标准（`docs/standard.md` §0 第 6 条、§10.1）与 `README.md`、`AGENTS.md` 同步更新权威定义。

- 装机、自检与事件传输优化（复用本机 `lark-cli`、Local Event Bus 与本地 Agent 自动扫描）：
  - `install.sh` 移除预先生成空壳 `app.env` 的步骤；
  - `hub-node setup` 优先检测并复用本机 `lark-cli`（支持新版 `lark-cli` AES-256-GCM 安全存储自动解密、未初始化时自动交互式调起 `lark-cli config init`、自动探测包含 6 张标准表的多维表格 Base 作为默认值、以 `--as user` 注册并校验云文档事件订阅）；
  - `hub-node setup` 交互体验与从零装机加固：
    - 封装 `runInteractive()`，在调起 `lark-cli config init` 或 `lark-cli auth login` 时动态关闭并重建 Node `readline` 接口，解决子进程终端交互争抢 `process.stdin` 导致无法输入的问题；
    - 自动检测 User 登录态及必备 Scope（`docs:event:subscribe`、`docs:permission.member:create`），缺少时自动引导授权（移除需企业租户管理员审批的 `search:docs:read`）；
    - 自动化权限打通：在 Base 探测及拉取表列表遇到权限问题时，自动以 User 身份调用 `lark-cli drive +member-add` 将应用添加为多维表格「可管理（full_access）」协作者，实现无需手动在飞书界面点击添加协作者的一键闭环；
  - `hub-node setup` 新增本地终端 Agent 自动扫描发现：探测常见用户级路径下已安装的 CLI Agent（`claude`, `codex`, `agy`, `gemini`, `amp`, `droid`, `grok`, `hermes`, `cursor-agent`, `opencode`, `aider` 等），自动生成写入带绝对路径与标准安全字段的标准 `commands.json`（默认 `approval_class: "auto"`，由任务行 `Approval_Class` 控制是否需机主审批），并将首选主力 Agent 自动注册为通用的 `ops-agent` 能力模板；
  - `hub-node setup` 完善唤醒方式三级引导与检查：自动检测飞书开放平台应用线上版本事件订阅配置与云文档订阅状态，支持秒级长连接（ws）、Local Event Bus 复用与 45s 轮询无缝切换；
  - `hub-node doctor` 新增完整的环境与权限诊断：
    - `lark-cli` 状态检查；
    - Base 协作者编辑权限诊断提示；
    - 飞书开放平台应用线上版本是否订阅 `drive.file.bitable_record_changed_v1` 事件诊断；
    - `--as user` 云文档事件订阅状态（`is_subscribe`）自检；
    - 本机 `lark-cli` Local Event Bus（`bus.sock`）在线与复用状态检查；
  - `src/transport/ws.mjs` 秒级门铃机制增强：优先复用本机 `~/.lark-cli/events/<appId>/bus.sock` 共享长连接事件流；同时实时监控同目录下 `bus.log` 增量，通过正则提取 `drive.file.bitable_record_changed_v1` 并按 `message_id` 去重触发门铃，规避 Go SDK 本地事件总线丢弃非内置 handler 事件的问题，确保秒级事件唤醒 100% 稳定送达。

- 仓库只保留 Node。删除 `hub/` 下的 Python 枢纽（含接收端、呈递扫描、审批发卡、systemd 单元与自愈脚本）和 `schema/generate_schema.py`。Base 结构生成器改为 `schema/generate_schema.mjs`（Node >= 20、全局 `fetch`，不新增依赖）；生成物页眉字符串未改，以便与现有 `schema/base-schema.json`、`docs/base-schema.md` 逐字节一致。
- `hub-node daemon` 省略 `--role` 时与 doctor、service 一样：先读配置目录 `node.json` 的 `role`，缺省 node。
- `hub-node task create` 为现行建单入口（先写 instruction 与 Parts，最后写 Tasks 行）。Rules 自动路由仍为计划。hub 角色的呈递、审批与陈旧告警由 `src/hub/` 在同一守护进程里完成，状态文件在配置目录（`approval_state.json`、`present_state.json`、`stale_state.json`）。
- 中台标准 v3.1（hub 与 node 合一、统一传输方式；表结构不变，只改文档，
  实现在后续阶段跟进）：
  - §0：新增第 6 条，hub 是逻辑角色，不是独立进程或独立实现；第 3 条
    「只出不进」写明 webhook 只指出站通知，本项目不提供入站端点，与 §6
    Receive_Mode 枚举对齐。
  - §10.1（新增）：定义 node / hub 两个角色；hub 职责为建单（instruction
    消息 → Parts → Tasks 行，入口 `hub-node task create`）、发审批卡、
    回调校验机主、写 auth_decision（From_Node=hub、Role=user、
    In_Reply_To=当前 Status_Msg）、写 canceled、结果呈递、陈旧任务告警。
    原有枢纽约束不变，改由 hub 角色承担；角色边界：node 角色从不写
    auth_decision 与 canceled，hub 角色是唯一写方。一台机器要同时承担
    两角色就起两个守护进程、各用一个配置目录。hub 角色强制长连接
    （审批卡回调只能经长连接送达），node 角色可选 ws / poll。
  - §10.2（新增）：应用身份默认 hub 与 node 两个应用（身份隔离），也可
    共用一个应用，并写明代价（审计不可区分、权限并集、凭据泄露可冒写
    hub 决定、吊销联动）。
  - §10.3（新增）：唤醒方式定为 ws（SDK 长连接，出站）、poll（默认 45
    秒）、webhook 三种——webhook 专指飞书多维表格自动化 POST 通知（只带
    ID，Receive_Mode 统一记 `automation`，遗留选项 `webhook` 不再使用；
    本项目任何进程不主动推送），均保留 15 分钟对账兜底；Receive_Mode
    沿用现有选项，ws 记为 `event`，守护进程型节点只取 `event` / `poll`。
  - §2 canceled、§3 唤醒语义、§6 Receive_Mode、§8.3 写入方、§9 节点传输
    随之改写。
- hub 角色由 `hub-node daemon --role hub` 承载，代码在 `src/hub/` 与
  `src/transport/`。省略 `--role` 时读 `node.json` 的 `role`，缺省 node。
- 装机与运维角色适配（任务 E）：
  - `hub-node setup` 支持 `--role node|hub`（默认 node）：hub 角色收集机主 `ownerOpenId`（用于审批发卡与回调鉴权），无需 `commands.json`；尝试调用 `lark-cli` 自动完成云文档事件订阅注册，未就绪时给出清晰的一次性手动注册步骤。凭据写 600 权限的 `app.env`，不打印明文。
  - `hub-node doctor` 支持 `--role node|hub` 按角色检查：打印当前角色与唤醒方式；hub 角色不要求 `commands.json`，校验长连接模块与机主配置。
  - `hub-node service` 支持 `--role node|hub`：自启命令显式透传 `--role`，macOS（`hub-node-${role}.${node}`）与 Linux（`hub-node-${role}-${node}.service`）按角色命名服务，支持单机同时部署 hub 与 node 互不覆盖。
  - 上手指南与文档精简（README.md / CONTRIBUTING.md / install.sh）：README 上手部分重构为「加入现成中台（装 node）」与「自建中台（单机起 hub + node 双角色）」两条精简路径（各约 3 步），新增外部 bot 经飞书自动化 webhook 接入说明。
- 同步更新 `docs/architecture.md`、`docs/hub-integration.md`、`DESIGN.md`
  （§6 唤醒、§11 仓库结构）、`AGENTS.md`、`README.md`。
## [0.5.0] - 2026-11-05

- 中台标准 v3.0 补订（第二评审收敛，表结构不变；见
  `docs/reviews/2026-11-05-optimization.md`）：
  - §4/§8.1：执行失败才计入重试；执行成功但回执无效直接 failed＋notice，
    提交总线中途失败只补齐提交，均不重跑、不重做副作用。
  - §8.3：approve 类任务在认领前 submitted→auth-required；生效审批级别取
    任务行与节点 `approval_class` 中更严者；枢纽回调须校验操作者是机主；
    有效 auth_decision 须 From_Node=hub、Role=user、In_Reply_To 等于当前
    Status_Msg、以最新一条为准、只认 DataPart。
  - §8.4：Idempotency_Key 在非 failed/canceled 任务中只执行一次，重复者
    rejected＋notice 指向原任务；心跳回收计入 Retry_Count，超限 failed＋notice。
  - §8.5：呈递去重按 (Task_ID, Status_Msg)，已呈递 Msg_ID 记入 Tasks.Metadata。
  - §9：agent 输入约定，指令与数据经 `input.json` 隔离，参数带执行控制键直接拒收。
- 节点 P0/P1/P2：写状态前重读，终态或认领人已变则放手；配置目录单实例锁；
  心跳回收并入每轮对账并与收尾写串行。执行与提交分离，创建记录带
  client_token，提交中断只补齐 outbox。carrier 命令不再静默直跑，stdin
  EPIPE 不击穿进程；超时杀掉进程组，`timeout_sec` 夹在本机上限内。指令、
  问答与 FilePart 只经 `input.json`；续跑走同一套 preflight。能力表热更新，
  解析失败保留上一版。消息按轮建索引。幂等键查重；认领后开 Run、结束时关行。
- 枢纽 P0-3/P1-3/P1-8/P2-6：审批回调核对机主 open_id，未配置则拒绝；批准回
  submitted 时保留 Status_Msg。呈递全表翻页，按 (Task_ID, Status_Msg) 去重，
  键写入 Metadata；`--sweep` 作 20 分钟兜底并告警陈旧 working。审批卡展示
  待执行正文（凭据样键名脱敏），每成功一张立即落状态。自愈脚本失败打印
  BROKEN 并以非 0 退出。
- 装机与运维 P1-4/P2-5/P2-7：首装不再种下会挡住 setup 的示例配置；移除
  `--app-secret`，Secret 输入不回显，app.env 非 600 不读。doctor 把 socket
  在线与局域网可达分开，新增 `--probe`。配置加载失败打出原因、退避后以非 0
  退出。`DAEMON_VERSION` 为 `node-0.5.0`。

## 2026-11-05 — 项目更名为 lark-a2a-hub

- 项目名由 `agent-node-adapter` 更名为 `lark-a2a-hub`（同步更新 `package.json`、`package-lock.json`、`install.sh` 及文档中的仓库地址 `backtomyfuture/lark-a2a-hub`）。

## 2026-11-05 — 全量设计与枢纽参考实现公开

- 新增 `docs/`：中台标准 v3.0（standard.md）、系统架构（architecture.md）、
  Base 字段级结构（base-schema.md）、枢纽对接规范（hub-integration.md）、
  协议接入型节点运行手册（protocol-node-runbook.md）。
- 新增 `schema/`：`base-schema.json`（由运行中的 Base 经字段 API 生成）
  与生成器 `generate_schema.py`——改表后重跑即可同步文档。
- 新增 `hub/`：枢纽参考实现（总线客户端、长连接事件接收端、呈递扫描器、
  审批卡发送器、systemd 单元与自愈脚本），全部参数化、无真实凭据。
- 顶层 README 改为系统总览；新增 CONTRIBUTING 与本文件。

## [0.4.1] - 2026-11-05

- `hub-node setup` 改纯提示式：交互只问 Base 链接、节点名、在哪用
  （1 家里 / 2 公司）；能力前缀自动取节点名末段；写文件前一行汇总确认。
  参数模式不变。

## [0.4.0] - 2026-11-05

- 新增 `hub-node setup` 一键配置向导：自动安装 lark-cli（缺失时）、复用
  其已配置的飞书应用（凭据只在本机解析、绝不打印）、按表名自动发现
  Base 六表、生成 app.env / node.json / commands.json、运行 doctor、
  可选注册自启。

## [0.3.0] - 2026-11-04

- M4 carrier context：`commands.json` 条目可声明 `"context": "carrier"`，
  守护进程经本地 unix socket 交 `hub-node host` 在用户终端语境代跑
  （macOS 局域网权限场景）；carrier 离线时能力自动标离线、任务明确
  拒收，绝不静默改走直跑。doctor 增加 carrier 检查段。

## [0.2.0] - 2026-11-04

- M3 安装与自启：`install.sh` 一行安装（配置与程序分离、重跑只更新
  程序）、`hub-node doctor` 全项自检、`hub-node service` 注册/卸载
  开机自启（macOS launchd / Linux systemd 用户单元）。

## [0.1.0] - 2026-11-04

- M1/M2：内核自生产 Python 参考实现移植到 Node——认领租约与心跳、
  命令模板执行（json / agent 两模式）、能力自注册（AgentCards）、
  提问（input-required）与审批（auth-required）续跑、跳数熔断、
  幂等对账、失败重试；飞书后端含同表写冲突（1254291）与限流退避、
  长连接事件订阅唤醒＋低频对账兜底。
