// cron 解析与期次计算的纯函数，从 src/hub/schedule.mjs 原样搬出（零行为变化）。
// 它们只依赖 Intl 与 Date，不碰总线与文件系统；抽出来是为了让节点本地调度
// （方案 §3.2）与 lah schedule / task begin 共用同一套表达式语义与期次键写法。
// 期次按配置时区（缺省 Asia/Shanghai）的墙钟计算，不用宿主机时区：
// hub 常驻在 UTC 的机器上，表达式却按北京时间书写。

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
