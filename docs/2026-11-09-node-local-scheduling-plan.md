# 定时调度改版：实现方案（v3.6）

> 依据：`docs/2026-11-09-node-local-scheduling.md`（机主草案）＋ 2026-11-09 三方评审（内核状态机 / 标准与红线 / 实现与测试）＋ 机主追加口径。
> 本文是实现依据，实现完成时规范性内容并入 `docs/standard.md`，本文留档。
> 与草案冲突处以本文为准，冲突点见 §1。

## 1. 相对草案的修订（均已经机主确认）

| # | 草案 | 本方案 | 原因 |
|---|------|--------|------|
| 1 | 自触发任务直接写 `working` | 一律写 `submitted`，写完立刻唤醒本进程，由现行认领链路接手 | 心跳、direct 在途账本、单并发、重试退避、审批都挂在 `submitted→working` 认领路径上；直接写 `working` 会全部绕开，且无法进入 `auth-required`（只能从 `submitted` 迁入） |
| 2 | 只有「`lah` 内置调度」一种时钟 | 双时钟：终端类用 `lah` 内置调度；Agent 类（Muse、Grok 等自带 cron）用自己的定时器，到点调 `lah task begin` | Agent 自带定时器比 `lah` 靠谱的场景，不重复造轮子；Mac mini 这类 Agent 不常开的终端，`lah` 常驻时钟更靠谱 |
| 3 | Rules 三列停用 | Rules 保留为**单向观察镜像**：各节点把自己的计划摘要写进 Rules，供总览页面查看，**任何节点不从 Rules 读计划来触发** | 机主要做「全网终端定时任务总览页」 |
| 4 | `Source=cron` 由 hub 统一呈递 | 谁发起回给谁：节点呈递自己发起的单；hub 只收发起方为空或为 hub 的 cron 单 | 现状 `present.mjs:42` 对 `source==="cron"` 一律入队，与「发起方是本节点」两条规则同时命中，去重键先写者独占，结果会被吞或送错 |
| 5 | 「偏差 ≤60 秒」靠扫表顺带检查 | 守护进程内加独立定时器，到点置唤醒标志 | ws 模式下主循环可睡满 `sweepSec=900` 秒 |

## 2. 总体设计

**记录格式统一（硬规矩）**：不管谁计时，每次运行都是总线里的一条普通任务。

- `Source=cron`，`From_Node`＝`Target_Node`＝本节点（`Node_ID` 即 `node.json` 的 `node`，与 `From_Node`/`Target_Node`/`Claimed_By` 同一字符串）。
- `Idempotency_Key` ＝ `sched:<Node_ID>:<Schedule_ID>:<期次键>`，期次键格式沿用 v3.5.4：`YYYY-MM-DDThh:mm:ss±HHMM`（不带冒号）。
- 状态机、心跳、回执、审批、陈旧回收全部沿用，没有新状态、没有新列。

**时钟来源**

| | 终端类（Mac mini / MacBook Air / hub 所在机） | Agent 类（Muse、Grok 等） |
|---|---|---|
| 计时 | `lah` 守护进程 | Agent 自带定时器 |
| 到点动作 | `lah` 自动建 `submitted` 任务，本机立即认领，按 `commands.json` 模板执行 | Agent 定时器调 `lah task begin`，建 `submitted` 任务，本机守护进程认领进收件箱 |
| 计划定义 | 本机 `schedules.json` | Agent 自己的配置；用 `lah schedule register` 登记镜像 |
| 完成登记 | 现行执行层回执 | `lah inbox done|ask|fail` |

`lah task begin` 不直接写 `working`（修订 #1）：它只是「带调度语义的 `lah task create`」，保证 Agent 类也走同一条认领链路、同样有心跳与审批。

## 3. 模块设计

### 3.1 `src/schedule-cron.mjs`（新，批次 1）
把 `src/hub/schedule.mjs` 第 14–177 行的纯函数整体搬出：`parseCron`、`resolveScheduleTz`、`wallClock`、`formatOccurrenceKey`、`latestOccurrence`、`DEFAULT_SCHEDULE_TZ`。`src/hub/schedule.mjs` 改为 import 并 re-export，`tests/schedule.test.mjs` 改 import 路径，**行为零变化**。

### 3.2 `src/local-schedule.mjs`（新，批次 2）
`LocalScheduleService`，构造参数：`{ bus, node, tz, schedulesPath, statePath, now, log, createTask }`（`now`/`createTask` 可注入以便测试）。

- **读计划**：`schedules.json`（配置目录，不进仓库、不进总线）。结构 `{"schedules":[{id, enabled, cron, cap, text, approval_class?}]}`。整个文件缺失视为没有计划；**文件损坏**整体停用并记日志，进程不退出（标准 §10.5）；单条非法（缺字段、cron 不可解析、`cap` 不在本机 `commands.json`）只停用该条并记日志一次。文件中出现 `command`/`cwd`/`context`/`agent`/`mode` 等控制键整条拒收（沿用 `config.mjs` 的控制键清单，不放宽）。
- **状态**：`schedule_local_state.json`（配置目录）记 `{id, cron}` 基线与 `last_fired`。旧 `schedule_state.json` 废弃，不迁移（首次均按「无基线」只锚不触发）。
- **`tick()`**：
  1. 非法 `tz` → 记日志，本地调度整体停用，不回退宿主机时区。
  2. 对每条启用的计划算最近一期期次键。
  3. 无基线 / cron 文本变化 / 状态文件缺失或损坏 → 只锚基线，不触发（**基线优先于补期**）。基线写失败 → 本轮不触发。
  4. 已有基线且 `last_fired` ≠ 最近一期 → 触发，且只补最近一期（含守护启动后的首次 tick，即开机补期）。
  5. 触发前按幂等键查 Tasks，已有同键则只补水位线（防重启重复）。
  6. 建单走 `createTask`（`src/hub/create.mjs`）：先 instruction Message 和 Parts，最后写 Tasks 行，`Status=submitted`，`Source=cron`，`from=to=本节点`，`approval` 取计划的 `approval_class`（与 `commands.json` 的 `approval_class` 下限取严，只收紧不放宽，沿用现有生效级别逻辑，不新增放宽路径）。
  7. 建单成功后写 `last_fired`，并置本进程唤醒标志，让同一进程立刻认领。
- **多条计划串行写**，不并发。
- **direct 槽位忙**：任务落成 `submitted`，`handleTask` 现行逻辑自然排队，不会丢期。

### 3.3 内核挂接（批次 2）
- `Kernel` 持有 `localSchedule`，在 `sweepOnce` 里「能力已登记」之后、`listRecords(tasks)` 之前调用 `tick()`，保证刚建的任务在同一轮被认领。
- `tick()` 的异常只记日志，不影响扫表（沿用 present/stale 的写法）。
- **分钟定时器**：守护进程起一个 `setTimeout` 链，对齐到下一个整分钟（或下一期期次）置 `_wakeFlag = true`。hub 角色的 `HubRuntime._wakeFlag` 同样接上（`HubRuntime` 包着同一个 `Kernel`，需把 kernel 的唤醒通知接到 hub 标志，沿用现有 `kernel._notifyWake`）。`requestStop` 时清除定时器。
- 内核仍只通过 `createTask`/现行路径写总线，不写 `auth_decision` 与 `canceled`。

### 3.4 Rules 观察镜像（批次 2）
`src/schedule-mirror.mjs`：把本节点每条本地计划同步成 Rules 一行。

- `Rule_ID`＝`<Node_ID>:<Schedule_ID>`，`Target_Node`＝本节点，`Skill_ID`＝cap，`Schedule`＝cron，`Text`＝指令，`Enabled`＝Yes/No，`Last_Fired`＝最近期次键，`Note`＝机器维护摘要（上次运行任务号与状态、`同步于 <时间>`）。**不新增列**。
- **只写自己的行**（`Rule_ID` 以 `<本节点>:` 开头）；不读他人行，不读 Rules 来触发。
- 同步时机：启动、计划变更、每次触发、上次运行任务到终态、以及至少每个对账周期（15 分钟）刷新一次「同步于」（节点挂了镜像停在旧值，总览页可见）。
- 写失败只记日志，不影响调度。`node.json` 缺 `tables.rules` 映射时跳过并提示。
- 总线写量控制：只在字段变化或到刷新周期时写，不每轮全表写。

### 3.5 CLI（批次 3）
- `lah schedule add|ls|rm|enable|disable [--config <dir>]`：维护本机 `schedules.json`（写入前同样校验 cron、cap、控制键），并立即刷新镜像。
- `lah schedule register --id <id> --cron <expr> --cap <cap> [--text …]`：Agent 类登记镜像行（不进 `schedules.json`，不触发）。
- `lah task begin --schedule <id> [--period <期次键>] [--cap <cap>] --text <指令>`：Agent 定时器到点时调用。默认 `--cap agent`、`--to`/`--from` ＝本节点、`Source=cron`；`--period` 缺省取当前时刻在 `node.json` 时区下的分钟级期次键，生成 `sched:<Node_ID>:<id>:<期次键>` 作幂等键。已存在同键任务时输出已有 Task_ID，不重复建单。
- `bin/lah.mjs` 帮助文本同步。

### 3.6 hub 角色改动（批次 4）
- `src/hub/schedule.mjs`：删除 `scanCron` 及其基线读写、`routeFor`；`scan()` 只保留 `scanLater`；`later` 复查逻辑与测试 **不动**。
- `src/hub/index.mjs`：doctor 提示文案与装配同步；不再需要 `schedule_state.json` 路径。
- `src/hub/present.mjs`：`shouldPresent` 的 hub 分支改为只收「发起方为空、`hub`、`cron`」，不再因 `source==="cron"` 吞别的节点发起的单（修订 #4）。
- `lah task why`：输出补幂等键，便于确认调度来源。

### 3.7 doctor（批次 4）
`schedules.json` 存在时逐条校验：cap 在本机 `commands.json` 存在、cron 可解析、`tz` 合法、无控制键；不通过只告警，不阻断守护启动。`tz` 检查从「仅 hub」放开到所有角色（只要存在 `schedules.json`）。

## 4. 部署顺序与迁移

- **先升级 hub，再升级其它节点**：旧 hub 仍会读 Rules 里 `Enabled=Yes` 且 `Schedule` 非空的行建单，新节点一旦写镜像行就会被旧 hub 误触发，造成双跑。
- `SCHED-HUB-MORNING`：先把 Rules 旧行 `Enabled` 置 No → 在 hub 配置目录用 `lah schedule add` 落 `SCHED-HUB-MORNING`（`50 8 * * *`，cap=`agent`）并锚基线 → 次日 08:50 验证。幂等键变为 `sched:hub:SCHED-HUB-MORNING:<期次>`，切换在期次之间完成。
- 旧状态文件 `schedule_state.json` 保留不删，不再使用。

## 5. 文档同步（批次 5）

- `docs/standard.md`：§7 换入本方案规范表述（删除「时钟只在 hub」）；§8.5 呈递归属改为谁发起回给谁；§10.1 第 2 条补「节点守护可按同一写序给自己建计划任务，仍不写 `auth_decision`/`canceled`」；第 7 条改写为账本派生职责（later、陈旧观察），不含建单型调度；修订记录加 v3.6。
- `docs/configuration.md`（tz 不再标 hub 专用，新增 `schedules.json` 与 CLI 速查）、`AGENTS.md`（目录职责、禁止提交 `schedules.json` 与 `schedule_local_state.json`、调度句子）、`.gitignore`、`README.md`/`README.en.md` 涉及调度处、`config/schedules.example.json`（占位符）、`skills/lah/SKILL.md`、`src/setup.mjs` 注释、`DESIGN.md` 如涉及。
- `CHANGELOG.md` 顶部加条目；版本三处同步 bump（`package.json`、`package-lock.json`、`src/kernel.mjs` 的 `DAEMON_VERSION`）。**发版只 bump 不提交、不推送。**

## 6. 开发批次与分工

| 批次 | 内容 | 执行 | 独立验证（换模型） | 验证命令 |
|---|---|---|---|---|
| 1 | 抽 `schedule-cron.mjs`，零行为变化 | amp low | agy 3.8 Flash 只读复核 diff | 逐文件 `node --check`；`npm test` 83/83 |
| 2 | `local-schedule.mjs`、内核挂接、分钟定时器、`schedule-mirror.mjs`、新测试 | grok 4.7 | agy 3.8 Flash 评审 + amp low 补测边界 | 同上 + 新测试覆盖 T2/T4/T5/T6/T7/T8 |
| 3 | `lah schedule`、`lah task begin`、help | agy 3.8 Flash | grok 4.7 复核 | 同上 + CLI 冒烟（临时配置目录） |
| 4 | hub 停 scanCron、present 归属、doctor、`why` | grok 4.7 | amp low 复核 | 同上；`tests/schedule-scan.test.mjs` 重写为本地版；`later.test.mjs` 必须原样通过 |
| 5 | 标准、配置文档、CHANGELOG、版本 | agy 3.8 Flash | 我逐条对照 | 文档与实现逐条核对；语法检查 + `npm test` |

规则：同一时刻只有一个子 agent 写仓库，避免并发改同一批文件；评审类 agent 严格只读；每批结束由我亲自跑 `npm test` 与语法检查，通过才进入下一批；不提交、不推送。

## 7. 验收（对应草案 §9）

| 用例 | 自动化 | 说明 |
|---|---|---|
| T1 准点 | 部分 | mock 验「每期恰好一次、晚到只补最近一期」；偏差 ≤60 秒只能真机 |
| T2 重启补期 | 可 | 注入 `now()`，重建服务实例 |
| T3 hub 停机 | 可（mock）＋真机 | mock 下节点独立写账；真机场景由机主验证 |
| T4 多节点同计划 | 可 | 两个服务实例共用一个 mock 总线，幂等键含各自 Node_ID |
| T5 审批 | 可 | 到点任务先 `auth-required`，驳回不执行，批准才执行 |
| T6 基线 | 可 | 新建、改 cron 后首轮只锚基线 |
| T7 时区 | 可 | 改宿主 `TZ` 为 UTC，行为不变 |
| T8 陈旧 | 可 | 现行 stale 逻辑对本地触发任务照常生效 |
| 新增 T9 镜像 | 可 | 镜像行只写自己的、字段变化才写、挂掉后「同步于」不再更新；Rules 缺映射时跳过 |
| 新增 T10 呈递 | 可 | 节点发起的 cron 单只由该节点入队，hub 不吞 |
| 新增 T11 begin | 可 | 同键不重复建单；默认字段与幂等键格式 |

## 8. 风险与已知限制

- 部署顺序（§4）：旧 hub 在场时不要让节点写镜像行。
- 节点关机或睡眠期间该期无法执行，不做代偿（草案 §2.6）；开机后只补最近一期。
- Agent 类的防重只靠幂等键与 Agent 自己的定时器；同一计划不要同时挂 `lah` 与 Agent 两边（幂等键相同时第二个会被挡住）。
- 镜像只用现有列，「下次触发时间」「上次状态」等筛选列待总览页确认需求后，由机主先加线上列再重跑 schema 生成。
- 时钟漂移直接进期次键；doctor 不做时钟校验，生产上依赖系统 NTP。
