// hub 角色的审批中继（标准 §8.3）。
// 扫 auth-required → 给机主发一张卡；卡片回调先核对操作者是机主，
// 写之前再回读任务，确认仍是 auth-required 且 Status_Msg 没变。
// 通过后按「消息 → Parts → 任务行」写 auth_decision。认领前批准回 submitted；
// 执行中（Claimed_By 非空）保持 auth-required，由原节点核验后自己续跑。驳回置 canceled 并写 notice。
// 写操作经调用方逐条 await；本模块用一条队列串行回调，避免两张卡同时改同一张表。
// 飞书要求卡片回调大约 3 秒内返回。同步路径只做本地校验和一次回读，
// 通过就当场交回批准或驳回卡，写表放进后台。写失败或写前发现任务已变，才 PATCH 纠正卡片。

import { pickSignedDecision, publicKeyOf, signDecision } from "../approval-sign.mjs";
import fs from "node:fs";
import path from "node:path";
import { f1 } from "../bus/feishu.mjs";
import { buildCard, buildStatusCard } from "./cards.mjs";

// 同步回读的上限。飞书 3 秒预算里只留这一次读，读挂住不能把回调拖过超时。
const READ_FRESH_MS = 2000;

function toast(type, content) {
  return { toast: { type, content, i18n: { zh_cn: content } } };
}

function dig(obj, name) {
  if (obj == null || typeof obj !== "object") return undefined;
  return obj[name];
}

export function extractEventId(data) {
  if (!data || typeof data !== "object") return "";
  const id = data.event_id
    ?? data.header?.event_id
    ?? data.uuid
    ?? data.open_message_id
    ?? data.event?.header?.event_id
    ?? data.payload?.header?.event_id
    ?? data.payload?.event_id;
  if (id) return String(id).trim();
  return "";
}

export function operatorOpenId(data) {
  if (!data || typeof data !== "object") return "";
  const candidates = [
    data,
    data.event,
    data.payload,
    data.payload?.event,
    data.data,
    data.data?.event,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const op = c.operator;
    if (op && typeof op === "object") {
      const id = op.open_id ?? op.openId ?? op.user_id;
      if (id) return String(id).trim();
    } else if (typeof op === "string" && op.trim()) {
      return op.trim();
    }
    const directId = c.open_id ?? c.openId ?? c.user_id;
    if (directId) return String(directId).trim();
  }
  return "";
}

export function actionValue(data) {
  if (!data || typeof data !== "object") return {};
  const candidates = [
    data,
    data.event,
    data.payload,
    data.payload?.event,
    data.data,
    data.data?.event,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const act = c.action;
    let val = act && typeof act === "object" ? act.value : c.value;
    if (typeof val === "string") {
      try { val = JSON.parse(val); } catch { /* 继续 */ }
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return val;
    }
  }
  return {};
}

// PATCH 用的是消息 id，不是 header.token，也不是卡片延时更新 token。
export function cardMessageId(data) {
  if (!data || typeof data !== "object") return "";
  const layers = [
    data.event,
    data.payload?.event,
    data.data?.event,
    data.payload,
    data.data,
    data,
  ];
  for (const layer of layers) {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) continue;
    const ctx = layer.context;
    if (ctx && typeof ctx === "object") {
      const id = ctx.open_message_id ?? ctx.openMessageId ?? ctx.message_id;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
    if (!(layer.action || layer.operator || layer.context)) continue;
    const direct = layer.open_message_id ?? layer.openMessageId;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }
  return "";
}

function nowIso() {
  // 与 kernel.nowStr 同一口径：本地时间 ISO 8601 带时区偏移。
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}`;
}

function msgSeq(msg) {
  const id = String(f1(msg, "Msg_ID") ?? "");
  const matched = id.match(/-(\d+)$/);
  return matched ? Number(matched[1]) : -1;
}

// 用已有最大序号 + 1。按条数 + 1 会在缺号时撞上已有 Msg_ID。
function nextMsgId(taskId, msgs) {
  let max = 0;
  for (const msg of msgs) {
    const n = msgSeq(msg);
    if (n > max) max = n;
  }
  const seq = max + 1;
  return `MSG-${String(taskId).replace("TASK-", "")}-${String(seq).padStart(2, "0")}`;
}

function bumpMsgId(msgId) {
  const matched = String(msgId).match(/^(.*-)(\d+)$/);
  if (!matched) return msgId;
  return matched[1] + String(Number(matched[2]) + 1).padStart(matched[2].length, "0");
}

export class ApprovalService {
  constructor({ bus, ownerOpenId = "", statePath, log, now = nowIso, dedupWindowMs = 60_000, signKey = null }) {
    // hub 的签名私钥（KeyObject）。有它就给每条决定签名，节点按固定公钥验签（标准 §8.3 第 5 条）。
    this.signKey = signKey;
    this.bus = bus;
    this.ownerOpenId = String(ownerOpenId ?? "").trim();
    this.statePath = statePath;
    this.log = log ?? (() => {});
    this.now = now;
    this.dedupWindowMs = Number(dedupWindowMs) > 0 ? Number(dedupWindowMs) : 60_000;
    this._tail = Promise.resolve();
    this._recentEvents = new Map();
    this._decidedCards = new Map();
    // 正在写表的卡。回调已经返回，第二次点击不能再开一轮决定。
    this._inflight = new Map();
  }

  _purgeExpired(map) {
    const now = Date.now();
    for (const [key, val] of map.entries()) {
      const ts = typeof val === "number" ? val : val?.ts;
      if (!ts || now - ts > this.dedupWindowMs) {
        map.delete(key);
      }
    }
  }

  enqueue(fn) {
    const run = this._tail.then(fn, fn);
    this._tail = run.then(() => {}, () => {});
    return run;
  }

  // 回调本身不等写表。测试要等后台决定落定再读总线。
  whenIdle() {
    return this._tail;
  }

  loadState() {
    if (!this.statePath) return {};
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return {};
      this.log("approval_state.json 读失败，本轮不发卡，避免把已发出的卡整批重发：" + e.message);
      return null;
    }
  }

  saveState(state) {
    if (!this.statePath) return;
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
  }

  alreadySent(state, recordId, statusMsg) {
    const row = state?.[recordId];
    return !!(row?.card_sent && row.status_msg === statusMsg);
  }

  // 没有待发卡的任务就不拉 Messages/Parts。每成功一张立刻落盘。
  async scan() {
    const owner = String(this.ownerOpenId ?? "").trim();
    if (!owner) {
      this.log("hub 未配置机主 open_id，跳过审批发卡");
      return 0;
    }
    const state = this.loadState();
    if (state == null) return 0;
    const tasks = await this.bus.listRecords(this.bus.tables.tasks);
    const pending = [];
    for (const task of tasks) {
      if (f1(task, "Status") !== "auth-required") continue;
      const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
      if (!statusMsg) {
        this.log("skip card: " + f1(task, "Task_ID") + " Status_Msg 为空，不发无法对上决定的卡");
        continue;
      }
      if (this.alreadySent(state, task.record_id, statusMsg)) continue;
      pending.push(task);
    }
    if (!pending.length) return 0;
    const messages = await this.bus.listRecords(this.bus.tables.messages);
    const parts = await this.bus.listRecords(this.bus.tables.parts);
    let sent = 0;
    for (const task of pending) {
      const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
      const res = await this.bus.sendCard(owner, buildCard(task, messages, parts));
      state[task.record_id] = {
        card_sent: true,
        message_id: res?.message_id ?? "",
        status_msg: statusMsg,
      };
      this.saveState(state);
      sent += 1;
      this.log("card sent for " + f1(task, "Task_ID"));
    }
    return sent;
  }

  async handleCardAction(data) {
    try {
      return await this._accept(data);
    } catch (e) {
      this.log("card action error: " + (e?.message ?? e));
      return toast("error", "处理失败，请重试");
    }
  }

  _rawCard(info, patch) {
    return { type: "raw", data: buildStatusCard(info, patch) };
  }

  _terminalResponse(entry) {
    return {
      ...toast("info", "该审批已处理"),
      card: this._rawCard(entry.value, {
        state: entry.state,
        operator: entry.operator,
        at: entry.at,
        note: entry.note ?? "",
      }),
    };
  }

  // 本地校验之后只读一次任务行。通过就标成已决定并立刻交回终态卡，写表不挡回调。
  async _accept(data) {
    this._purgeExpired(this._recentEvents);
    this._purgeExpired(this._decidedCards);

    const eventId = extractEventId(data);
    const src = data?._source || "unknown";
    const owner = String(this.ownerOpenId ?? "").trim();
    const operator = operatorOpenId(data);
    if (!owner) {
      this.log("WARN card action rejected: owner open_id is unset");
      return toast("error", "未配置机主，已拒绝。");
    }
    if (operator !== owner) {
      this.log(`WARN card action rejected: operator is not owner (source=${src}, operator_empty=${!operator})`);
      return toast("error", "只有机主可以审批。");
    }
    const value = actionValue(data);
    const recordId = String(value.record_id ?? "").trim();
    const decision = String(value.decision ?? "").trim();
    const cardTaskId = String(value.task_id ?? "").trim();
    const cardStatusMsg = String(value.status_msg ?? "").trim();
    if (!recordId) return toast("error", "卡片缺少任务记录，已拒绝。");
    if (decision !== "approve" && decision !== "reject") {
      return toast("error", "无法识别的审批决定，已拒绝。");
    }
    if (!cardStatusMsg) return toast("error", "卡片缺少所批的 Status_Msg，已拒绝。");

    const decisionKey = `${recordId}|${cardStatusMsg}|${decision}|${operator}`;
    const cardKey = `${recordId}|${cardStatusMsg}`;
    // 同一次点击的并发回调要等第一笔回读结束。单线程里占坑发生在任何 await 之前。
    for (;;) {
      const pending = this._inflight.get(cardKey);
      if (!pending) break;
      await pending.done;
      const later = this._decidedCards.get(cardKey);
      if (later) return this._terminalResponse(later);
    }
    const decided = this._decidedCards.get(cardKey);
    if (decided) return this._terminalResponse(decided);
    if (eventId && this._recentEvents.has(eventId)) {
      return toast("info", "该审批已处理");
    }
    if (this._recentEvents.has(decisionKey)) {
      return toast("info", "该审批已处理");
    }

    let release = () => {};
    const done = new Promise((resolve) => { release = resolve; });
    this._inflight.set(cardKey, { done });
    try {
      let preview;
      try {
        preview = await this._readFreshLimited(recordId, cardTaskId, cardStatusMsg);
      } catch (e) {
        this.log("card read failed: " + (e?.message ?? e));
        return toast("error", "处理失败，请重试");
      }
      if (!preview.ok) {
        const at = this.now();
        return {
          ...toast(preview.type === "error" ? "error" : "info", preview.content),
          card: this._rawCard(value, { state: "expired", operator, at, note: preview.content }),
        };
      }
      const at = this.now();
      const state = decision === "approve" ? "approved" : "rejected";
      const ctx = {
        cardKey,
        decisionKey,
        eventId,
        value,
        operator,
        messageId: this._messageId(data, recordId, cardStatusMsg),
        recordId,
        decision,
        cardTaskId,
        cardStatusMsg,
      };
      const card = this._rawCard(value, { state, operator, at, note: "" });
      this._markDecided(ctx, { state, note: "", at });
      this.enqueue(() => this._finish(ctx));
      return {
        ...toast("info", state === "approved" ? "已批准" : "已驳回"),
        card,
      };
    } finally {
      this._inflight.delete(cardKey);
      release();
    }
  }

  _messageId(data, recordId, statusMsg) {
    const fromEvent = cardMessageId(data);
    if (fromEvent) return fromEvent;
    const state = this.loadState();
    const row = state?.[recordId];
    if (!row || String(row.status_msg ?? "") !== statusMsg) return "";
    return String(row.message_id ?? "").trim();
  }

  _readFreshLimited(recordId, cardTaskId, cardStatusMsg) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("readFresh timeout")), READ_FRESH_MS);
    });
    return Promise.race([
      this.readFresh(recordId, cardTaskId, cardStatusMsg),
      timeout,
    ]).finally(() => clearTimeout(timer));
  }

  _markDecided(ctx, { state, note, at }) {
    const ts = Date.now();
    this._decidedCards.set(ctx.cardKey, {
      ts,
      decision: ctx.decision,
      value: ctx.value,
      operator: ctx.operator,
      state,
      at,
      note: note ?? "",
    });
    this._recentEvents.set(ctx.decisionKey, ts);
    if (ctx.eventId) this._recentEvents.set(ctx.eventId, ts);
  }

  // 写失败或任务已变之后允许重试。事件去重键也要摘掉，否则 60 秒内点不了第二次。
  _clearDecided(ctx) {
    this._decidedCards.delete(ctx.cardKey);
    this._recentEvents.delete(ctx.decisionKey);
    if (ctx.eventId) this._recentEvents.delete(ctx.eventId);
  }

  async _publishCard(messageId, info, patch) {
    let card;
    try {
      card = buildStatusCard(info, patch);
    } catch (e) {
      this.log("status card build failed: " + (e?.message ?? e));
      return;
    }
    if (!messageId) {
      this.log("card update skipped: 没有 message_id");
      return;
    }
    if (typeof this.bus.patchInteractiveCard !== "function") {
      this.log("card update skipped: 总线不能更新消息");
      return;
    }
    try {
      await this.bus.patchInteractiveCard(messageId, card);
    } catch (e) {
      // 审批结果以表为准。卡片没换掉只记一笔。
      this.log("card update failed: " + (e?.message ?? e));
    }
  }

  async _correctCard(ctx, state, note) {
    this._clearDecided(ctx);
    await this._publishCard(ctx.messageId, ctx.value, {
      state,
      operator: ctx.operator,
      at: this.now(),
      note: note ?? "",
    });
  }

  async _finish(ctx) {
    const { recordId, decision, cardTaskId, cardStatusMsg } = ctx;
    try {
      const preview = await this.readFresh(recordId, cardTaskId, cardStatusMsg);
      if (!preview.ok) {
        await this._correctCard(ctx, "expired", preview.content);
        return;
      }
      const taskId = f1(preview.task, "Task_ID");
      const messages = (await this.bus.listRecords(this.bus.tables.messages))
        .filter((msg) => f1(msg, "Task_ID") === taskId);
      // 列表和第一笔写之间再读一次。过期卡在这里被拒绝，不会留下 auth_decision。
      const fresh = await this.readFresh(recordId, cardTaskId, cardStatusMsg);
      if (!fresh.ok) {
        await this._correctCard(ctx, "expired", fresh.content);
        return;
      }
      const task = fresh.task;
      const statusMsg = fresh.statusMsg;
      const claimed = String(f1(task, "Claimed_By") ?? "").trim();
      // 执行中的审批批准后任务行不动，内存去重一丢（重启）就拦不住重复点击。
      // 这一类已有验签通过的决定就不再写第二条。认领前的审批不在此列：它的状态写可能中途失败，
      // 重试要靠追加决定再补一次状态写。
      if (claimed && await this.validDecisionFor(task, messages, statusMsg) !== null) {
        await this._correctCard(ctx, "expired", "该审批已处理");
        return;
      }
      // 失败重试时照样追加一条决定，不看之前写没写过：同一请求以最新一条为准（标准 §8.3），
      // 而上一轮可能只写了消息没写签名 DataPart，或机主这次改了主意。
      const decisionId = nextMsgId(taskId, messages);
      await this.writeDecision(task, decisionId, statusMsg, decision);
      if (decision === "reject") {
        await this.writeNotice(task, bumpMsgId(decisionId), statusMsg);
      }

      const again = await this.readFresh(recordId, cardTaskId, cardStatusMsg);
      if (!again.ok) {
        this.log("card action: 决定消息已写入，但任务在落状态前变化，不再改任务行 " + taskId);
        await this._correctCard(ctx, "expired", again.content);
        return;
      }

      if (decision === "approve") {
        // 认领前（Claimed_By 为空）才回 submitted；执行中改回 submitted 会让原节点整段重跑，
        // 所以执行中的批准只留下签名决定，由原节点核验后自己续跑。
        // 保留 Status_Msg，节点用它核对 In_Reply_To。后续终态靠新 presentKey
        // 再次呈递，不再清 Presented 列（v3.5 已废弃，见标准 §10.2）。
        if (!claimed) {
          await this.bus.updateRecord(this.bus.tables.tasks, recordId, {
            Status: "submitted",
            Status_Msg: statusMsg,
          });
        }
      } else {
        await this.bus.updateRecord(this.bus.tables.tasks, recordId, {
          Status: "canceled",
        });
      }
    } catch (e) {
      const message = String(e?.message ?? e).slice(0, 100);
      this.log("card action error: " + message);
      await this._correctCard(ctx, "failed", message);
    }
  }

  // 与 kernel.decisionForRequest 同一套：有私钥就推导公钥，伪造的无签名行不当作已处理。
  async validDecisionFor(task, messages, requestId) {
    const taskId = f1(task, "Task_ID");
    const candidates = (messages || []).filter((m) =>
      f1(m, "Kind") === "auth_decision" &&
      f1(m, "From_Node") === "hub" &&
      f1(m, "Role") === "user" &&
      f1(m, "In_Reply_To") === requestId)
      .sort((a, b) => (this.msgNewer(a, b) ? -1 : 1));
    const parts = await this.bus.listRecords(this.bus.tables.parts);
    const packed = candidates.map((m) => {
      const data = {};
      for (const p of parts) {
        if (f1(p, "Parent_ID") !== f1(m, "Msg_ID") || f1(p, "Kind") !== "data" || !f1(p, "Data")) continue;
        try { Object.assign(data, JSON.parse(f1(p, "Data"))); } catch { /* 坏数据跳过 */ }
      }
      return { decision: String(data.decision ?? ""), sig: data.sig };
    });
    let key = "";
    if (this.signKey) {
      try { key = publicKeyOf(this.signKey); } catch { key = ""; }
    }
    return pickSignedDecision(key, taskId, requestId, packed);
  }

  msgTime(m) {
    const raw = String(f1(m, "Created_At") ?? "").trim().replace(" ", "T");
    const ts = Date.parse(raw);
    return Number.isNaN(ts) ? 0 : ts;
  }

  msgNewer(a, b) {
    const ds = msgSeq(a) - msgSeq(b);
    if (ds !== 0) return ds > 0;
    return this.msgTime(a) >= this.msgTime(b);
  }

  async readFresh(recordId, cardTaskId, cardStatusMsg) {
    const task = await this.bus.getRecord(this.bus.tables.tasks, recordId);
    if (!task) return { ok: false, type: "error", reason: "missing", content: "任务不存在，已拒绝。" };
    const taskId = String(f1(task, "Task_ID") ?? "");
    if (cardTaskId && taskId !== cardTaskId) {
      this.log("WARN card action rejected: task_id does not match record");
      return { ok: false, type: "error", reason: "mismatch", content: "卡片与任务编号不一致，已拒绝。" };
    }
    const status = String(f1(task, "Status") ?? "");
    const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
    if (status !== "auth-required" || statusMsg !== cardStatusMsg) {
      this.log("WARN card action rejected: stale card for " + (taskId || recordId));
      return { ok: false, type: "info", reason: "expired", content: "任务状态已变化或审批已过期，未处理。" };
    }
    return { ok: true, task, statusMsg };
  }

  async writeDecision(task, msgId, statusMsg, decision) {
    const text = decision === "approve"
      ? "approved：操作者已在审批卡批准。"
      : "rejected：操作者已在审批卡驳回。";
    await this.bus.createRecord(this.bus.tables.messages, {
      Msg_ID: msgId,
      Task_ID: f1(task, "Task_ID"),
      Context_ID: f1(task, "Context_ID"),
      From_Node: "hub",
      To_Node: f1(task, "Target_Node"),
      Role: "user",
      Kind: "auth_decision",
      In_Reply_To: statusMsg,
      Created_At: this.now(),
    });
    await this.bus.createRecord(this.bus.tables.parts, {
      Part_ID: msgId + "-P1",
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: text,
    });
    await this.bus.createRecord(this.bus.tables.parts, {
      Part_ID: msgId + "-P2",
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 2,
      Kind: "data",
      Data: JSON.stringify(this.signKey
        ? {
          decision,
          alg: "ed25519",
          sig: signDecision(this.signKey, { taskId: f1(task, "Task_ID"), requestId: statusMsg, decision }),
        }
        : { decision }),
    });
  }

  async writeNotice(task, msgId, statusMsg) {
    await this.bus.createRecord(this.bus.tables.messages, {
      Msg_ID: msgId,
      Task_ID: f1(task, "Task_ID"),
      Context_ID: f1(task, "Context_ID"),
      From_Node: "hub",
      To_Node: f1(task, "Target_Node"),
      Role: "agent",
      Kind: "notice",
      In_Reply_To: statusMsg,
      Created_At: this.now(),
    });
    await this.bus.createRecord(this.bus.tables.parts, {
      Part_ID: msgId + "-P1",
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: "机主已在审批卡驳回，任务取消。",
    });
  }
}
