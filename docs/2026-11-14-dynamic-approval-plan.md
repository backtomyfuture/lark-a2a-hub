# 动态审批流改造方案：执行侧按需发起审批（未发布，随标准 v3.7 修订记录）

> 依据：机主需求 + 2026-11-14 Grok 4.7 代码评审修订（已全部吸收阻塞项与竞态修补）。
> 背景：现行审批机制是「hub 在 `submitted` 阶段抢跑拦截（`primeRowApprovals`）+ 节点 `preflight()` 静态门禁」，而任务进入 `working` 后没有向中台发起 `auth-required` 审批卡的协议通道。
> 目标流程：**hub 正常发单（`submitted`） → 具体节点/Agent 认领执行 → Agent 判断需要审批时主动发起 `auth-required` → 机主在飞书审批卡批完 → 原节点/Agent 从断点继续完成。**

---

## 1. 核心原则与 `Approval_Class` 边界（对齐标准 §8.3 / §10.1）

| 维度 | 现行实现 | 改造后 |
|---|---|---|
| Hub 职责 | `ApprovalService.scan()` 在 `submitted` 阶段调 `primeRowApprovals()` 抢跑代写 `auth_request` 并发卡 | **停止抢跑**：hub 不再在 `submitted` 阶段拦截发卡，只对已是 `auth-required` 的任务发审批卡、鉴权回调并写带 ed25519 签名的 `auth_decision` |
| `Approval_Class` 静态门禁 | 行级（hub 抢跑 + 节点 `preflight`）＋ 本机 `commands.json` 下限 | **保留为节点侧认领前硬门**：`commands.json` `approval_class=approve` 与任务行显式 `Approval_Class=approve`（如 `--approval approve`、定时计划、`later` 继承）继续由目标节点 `preflight()` 拦截；**普通任务默认不传 `approve`**，直接入 `working` 由执行侧动态决定 |
| 动态审批时机 | 无 | 新增 **`working -> auth-required` 运行中动态发起**，由执行中的 Agent 按实际待执行动作决定 |
| 卡片正文内容 | 原始指令与参数摘要 | 执行节点写入的 `auth_request` 正文：**具体要执行的高危动作、目标对象、影响范围与风险** |
| 批准后流转 | 一律回 `Status=submitted` | **认领前审批（`Claimed_By` 为空）** 仍回 `submitted`；**执行中动态审批（`Claimed_By` 非空）** 保持 `auth-required`，由原节点核验签名决定后自行切回 `working` 续跑 |

> 说明：`src/local-schedule.mjs` 与 `src/hub/schedule.mjs`（`later` 继承 `Approval_Class`）保持现行规则不变；停掉的仅是 hub 在节点认领前代写 `auth_request` 抢跑。

---

## 2. 状态机、竞态防护与去重设计

### 2.1 状态迁移与两条不混用的恢复路径

```
[认领前静态门（Claimed_By=""）]
submitted ──(preflight 拦截, scope="preflight")──▶ auth-required
                                                        │
        ┌───(reject: hub 写 auth_decision + notice)─────┴───▶ canceled
        └───(approve: hub 写 auth_decision, 置 submitted)──▶ submitted ──(节点认领 execute)──▶ working

[运行中动态审批（Claimed_By="<node>"）]
submitted ──(节点认领)──▶ working
                            │
                            ├──(Agent 触发动态审批: 保留 Claimed_By, 清 Heartbeat_At, Runs=paused, 写 scope="dynamic" auth_request)
                            ▼
                      auth-required
                            │
                            ├──(reject: hub 写 auth_decision + notice)──▶ canceled
                            │
                            └──(approve: hub 写 auth_decision, 保持 auth-required & Claimed_By 不变)
                                  │
                                  ▼ (原节点 resumeAuthCheck 核验有效签名决定)
                          ┌───────┴────────┐
                      [inbox]          [direct / carrier]
                   由 resumeAuthCheck   保持 auth-required 交给 execute(task)
                   置 working 并再验     由 execute() 抢占 working 并再验决定
                   决定后写入收件箱       按 entering status 自动计算 resume=true
```

**两条恢复路径严格分离（消除状态写反冲突）**：
1. **`inbox` 模式**：`resumeAuthCheck(task)` 在非审批校验通过后，自己完成 `auth-required -> working`（`requireOwner = true`）及写入后二次核验，再调用 `enqueueOrUpdateInbox`，不调用 `execute()`。
2. **`direct` / `carrier` 模式**：`resumeAuthCheck(task)` **不改任务状态**（保持 `auth-required`），先检查 `this._directFlight` 是否占槽（若占槽则推迟续跑，与 `resumeCheck` 一致），再将仍为 `auth-required` 的 `task` 交给 `execute(task)`。`execute()` 允许源状态为 `["submitted", "input-required", "auth-required"]`（后两者 `requireOwner = true`），且在写入 `working` 前按进入时的状态计算 `resume = (origStatus === "input-required" || origStatus === "auth-required")`。

### 2.2 四项竞态与安全防线

1. **Hub `_decide()` 写决定前基于总线验签去重（解决保持 `auth-required` 导致的重复点击/跨重启重放）**：
   - 因 `Claimed_By` 非空时批准后任务仍停在 `auth-required` 且 `Status_Msg` 不变，`readFresh` 仍能读到原任务，60 秒内存缓存 `_decidedCards` 不够用。
   - 在 `ApprovalService._decide()` 查完 `messages` 后、写 `auth_decision` 之前，**必须复用与 `decisionForRequest` 同一套验签逻辑**（有 `hubPublicKey` 或 `signKey` 时推导公钥验签）检查 `statusMsg` 下是否已存在任意一条有效 `auth_decision`（无论 `approve` 还是 `reject`）。
   - 若已存在有效决定，直接返回 `toast("info", "该审批已处理。")`，不再写第二条决定、也不改任务行。未通过验签的伪造行不算已处理。
2. **节点写 `working` 后的防覆盖校验（解决 `updateTaskState` 非 CAS 与 `canceled`/后到拒绝的竞争）**：
   - 节点在把 `auth-required` 写成 `working` 之前，**先记下当前的 `statusMsg`**（更新 `Heartbeat_At: nowStr()`，**此时不清空 `Status_Msg`**，保留对当前决定的指针绑定）。
   - 写入 `working` 之后、spawn 子进程或 `enqueueOrUpdateInbox` 之前，**必须再回读一次任务行与总线消息**，同时校验三项：
     1. 回读的任务行仍为 `Status === "working" && Claimed_By === this.cfg.node`（若已被写成终态如 `canceled` 或失主，立刻停手、不执行）；
     2. `this.decisionForRequest(freshTask, msgs, statusMsg) === "approve"`（注意比较的是决定值，不是 `Status_Msg` 字段值）；
     3. 消息列表中**不存在** `Kind === "notice" && f1(m, "In_Reply_To") === statusMsg`（`lah task cancel` 和 hub 驳回都会写此类 `notice`，批准不会；因此即便节点的后到 `updateRecord` 把刚落库的 `canceled` 盖回 `working`，也能靠此条察觉已撤单）。
   - 任一失败：绝不执行（不 spawn、不写收件箱），清理本机 `session.json`（`dropSession`）。若此时任务行已被自己写成 `working`（非终态且 `Claimed_By === this.cfg.node`），立即写入一条 `notice` 并将任务置 `failed`（`Outcome=failed`）；节点仍然绝不写 `canceled`。
3. **静态门与动态门的请求隔离（消除 `preflight` 死循环与误放行）**：
   - `authRequestToken(taskId, scope = "")`：当 `scope` 为空时**严格保留**原哈希输入 `"lah-auth-request\0" + taskId`；动态审批传入唯一且确定的 `scope`（本次执行段的 `runId`），生成的 `client_token` 仍格式化为标准 UUID 形状（sha256 切片 `8-4-4-4-12`），绝不直接把 `runId` 原文当 `client_token`。
   - 动态审批写入的 `auth_request` 附加一条 `Kind: "data"` 的 Part：`{"scope":"dynamic","run_id":"..."}`（`cards.mjs` 只拼 `Kind === "text"`，对卡片无影响）。
   - 节点 `preflight()` 的 `askApproval()` / `preflightAuthRequestOf()` **只认静态门请求**（加载相关消息的 Parts 并排除 `scope === "dynamic"` 的 `auth_request`），避免一次动态审批批准后绕过本机 `commands.json` 的静态下限，也避免一次动态驳回卡死重跑、或把静态门送进无限重新发卡循环。
   - **从 `auth-required` 恢复（`resumeAuthCheck`）时，绝不再调用完整的 `preflight()` / `askApproval()`**：改为抽出共用纯检查函数 `preflightChecks(task, caps, allowed)`（含幂等查重、跳数上限、能力存在性、控制键拦截、`context`/`mode` 合法性、carrier 在线校验），允许 `allowed` 包含 `"auth-required"`。`inbox` 与 `direct`/`carrier` 两个分支均先通过 `preflightChecks(..., ["auth-required"])`，不通过直接返回不继续。
4. **`NeedAuth` 原子顺序与稳定 `runId` 作用域**：
   - `direct` 账本模式下，`entry.json` 在启动飞行时即持久化本次 `runId`。写入动态 `auth_request` 时**必须使用已有的 `flight.runId`**（严禁使用 `writeRun(..., "paused")` 的返回值，因 `writeRun` 在 Run 已是 `paused` 时会新建下一个 Run；也**严禁使用 `randomUUID()` 回退**），保证跨崩溃/重启与重试期间 `authRequestToken(taskId, runId)` 恒定不变、不会发出第二张审批卡。
   - 仅当 `auth_request` 与 Tasks 更新为 `auth-required` **均写入成功**后，才删除 `runs/<Task_ID>/entry.json` 并释放 `_directFlight`（与 `NeedInput` 一致）。若写入失败，保留 `entry.json` 以便下一轮重试收口，且重启后从 `entry.json` 读回同一个 `runId`。
   - `carrier` / 同步路径无 `entry.json` 在途账本：`execute()` 开始时先确立并沿用本次执行的 `openRunId` 传给 `writeDynamicAuthRequest`；需注明若状态未写成 `auth-required` 前进程崩溃，`carrier` 路径与现行 `NeedInput` 一样会整段重跑（不为此引入额外账本）。

---

## 3. 分模块改动清单

### 3.1 Hub 侧（`src/hub/approval.mjs`、`src/hub/cards.mjs`、`src/hub/index.mjs`）
1. `src/hub/approval.mjs`：
   - `scan()` 移除 `await this.primeRowApprovals(tasks)` 调用，停止在 `submitted` 阶段提前抢跑发卡。
   - `_decide()` 在拉取 `messages` 后，调用共享验签逻辑检查当前 `statusMsg` 是否已有有效 `auth_decision`，有则拦截返回 `toast("info", "该审批已处理。")`。
   - `_decide()` 批准 branch：读出最新 `task` 的 `Claimed_By`；为空时按原逻辑写 `Status: "submitted", Status_Msg: statusMsg`；**非空时保持 `Status: "auth-required"` 与 `Status_Msg: statusMsg` 不变**，返回 `toast("success", "已批准，等待执行节点继续处理。")`。
   - `ApprovalService` 构造函数可由 `signKey` 导出公钥（或传入 `hubPublicKey`）供总线决定验签使用。
2. `src/hub/cards.mjs`：
   - `buildCard()` 中当 `Claimed_By` 非空时在卡片展示字段注明 `阶段：执行中请求授权（${claimedBy}）`，否则显示 `执行前审批`。
3. `src/hub/index.mjs`：
   - 清理或更新“行级审批提前发卡”的过时注释。

### 3.2 内核审批与收口（`src/kernel-approval.mjs`、`src/kernel.mjs`、`src/kernel-direct.mjs`）
1. `src/kernel-approval.mjs`：
   - `authRequestToken(taskId, scope = "")`：空 `scope` 沿用 `"lah-auth-request\0" + taskId`；非空 `scope` 用 `"lah-auth-request\0" + taskId + "\0" + scope` 并格式化成合法 UUID。
   - `preflightAuthRequestOf(task, msgs)`：必须显式批量加载相关 `auth_request` 消息的 Parts，排除带 `data` Part `scope === "dynamic"` 的动态审批请求；`askApproval()` 仅匹配静态门请求。
   - 新增 `writeDynamicAuthRequest(task, reason, runId)`：要求传入已确定的稳定 `runId`（**严禁使用 `|| randomUUID()` 回退**，缺失 `runId` 直接视为异常或在上层确定）；写入 `Kind: "auth_request"`（`From_Node: this.cfg.node, To_Node: "hub", Role: "agent"`, `clientToken: this.authRequestToken(taskId, runId)`），Part 1 为 `text`（`reason.slice(0, 4000)`，不与 `approvalBody` 混用），Part 2 为 `data`（`{"scope":"dynamic","run_id": runId}`）。需考虑 `winner` 回读逻辑（同 `client_token` 重试命中时沿用已有 `Msg_ID` 并确保 Parts 存在）。
   - 新增 `collectApprovedAuths(task)`：遍历该任务全部 `Kind === "auth_request"`，对每条请求调用 `decisionForRequest(task, msgs, mid)`，仅收集返回 `"approve"` 的请求正文与决定摘要（只认验签通过的决定）。
   - 把“已有有效决定去重”的验签逻辑抽成可被 `ApprovalService` 与 `Kernel` 共用的纯函数（如放在 `src/approval-sign.mjs` 或 `src/kernel-approval.mjs` 导出）。
2. `src/kernel.mjs`：
   - 从 `preflight()` 拆出 `preflightChecks(task, caps, allowed)`（不含 `askApproval`），供 `preflight()` 与 `resumeAuthCheck()` 共用；**`resumeAuthCheck` 对 `inbox` 与 `direct` / `carrier` 两个分支均必须先调用 `preflightChecks(task, caps, ["auth-required"])`**，若失败（已落 `rejected` 或需中止）直接返回，不调用 `enqueueOrUpdateInbox` 或 `execute()`。
   - 抽取共用复核函数（如 `verifyApprovedAndUncanceled(taskId, statusMsg)`）：在写 `working` 之前记下 `statusMsg`（不清空 `Status_Msg`）；写入 `working` 并回读 `check` 确认 `Status === "working" && Claimed_By === this.cfg.node` 后，重读消息校验 `decisionForRequest(freshTask, msgs, statusMsg) === "approve"` 且**不存在** `Kind === "notice" && In_Reply_To === statusMsg` 的消息。若任一校验失败且行已被自己写成 `working`，立即写入 `notice` 并将任务置 `failed`、`dropSession(taskId)`，绝不执行。
   - `execute(task, extraAnswers = null)`：
     - 进入时计算 `const origStatus = f1(task, "Status"); const statusMsg = f1(task, "Status_Msg"); const resume = origStatus === "input-required" || origStatus === "auth-required";`。
     - 认领 allowed 列表扩为 `["submitted", "input-required", "auth-required"]`，`requireOwner` 为 `origStatus === "input-required" || origStatus === "auth-required"`。
     - 写入 `working`（`Heartbeat_At: nowStr()`，**不清空 `Status_Msg`**）并回读 `check` 后，若 `origStatus === "auth-required"`，**在拉起命令之前调用上述 `verifyApprovedAndUncanceled` 校验**（防 `updateTaskState` 覆盖并发的 `reject` / `canceled`）。
     - 同步执行（`carrier` 等非 `usesDirectLedger` 路径）在执行前捕获并沿用本次执行的稳定 `openRunId`；其 `catch` 块增加 `if (e instanceof NeedAuth)` 处理：写 `writeRun(..., "paused", ...)`、传 `openRunId` 调 `writeDynamicAuthRequest(...)`、置 `Status: "auth-required", Status_Msg: mid, Heartbeat_At: ""`（不清除 `Claimed_By`）、`applyUsage`、清重试水位。（注：`carrier` 无 `entry.json` 在途账本，若更新 `auth-required` 前进程崩溃，下一轮按既有行为与 `NeedInput` 一样整段重跑。）
   - `buildPrompt(inputPath, entry)`：补充 ```` ```agent-auth ```` 围栏回执说明。
   - `writeAgentInput()` 与 `prepareCommand()`（`json` 信封分支）：均注入 `approvals: await this.collectApprovedAuths(task)`。
   - `reclaimStale()`：当任务仍处于 `working`（尚未落成 `auth-required`）且本地 `agent_inbox.jsonl` 为 `waiting-auth` 时，与 `waiting-answer` 同等对待：只续心跳，不误回收回 `submitted`。
   - `sweepOnce()`：
     - 扫描 `Target_Node === this.cfg.node && Status === "auth-required" && Claimed_By === this.cfg.node`，调用 `resumeAuthCheck(t)`；
     - 扫描属于本节点且已进入终态（尤其是 `canceled` / `failed` / `rejected`）的任务：若本机仍残留非终态的 `agent_inbox.jsonl` 条目（`pending`/`acked`/`waiting-answer`/`waiting-auth`）或 `runs/<Task_ID>/session.json`，立即同步清理（标为对应终态并 `dropSession(taskId)`）。
3. `src/kernel-direct.mjs`：
   - 启动直跑写入 `entry.json` 时即固化并持久化 `flight.runId`（重启后从 `entry.json` 读回同一个 `runId`）。
   - `finishFlightFromOutput()` 增加 `if (e instanceof NeedAuth)` 分支：
     - `persistSession(taskId, e.session)`；
     - `writeRun(current, "paused", flight.started, "auth-required: " + String(e.message).slice(0, 400))`（不使用其返回值作为 token scope）；
     - 传 `flight.runId` 调 `writeDynamicAuthRequest(current, String(e.message), flight.runId)`；
     - `updateTaskState(current, { Status: "auth-required", Latest_Run: rid, Status_Msg: mid, Heartbeat_At: "" }, ["working"], true)`（保留 `Claimed_By`）；
     - 仅当 `ok === true` 时才 `applyUsage`、清重试水位、清理 `entry.json` 与释放 `clearFlight(flight)`（与 `NeedInput` 对称）。

### 3.3 回执解析（`src/receipt.mjs`）
1. 新增 `export class NeedAuth extends Error {}`。
2. `parseAgentReceipt`：
   - 将 ```` ```agent-ask ```` 与 ```` ```agent-auth ```` 视作同一序列中的中断围栏，取**最后一个完整围栏**：
     - 命中 `agent-ask`：按原逻辑抛 `NeedInput`；
     - 命中 `agent-auth`：若块内正文 trim 后为空，抛 `InvalidReceipt("agent-auth 缺少审批说明")`；否则记录忽略 `LATER:` 并抛 `NeedAuth(body)`（带 `usage`、`session`）。
3. `parseJsonReceipt`：
   - `JSON_RECEIPT_KEYS` 加入 `"need_auth"`。
   - 在检查 `need_input` 之前先校验：`if (res.need_input && res.need_auth)` 抛 `InvalidReceipt("need_input 与 need_auth 不能同时存在")`。
   - 若 `res.need_auth` 非空（转字符串 trim 非空，空串不触发；若显式非字符串或空空白按需要处理），记录忽略 `LATER:` 并抛 `NeedAuth(String(res.need_auth).trim())`（带 `usage`、`session`）。

### 3.4 独立 Agent 收件箱与 CLI（`src/inbox.mjs`、`bin/lah.mjs`）
1. `src/inbox.mjs`：
   - `OP_SPEC` 新增 `auth: { msgKind: "auth_request", outcome: "paused", taskStatus: "auth-required" }`。
   - `errorLogFor` 增加 `op === "auth"` → `"auth-required: " + ...`。
   - `ensureMessage` 当 `plan.op === "auth"` 时，`To_Node` 固定设为 `"hub"`（而非 `plan.recipient`），`Role` 为 `"agent"`，并追加一条 `data` Part：`{"scope":"dynamic","run_id": plan.runId}`（使用 `tokens.partData` 幂等补齐；`plan.runId` 在生成 outbox 计划时一次性固化）。
   - `taskFieldsOf`：已有 `if (plan.op !== "ask") fields.Heartbeat_At = "";`，对 `auth` 自动清空心跳并保留 `Claimed_By`。
   - `handleInboxAuth({ bus, configDir, node, taskId, text })`：**在任何总线写之前**（生成 outbox 计划或发起请求前）就先将本地 `agent_inbox.jsonl` 条目标记为 `waiting-auth`（防止写总线期间 `lah inbox --pop` 仍能取走 `pending`），在 `rememberLocal` 中再补充 `auth_msg_id`、`auth_reason`、`auth_requested_at`。要求 `text` 非空。
   - `inbox-outbox/<Task_ID>.json` 沿用「一次一计划」防覆盖约束（若已有未完成的 `done`/`ask`/`fail` 计划，拒绝覆盖并提示重试原命令）。
2. `src/kernel.mjs`（`resumeAuthCheck` 的 `inbox` 分支）：
   - 先记下当前 `statusMsg = f1(task, "Status_Msg")`，通过 `preflightChecks(..., ["auth-required"])`；
   - 写入 `working`（`Heartbeat_At: nowStr()`，`requireOwner = true`，**不清空 `Status_Msg`**）；
   - 调用与 direct 相同的写入后双检（回读确认 `Status === "working" && Claimed_By === this.cfg.node`、`decisionForRequest(freshTask, msgs, statusMsg) === "approve"` 且无 `In_Reply_To === statusMsg` 的 `notice`；任一失败则写 `notice` + 置 `failed`、`dropSession` 并中止）；
   - 调用 `enqueueOrUpdateInbox` 恢复为 `status: "pending"`，**显式刷新 `claimed_at: Date.now()`**（防止等待审批期间耗尽 86400 秒 `inbox` 超时），并写入 `auth_decision: { status: "approved", request_msg_id, request_text, decided_at }` 与 `approvals` 列表。
3. `bin/lah.mjs`：
   - 新增 `lah inbox auth --task <Task_ID> --text <审批说明> [--config <dir>]` 子命令与帮助文本。

### 3.5 可观测性、文档与测试
1. `src/why.mjs`：
   - 补读本地 `agent_inbox.jsonl` 中该任务状态（如 `waiting-auth` 及审批请求摘要），并在 `auth-required` 已有有效 `approve` 决定时提示「已批准，等待原节点续跑」。
2. 文档同步（批次 1 先于或同步代码）：
   - `docs/standard.md`：更新 §0 第 4 条、§2 状态图、§3 消息、§4 `paused` 说明、§8.1、§8.3（停用 hub 抢跑、动态 `auth-required`、多次请求 `client_token`、批准后按 `Claimed_By` 分流——含在 `input-required` 上触发静态门后因 `Claimed_By` 非空走动态 `resume=true` 续跑的说明）、§10.1 第 3 条、§10.4 `lah inbox auth`；补注 host 无头 CLI 的软约束边界。
   - `docs/configuration.md`、`AGENTS.md`、`skills/lah/SKILL.md`、`CHANGELOG.md`（未发布条目）。
3. 测试：
   - 重写 `tests/approval-prime.test.mjs`（锁定新行为：hub 不再在 `submitted` 阶段替节点发 `auth_request` / 改状态；节点认领前仍遵守显式行级/本地 `approve` 下限）。
   - 新增动态审批测试覆盖：
     - `direct` (`agent` + `json`) 与 `carrier` 触发 `NeedAuth` → hub 发卡 → `Claimed_By` 非空批准后**不写 `submitted`** → 原节点 `resumeAuthCheck` 切回 `working` 并带 `approvals` / `resume_command` 续跑；
     - `inbox` 模式 `lah inbox auth` → 写总线前即标 `waiting-auth` 不可再 `pop` → 批准后刷新 `claimed_at` 恢复 `pending` 并带批准上下文；
     - 同一任务多次动态审批（不同 `runId` 不撞 `client_token`，第二轮也能正常发卡并验签），且 `writeRun` 已有 `paused` Run 后第二次 `finishFlightFromOutput` 重试仍复用同一个 `flight.runId` 不发第二张卡；
     - `NeedAuth` 与 `NeedInput` 围栏先后顺序 / JSON 同时出现拒收 / 空 `agent-auth` 拒收；
     - 伪造无签名或错签名 `auth_decision` 不触发续跑，且不阻断 hub 再次处理合法点击；
     - 同一 `Status_Msg` 已处理后再点卡片按钮被总线验签拦截（幂等返回已处理）；
     - 节点与 hub/cancel 竞态：**严格按「节点先读到 `auth-required` → `cancel`/`reject`（写 `notice` + 改状态）先落总线 → 节点后写的 `working` 覆盖原行」时序**，验证节点写后双检能识别 `notice` / 非 `approve` 拦截执行并落 `failed`（不启动命令 / 不入收件箱）；
     - `direct` 槽忙时推迟 `resumeAuthCheck` 续跑；
     - `canceled` 后清理本地 `session.json` 与 `agent_inbox.jsonl` 条目（不再被 `pop`）。
