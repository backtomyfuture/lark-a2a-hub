// 内核共用的小工具。独立成模块，是为了让回执解析和状态机骨架都能用 log / nowStr，而不互相引用。

// 终态集合。骨架与 outbox 共用这一份，避免回指 kernel.mjs 形成环。
export const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled", "rejected"]);

// 坏 JSON 不能当成空对象写回去，否则会把别人写在 Metadata 里的键冲掉。
export function readTaskMeta(raw) {
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

// 任务行用 auto/notify/approve，本机 commands.json 用 auto/auto_notify/approve。
// notify 与 auto_notify 同级。空值视为 auto（未标）；认不出的值按最严，避免把下限放宽。
export function approvalRank(value) {
  const v = String(value ?? "").trim();
  if (!v || v === "auto") return 0;
  if (v === "notify" || v === "auto_notify") return 1;
  if (v === "approve") return 2;
  return 2;
}

export function clipText(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// 审批卡要给人看参数，但键名里带凭据字样的值不能进总线。
export function redactValue(value, depth = 0) {
  if (depth > 8) return "…";
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => redactValue(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/(secret|token|key|password)/i.test(k)) out[k] = "***";
    else out[k] = redactValue(v, depth + 1);
  }
  return out;
}

export function log(msg) {
  console.log(new Date().toISOString().slice(0, 19), msg);
}

export function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}`;
}

// 一行 key=value、值里没有空格，方便按天 awk 相加。ms 不取整：调用方传入的就是要打印的数。
// stats 缺席（总线没有 takeStats）时不补 0，避免把「没计数」写成「零请求」。
export function formatStats(label, ms, ok, stats) {
  let line = `${label} ms=${ms} ok=${ok ? 1 : 0}`;
  if (stats) {
    line += ` list=${stats.list ?? 0} get=${stats.get ?? 0} write=${stats.write ?? 0} other=${stats.other ?? 0} backoff=${stats.backoff ?? 0}`;
  }
  return line;
}

// Created_At 一律写 nowStr() 的完整 ISO（带时区偏移）：各节点时区不同，
// 无偏移的本地时间文本混写会让同一任务里回复看起来比请求还早（会审实证）。

// 表上没有耗时列。收尾时用起止时间表达耗时；失败信息里再附上秒数，成功不往 Error_Log 塞备注。
function elapsedSec(started, finished) {
  const a = Date.parse(String(started ?? ""));
  const b = Date.parse(String(finished ?? ""));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

export function annotateElapsed(error, started, finished) {
  const base = String(error ?? "");
  const sec = elapsedSec(started, finished);
  if (!base || sec == null) return base.slice(0, 800);
  return `${base}（耗时 ${sec}s）`.slice(0, 800);
}
