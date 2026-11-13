// 审批卡内容。脱敏按键名分词，不按子串，避免把含有这些词的普通字段误伤。
// 卡片用 schema 2.0，按钮走 callback behavior，这样 Node SDK 的
// card.action.trigger 才能收到点击。按钮 value 多带 status_msg，回调用它判断卡是否过期，
// 并带上标题、目标节点和技能，结果卡不用再读表。
// 正文只取首条 instruction。auth_request 正文会把标题和指令再抄一遍，读它会让同一段话出现三次。
// update_multi 是 schema 2.0 后续 PATCH 换卡的开关，缺了飞书会拒绝延时更新。

import { f1 } from "../bus/feishu.mjs";

const INSTRUCTION_LIMIT = 300;
const PARAM_LIMIT = 300;
const TITLE_VALUE_LIMIT = 60;
const SECRET_WORDS = new Set([
  "password", "passwd", "secret", "token", "apikey", "authorization", "credential",
]);

export function isSecretKey(key) {
  const words = String(key).toLowerCase().replaceAll("-", "_").split("_").filter(Boolean);
  if (words.includes("api") && words.includes("key")) return true;
  if (words.includes("private") && words.includes("key")) return true;
  return words.some((word) => SECRET_WORDS.has(word));
}

export function redact(obj) {
  if (Array.isArray(obj)) return obj.map((item) => redact(item));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = isSecretKey(key) ? "***" : redact(value);
    }
    return out;
  }
  return obj;
}

function textValue(value) {
  // 多维表格文本偶发成 {text: ...}；取不到正文就当空，走回退，别把结构体印上卡片。
  if (value && typeof value === "object") return String(value.text ?? "").trim();
  return String(value ?? "").trim();
}

function seqOf(part) {
  const n = Number(f1(part, "Seq"));
  return Number.isFinite(n) ? n : 0;
}

function partsOf(parts, parentId) {
  const parent = String(parentId ?? "");
  return parts
    .filter((part) => String(f1(part, "Parent_ID") ?? "") === parent)
    .sort((a, b) => seqOf(a) - seqOf(b));
}

export function messageText(parts, parentId) {
  const chunks = [];
  for (const part of partsOf(parts, parentId)) {
    if (f1(part, "Kind") !== "text") continue;
    const text = textValue(f1(part, "Text"));
    if (text) chunks.push(text);
  }
  return chunks.join("\n").trim();
}

function fmtScalar(value) {
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function fmtParams(obj) {
  const redacted = redact(obj);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return Object.keys(redacted)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => `${key}: ${fmtScalar(redacted[key])}`)
      .join("\n");
  }
  return fmtScalar(redacted);
}

export function messageParams(parts, parentId) {
  const merged = {};
  const extras = [];
  for (const part of partsOf(parts, parentId)) {
    if (f1(part, "Kind") !== "data") continue;
    const raw = f1(part, "Data");
    if (raw == null || raw === "") continue;
    if (typeof raw === "object" && !Array.isArray(raw)) {
      Object.assign(merged, raw);
      continue;
    }
    if (Array.isArray(raw)) {
      extras.push(fmtParams(raw));
      continue;
    }
    const text = String(raw).trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(merged, parsed);
      else extras.push(fmtParams(parsed));
    } catch {
      extras.push(text);
    }
  }
  const lines = [];
  if (Object.keys(merged).length) lines.push(fmtParams(merged));
  for (const item of extras) if (item) lines.push(item);
  return lines.join("\n").trim();
}

function msgSeq(msg) {
  const mid = String(f1(msg, "Msg_ID") ?? "");
  const tail = mid ? mid.slice(mid.lastIndexOf("-") + 1) : "";
  return /^\d+$/.test(tail) ? Number(tail) : 1_000_000_000;
}

function firstInstruction(messages, taskId) {
  const id = String(taskId ?? "");
  const rows = messages.filter((msg) => String(f1(msg, "Task_ID") ?? "") === id && f1(msg, "Kind") === "instruction");
  if (!rows.length) return null;
  rows.sort((a, b) => {
    const ds = msgSeq(a) - msgSeq(b);
    if (ds !== 0) return ds;
    const ca = String(f1(a, "Created_At") ?? "");
    const cb = String(f1(b, "Created_At") ?? "");
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    const ia = String(f1(a, "Msg_ID") ?? "");
    const ib = String(f1(b, "Msg_ID") ?? "");
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
  return rows[0];
}

function clipChars(text, limit) {
  const value = String(text ?? "").trim();
  return value.length <= limit ? value : value.slice(0, limit);
}

// 超长指令留在总线上。卡片只给入口，避免把同一段话截成两份还占满屏幕。
function clipInstruction(text, taskId) {
  const value = String(text ?? "").trim();
  if (value.length <= INSTRUCTION_LIMIT) return value;
  return value.slice(0, INSTRUCTION_LIMIT) + `…（全文：lah task why ${taskId}）`;
}

function clipParams(text) {
  const value = String(text ?? "").trim();
  if (value.length <= PARAM_LIMIT) return value;
  return value.slice(0, PARAM_LIMIT).trimEnd() + "…";
}

// 与 kernel.capLabel 同一口径：有 Worker 时技能是 Worker/技能，否则就是技能名。
function skillLabel(task) {
  const worker = textValue(f1(task, "Worker_Hint"));
  const skill = textValue(f1(task, "Skill_ID"));
  return worker ? `${worker}/${skill || "(空)"}` : (skill || "-");
}

// 标题已经写在指令开头时再单独一行就是重复。
function titleAlreadyLeads(title, instruction) {
  const head = String(title ?? "").trim();
  const body = String(instruction ?? "").trim();
  return !!head && !!body && body.startsWith(head);
}

const CARD_CONFIG = { wide_screen_mode: true, update_multi: true };

function cardHeader(content, template, subtitle) {
  const header = {
    title: { tag: "plain_text", content },
    template,
  };
  const sub = String(subtitle ?? "").trim();
  if (sub) header.subtitle = { tag: "plain_text", content: sub };
  return header;
}

function button(label, type, value) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

function decisionButtons(base) {
  const value = (decision) => ({ ...base, decision });
  return {
    tag: "column_set",
    flex_mode: "flow",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [button("同意执行", "primary", value("approve"))],
      },
      {
        tag: "column",
        width: "auto",
        elements: [button("驳回", "danger", value("reject"))],
      },
    ],
  };
}

function instructionOf(task, messages, parts) {
  const taskId = String(f1(task, "Task_ID") ?? "").trim();
  const instr = firstInstruction(messages, taskId);
  if (!instr) return { taskId, text: "", params: "" };
  const mid = f1(instr, "Msg_ID");
  return { taskId, text: messageText(parts, mid), params: messageParams(parts, mid) };
}

export function buildCard(task, messages, parts) {
  const { taskId, text, params } = instructionOf(task, messages || [], parts || []);
  const title = textValue(f1(task, "Title"));
  const target = textValue(f1(task, "Target_Node"));
  const skill = skillLabel(task);
  const worker = textValue(f1(task, "Worker_Hint"));
  const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
  const lines = [clipInstruction(text, taskId) || "（无文字指令）"];
  if (!titleAlreadyLeads(title, text)) lines.push(title);
  const paramText = clipParams(params);
  if (paramText) lines.push("参数：\n" + paramText);
  if (worker) lines.push("执行者：" + worker);
  const base = {
    record_id: task.record_id,
    task_id: taskId,
    status_msg: statusMsg,
    title: clipChars(title, TITLE_VALUE_LIMIT),
    target,
    skill,
  };
  return {
    schema: "2.0",
    config: { ...CARD_CONFIG },
    header: cardHeader(`待审批 · ${target}/${skill}`, "orange", taskId),
    body: {
      elements: [
        { tag: "markdown", content: lines.filter((line) => String(line ?? "").trim()).join("\n") },
        decisionButtons(base),
      ],
    },
  };
}

const STATUS_HEADER = {
  approved: ["已批准", "green"],
  rejected: ["已驳回", "red"],
  expired: ["已失效（任务状态已变化）", "grey"],
  failed: ["处理失败，可重试", "red"],
};

// 回调换卡时手里只有按钮 value。除失败外不再留按钮，避免机主对已经落定的决定再点一次。
// failed 保留同意/驳回，写表失败后可以原样重试。
export function buildStatusCard(info, { state, at = "", note = "" } = {}) {
  const src = info && typeof info === "object" && !Array.isArray(info) ? info : {};
  const taskId = String(src.task_id ?? "").trim();
  const title = String(src.title ?? "").trim();
  const target = String(src.target ?? "").trim();
  const skill = String(src.skill ?? "").trim();
  const when = String(at ?? "").trim();
  const extra = String(note ?? "").trim();
  const [headerText, template] = STATUS_HEADER[state] ?? ["审批状态未知", "grey"];
  const lines = [];
  if (title) lines.push(title);
  const where = [target, skill].filter(Boolean).join("/");
  if (where) lines.push(where);
  // 卡只发给机主本人，操作者必然是他，不必把 open_id 打在卡上。
  if (state === "approved" && when) lines.push(when);
  if ((state === "expired" || state === "failed") && extra) lines.push(extra);
  if (!lines.length) lines.push(taskId || "-");
  const elements = [{ tag: "markdown", content: lines.join("\n") }];
  if (state === "failed") elements.push(decisionButtons(src));
  return {
    schema: "2.0",
    config: { ...CARD_CONFIG },
    header: cardHeader(headerText, template, taskId),
    body: { elements },
  };
}
