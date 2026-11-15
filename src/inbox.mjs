// src/inbox.mjs —— 独立 Agent 收件箱操作库。
// 承载 agent_inbox.jsonl 的原子读写、心跳核验与 lah inbox (done|ask|fail|auth) 的总线状态流转。
// 回执先落入本文件自己的 inbox-outbox（固定 Msg_ID / Part_ID / Artifact_ID / Run 更新），
// 写表中途失败只补缺，不另开一条 result。这个目录不能并进内核的 outbox/：
// 内核 flushOutbox 会把该目录下每个 json 当成自己的提交计划。
// 严格遵守红线：只能操作本节点认领且处于 working 的任务；node 角色绝不写 auth_decision 与 canceled。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  acceptanceIndex,
  buildAcceptance,
  CHECK_VERDICTS,
  CRITERION_ID,
  judgeChecks,
  MAX_EVIDENCE,
  parseCheckFlag,
  parseCriteria,
} from "./acceptance.mjs";
import { f1 } from "./bus/feishu.mjs";
import { log, readTaskMeta } from "./kernel-util.mjs";

export function inboxFilePath(configDir) {
  return path.join(configDir, "agent_inbox.jsonl");
}

export function readInbox(configDir) {
  const file = inboxFilePath(configDir);
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const list = [];
    for (const l of lines) {
      try { list.push(JSON.parse(l)); } catch {}
    }
    return list;
  } catch {
    return [];
  }
}

export function writeInbox(configDir, list) {
  const file = inboxFilePath(configDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  const content = list.map((item) => JSON.stringify(item)).join("\n") + (list.length ? "\n" : "");
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function enqueueOrUpdateInbox(configDir, item) {
  const list = readInbox(configDir);
  const idx = list.findIndex((x) => x.task_id === item.task_id);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      ...item,
      updated_at: new Date().toISOString(),
      status: "pending", // 置回 pending 等待 Agent 消费
    };
  } else {
    list.push({
      ...item,
      status: "pending",
      created_at: new Date().toISOString(),
    });
  }
  writeInbox(configDir, list);
}

export function popPendingInbox(configDir, { pop = false } = {}) {
  const list = readInbox(configDir);
  const pending = list.filter((item) => item.status === "pending");
  if (pop && pending.length > 0) {
    for (const p of pending) {
      p.status = "acked";
      p.acked_at = new Date().toISOString();
    }
    writeInbox(configDir, list);
  }
  return pending;
}

export function markInboxStatus(configDir, taskId, status, extra = {}) {
  const list = readInbox(configDir);
  const target = list.find((x) => x.task_id === taskId);
  if (target) {
    target.status = status;
    Object.assign(target, extra);
    writeInbox(configDir, list);
    return true;
  }
  return false;
}

export function initiatorOf(task, messages = []) {
  if (Array.isArray(messages) && messages.length > 0) {
    const instr = messages.find((m) => f1(m, "Kind") === "instruction");
    if (instr) {
      const from = String(f1(instr, "From_Node") ?? "").trim();
      if (from) return from;
    }
  }
  const source = String(f1(task, "Source") ?? "").trim();
  if (source) return source;
  return "hub";
}

function nowIso() {
  // 与 kernel.nowStr 同一口径：本地时间 ISO 8601 带时区偏移。
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}`;
}

// 终态与计划目标不一致时，不能再往总线上补一条回执。canceled 只由 hub 写，这里只丢本地计划。
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled", "rejected"]);

const OP_SPEC = {
  done: { msgKind: "result", outcome: "succeeded", taskStatus: "completed" },
  ask: { msgKind: "question", outcome: "paused", taskStatus: "input-required" },
  fail: { msgKind: "notice", outcome: "failed", taskStatus: "failed" },
  auth: { msgKind: "auth_request", outcome: "paused", taskStatus: "auth-required" },
};

function inboxOutboxPath(configDir, taskId) {
  const id = String(taskId ?? "");
  // 与内核 outboxPath 同一套字符约束，避免 Task_ID 把路径带出配置目录。
  if (!/^[\w-]+$/.test(id)) throw new Error("非法 Task_ID，拒绝写入 inbox outbox");
  return path.join(configDir, "inbox-outbox", `${id}.json`);
}

function readInboxOutbox(configDir, taskId) {
  try {
    return JSON.parse(fs.readFileSync(inboxOutboxPath(configDir, taskId), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function saveInboxOutbox(configDir, plan) {
  const dest = inboxOutboxPath(configDir, plan.taskId);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(plan), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
}

function deleteInboxOutbox(configDir, taskId) {
  try { fs.unlinkSync(inboxOutboxPath(configDir, taskId)); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
}

// 编号取已有最大序号 + 1。用行数 + 1 会在缺号时撞车；与内核 nextSuffix 同一算法，不抽共享模块。
function nextSuffix(ids, re) {
  let max = 0;
  for (const id of ids) {
    const m = String(id ?? "").match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function nextMsgSeqFrom(msgs) {
  let max = 0;
  for (const m of msgs) {
    const id = String(f1(m, "Msg_ID") ?? "");
    const match = id.match(/-(\d+)$/);
    if (!match) continue;
    const n = Number(match[1]);
    if (n > max) max = n;
  }
  return max + 1;
}

// 没有 Finished_At、也没有 Outcome，才是认领时打开、尚未关账的执行段。
function runIsOpen(row) {
  if (!row) return false;
  if (String(f1(row, "Finished_At") ?? "").trim()) return false;
  if (String(f1(row, "Outcome") ?? "").trim()) return false;
  return true;
}

function mimeOf(name) {
  const ext = path.extname(String(name ?? "")).toLowerCase();
  const known = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".xml": "application/xml",
  };
  return known[ext] || "application/octet-stream";
}

// 摘要留在 result 的 TextPart。Outcome 是单选，fail 的原因进 Error_Log，ask 与内核 NeedInput 一样记一笔暂停原因。
function errorLogFor(op, text) {
  if (op === "fail") return String(text ?? "").slice(0, 800);
  if (op === "ask") return ("input-required: " + String(text ?? "").slice(0, 400)).slice(0, 800);
  if (op === "auth") return ("auth-required: " + String(text ?? "").slice(0, 400)).slice(0, 800);
  return "";
}

function assertOwner(task, node) {
  const target = f1(task, "Target_Node");
  const claimedBy = f1(task, "Claimed_By");
  if (target !== node) throw new Error(`任务目标节点是 ${target}，不是当前节点 ${node}`);
  if (claimedBy !== node) throw new Error(`任务当前认领者是 ${claimedBy}，不是当前节点 ${node}`);
}

async function loadTask(bus, taskId) {
  const tasks = await bus.listRecords(bus.tables.tasks);
  const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);
  return task;
}

function msgTail(id) {
  const m = String(id ?? "").match(/-(\d+)$/);
  return m ? Number(m[1]) : -1;
}

function normalizeFlagChecks(checks) {
  if (checks == null) return { reported: {}, hasCheckFlags: false };
  if (!Array.isArray(checks)) throw new Error("checks 必须是数组");
  if (checks.length === 0) return { reported: {}, hasCheckFlags: false };
  const reported = {};
  for (const item of checks) {
    if (typeof item === "string") {
      const parsed = parseCheckFlag(item);
      reported[parsed.id] = { verdict: parsed.verdict, evidence: parsed.evidence };
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const id = String(item.id ?? "").trim();
      const verdict = String(item.verdict ?? "").trim().toLowerCase();
      if (!CRITERION_ID.test(id)) throw new Error(`--check 的 id 不合法：${id.slice(0, 40)}`);
      if (!CHECK_VERDICTS.has(verdict)) throw new Error(`--check 的判定只能是 pass / fail / blocked：${verdict.slice(0, 20)}`);
      const ev = String(item.evidence ?? "").trim();
      reported[id] = { verdict, evidence: ev.length > MAX_EVIDENCE ? ev.slice(0, MAX_EVIDENCE) : ev };
    } else {
      throw new Error("--check 参数格式非法");
    }
  }
  return { reported, hasCheckFlags: true };
}

// 清单只认首条 instruction 消息的 DataPart 合并（标准 §11.2），不认 Tasks.Metadata。
async function instructionCriteria(bus, taskMsgs, logFn = log) {
  const sorted = taskMsgs.slice().sort((a, b) => msgTail(f1(a, "Msg_ID")) - msgTail(f1(b, "Msg_ID")));
  const instr = sorted.find((m) => f1(m, "Kind") === "instruction");
  if (!instr) return { criteriaRef: "", criteria: [] };
  const criteriaRef = String(f1(instr, "Msg_ID") ?? "");
  if (!bus.tables.parts || !criteriaRef) return { criteriaRef, criteria: [] };
  const allParts = await bus.listRecords(bus.tables.parts);
  const instrParts = allParts
    .filter((p) => String(f1(p, "Parent_ID") ?? "") === criteriaRef)
    .sort((a, b) => (Number(f1(a, "Seq")) || 0) - (Number(f1(b, "Seq")) || 0));
  const params = {};
  for (const p of instrParts) {
    if (f1(p, "Kind") !== "data") continue;
    const raw = f1(p, "Data");
    if (!raw) continue;
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) Object.assign(params, obj);
    } catch { /* 坏数据跳过 */ }
  }
  const parsed = parseCriteria(params);
  if (!parsed.ok) {
    logFn("instruction 清单不合法，按无清单处理：" + parsed.error);
    return { criteriaRef, criteria: [] };
  }
  return { criteriaRef, criteria: parsed.criteria };
}

async function buildPlan({ bus, node, task, text, artifact, op, reportedChecks = {}, hasCheckFlags = false, logFn = log }) {
  const spec = OP_SPEC[op];
  const taskId = f1(task, "Task_ID");
  const messages = await bus.listRecords(bus.tables.messages);
  const taskMsgs = messages.filter((m) => f1(m, "Task_ID") === taskId);
  const seq = nextMsgSeqFrom(taskMsgs);
  const msgId = `MSG-${taskId.replace(/^TASK-/, "")}-${String(seq).padStart(2, "0")}`;
  const createdAt = nowIso();
  const body = String(text ?? "");

  let acceptance = null;
  if (op === "done") {
    const { criteriaRef, criteria } = await instructionCriteria(bus, taskMsgs, logFn);
    if (hasCheckFlags && criteria.length === 0) {
      throw new Error(`任务 ${taskId} 没有验收清单`);
    }
    if (criteria.length > 0) {
      const checked = judgeChecks(criteria, reportedChecks, logFn);
      acceptance = buildAcceptance({ verify: null, criteriaRef, checks: checked });
    }
  }

  let artId = "";
  let artName = "";
  let fileUri = "";
  let mime = "";
  let description = "";
  let metadata = "";
  if (artifact && bus.tables.artifacts) {
    const arts = (await bus.listRecords(bus.tables.artifacts)).filter((a) => f1(a, "Task_ID") === taskId);
    artId = `${taskId}-A${nextSuffix(arts.map((a) => f1(a, "Artifact_ID")), /-A(\d+)$/)}`;
    artName = path.basename(String(artifact));
    fileUri = String(artifact);
    mime = mimeOf(artName);
    description = (body.trim() || `Artifact for task ${taskId}: ${artName}`).slice(0, 500);
    // Metadata.path 只是附注。内容以 Parent_Type=artifact 的 file Part 为准（标准 §5）。
    metadata = JSON.stringify({ path: fileUri });
  }

  // 认领时内核已经开过 Run。没关账就更新那一行；已 paused 说明这是续跑后的新执行段，另开一行。
  // inbox 的 resumeCheck 只把任务放回 working 并重新入队，不开 Run；新段只能在本文件的下一次回执里开。
  let runId = "";
  let runMode = "create";
  let startedAt = createdAt;
  if (bus.tables.runs) {
    const runs = await bus.listRecords(bus.tables.runs);
    const latest = String(f1(task, "Latest_Run") ?? "").trim();
    const open = latest ? runs.find((r) => f1(r, "Run_ID") === latest) : null;
    if (runIsOpen(open)) {
      runId = latest;
      runMode = "update";
      startedAt = String(f1(open, "Started_At") ?? "") || createdAt;
    } else {
      const mine = runs.filter((r) => f1(r, "Task_Ref") === taskId);
      runId = `${taskId}-R${nextSuffix(mine.map((r) => f1(r, "Run_ID")), /-R(\d+)$/)}`;
    }
  }

  return {
    v: 1,
    kind: "inbox-receipt",
    op,
    node,
    taskId,
    text: body,
    recipient: initiatorOf(task, taskMsgs),
    contextId: String(f1(task, "Context_ID") ?? ""),
    createdAt,
    msgId,
    msgPartId: `${msgId}-P1`,
    msgDataPartId: (op === "auth" || (op === "done" && acceptance)) ? `${msgId}-P2` : "",
    msgKind: spec.msgKind,
    acceptance,
    artId,
    artPartId: artId ? `${artId}-P1` : "",
    artName,
    fileUri,
    mime,
    description,
    metadata,
    runId,
    runMode,
    worker: String(f1(task, "Worker_Hint") || "daemon"),
    startedAt,
    runUpdate: {
      Finished_At: createdAt,
      Outcome: spec.outcome,
      Error_Log: errorLogFor(op, body),
    },
    taskStatus: spec.taskStatus,
    tokens: {
      artifact: randomUUID(),
      artifactPart: randomUUID(),
      run: randomUUID(),
      message: randomUUID(),
      partText: randomUUID(),
      partData: randomUUID(),
    },
  };
}

async function findRow(bus, table, field, value) {
  if (!table || !value) return null;
  const rows = await bus.listRecords(table);
  return rows.find((r) => f1(r, field) === value) ?? null;
}

async function ensureCreate(bus, table, idField, id, fields, token) {
  if (!id) return;
  if (await findRow(bus, table, idField, id)) return;
  await bus.createRecord(table, fields, token);
}

async function ensureArtifact(bus, plan, node) {
  if (!plan.artId || !bus.tables.artifacts) return;
  await ensureCreate(bus, bus.tables.artifacts, "Artifact_ID", plan.artId, {
    Artifact_ID: plan.artId,
    Task_ID: plan.taskId,
    Context_ID: plan.contextId,
    Name: plan.artName,
    Description: plan.description,
    Is_Final: "Yes",
    Created_By: node,
    Created_At: plan.createdAt,
    Metadata: plan.metadata,
  }, plan.tokens.artifact);
  // 产物正文不在 Artifacts 表。补齐时按 Part_ID 跳过，避免再插一块。
  await ensureCreate(bus, bus.tables.parts, "Part_ID", plan.artPartId, {
    Part_ID: plan.artPartId,
    Parent_ID: plan.artId,
    Parent_Type: "artifact",
    Seq: 1,
    Kind: "file",
    File_URI: plan.fileUri,
    File_Name: plan.artName,
    Mime_Type: plan.mime,
  }, plan.tokens.artifactPart);
}

async function ensureRun(bus, plan, node) {
  if (!plan.runId || !bus.tables.runs) return;
  const row = await findRow(bus, bus.tables.runs, "Run_ID", plan.runId);
  const want = plan.runUpdate;
  if (row) {
    const closed = String(f1(row, "Finished_At") ?? "").trim() && f1(row, "Outcome") === want.Outcome;
    if (closed) return;
    await bus.updateRecord(bus.tables.runs, row.record_id, {
      Finished_At: want.Finished_At,
      Outcome: want.Outcome,
      Error_Log: want.Error_Log,
    });
    return;
  }
  await bus.createRecord(bus.tables.runs, {
    Run_ID: plan.runId,
    Task_Ref: plan.taskId,
    Node: node,
    Worker: plan.worker || "daemon",
    Error_Log: want.Error_Log,
    Started_At: plan.startedAt || plan.createdAt,
    Finished_At: want.Finished_At,
    Outcome: want.Outcome,
  }, plan.tokens.run);
}

async function ensureMessage(bus, plan, node) {
  const fields = {
    Msg_ID: plan.msgId,
    Task_ID: plan.taskId,
    Context_ID: plan.contextId,
    From_Node: node,
    // 动态审批要进 hub 的发卡扫描。原路回给发起方，机主看不到这张请求。
    To_Node: plan.op === "auth" ? "hub" : plan.recipient,
    Role: "agent",
    Kind: plan.msgKind,
    Created_At: plan.createdAt,
  };
  if (plan.artId) fields.Artifact_Ref = plan.artId;
  await ensureCreate(bus, bus.tables.messages, "Msg_ID", plan.msgId, fields, plan.tokens.message);
  await ensureCreate(bus, bus.tables.parts, "Part_ID", plan.msgPartId, {
    Part_ID: plan.msgPartId,
    Parent_ID: plan.msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: String(plan.text ?? "").slice(0, 4000),
  }, plan.tokens.partText);
  if (plan.op === "auth" && plan.msgDataPartId) {
    await ensureCreate(bus, bus.tables.parts, "Part_ID", plan.msgDataPartId, {
      Part_ID: plan.msgDataPartId,
      Parent_ID: plan.msgId,
      Parent_Type: "message",
      Seq: 2,
      Kind: "data",
      Data: JSON.stringify({ scope: "dynamic", run_id: plan.runId }),
    }, plan.tokens.partData);
  } else if (plan.op === "done" && plan.acceptance && plan.msgDataPartId) {
    await ensureCreate(bus, bus.tables.parts, "Part_ID", plan.msgDataPartId, {
      Part_ID: plan.msgDataPartId,
      Parent_ID: plan.msgId,
      Parent_Type: "message",
      Seq: 2,
      Kind: "data",
      Data: JSON.stringify({ acceptance: plan.acceptance }),
    }, plan.tokens.partData);
  }
}

function taskFieldsOf(plan) {
  const fields = {
    Status: plan.taskStatus,
    Status_Msg: plan.msgId,
  };
  if (plan.runId) fields.Latest_Run = plan.runId;
  // ask 只把任务送进 input-required。done/fail 才清心跳；重新呈递靠新终态的
  // presentKey（与旧键不同），不再写 Presented 列（v3.5 已废弃，见标准 §10.2）。
  if (plan.op !== "ask") {
    fields.Heartbeat_At = "";
  }
  return fields;
}

async function ensureTask(bus, plan, node) {
  const task = await loadTask(bus, plan.taskId);
  assertOwner(task, node);
  const st = f1(task, "Status");
  if (st === plan.taskStatus) return task.record_id;
  if (st !== "working") throw new Error(`任务当前状态是 ${st}，无法补齐为 ${plan.taskStatus}`);
  await bus.updateRecord(bus.tables.tasks, task.record_id, taskFieldsOf(plan));
  return task.record_id;
}

// Metadata 只是索引，权威记录已经在 result 的 DataPart 落表；先读后合并，写失败只记日志不影响回执。
async function ensureAcceptanceMeta(bus, plan, recordId, logFn = log) {
  try {
    const fresh = bus.getRecord && recordId
      ? await bus.getRecord(bus.tables.tasks, recordId)
      : await loadTask(bus, plan.taskId);
    if (!fresh) return;
    const read = readTaskMeta(f1(fresh, "Metadata"));
    if (!read.ok) {
      logFn("Tasks.Metadata 无法合并，跳过 acceptance（不影响回执）");
      return;
    }
    read.meta.acceptance = acceptanceIndex(plan.acceptance, plan.msgId);
    await bus.updateRecord(bus.tables.tasks, fresh.record_id, {
      Metadata: JSON.stringify(read.meta),
    });
  } catch (e) {
    logFn("Tasks.Metadata.acceptance 写失败（不影响回执）：" + (e?.message ?? e));
  }
}

function rememberLocal(configDir, plan) {
  if (plan.op === "done") {
    markInboxStatus(configDir, plan.taskId, "done", { completed_at: new Date().toISOString() });
  } else if (plan.op === "ask") {
    markInboxStatus(configDir, plan.taskId, "waiting-answer", {
      asked_at: new Date().toISOString(),
      question: plan.text,
    });
  } else if (plan.op === "auth") {
    markInboxStatus(configDir, plan.taskId, "waiting-auth", {
      auth_msg_id: plan.msgId,
      auth_reason: plan.text,
      auth_requested_at: new Date().toISOString(),
    });
  } else {
    markInboxStatus(configDir, plan.taskId, "failed", {
      failed_at: new Date().toISOString(),
      reason: plan.text,
    });
  }
}

function receiptOf(plan) {
  const base = { taskId: plan.taskId, msgId: plan.msgId, recipient: plan.recipient };
  if (plan.op === "done") {
    return {
      ...base,
      artifactId: plan.artId || "",
      ...(plan.acceptance ? { acceptance: plan.acceptance } : {}),
    };
  }
  return base;
}

// 顺序对齐内核：Artifacts → Runs → Messages/Parts → Tasks。任一步失败都留着计划，下次只补缺。
async function commitInboxReceipt({ bus, configDir, node, taskId, text, artifact, op, reportedChecks = {}, hasCheckFlags = false, logFn = log }) {
  const existing = readInboxOutbox(configDir, taskId);
  if (existing && existing.op !== op) {
    throw new Error(`任务 ${taskId} 有未完成的 inbox ${existing.op} 提交，请重试同一命令补齐`);
  }
  if (existing && existing.node && existing.node !== node) {
    throw new Error(`任务 ${taskId} 的 inbox 提交属于节点 ${existing.node}`);
  }

  const task = await loadTask(bus, taskId);
  assertOwner(task, node);
  const st = f1(task, "Status");
  if (existing && TERMINAL_STATUSES.has(st) && st !== existing.taskStatus) {
    deleteInboxOutbox(configDir, taskId);
    throw new Error(`任务已进入终态 ${st}，未完成的 inbox 提交已放弃`);
  }
  if (!existing && st !== "working") {
    throw new Error(`任务当前状态是 ${st}，不是 working`);
  }
  if (existing && st !== "working" && st !== existing.taskStatus) {
    throw new Error(`任务当前状态是 ${st}，不是 working`);
  }

  // 第一笔总线写之前先落盘。重试复用这份计划，不再按当前行数重新编号。
  const plan = existing ?? await buildPlan({ bus, node, task, text, artifact, op, reportedChecks, hasCheckFlags, logFn });
  if (!existing) saveInboxOutbox(configDir, plan);

  await ensureArtifact(bus, plan, node);
  await ensureRun(bus, plan, node);
  await ensureMessage(bus, plan, node);
  const taskRecordId = await ensureTask(bus, plan, node);
  if (plan.op === "done" && plan.acceptance) {
    await ensureAcceptanceMeta(bus, plan, taskRecordId, logFn);
  }

  rememberLocal(configDir, plan);
  deleteInboxOutbox(configDir, taskId);
  return receiptOf(plan);
}

export async function handleInboxDone({ bus, configDir, node, taskId, text, artifact, checks, log: logFn = log }) {
  const { reported, hasCheckFlags } = normalizeFlagChecks(checks);
  return commitInboxReceipt({
    bus, configDir, node, taskId, text, artifact, op: "done",
    reportedChecks: reported, hasCheckFlags, logFn,
  });
}

export async function handleInboxAsk({ bus, configDir, node, taskId, text }) {
  return commitInboxReceipt({ bus, configDir, node, taskId, text, op: "ask" });
}

export async function handleInboxFail({ bus, configDir, node, taskId, text }) {
  // inbox fail 是本尊宣告终止，直接进 failed，不按 Retry_Count 退回 submitted。
  return commitInboxReceipt({ bus, configDir, node, taskId, text, op: "fail" });
}

export async function handleInboxAuth({ bus, configDir, node, taskId, text }) {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("审批说明不能为空");
  // 先标 waiting-auth，写总线期间 lah inbox --pop 不能再把这条 pending 取走。
  if (!markInboxStatus(configDir, taskId, "waiting-auth")) {
    throw new Error(`收件箱没有任务 ${taskId}`);
  }
  return commitInboxReceipt({ bus, configDir, node, taskId, text: body, op: "auth" });
}
