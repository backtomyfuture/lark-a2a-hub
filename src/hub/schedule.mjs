// hub 角色的定时调度（标准 §7 调度语义、§10.1 第 7 条，v3.5.2）。
// 全网唯一的时钟：计划存 Rules 表（Enabled=Yes 且 Schedule 非空的行），hub 在
// 每轮扫表时顺带检查；到期就经 createTask 建一张 Source=cron 的普通任务，后续
// 认领/回执/告警全走现行链路，节点侧零改动。
// 不重复靠双保险：行上的 Last_Fired 水位线 + 任务的幂等键 sched:<Rule_ID>:<期次键>。
// 错过的早期期次不补，只触发最近一期；期次搜索窗口 8 天。

import { f1 } from "../bus/feishu.mjs";
import { createTask, formatCreatedAt } from "./create.mjs";

const SEARCH_MINUTES = 8 * 24 * 60;

function parseField(text, min, max, isDow = false) {
  const values = new Set();
  for (const part of String(text).split(",")) {
    const seg = part.trim();
    if (!seg) throw new Error(`cron 字段为空段：${text}`);
    let base = seg;
    let step = 1;
    const slash = seg.indexOf("/");
    if (slash >= 0) {
      base = seg.slice(0, slash);
      step = Number(seg.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) throw new Error(`cron 步长非法：${seg}`);
    }
    let lo;
    let hi;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      hi = slash >= 0 ? max : lo;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(base);
      if (!m) throw new Error(`cron 字段无法解析：${seg}`);
      lo = Number(m[1]);
      hi = Number(m[2]);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 字段越界：${seg}（允许 ${min}-${max}）`);
    for (let v = lo; v <= hi; v += step) values.add(isDow && v === 7 ? 0 : v);
  }
  return values;
}

export function parseCron(expr) {
  const fields = String(expr ?? "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 必须是五段（分 时 日 月 周）：${expr}`);
  const [minute, hour, dom, month, dow] = fields;
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12),
    dow: parseField(dow, 0, 7, true),
    domAny: dom === "*",
    dowAny: dow === "*",
  };
}

function cronMatches(parsed, d) {
  if (!parsed.minute.has(d.getMinutes())) return false;
  if (!parsed.hour.has(d.getHours())) return false;
  if (!parsed.month.has(d.getMonth() + 1)) return false;
  const domHit = parsed.dom.has(d.getDate());
  const dowHit = parsed.dow.has(d.getDay());
  // Vixie cron 语义：日与周都受限时任一命中即可；只有一侧受限时听那一侧。
  if (parsed.domAny && parsed.dowAny) return true;
  if (parsed.domAny) return dowHit;
  if (parsed.dowAny) return domHit;
  return domHit || dowHit;
}

// 不晚于 now 的最近一期期次（分钟粒度）。窗口内没有就返回 null。
export function latestOccurrence(parsed, now) {
  const start = new Date(now.getTime());
  start.setSeconds(0, 0);
  for (let i = 0; i <= SEARCH_MINUTES; i++) {
    const t = new Date(start.getTime() - i * 60_000);
    if (cronMatches(parsed, t)) return t;
  }
  return null;
}

function text(row, name) {
  return String(f1(row, name) ?? "").trim();
}

function priorityOf(row) {
  const n = Number(f1(row, "Priority"));
  return Number.isFinite(n) ? n : 0;
}

export class ScheduleService {
  constructor({ bus, log, now = () => Date.now() }) {
    this.bus = bus;
    this.log = log ?? (() => {});
    this.now = now;
    this._badLogged = new Set();
  }

  // 路由行：Schedule 为空、同 Skill_ID、Enabled=Yes，Priority 最高的一行。
  routeFor(rows, skillId) {
    const candidates = rows.filter((row) =>
      !text(row, "Schedule")
      && text(row, "Skill_ID") === skillId
      && text(row, "Enabled") === "Yes");
    if (!candidates.length) return null;
    return candidates.slice().sort((a, b) => priorityOf(b) - priorityOf(a))[0];
  }

  async scan() {
    const rulesTable = this.bus.tables.rules;
    if (!rulesTable) return 0;
    const rows = await this.bus.listRecords(rulesTable);
    const plans = rows.filter((row) => text(row, "Enabled") === "Yes" && text(row, "Schedule"));
    if (!plans.length) return 0;
    const nowDate = new Date(Number(this.now()));
    let fired = 0;
    let taskKeys = null;
    for (const row of plans) {
      const ruleId = text(row, "Rule_ID") || row.record_id;
      let parsed;
      try {
        parsed = parseCron(text(row, "Schedule"));
      } catch (e) {
        if (!this._badLogged.has(ruleId)) {
          this._badLogged.add(ruleId);
          this.log(`调度计划 ${ruleId} 的 cron 无法解析，已跳过：` + (e?.message ?? e));
        }
        continue;
      }
      const occurrence = latestOccurrence(parsed, nowDate);
      if (!occurrence) continue;
      const occKey = formatCreatedAt(occurrence);
      if (text(row, "Last_Fired") === occKey) continue;
      const idem = `sched:${ruleId}:${occKey}`;
      if (taskKeys == null) {
        const tasks = await this.bus.listRecords(this.bus.tables.tasks);
        taskKeys = new Set(tasks.map((t) => String(f1(t, "Idempotency_Key") ?? "")).filter(Boolean));
      }
      if (taskKeys.has(idem)) {
        // 同期任务已在表里（多半是上轮水位线回写失败）：只补水位线，不重复建单。
        try {
          await this.bus.updateRecord(rulesTable, row.record_id, { Last_Fired: occKey });
          this.log(`schedule watermark healed ${ruleId}（期次 ${occKey} 已建单）`);
        } catch (e) {
          this.log(`调度水位线回写失败 ${ruleId}：` + (e?.message ?? e));
        }
        continue;
      }
      const route = this.routeFor(rows, text(row, "Skill_ID"));
      const to = text(row, "Target_Node") || (route ? text(route, "Target_Node") : "");
      const approval = text(row, "Approval_Class") || (route ? text(route, "Approval_Class") : "");
      let taskId;
      try {
        taskId = await createTask({
          bus: this.bus,
          from: "hub",
          source: "cron",
          to,
          cap: text(row, "Skill_ID"),
          text: text(row, "Text"),
          approval,
          idempotencyKey: idem,
          now: nowDate,
        });
      } catch (e) {
        this.log(`调度建单失败 ${ruleId}（期次 ${occKey}，下一轮重试）：` + (e?.message ?? e));
        continue;
      }
      taskKeys.add(idem);
      try {
        await this.bus.updateRecord(rulesTable, row.record_id, { Last_Fired: occKey });
      } catch (e) {
        this.log(`调度水位线回写失败 ${ruleId}（下轮按幂等键自愈）：` + (e?.message ?? e));
      }
      fired += 1;
      this.log(`schedule fired ${ruleId} -> ${taskId}（期次 ${occKey}）`);
    }
    return fired;
  }
}
