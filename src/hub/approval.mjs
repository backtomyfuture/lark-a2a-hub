// hub 角色的审批中继（标准 §8.3）。
// 扫 auth-required → 给机主发一张卡；卡片回调先核对操作者是机主，
// 写之前再回读任务，确认仍是 auth-required 且 Status_Msg 没变。
// 通过后按「消息 → Parts → 任务行」写 auth_decision，批准回 submitted，驳回置 canceled 并写 notice。
// 写操作经调用方逐条 await；本模块用一条队列串行回调，避免两张卡同时改同一张表。

import fs from "node:fs";
import path from "node:path";
import { f1 } from "../bus/feishu.mjs";
import { buildCard } from "./cards.mjs";

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
  constructor({ bus, ownerOpenId = "", statePath, log, now = nowIso, dedupWindowMs = 60_000, kernel = null }) {
    this.bus = bus;
    this.ownerOpenId = String(ownerOpenId ?? "").trim();
    this.statePath = statePath;
    this.log = log ?? (() => {});
    this.now = now;
    this.dedupWindowMs = Number(dedupWindowMs) > 0 ? Number(dedupWindowMs) : 60_000;
    this.kernel = kernel || null;
    this._tail = Promise.resolve();
    this._recentEvents = new Map();
    this._decidedCards = new Map();
    this._kernelMissLogged = false;
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
    await this.primeRowApprovals(tasks);
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

  hubKernel() {
    return this.kernel || null;
  }

  // 只处理任务行 Approval_Class=approve。本机 commands.json 的下限 hub 看不见，仍等节点认领时触发。
  // 发卡仍走下面的 auth-required 通道，去重键是 record_id + Status_Msg，不另做一套。
  async primeRowApprovals(tasks) {
    const kernel = this.hubKernel();
    if (!kernel || typeof kernel.primeSubmittedApproval !== "function") {
      if (!this._kernelMissLogged) {
        this._kernelMissLogged = true;
        this.log("hub 审批提前发卡未接上内核，本轮只给已是 auth-required 的任务发卡");
      }
      return 0;
    }
    let n = 0;
    for (const task of tasks) {
      if (f1(task, "Status") !== "submitted") continue;
      if (String(f1(task, "Approval_Class") ?? "").trim() !== "approve") continue;
      if (String(f1(task, "Claimed_By") ?? "").trim()) continue;
      try {
        const res = await kernel.primeSubmittedApproval(task);
        if (res?.status === "auth-required" && res.msgId) {
          task.fields = { ...(task.fields || {}), Status: "auth-required", Status_Msg: res.msgId };
          n += 1;
        }
      } catch (e) {
        // 单条失败留下 submitted，下一轮再试。不能挡住同轮其他任务的发卡。
        this.log("row approval prime failed " + f1(task, "Task_ID") + ": " + (e?.message ?? e));
      }
    }
    return n;
  }

  handleCardAction(data) {
    return this.enqueue(() => this._handle(data));
  }

  async _handle(data) {
    try {
      return await this._decide(data);
    } catch (e) {
      this.log("card action error: " + (e?.message ?? e));
      return toast("error", "处理失败：" + String(e?.message ?? e).slice(0, 100));
    }
  }

  async _decide(data) {
    this._purgeExpired(this._recentEvents);
    this._purgeExpired(this._decidedCards);

    const eventId = extractEventId(data);
    if (eventId && this._recentEvents.has(eventId)) {
      return toast("info", "该审批已处理。");
    }

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
    if (this._recentEvents.has(decisionKey)) {
      return toast("info", "该审批已处理。");
    }

    const cardKey = `${recordId}|${cardStatusMsg}`;
    if (this._decidedCards.has(cardKey)) {
      return toast("info", "该审批已处理。");
    }

    const preview = await this.readFresh(recordId, cardTaskId, cardStatusMsg);
    if (!preview.ok) return toast(preview.type, preview.content);

    const taskId = f1(preview.task, "Task_ID");
    const messages = (await this.bus.listRecords(this.bus.tables.messages))
      .filter((msg) => f1(msg, "Task_ID") === taskId);
    // 列表和第一笔写之间再读一次。过期卡在这里被拒绝，不会留下 auth_decision。
    const fresh = await this.readFresh(recordId, cardTaskId, cardStatusMsg);
    if (!fresh.ok) return toast(fresh.type, fresh.content);
    const task = fresh.task;
    const statusMsg = fresh.statusMsg;
    const decisionId = nextMsgId(taskId, messages);
    await this.writeDecision(task, decisionId, statusMsg, decision);
    if (decision === "reject") {
      await this.writeNotice(task, bumpMsgId(decisionId), statusMsg);
    }

    const again = await this.readFresh(recordId, cardTaskId, cardStatusMsg);
    if (!again.ok) {
      this.log("card action: 决定消息已写入，但任务在落状态前变化，不再改任务行 " + taskId);
      return toast("info", "任务状态已变化或审批已过期，未改任务状态。");
    }

    const now = Date.now();
    this._decidedCards.set(cardKey, { ts: now, decision });
    this._recentEvents.set(decisionKey, now);
    if (eventId) {
      this._recentEvents.set(eventId, now);
    }

    if (decision === "approve") {
      // 保留 Status_Msg，节点认领前用它核对 In_Reply_To。后续终态靠新 presentKey
      // 再次呈递，不再清 Presented 列（v3.5 已废弃，见标准 §10.2）。
      await this.bus.updateRecord(this.bus.tables.tasks, recordId, {
        Status: "submitted",
        Status_Msg: statusMsg,
      });
      return toast("success", "已批准，任务重新入队执行。");
    }
    await this.bus.updateRecord(this.bus.tables.tasks, recordId, {
      Status: "canceled",
    });
    return toast("info", "已驳回，任务取消。");
  }

  async readFresh(recordId, cardTaskId, cardStatusMsg) {
    const task = await this.bus.getRecord(this.bus.tables.tasks, recordId);
    if (!task) return { ok: false, type: "error", content: "任务不存在，已拒绝。" };
    const taskId = String(f1(task, "Task_ID") ?? "");
    if (cardTaskId && taskId !== cardTaskId) {
      this.log("WARN card action rejected: task_id does not match record");
      return { ok: false, type: "error", content: "卡片与任务编号不一致，已拒绝。" };
    }
    const status = String(f1(task, "Status") ?? "");
    const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
    if (status !== "auth-required" || statusMsg !== cardStatusMsg) {
      this.log("WARN card action rejected: stale card for " + (taskId || recordId));
      return { ok: false, type: "info", content: "任务状态已变化或审批已过期，未处理。" };
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
      Data: JSON.stringify({ decision }),
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
