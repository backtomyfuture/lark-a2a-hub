// 回执解析与命令模板占位符。从内核拆出后行为不变；默认日志函数来自 kernel-util，避免和状态机循环引用。
import { log } from "./kernel-util.mjs";

const JSON_RECEIPT_KEYS = new Set(["summary", "artifact", "artifact_name", "need_input", "need_auth", "usage", "session", "later"]);
const USAGE_CAP = 1e12;
export const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const USAGE_NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export class NeedInput extends Error {}

// 执行中请求机主批准。与提问一样不是失败，不许按重试再跑一遍。
export class NeedAuth extends Error {}

// 进程已成功退出，但 stdout 不能按回执约定解析。这不是执行失败，不许重跑。
export class InvalidReceipt extends Error {
  constructor(message, raw) {
    super(message);
    this.name = "InvalidReceipt";
    this.raw = raw ?? "";
  }
}

// 费用只留 6 位小数。toFixed 的舍入足够，1e12 以内没有整数精度问题。
function roundCost(n) {
  return Number(Number(n).toFixed(6));
}

function parseLooseNumber(raw) {
  const s = String(raw ?? "").trim();
  if (!USAGE_NUMBER.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > USAGE_CAP) return null;
  return n;
}

function blankUsage() {
  return { input: 0, output: 0, cached: 0, cost: 0, runs: 0, reported: 0 };
}

// 坏的历史值不当作上报，按 0 接着累加，避免一格脏数据让后续轮次写不进去。
function asUsageTotals(raw) {
  const base = blankUsage();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const n = (v, cost = false) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) return 0;
    return cost ? roundCost(x) : Math.trunc(x);
  };
  base.input = n(raw.input);
  base.output = n(raw.output);
  base.cached = n(raw.cached);
  base.cost = n(raw.cost, true);
  base.runs = n(raw.runs);
  base.reported = Math.min(base.runs, n(raw.reported));
  return base;
}

// report 为 null 表示这一轮没上报：只加 runs。合法对象才加 reported 和四项用量。
export function addUsage(prev, report) {
  const base = asUsageTotals(prev);
  base.runs += 1;
  if (report && typeof report === "object" && !Array.isArray(report)) {
    const add = asUsageTotals(report);
    base.reported += 1;
    base.input += add.input;
    base.output += add.output;
    base.cached += add.cached;
    base.cost = roundCost(base.cost + add.cost);
  }
  return base;
}

function logUsageIgnored(logFn) {
  logFn("usage 整条忽略：非法或超限");
}

// 行文本或 JSON 对象。键可缺，缺的按 0；任一已知键非法则整条作废。未知键不执行。
function parseUsageValue(raw, logFn, fromLine) {
  if (fromLine) {
    const text = String(raw ?? "").trim();
    const usage = { input: 0, output: 0, cached: 0, cost: 0 };
    if (!text) return usage;
    const seen = new Set();
    for (const token of text.split(/\s+/)) {
      const m = /^(input|output|cached|cost)=(.+)$/.exec(token);
      if (!m || seen.has(m[1])) {
        logUsageIgnored(logFn);
        return null;
      }
      seen.add(m[1]);
      const num = parseLooseNumber(m[2]);
      if (num == null) {
        logUsageIgnored(logFn);
        return null;
      }
      usage[m[1]] = m[1] === "cost" ? roundCost(num) : Math.trunc(num);
    }
    return usage;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    logUsageIgnored(logFn);
    return null;
  }
  const usage = { input: 0, output: 0, cached: 0, cost: 0 };
  for (const key of ["input", "output", "cached", "cost"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > USAGE_CAP) {
      logUsageIgnored(logFn);
      return null;
    }
    usage[key] = key === "cost" ? roundCost(v) : Math.trunc(v);
  }
  return usage;
}

function parseSessionValue(raw, logFn) {
  if (typeof raw !== "string" || !SESSION_ID.test(raw.trim())) {
    logFn("session 整条忽略：id 非法");
    return null;
  }
  return raw.trim();
}

// 复查时刻必须自己核日历。Date.parse 会把 2027-02-29 滚成 3 月 1 日，不能拿来判合法性。
const LATER_MIN_MS = 60_000;
const LATER_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const LATER_ABOUT_MAX = 200;
const LATER_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 0;
}

function hasControlChar(text) {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

function clockMs(now) {
  const clock = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(clock) ? clock : Date.now();
}

// 返回绝对毫秒；文本不是带时区的真实日历时间时返回 null。不套「至少 1 分钟 / 30 天」窗口。
export function parseLaterInstant(text) {
  const m = LATER_AT.exec(String(text ?? "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const frac = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMin = 0;
  if (m[8] !== "Z") {
    const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(m[8]);
    if (!zm) return null;
    const oh = Number(zm[2]);
    const om = Number(zm[3]);
    if (oh > 23 || om > 59) return null;
    offsetMin = (oh * 60 + om) * (zm[1] === "+" ? 1 : -1);
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second, frac);
  const check = new Date(asUtc);
  if (check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
    || check.getUTCHours() !== hour
    || check.getUTCMinutes() !== minute
    || check.getUTCSeconds() !== second
    || check.getUTCMilliseconds() !== frac) {
    return null;
  }
  return asUtc - offsetMin * 60_000;
}

// 含控制字符或超长就整条作废。不删掉控制字符后收下，避免把改过的说明当成执行者原文。
function parseLaterRequest(atRaw, aboutRaw, logFn, now) {
  if (typeof atRaw !== "string") {
    logFn("later 整条忽略：时刻不是文本");
    return null;
  }
  const atText = atRaw.trim();
  const instant = parseLaterInstant(atText);
  if (instant == null) {
    logFn("later 整条忽略：时刻不是带时区偏移的合法日历时间");
    return null;
  }
  const nowMs = clockMs(now);
  if (instant < nowMs + LATER_MIN_MS) {
    logFn("later 整条忽略：时刻晚于现在不足 1 分钟");
    return null;
  }
  if (instant > nowMs + LATER_MAX_MS) {
    logFn("later 整条忽略：时刻超过 30 天");
    return null;
  }
  if (typeof aboutRaw !== "string") {
    logFn("later 整条忽略：about 不是纯文本");
    return null;
  }
  if (hasControlChar(aboutRaw)) {
    logFn("later 整条忽略：about 含控制字符");
    return null;
  }
  const about = aboutRaw.trim();
  if (!about) {
    logFn("later 整条忽略：about 为空");
    return null;
  }
  if ([...about].length > LATER_ABOUT_MAX) {
    logFn("later 整条忽略：about 超过 200 字");
    return null;
  }
  return { at: atText, about };
}

function parseLaterLine(line, logFn, now) {
  const m = /^LATER:\s*([^|]+?)\s*\|\s*(.*)$/.exec(line);
  if (!m) {
    logFn("later 整条忽略：不是「时刻 | 说明」");
    return null;
  }
  return parseLaterRequest(m[1], m[2], logFn, now);
}

function parseLaterValue(raw, logFn, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    logFn("later 整条忽略：不是 {at, about}");
    return null;
  }
  return parseLaterRequest(raw.at, raw.about, logFn, now);
}

// 失败输出不必是合法回执。只要围栏外有 LATER 行，或 json 末行带 later 键，就说明执行者写过预约。
export function laterClausePresent(mode, stdout) {
  const text = String(stdout ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (mode === "json") {
    const lines = text.trim().split("\n").filter(Boolean);
    if (!lines.length) return false;
    try {
      const res = JSON.parse(lines[lines.length - 1]);
      return !!res && typeof res === "object" && !Array.isArray(res)
        && Object.prototype.hasOwnProperty.call(res, "later");
    } catch {
      return false;
    }
  }
  const lines = text.split("\n");
  let open = false;
  for (const line of lines) {
    if (open) {
      if (/^```\s*$/.test(line)) open = false;
      continue;
    }
    if (line.startsWith("```")) {
      open = true;
      continue;
    }
    if (/^LATER:/.test(line)) return true;
  }
  return false;
}

function stampSide(err, usage, session) {
  err.usage = usage ?? null;
  err.session = session ?? null;
  return err;
}

// 只认最后一个完整围栏：资料里的示例围栏不能抢先变成提问。
// 产物行必须整行落在围栏外，避免模型复述示例时登记错误路径。
// 输出被截成头尾时，头里未闭合的围栏不能吞掉尾部回执，所以只解析最后一处省略标记之后。
const OUTPUT_OMITTED_LINE = /^…\[中间省略 \d+ 字节\]…$/;

export function parseAgentReceipt(out, logFn = log, now = Date.now()) {
  const text = String(out ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const all = text.split("\n");
  let cut = 0;
  for (let i = 0; i < all.length; i++) {
    if (OUTPUT_OMITTED_LINE.test(all[i])) cut = i + 1;
  }
  const lines = all.slice(cut);
  const closed = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      if (/^```\s*$/.test(line)) {
        open.end = i;
        closed.push(open);
        open = null;
      } else {
        open.body.push(line);
      }
    } else if (line.startsWith("```")) {
      open = { start: i, end: -1, lang: line.slice(3).trim(), body: [] };
    }
  }
  const last = closed.length ? closed[closed.length - 1] : null;
  // 提问与执行中审批共用「最后一个完整围栏」：更早的围栏（含另一种中断）不算数。
  const ask = last && /^agent-ask(?:\s|$)/.test(last.lang) ? last.body.join("\n").trim() : null;
  const authLang = last && /^agent-auth(?:\s|$)/.test(last.lang);
  const authBody = authLang ? last.body.join("\n").trim() : null;
  const inside = new Set();
  for (const fence of closed) {
    for (let i = fence.start; i <= fence.end; i++) inside.add(i);
  }
  let artifact = "";
  let artName = "";
  // 最后一条才算数。非法则整条丢掉，不退回更早的一条。
  let usageBody;
  let sessionBody;
  let laterCount = 0;
  let laterLine;
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inside.has(i)) {
      const art = /^ARTIFACT:\s*(.*?)\s*$/.exec(line);
      const name = /^ARTIFACT_NAME:\s*(.*?)\s*$/.exec(line);
      const usage = /^USAGE:\s*(.*)$/.exec(line);
      const session = /^SESSION:\s*(.*)$/.exec(line);
      if (art) { artifact = art[1]; continue; }
      if (name) { artName = name[1]; continue; }
      if (usage) { usageBody = usage[1]; continue; }
      if (session) { sessionBody = session[1]; continue; }
      // 围栏里的 LATER 留在正文里，不当预约。围栏外的整行从摘要里拿掉，避免说明混进结果。
      if (/^LATER:/.test(line)) {
        laterCount += 1;
        laterLine = line;
        continue;
      }
    }
    keep.push(line);
  }
  const usage = usageBody === undefined ? null : parseUsageValue(usageBody, logFn, true);
  const session = sessionBody === undefined ? null : parseSessionValue(sessionBody, logFn);
  if (laterCount > 1) logFn("later 多条，只取最后一条");
  // 提问和无效回执都不是完成。预约留到完成再写，这里只记一笔，不把 later 挂到错误上。
  if (ask != null) {
    if (laterCount) logFn("later 在 input-required 上忽略");
    throw stampSide(new NeedInput(ask), usage, session);
  }
  if (authLang) {
    if (laterCount) logFn("later 在 auth-required 上忽略");
    if (!authBody) {
      throw stampSide(new InvalidReceipt("agent-auth 缺少审批说明", text.slice(0, 500)), usage, session);
    }
    throw stampSide(new NeedAuth(authBody), usage, session);
  }
  let summary = keep.join("\n").trim();
  // 进程已经成功退出。没有摘要是回执无效，不是执行失败，不能按重试再跑一遍。
  if (!summary) {
    if (laterCount) logFn("later 在 failed 上忽略");
    throw stampSide(new InvalidReceipt("agent produced no output", text.slice(0, 500)), usage, session);
  }
  // 未截断时仍从开头留 4000，和原来的回执一致。截断后正文在尾部，从末尾留 4000，避免结论被日志挤掉。
  if (summary.length > 4000) summary = cut > 0 ? summary.slice(-4000) : summary.slice(0, 4000);
  const later = laterLine === undefined ? null : parseLaterLine(laterLine, logFn, now);
  const r = { summary, artifact, usage, session, later };
  if (artName) r.artifact_name = artName;
  return r;
}

// json 模式仍只看最后一行对象。未知顶层键不执行，只留一条日志，避免回执里的 command 被当成控制项。
export function parseJsonReceipt(res, logFn = log, now = Date.now()) {
  if (!res || typeof res !== "object" || Array.isArray(res)) {
    throw new InvalidReceipt("回执不是 JSON 对象", "");
  }
  const unknown = Object.keys(res).filter((k) => !JSON_RECEIPT_KEYS.has(k));
  if (unknown.length) logFn(("json 回执忽略未知顶层键：" + unknown.join(",")).slice(0, 300));
  // 缺键是未上报，不是非法。非法才记日志并整条丢掉。
  const usage = Object.prototype.hasOwnProperty.call(res, "usage")
    ? parseUsageValue(res.usage, logFn, false)
    : null;
  const session = Object.prototype.hasOwnProperty.call(res, "session")
    ? parseSessionValue(res.session, logFn)
    : null;
  const hasLater = Object.prototype.hasOwnProperty.call(res, "later");
  if (res.need_input && res.need_auth) {
    throw stampSide(new InvalidReceipt("need_input 与 need_auth 不能同时存在", ""), usage, session);
  }
  if (res.need_input) {
    if (hasLater) logFn("later 在 input-required 上忽略");
    throw stampSide(new NeedInput(String(res.need_input)), usage, session);
  }
  const authText = res.need_auth == null ? "" : String(res.need_auth).trim();
  if (authText) {
    if (hasLater) logFn("later 在 auth-required 上忽略");
    throw stampSide(new NeedAuth(authText), usage, session);
  }
  const later = hasLater ? parseLaterValue(res.later, logFn, now) : null;
  const r = {
    summary: String(res.summary ?? "").slice(0, 4000),
    artifact: String(res.artifact ?? ""),
    usage,
    session,
    later,
  };
  if (res.artifact_name) r.artifact_name = String(res.artifact_name);
  return r;
}

// {prompt} 与 {session} 各替换一次，插入的文本不再扫描，避免会话号或提示里的占位符二次展开。
export function substituteCommand(template, vars = {}) {
  const text = String(template ?? "");
  let out = "";
  let i = 0;
  const seen = new Set();
  while (i < text.length) {
    let hit = "";
    if (!seen.has("prompt") && text.startsWith("{prompt}", i)) hit = "prompt";
    else if (!seen.has("session") && text.startsWith("{session}", i)) hit = "session";
    if (hit) {
      seen.add(hit);
      const value = vars[hit];
      out += value == null ? `{${hit}}` : shellQuote(value);
      i += hit.length + 2;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}
