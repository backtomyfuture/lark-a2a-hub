// hub 角色的陈旧任务告警与回收（标准 §10.1 第 6 条，v3.5.1）。
// working：心跳为空、无法解析，或早于 20 分钟（与节点 STALE_MIN 一致）→ 先
// 告警机主；告警后宽限 30 分钟，心跳恢复则撤销告警，届满仍无心跳由 hub 置
// failed 回收（清认领、关未结束的 Run、写 notice 说明）。submitted：仍无人
// 认领且已超过 20 分钟，只告警不回收。Tasks 没有创建时间，submitted 的龄
// 能解析到首条 instruction 的 Created_At 就用它，否则从本进程第一次看见该
// 任务起算。告警去重与宽限计时记在配置目录的 stale_state.json，不进仓库。

import fs from "node:fs";
import path from "node:path";
import { f1 } from "../bus/feishu.mjs";

export const STALE_MIN = 20;
export const STALE_GRACE_MIN = 30;
const STALE_MS = STALE_MIN * 60_000;
const GRACE_MS = STALE_GRACE_MIN * 60_000;

// 与 kernel.nowStr 同一口径：本地时间 ISO 8601 带时区偏移。
function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}`;
}
const HB_OFF = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)([+-])(\d{2})(\d{2})$/;

export function parseHeartbeat(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const sec = Math.abs(value) > 10_000_000_000 ? value / 1000 : value;
    return new Date(sec * 1000);
  }
  let text = String(value).trim();
  if (!text) return null;
  const matched = HB_OFF.exec(text);
  if (matched) {
    let head = matched[1].replace(" ", "T");
    if (head.length === 16) head += ":00";
    text = `${head}${matched[2]}${matched[3]}:${matched[4]}`;
  } else {
    text = text.replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) text += ":00";
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isStaleWorking(heartbeat, now = new Date()) {
  const ts = parseHeartbeat(heartbeat);
  if (!ts) return true;
  const ref = now instanceof Date ? now : new Date(now);
  return ref.getTime() - ts.getTime() > STALE_MS;
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const alerted = Array.isArray(parsed?.alerted)
      ? parsed.alerted.filter((k) => typeof k === "string")
      : [];
    const seen = {};
    if (parsed?.seen && typeof parsed.seen === "object" && !Array.isArray(parsed.seen)) {
      for (const [key, value] of Object.entries(parsed.seen)) {
        const n = Number(value);
        if (Number.isFinite(n)) seen[key] = n;
      }
    }
    // alerted_at：每条 working 告警的发出时刻（宽限倒计时起点）。旧版状态文件
    // 没有这一段，缺失的条目在 scan 里按「本轮首次看见」补记，宽限重新起算。
    const alertedAt = {};
    if (parsed?.alerted_at && typeof parsed.alerted_at === "object" && !Array.isArray(parsed.alerted_at)) {
      for (const [key, value] of Object.entries(parsed.alerted_at)) {
        const n = Number(value);
        if (Number.isFinite(n)) alertedAt[key] = n;
      }
    }
    return { alerted, seen, alertedAt };
  } catch (e) {
    if (e.code === "ENOENT") return { alerted: [], seen: {}, alertedAt: {} };
    return { alerted: [], seen: {}, alertedAt: {}, broken: e.message };
  }
}

function writeState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ alerted: state.alerted, seen: state.seen, alerted_at: state.alertedAt }, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function instructionAgeMs(messages, taskId, nowMs) {
  let oldest = null;
  for (const msg of messages) {
    if (String(f1(msg, "Task_ID") ?? "") !== taskId) continue;
    if (f1(msg, "Kind") !== "instruction") continue;
    const ts = parseHeartbeat(f1(msg, "Created_At"));
    if (!ts) continue;
    if (oldest == null || ts.getTime() < oldest) oldest = ts.getTime();
  }
  if (oldest == null) return null;
  return nowMs - oldest;
}

function alertText(kind, task) {
  const taskId = String(f1(task, "Task_ID") ?? "");
  const target = String(f1(task, "Target_Node") ?? "") || "-";
  if (kind === "working") {
    const hb = String(f1(task, "Heartbeat_At") ?? "").trim();
    return [
      "【陈旧任务】执行中的任务心跳超时",
      `编号：${taskId}`,
      `目标节点：${target}`,
      `心跳：${hb || "（无）"}`,
      `已超过 ${STALE_MIN} 分钟没有心跳，或心跳缺失。枢纽先告警：若 ${STALE_GRACE_MIN} 分钟内仍无心跳恢复，任务将被置 failed 回收；心跳恢复则自动撤销告警。`,
    ].join("\n");
  }
  return [
    "【陈旧任务】已提交的任务无人认领",
    `编号：${taskId}`,
    `目标节点：${target}`,
    `已超过 ${STALE_MIN} 分钟仍是 submitted，且没有 Claimed_By。枢纽只告警，不改状态。`,
  ].join("\n");
}

export class StaleService {
  constructor({ bus, ownerOpenId = "", statePath, log, now = () => Date.now() }) {
    this.bus = bus;
    this.ownerOpenId = String(ownerOpenId ?? "").trim();
    this.statePath = statePath;
    this.log = log ?? (() => {});
    this.now = now;
  }

  // 宽限届满的回收：置 failed + notice + 关未结束的 Run + 清认领。动手前回读
  // 任务再验一次状态与心跳，避免与刚恢复的节点抢写；校验不过就放弃本轮。
  async reclaim(task) {
    const taskId = String(f1(task, "Task_ID") ?? "");
    const fresh = await this.bus.getRecord(this.bus.tables.tasks, task.record_id);
    if (!fresh || String(f1(fresh, "Status") ?? "") !== "working") return false;
    if (!isStaleWorking(f1(fresh, "Heartbeat_At"), new Date(Number(this.now())))) return false;
    const target = String(f1(fresh, "Target_Node") ?? "") || "-";
    const messages = (await this.bus.listRecords(this.bus.tables.messages))
      .filter((m) => String(f1(m, "Task_ID") ?? "") === taskId);
    let maxSeq = 0;
    let initiator = "";
    for (const m of messages) {
      const match = /-(\d+)$/.exec(String(f1(m, "Msg_ID") ?? ""));
      if (match) maxSeq = Math.max(maxSeq, Number(match[1]));
      if (f1(m, "Kind") === "instruction" && !initiator) {
        initiator = String(f1(m, "From_Node") ?? "").trim();
      }
    }
    if (!initiator) initiator = String(f1(fresh, "Source") ?? "").trim() || "hub";
    const noticeText = [
      `【陈旧回收】任务在 ${target} 的心跳已停止：超过 ${STALE_MIN} 分钟无心跳时枢纽已告警，`,
      `${STALE_GRACE_MIN} 分钟宽限内仍未恢复。枢纽已将任务置 failed 并回收认领、关账未结束的 Run。`,
      "原节点若事后恢复，其迟到回执将按终态守卫处理；需要重跑请按同一 Context_ID 新建任务。",
    ].join("");
    // 上一轮回收若在写完 notice 后中断，重试时复用那条 notice 而不是再写一条：
    // Messages 只追加，多余的回收说明会让呈递与审计都变脏。
    const existing = messages.find((m) => f1(m, "Kind") === "notice" && String(f1(m, "From_Node") ?? "") === "hub");
    let msgId = existing ? String(f1(existing, "Msg_ID") ?? "") : "";
    if (!msgId) {
      msgId = `MSG-${taskId.replace("TASK-", "")}-${String(maxSeq + 1).padStart(2, "0")}`;
      const createdMsg = await this.bus.createRecord(this.bus.tables.messages, {
        Msg_ID: msgId, Task_ID: taskId, Context_ID: f1(fresh, "Context_ID"),
        From_Node: "hub", To_Node: initiator, Role: "agent", Kind: "notice",
        Artifact_Ref: "", In_Reply_To: "", Created_At: nowIso(),
      });
      // createRecord 回的是飞书原始响应，record_id 在 record 里（与 kernel._asRow 同口径）。
      const newId = createdMsg?.record?.record_id || createdMsg?.record_id || "";
      if (!newId) throw new Error("notice 消息写入失败");
    }
    const parts = (await this.bus.listRecords(this.bus.tables.parts))
      .filter((p) => String(f1(p, "Parent_ID") ?? "") === msgId);
    if (!parts.some((p) => String(f1(p, "Part_ID") ?? "") === `${msgId}-P1`)) {
      await this.bus.createRecord(this.bus.tables.parts, {
        Part_ID: `${msgId}-P1`, Parent_ID: msgId, Parent_Type: "message",
        Seq: 1, Kind: "text", Text: noticeText, File_URI: "", File_Name: "", Mime_Type: "", Data: "",
      });
    }
    const runs = await this.bus.listRecords(this.bus.tables.runs);
    for (const run of runs) {
      if (String(f1(run, "Task_Ref") ?? "") !== taskId) continue;
      if (String(f1(run, "Finished_At") ?? "").trim()) continue;
      await this.bus.updateRecord(this.bus.tables.runs, run.record_id, {
        Finished_At: nowIso(), Outcome: "failed",
        Error_Log: `陈旧回收：心跳停止超 ${STALE_MIN} 分钟告警，${STALE_GRACE_MIN} 分钟宽限内未恢复`,
      });
    }
    await this.bus.updateRecord(this.bus.tables.tasks, fresh.record_id, {
      Status: "failed", Status_Msg: msgId, Claimed_By: "", Heartbeat_At: "",
    });
    this.log("stale reclaimed " + taskId);
    return true;
  }

  async scan() {
    if (!this.statePath) {
      this.log("陈旧告警没有状态文件路径，本轮跳过，避免无法去重仍发消息");
      return 0;
    }
    const state = readState(this.statePath);
    if (state.broken) this.log("stale_state.json 读失败，本轮按未告警处理：" + state.broken);
    const alerted = new Set(state.alerted);
    const nowMs = Number(this.now());
    const tasks = await this.bus.listRecords(this.bus.tables.tasks);
    const submittedIds = [];
    for (const task of tasks) {
      if (f1(task, "Status") !== "submitted") continue;
      if (String(f1(task, "Claimed_By") ?? "").trim()) continue;
      const taskId = String(f1(task, "Task_ID") ?? "");
      if (taskId) submittedIds.push(taskId);
    }
    let messages = null;
    if (submittedIds.some((id) => !alerted.has(`${id}\tsubmitted`))) {
      messages = await this.bus.listRecords(this.bus.tables.messages);
    }
    const due = [];
    const reclaimDue = [];
    const liveSubmitted = new Set();
    let seenDirty = false;
    for (const task of tasks) {
      const taskId = String(f1(task, "Task_ID") ?? "");
      if (!taskId) continue;
      const status = String(f1(task, "Status") ?? "");
      if (status === "working") {
        const key = `${taskId}\tworking`;
        if (!isStaleWorking(f1(task, "Heartbeat_At"), new Date(nowMs))) {
          // 心跳已恢复：撤销告警与宽限计时，下次再超时重新走一遍完整流程。
          if (alerted.has(key)) {
            alerted.delete(key);
            state.alerted = state.alerted.filter((k) => k !== key);
            delete state.alertedAt[key];
            seenDirty = true;
            this.log("stale recovered " + taskId + "（心跳恢复，告警撤销）");
          }
          continue;
        }
        if (!alerted.has(key)) {
          due.push({ task, key, kind: "working" });
          continue;
        }
        // 已告警：宽限计时。旧状态文件没有 alerted_at 的，按本轮补记重新起算。
        if (state.alertedAt[key] == null) {
          state.alertedAt[key] = nowMs;
          seenDirty = true;
          continue;
        }
        if (nowMs - Number(state.alertedAt[key]) >= GRACE_MS) {
          reclaimDue.push({ task, key });
        }
        continue;
      }
      if (status !== "submitted") continue;
      if (String(f1(task, "Claimed_By") ?? "").trim()) continue;
      liveSubmitted.add(taskId);
      const key = `${taskId}\tsubmitted`;
      if (alerted.has(key)) continue;
      const age = instructionAgeMs(messages ?? [], taskId, nowMs);
      if (age != null) {
        if (age > STALE_MS) due.push({ task, key, kind: "submitted" });
        continue;
      }
      if (state.seen[taskId] == null) {
        state.seen[taskId] = nowMs;
        seenDirty = true;
        continue;
      }
      if (nowMs - Number(state.seen[taskId]) > STALE_MS) {
        due.push({ task, key, kind: "submitted" });
      }
    }
    for (const taskId of Object.keys(state.seen)) {
      if (!liveSubmitted.has(taskId)) {
        delete state.seen[taskId];
        seenDirty = true;
      }
    }
    const owner = String(this.ownerOpenId ?? "").trim();
    let sent = 0;
    if (!owner) {
      if (due.length) this.log("hub 未配置机主 open_id，陈旧任务只记在日志里，本轮不标记已告警");
      for (const item of due) this.log("stale " + item.kind + " " + f1(item.task, "Task_ID"));
    } else {
      for (const item of due) {
        try {
          await this.bus.sendMessage(owner, "text", { text: alertText(item.kind, item.task) });
        } catch (e) {
          this.log("陈旧告警发送失败 " + f1(item.task, "Task_ID") + "：" + (e?.message ?? e));
          continue;
        }
        if (!alerted.has(item.key)) {
          alerted.add(item.key);
          state.alerted.push(item.key);
        }
        if (item.kind === "working") state.alertedAt[item.key] = nowMs;
        sent += 1;
        this.log("stale alerted " + item.kind + " " + f1(item.task, "Task_ID"));
      }
    }
    // 回收不依赖机主 open_id：告警发过（或旧状态已有记录）且宽限届满就执行。
    // 成功才清告警记录；失败保留记录与原计时，下一轮 scan 直接重试（回收
    // 本身对重复执行安全：复用已写的 notice、只关未结束的 Run）。
    let reclaimed = 0;
    let reclaimFailed = false;
    for (const item of reclaimDue) {
      let ok = false;
      try {
        ok = await this.reclaim(item.task);
      } catch (e) {
        reclaimFailed = true;
        this.log("陈旧回收失败 " + f1(item.task, "Task_ID") + "（保留告警记录，下一轮重试）：" + (e?.message ?? e));
      }
      if (ok) {
        alerted.delete(item.key);
        state.alerted = state.alerted.filter((k) => k !== item.key);
        delete state.alertedAt[item.key];
        reclaimed += 1;
      }
    }
    if (sent || seenDirty || reclaimed || reclaimFailed) {
      try { writeState(this.statePath, state); } catch (e) {
        this.log("stale_state.json 写失败，告警可能在下一轮重发：" + (e?.message ?? e));
      }
    }
    return sent;
  }
}
