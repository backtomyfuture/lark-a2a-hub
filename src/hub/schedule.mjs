// hub 不再按 Rules 建定时任务。计划在各节点本机 schedules.json，到点由节点自己建单。
// 这里只留事项级 later：到期在同一 Context_ID 下建一张复查任务。
// 逾期再久只补一次。node 角色没有这只时钟，扫到 role=node 时不建复查任务。
// 与 create.mjs / kernel.mjs 的 HOP_LIMIT 对齐。再加一跳超过 8 就只写标记，不再每轮重试。
const HOP_LIMIT = 8;

import { f1 } from "../bus/feishu.mjs";
import { parseLaterInstant } from "../kernel.mjs";
import { createTask } from "./create.mjs";

// 纯函数留在 src/schedule-cron.mjs，节点本地调度在用。这里继续 re-export，
// doctor 与旧 import 路径不用改。
export {
  DEFAULT_SCHEDULE_TZ,
  formatOccurrenceKey,
  latestOccurrence,
  parseCron,
  resolveScheduleTz,
  wallClock,
} from "../schedule-cron.mjs";

function text(row, name) {
  return String(f1(row, name) ?? "").trim();
}

function readMeta(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ok: true, meta: { ...raw } };
  const text = raw == null ? "" : String(raw).trim();
  if (!text) return { ok: true, meta: {} };
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false };
    return { ok: true, meta: obj };
  } catch {
    return { ok: false };
  }
}

function metaRawText(raw) {
  if (raw && typeof raw === "object") {
    try { return JSON.stringify(raw); }
    catch { return ""; }
  }
  return raw == null ? "" : String(raw);
}

export class ScheduleService {
  // tz、statePath 是旧 Rules 时钟的参数。调用方还在传，这里故意不收，避免再去读基线。
  constructor({ bus, log, now = () => Date.now(), role } = {}) {
    this.bus = bus;
    this.log = log ?? (() => {});
    this.now = now;
    // 缺省 hub：现有调用方不传 role，复查行为保持原样。只有显式 node 才停掉复查建单。
    this.role = role === "node" ? "node" : "hub";
    this._laterBad = new Set();
  }

  // 返回值仍是按 Rules 建单的次数，时钟挪走之后恒为 0。
  // later 建了几张不改变这个数，调用方一直把 scan()===0 当成「没有按 Rules 建单」。
  async scan() {
    await this.scanLater();
    return 0;
  }

  async scanLater() {
    if (this.role === "node") return 0;
    try {
      return await this.fireDueLaters();
    } catch (e) {
      this.log("later 扫描失败，本轮跳过：" + (e?.message ?? e));
      return 0;
    }
  }

  // 终态不能重启。到期就在同一会话下另开一张复查任务，幂等键挡住重启后的第二次。
  async fireDueLaters() {
    const tasksTable = this.bus?.tables?.tasks;
    if (!tasksTable) return 0;
    const nowMs = Number(this.now());
    const tasks = await this.bus.listRecords(tasksTable);
    const known = new Set(tasks.map((row) => text(row, "Idempotency_Key")).filter(Boolean));
    let fired = 0;
    for (const task of tasks) {
      if (text(task, "Status") !== "completed") continue;
      const raw = f1(task, "Metadata");
      const rawText = metaRawText(raw);
      if (!rawText.includes("\"later\"")) continue;
      const taskId = text(task, "Task_ID");
      const read = readMeta(raw);
      if (!read.ok) {
        if (!this._laterBad.has(taskId)) {
          this._laterBad.add(taskId);
          this.log(`later 的 Metadata 无法合并，跳过 ${taskId}`);
        }
        continue;
      }
      if (read.meta.later_fired != null && read.meta.later_fired !== "") continue;
      const later = read.meta.later;
      if (!later || typeof later !== "object" || Array.isArray(later) || typeof later.at !== "string") {
        if (!this._laterBad.has(taskId)) {
          this._laterBad.add(taskId);
          this.log(`later 请求无法识别，跳过 ${taskId}`);
        }
        continue;
      }
      const instant = parseLaterInstant(later.at);
      if (instant == null) {
        if (!this._laterBad.has(taskId)) {
          this._laterBad.add(taskId);
          this.log(`later 时刻无法解析，跳过 ${taskId}`);
        }
        continue;
      }
      if (!Number.isFinite(nowMs) || instant > nowMs) continue;
      const idem = `later:${taskId}`;
      const firedAt = new Date(nowMs).toISOString();
      if (known.has(idem)) {
        const existing = tasks.find((row) =>
          text(row, "Idempotency_Key") === idem && text(row, "Task_ID") !== taskId);
        await this.markLaterFired(task, {
          task_id: existing ? text(existing, "Task_ID") : "",
          at: firedAt,
        });
        continue;
      }
      const hopRaw = Number(f1(task, "Hop_Count"));
      const hop = Number.isFinite(hopRaw) && hopRaw > 0 ? hopRaw : 0;
      if (hop + 1 > HOP_LIMIT) {
        this.log(`later 跳数熔断 ${taskId}：Hop_Count ${hop}+1 超过 ${HOP_LIMIT}，不建复查任务`);
        await this.markLaterFired(task, { task_id: "", at: firedAt, reason: "hop_limit" });
        continue;
      }
      const about = typeof later.about === "string" ? later.about : "";
      let taskIdNew = "";
      try {
        taskIdNew = await createTask({
          bus: this.bus,
          from: "hub",
          source: "cron",
          to: text(task, "Target_Node"),
          cap: text(task, "Skill_ID"),
          text: `复查：${about}（承接任务 ${taskId}）`,
          context: text(task, "Context_ID"),
          ref: taskId,
          approval: text(task, "Approval_Class"),
          idempotencyKey: idem,
          now: new Date(nowMs),
        });
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes("超过上限")) {
          this.log(`later 跳数熔断 ${taskId}：${msg}`);
          await this.markLaterFired(task, { task_id: "", at: firedAt, reason: "hop_limit" });
        } else {
          // 名片暂缺或总线抖动：不写标记，下一轮还能再试。
          this.log(`later 建单失败 ${taskId}（下一轮重试）：${msg}`);
        }
        continue;
      }
      known.add(idem);
      await this.markLaterFired(task, { task_id: taskIdNew, at: firedAt });
      fired += 1;
      this.log(`later fired ${taskId} -> ${taskIdNew}`);
    }
    return fired;
  }

  // 读最新 Metadata 再合并。标记写失败时留下幂等键，下轮只补标记，不另开一张。
  async markLaterFired(task, fired) {
    const tasksTable = this.bus?.tables?.tasks;
    const taskId = text(task, "Task_ID");
    const recordId = task?.record_id;
    if (!tasksTable || !recordId) {
      this.log(`later 标记没有 record_id，跳过 ${taskId}`);
      return;
    }
    try {
      const fresh = await this.bus.getRecord(tasksTable, recordId);
      const row = fresh || task;
      const read = readMeta(f1(row, "Metadata"));
      if (!read.ok) {
        this.log(`later 标记无法合并 Metadata，跳过 ${taskId}`);
        return;
      }
      if (read.meta.later_fired != null && read.meta.later_fired !== "") return;
      read.meta.later_fired = {
        task_id: String(fired?.task_id ?? ""),
        at: String(fired?.at ?? ""),
      };
      if (fired?.reason) read.meta.later_fired.reason = String(fired.reason);
      await this.bus.updateRecord(tasksTable, row.record_id || recordId, {
        Metadata: JSON.stringify(read.meta),
      });
    } catch (e) {
      this.log(`later 标记写失败 ${taskId}（下轮按幂等键自愈）：` + (e?.message ?? e));
    }
  }
}
