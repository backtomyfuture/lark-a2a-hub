// hub 角色的定时调度（标准 §7 调度语义、§10.1 第 7 条，v3.5.4）。
// 全网唯一的时钟：计划存 Rules 表（Enabled=Yes 且 Schedule 非空的行），hub 在
// 每轮扫表时顺带检查；到期就经 createTask 建一张 Source=cron 的普通任务，后续
// 认领/回执/告警全走现行链路，节点侧零改动。
// 期次按 node.json 的 tz（缺省 Asia/Shanghai）的墙钟计算，不用宿主机时区：
// hub 常驻在 UTC 的机器上，表达式却按北京时间书写。
// 不重复靠三层：schedule_state.json 里的基线（Rule_ID＋Schedule 文本）、
// 行上的 Last_Fired 水位线、任务幂等键 sched:<Rule_ID>:<期次键>。
// 基线还没有（新建、改表达式、升级后第一次）时只回写水位线，不建单。
// 已有基线时错过的早期期次不补，只触发最近一期；期次搜索窗口 8 天。

import fs from "node:fs";
import path from "node:path";
import { f1 } from "../bus/feishu.mjs";
import { createTask } from "./create.mjs";

export const DEFAULT_SCHEDULE_TZ = "Asia/Shanghai";
const SEARCH_MINUTES = 8 * 24 * 60;
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

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

function cronMatches(parsed, wall) {
  if (!parsed.minute.has(wall.minute)) return false;
  if (!parsed.hour.has(wall.hour)) return false;
  if (!parsed.month.has(wall.month)) return false;
  const domHit = parsed.dom.has(wall.day);
  const dowHit = parsed.dow.has(wall.weekday);
  // Vixie cron 语义：日与周都受限时任一命中即可；只有一侧受限时听那一侧。
  if (parsed.domAny && parsed.dowAny) return true;
  if (parsed.domAny) return dowHit;
  if (parsed.dowAny) return domHit;
  return domHit || dowHit;
}

// 非法 IANA 名时 Intl 抛 RangeError。调用方必须把这个错误打进日志并停手，
// 不能改用宿主机时区——那正是 UTC 机器把北京时间表达式错位 8 小时的原因。
export function resolveScheduleTz(tz) {
  const name = String(tz ?? "").trim() || DEFAULT_SCHEDULE_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
  } catch (e) {
    const err = new Error(`非法时区 ${name}：${e?.message ?? e}`);
    err.cause = e;
    throw err;
  }
  return name;
}

const wallFormatters = new Map();

function wallFormatter(timeZone) {
  let fmt = wallFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallFormatters.set(timeZone, fmt);
  }
  return fmt;
}

// 该绝对时刻在配置时区里的墙钟。hourCycle=h23 在部分 ICU 上会把午夜报成 24，收成 0。
export function wallClock(date, timeZone) {
  const bag = {};
  for (const part of wallFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  const weekday = WEEKDAY[bag.weekday];
  if (!Number.isInteger(weekday)) throw new Error(`无法解析星期：${bag.weekday}`);
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    weekday,
  };
}

// 偏移按这一时刻自己算：夏令时切换日前后差一小时，不能用一个固定偏移套全部候选。
function offsetMinutes(date, timeZone) {
  const wall = wallClock(date, timeZone);
  const asUTC = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

function formatOffset(minutes) {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const p = (n) => String(n).padStart(2, "0");
  return sign + p(Math.floor(abs / 60)) + p(abs % 60);
}

// 期次键与 Last_Fired / Created_At 同一写法：ISO 8601，偏移不带冒号（+0800，不是 +08:00）。
export function formatOccurrenceKey(date, timeZone) {
  const tz = resolveScheduleTz(timeZone);
  const wall = wallClock(date, tz);
  const p = (n) => String(n).padStart(2, "0");
  return `${wall.year}-${p(wall.month)}-${p(wall.day)}T${p(wall.hour)}:${p(wall.minute)}:${p(wall.second)}${formatOffset(offsetMinutes(date, tz))}`;
}

// 不晚于 now 的最近一期（分钟粒度，配置时区的墙钟）。窗口内没有就返回 null。
// 按绝对分钟往回走：常见时区的偏移都是整分钟，墙钟的每一分钟都会被走到；
// 跳过的夏令时小时自然不会出现，回拨的小时会以两个不同偏移各出现一次。
export function latestOccurrence(parsed, now, timeZone = DEFAULT_SCHEDULE_TZ) {
  const tz = resolveScheduleTz(timeZone);
  const instant = now instanceof Date ? now : new Date(now);
  const start = Math.floor(instant.getTime() / 60000) * 60000;
  for (let i = 0; i <= SEARCH_MINUTES; i++) {
    const t = new Date(start - i * 60_000);
    if (cronMatches(parsed, wallClock(t, tz))) return t;
  }
  return null;
}

function readBaselines(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const src = parsed?.rules;
    if (!src || typeof src !== "object" || Array.isArray(src)) {
      return { rules: {}, broken: "schedule_state.json 结构无法识别" };
    }
    const rules = {};
    for (const [key, value] of Object.entries(src)) {
      if (typeof value === "string") rules[key] = value;
    }
    return { rules };
  } catch (e) {
    if (e.code === "ENOENT") return { rules: {}, missing: true };
    return { rules: {}, broken: e.message };
  }
}

function writeBaselines(file, rules) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ rules }, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function text(row, name) {
  return String(f1(row, name) ?? "").trim();
}

function priorityOf(row) {
  const n = Number(f1(row, "Priority"));
  return Number.isFinite(n) ? n : 0;
}

export class ScheduleService {
  constructor({ bus, log, now = () => Date.now(), tz, statePath }) {
    this.bus = bus;
    this.log = log ?? (() => {});
    this.now = now;
    this.tz = tz;
    this.statePath = statePath;
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
    if (!this.statePath) {
      // 没有落盘位置就分不清「升级第一轮」和「真的错过一期」。不建单。
      this.log("定时调度没有状态文件路径，本轮跳过，避免无法记住基线仍建单");
      return 0;
    }
    let tz;
    try {
      tz = resolveScheduleTz(this.tz);
    } catch (e) {
      this.log("定时调度时区非法，本轮跳过（不回退宿主机时区）：" + (e?.message ?? e));
      return 0;
    }
    const saved = readBaselines(this.statePath);
    if (saved.broken) {
      this.log("schedule_state.json 读失败，本轮全部计划只回写水位线、不建单：" + saved.broken);
    }
    const rows = await this.bus.listRecords(rulesTable);
    const plans = rows.filter((row) => text(row, "Enabled") === "Yes" && text(row, "Schedule"));
    if (!plans.length) return 0;
    const nowDate = new Date(Number(this.now()));
    const baselines = saved.rules;
    let dirty = false;
    const pending = [];
    for (const row of plans) {
      const ruleId = text(row, "Rule_ID") || row.record_id;
      const scheduleText = text(row, "Schedule");
      let parsed;
      try {
        parsed = parseCron(scheduleText);
      } catch (e) {
        if (!this._badLogged.has(ruleId)) {
          this._badLogged.add(ruleId);
          this.log(`调度计划 ${ruleId} 的 cron 无法解析，已跳过：` + (e?.message ?? e));
        }
        continue;
      }
      const occurrence = latestOccurrence(parsed, nowDate, tz);
      if (!occurrence) continue;
      const occKey = formatOccurrenceKey(occurrence, tz);
      const known = !saved.missing && !saved.broken && baselines[ruleId] === scheduleText;
      const anchored = text(row, "Last_Fired") !== "";
      if (!known || !anchored) {
        // 新建、改了表达式、或升级后还没有基线：先把水位线锚在最近一期，下一期才建单。
        if (text(row, "Last_Fired") !== occKey) {
          try {
            await this.bus.updateRecord(rulesTable, row.record_id, { Last_Fired: occKey });
          } catch (e) {
            // 水位线没锚上就登记基线，下一轮会按「已有基线」把这一期当成漏触发补发。
            this.log(`调度水位线回写失败，本轮不登记基线 ${ruleId}：` + (e?.message ?? e));
            continue;
          }
        }
        if (baselines[ruleId] !== scheduleText) {
          baselines[ruleId] = scheduleText;
          dirty = true;
        }
        this.log(`schedule baseline ${ruleId}（期次 ${occKey}，本次不建单）`);
        continue;
      }
      if (text(row, "Last_Fired") === occKey) continue;
      const idem = `sched:${ruleId}:${occKey}`;
      pending.push({ row, ruleId, occKey, idem });
    }
    if (dirty) {
      try {
        writeBaselines(this.statePath, baselines);
      } catch (e) {
        // 基线没落盘就建单的话，重启会把同一期再补一次。本轮宁可漏触发。
        this.log("schedule_state.json 写失败，本轮不建单：" + (e?.message ?? e));
        return 0;
      }
    }
    let fired = 0;
    let taskKeys = null;
    for (const item of pending) {
      const { row, ruleId, occKey, idem } = item;
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
