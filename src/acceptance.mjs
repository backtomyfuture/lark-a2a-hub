// 验收层（标准 §11）的纯函数：清单校验、自检归一、逐条判定、overall 与摘要文案。
// 内核、inbox、建单、why 与呈递共用这一份，避免几处各写一套口径。不读写总线，不碰文件。
import { f1 } from "./bus/feishu.mjs";
import { log } from "./kernel-util.mjs";

export const CRITERION_ID = /^[A-Za-z0-9._-]{1,32}$/;
export const MAX_CRITERIA = 20;
export const MAX_CRITERION_TEXT = 500;
export const MAX_EVIDENCE = 500;
export const MAX_VERIFY_EVIDENCE = 2000;
export const VERIFY_TIMEOUT_DEFAULT = 120;
export const VERIFY_TIMEOUT_MAX = 1800;
export const VERIFY_MAX_LAUNCHES = 3;
export const CHECK_VERDICTS = new Set(["pass", "fail", "blocked"]);
export const VERIFY_VERDICTS = new Set(["pass", "fail", "timeout", "error"]);

// 换行与制表符是清单正文里的正常排版，其余控制字符多半是注入或乱码。
function hasBadControl(text) {
  return /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text);
}

// 读首条 instruction DataPart 合并出的参数。没有 acceptance 键是「没清单」，不是错误。
export function parseCriteria(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return { ok: true, criteria: [] };
  if (!Object.prototype.hasOwnProperty.call(params, "acceptance")) return { ok: true, criteria: [] };
  const acc = params.acceptance;
  if (!acc || typeof acc !== "object" || Array.isArray(acc)) return { ok: false, error: "acceptance 必须是对象" };
  const list = acc.criteria;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "acceptance.criteria 必须是非空数组" };
  if (list.length > MAX_CRITERIA) return { ok: false, error: `acceptance.criteria 最多 ${MAX_CRITERIA} 条` };
  const seen = new Set();
  const criteria = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const at = `acceptance.criteria[${i}]`;
    if (!c || typeof c !== "object" || Array.isArray(c)) return { ok: false, error: `${at} 必须是对象` };
    const id = typeof c.id === "string" ? c.id : "";
    if (!CRITERION_ID.test(id)) return { ok: false, error: `${at}.id 不合法（只允许字母、数字、._-，1–32 字）` };
    if (seen.has(id)) return { ok: false, error: `${at}.id 重复：${id}` };
    seen.add(id);
    const text = typeof c.text === "string" ? c.text.trim() : "";
    if (!text || text.length > MAX_CRITERION_TEXT) return { ok: false, error: `${at}.text 必须是 1–${MAX_CRITERION_TEXT} 字` };
    if (hasBadControl(text)) return { ok: false, error: `${at}.text 含控制字符` };
    if (c.evidence_required != null && typeof c.evidence_required !== "boolean") {
      return { ok: false, error: `${at}.evidence_required 必须是布尔` };
    }
    criteria.push({ id, text, evidence_required: c.evidence_required === true });
  }
  return { ok: true, criteria };
}

function clipEvidence(raw) {
  const s = String(raw ?? "").trim();
  return s.length > MAX_EVIDENCE ? s.slice(0, MAX_EVIDENCE) : s;
}

// agent 回执里围栏外的一整行。不是 CHECK 行返回 null；是 CHECK 行但不合法返回 { invalid }。
export function parseCheckLine(line) {
  const m = /^CHECK:\s*(.*)$/.exec(String(line ?? ""));
  if (!m) return null;
  const body = m[1];
  const bar = body.indexOf("|");
  const head = (bar >= 0 ? body.slice(0, bar) : body).trim().split(/\s+/).filter(Boolean);
  const evidence = bar >= 0 ? clipEvidence(body.slice(bar + 1)) : "";
  if (head.length !== 2 || !CRITERION_ID.test(head[0]) || !CHECK_VERDICTS.has(head[1].toLowerCase())) {
    return { invalid: true, raw: body.slice(0, 120) };
  }
  return { id: head[0], verdict: head[1].toLowerCase(), evidence };
}

// json 回执的 checks 键。值可以是 {verdict, evidence} 或直接是判定字符串。非法项整条丢掉并记日志。
export function normalizeJsonChecks(raw, logFn = log) {
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    logFn("checks 不是对象，整体忽略");
    return out;
  }
  for (const [id, v] of Object.entries(raw)) {
    const verdict = typeof v === "string" ? v : v && typeof v === "object" ? v.verdict : undefined;
    const evidence = v && typeof v === "object" ? v.evidence : "";
    if (!CRITERION_ID.test(id) || typeof verdict !== "string" || !CHECK_VERDICTS.has(verdict.toLowerCase())) {
      logFn(`checks 忽略非法项：${String(id).slice(0, 40)}`);
      continue;
    }
    out[id] = { verdict: verdict.toLowerCase(), evidence: clipEvidence(evidence) };
  }
  return out;
}

// lah inbox done 的 --check <id>=<verdict>[:<证据>]。不合法直接抛错，让 CLI 当场报出来。
export function parseCheckFlag(raw) {
  const s = String(raw ?? "");
  const eq = s.indexOf("=");
  if (eq <= 0) throw new Error(`--check 需要 <id>=<pass|fail|blocked>[:<证据>]，收到：${s.slice(0, 80)}`);
  const id = s.slice(0, eq).trim();
  const rest = s.slice(eq + 1);
  const colon = rest.indexOf(":");
  const verdict = (colon >= 0 ? rest.slice(0, colon) : rest).trim().toLowerCase();
  const evidence = colon >= 0 ? clipEvidence(rest.slice(colon + 1)) : "";
  if (!CRITERION_ID.test(id)) throw new Error(`--check 的 id 不合法：${id.slice(0, 40)}`);
  if (!CHECK_VERDICTS.has(verdict)) throw new Error(`--check 的判定只能是 pass / fail / blocked：${verdict.slice(0, 20)}`);
  return { id, verdict, evidence };
}

// 把执行方的自检对到冻结的清单上。清单外的 id 不收；该给证据却没给的 pass 降为 uncertain。
export function judgeChecks(criteria, reported, logFn = log) {
  const rep = reported && typeof reported === "object" ? reported : {};
  const known = new Set((criteria ?? []).map((c) => c.id));
  const extra = Object.keys(rep).filter((id) => !known.has(id));
  if (extra.length) logFn(("自检忽略清单外的 id：" + extra.join(",")).slice(0, 300));
  return (criteria ?? []).map((c) => {
    const r = rep[c.id];
    if (!r) return { id: c.id, verdict: "missing", evidence: "", source: "self" };
    let verdict = r.verdict;
    if (verdict === "pass" && c.evidence_required && !r.evidence) verdict = "uncertain";
    return { id: c.id, verdict, evidence: r.evidence || "", source: "self" };
  });
}

export function verifyVerdict({ code = null, timedOut = false, error = false } = {}) {
  if (error) return "error";
  if (timedOut) return "timeout";
  return code === 0 ? "pass" : "fail";
}

export function overallOf(verify, checks) {
  if (verify && verify.verdict !== "pass") return "fail";
  const list = checks ?? [];
  if (list.some((c) => c.verdict === "fail")) return "fail";
  if (list.some((c) => c.verdict !== "pass")) return "uncertain";
  return "pass";
}

// 回执消息上的 DataPart 内容。既没 verify 也没清单时返回 null，调用方就不写这一块。
export function buildAcceptance({ verify = null, criteriaRef = "", checks = [] } = {}) {
  if (!verify && !(checks && checks.length)) return null;
  const v = verify ? {
    verdict: verify.verdict,
    exit_code: verify.exit_code ?? null,
    duration_ms: verify.duration_ms ?? null,
    evidence: "captured",
  } : null;
  return {
    version: 1,
    verify: v,
    criteria_ref: criteriaRef || "",
    checks: (checks ?? []).map((c) => ({ id: c.id, verdict: c.verdict, evidence: c.evidence || "", source: c.source || "self" })),
    overall: overallOf(v, checks),
  };
}

// Metadata 与呈递只存索引，证据正文留在 DataPart，避免 Metadata 越写越大。
export function acceptanceIndex(acc, msgId = "") {
  if (!acc) return null;
  return {
    version: acc.version,
    verify: acc.verify ? { verdict: acc.verify.verdict, exit_code: acc.verify.exit_code } : null,
    checks: (acc.checks ?? []).map((c) => ({ id: c.id, verdict: c.verdict })),
    overall: acc.overall,
    msg_id: msgId || acc.msg_id || "",
  };
}

const VERIFY_LABEL = { pass: "通过", fail: "未通过", timeout: "超时", error: "无法执行" };

// 一行摘要，供 notice 首行、why 与呈递正文共用。acc 为 null 时返回空串。
export function acceptanceLine(acc) {
  if (!acc) return "";
  const parts = [];
  if (acc.verify) {
    const code = acc.verify.exit_code == null ? "" : `，退出码 ${acc.verify.exit_code}`;
    parts.push(`执行式验收${VERIFY_LABEL[acc.verify.verdict] ?? acc.verify.verdict}（verify${code}）`);
  }
  const checks = acc.checks ?? [];
  if (checks.length) {
    const n = (v) => checks.filter((c) => c.verdict === v).length;
    const pass = n("pass");
    const others = [["fail", "失败"], ["blocked", "受阻"], ["uncertain", "缺证据"], ["missing", "未报"]]
      .filter(([v]) => n(v)).map(([v, label]) => `${n(v)} ${label}`);
    parts.push(`自检 ${pass}/${checks.length} 通过${others.length ? "，" + others.join("，") : ""}（执行方自述）`);
  }
  const head = acc.overall === "pass" ? "验收通过" : acc.overall === "fail" ? "验收未通过" : "验收待定";
  return `${head}：${parts.join("；")}`;
}

// verify 的证据：stdout 与 stderr 合并后只留尾部。失败原因通常在最后几行。
export function verifyEvidenceTail(stdout, stderr, max = MAX_VERIFY_EVIDENCE) {
  const merged = [String(stdout ?? "").trimEnd(), String(stderr ?? "").trimEnd()].filter(Boolean).join("\n");
  return merged.length > max ? "…" + merged.slice(-max) : merged;
}

export function clampVerifyTimeout(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return VERIFY_TIMEOUT_DEFAULT;
  return Math.min(Math.max(Math.round(n), 1), VERIFY_TIMEOUT_MAX);
}

function parsePartJson(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return JSON.parse(raw);
}

// 从一条消息的 Parts 里取出验收对象。权威记录是 Kind=data 且 Data.acceptance 存在的那块（约定 Seq 2）。
// 坏 JSON 返回 null：半截数据不能当成「没有验收」以外的任何结论。多条时优先 Seq 2。
export function acceptanceFromParts(parts) {
  let best = null;
  let bestRank = -1;
  for (const p of parts ?? []) {
    if (f1(p, "Kind") !== "data") continue;
    const raw = f1(p, "Data");
    if (raw == null || raw === "") continue;
    let obj;
    try {
      obj = parsePartJson(raw);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const acc = obj.acceptance;
    if (!acc || typeof acc !== "object" || Array.isArray(acc)) continue;
    const seq = Number(f1(p, "Seq")) || 0;
    const rank = seq === 2 ? 1_000_000 + seq : seq;
    if (rank >= bestRank) {
      best = acc;
      bestRank = rank;
    }
  }
  return best;
}

function metaAcceptance(metadata) {
  let meta = metadata;
  if (typeof meta === "string") {
    const text = meta.trim();
    if (!text) return null;
    try {
      meta = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const acc = meta.acceptance;
  if (!acc || typeof acc !== "object" || Array.isArray(acc)) return null;
  return acc;
}

function msgTail(id) {
  const matched = String(id ?? "").match(/-(\d+)$/);
  return matched ? Number(matched[1]) : -1;
}

// why 与呈递共用：result/notice 上的 DataPart 是权威，没有再退回 Metadata 索引。调用方传入已经读好的行，这里不再扫表。
export function acceptanceForTask(messages, parts, taskId, metadata) {
  const id = String(taskId ?? "");
  const msgs = (messages ?? []).filter((m) => {
    if (String(f1(m, "Task_ID") ?? "") !== id) return false;
    const kind = f1(m, "Kind");
    return kind === "result" || kind === "notice";
  });
  msgs.sort((a, b) => {
    const ds = msgTail(f1(a, "Msg_ID")) - msgTail(f1(b, "Msg_ID"));
    if (ds !== 0) return ds;
    const ca = String(f1(a, "Created_At") ?? "");
    const cb = String(f1(b, "Created_At") ?? "");
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return String(f1(a, "Msg_ID") ?? "").localeCompare(String(f1(b, "Msg_ID") ?? ""));
  });
  let found = null;
  let msgId = "";
  for (const m of msgs) {
    const mid = String(f1(m, "Msg_ID") ?? "");
    const mine = (parts ?? []).filter((p) => String(f1(p, "Parent_ID") ?? "") === mid);
    const acc = acceptanceFromParts(mine);
    if (acc) {
      found = acc;
      msgId = mid;
    }
  }
  if (found) return { acceptance: found, msgId };
  const indexed = metaAcceptance(metadata);
  if (!indexed) return { acceptance: null, msgId: "" };
  return { acceptance: indexed, msgId: String(indexed.msg_id ?? "") };
}
