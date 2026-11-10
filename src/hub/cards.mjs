// 审批卡内容。脱敏按键名分词，不按子串，避免把含有这些词的普通字段误伤。
// 卡片用 schema 2.0，按钮走 callback behavior，这样 Node SDK 的
// card.action.trigger 才能收到点击。按钮 value 多带 status_msg，回调用它判断卡是否过期。

import { f1 } from "../bus/feishu.mjs";

const DETAIL_LIMIT = 2000;
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

function clip(text) {
  const value = String(text ?? "").trim();
  if (value.length <= DETAIL_LIMIT) return value;
  return value.slice(0, DETAIL_LIMIT).trimEnd() + "…（已截断）";
}

export function pendingContent(task, messages = [], parts = []) {
  const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
  if (statusMsg) {
    const body = messageText(parts, statusMsg);
    if (body) return clip(body);
  }
  const instr = firstInstruction(messages, f1(task, "Task_ID"));
  if (instr) {
    const mid = f1(instr, "Msg_ID");
    const summary = messageText(parts, mid);
    const params = messageParams(parts, mid);
    const chunks = [];
    if (summary) chunks.push("摘要：" + summary);
    if (params) chunks.push("参数：\n" + params);
    if (chunks.length) return clip(chunks.join("\n"));
  }
  return clip(String(f1(task, "Context_ID") ?? ""));
}

function button(label, type, value) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

export function buildCard(task, messages, parts) {
  const detail = pendingContent(task, messages, parts) || "-";
  const recordId = task.record_id;
  const taskId = f1(task, "Task_ID");
  const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
  const base = { decision: "", record_id: recordId, task_id: taskId, status_msg: statusMsg };
  const field = (label, value) => `**${label}**\n${value ?? ""}`;
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "中台任务待审批" },
      template: "orange",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            field("任务", f1(task, "Title")),
            field("编号", taskId),
            field("目标节点", f1(task, "Target_Node")),
            field("技能", f1(task, "Skill_ID") || "-"),
            field("执行者", f1(task, "Worker_Hint") || "节点默认"),
            field("上下文", f1(task, "Context_ID") || "-"),
          ].join("\n"),
        },
        { tag: "markdown", content: "**待执行内容**\n" + detail },
        {
          tag: "column_set",
          flex_mode: "flow",
          columns: [
            {
              tag: "column",
              width: "auto",
              elements: [button("同意执行", "primary", { ...base, decision: "approve" })],
            },
            {
              tag: "column",
              width: "auto",
              elements: [button("驳回", "danger", { ...base, decision: "reject" })],
            },
          ],
        },
      ],
    },
  };
}
