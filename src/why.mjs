// why.mjs —— lah task why 单任务全链来龙去脉与时间线拼装。
// 职责：
// 1. 完全只读：复用 FeishuBus 现有 listRecords 接口，不写任何表，不新增依赖，不开端口；
// 2. 状态与溯源：汇总 Tasks 当前状态、认领节点、重试次数、待批/提问消息与跳数；
// 3. 消息与 Parts：按时间重排 Messages（instruction/question/answer/auth_request/auth_decision/result/notice 等），
//    标注 From_Node→To_Node 走向；文本正文截断至 200 字符；DataPart 仅显示键名、绝不显示值（凭据与参数值不泄露）；
// 4. 台账与产物：关联 Runs 每次执行的起止与结果，关联 Artifacts 成果指针；
// 5. 本地重试感知：只读检查配置目录下 outbox / inbox-outbox 是否存在该任务的待补交文件。
// 6. 用量：只读 Tasks.Metadata.usage，算出未上报轮数。没有这格就不估算。
// 7. 复查：只读 Tasks.Metadata.later / later_fired，显示待触发、已触发或跳数熔断。

import path from "node:path";
import fs from "node:fs";
import { f1 } from "./bus/feishu.mjs";

// 解析时间戳为毫秒数。兼容 ISO 8601、空格分隔格式与数字。
function parseTimestamp(val) {
  if (!val) return 0;
  if (typeof val === "number") return val;
  const s = String(val).trim();
  if (!s) return 0;
  const parsed = Date.parse(s.includes(" ") && !s.includes("T") ? s.replace(" ", "T") : s);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// 格式化展示时间
function formatTime(val) {
  if (!val) return "(未知时刻)";
  return String(val).trim();
}

// 文本正文截断至 200 字符
export function summarizeText(rawText, maxLen = 200) {
  if (!rawText) return "";
  const s = String(rawText).trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

// 递归提取结构化数据的所有键名，绝不输出任何值（防止泄露参数与凭据）
export function extractDataKeys(rawData, prefix = "") {
  if (!rawData) return [];
  let obj = rawData;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return ["(无法解析的非JSON数据)"];
    }
  }
  if (!obj || typeof obj !== "object") {
    return ["(非对象数据)"];
  }
  if (Array.isArray(obj)) {
    return prefix ? [`${prefix}[]`] : [`Array(${obj.length})`];
  }
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
      keys.push(...extractDataKeys(v, fullKey));
    } else if (Array.isArray(v)) {
      keys.push(`${fullKey}[]`);
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

// 用量只展示执行者上报后累加的结果。缺这格、坏 JSON、或 usage 不是对象，都视为没上报，不估算。
function usageView(rawMeta) {
  let meta = rawMeta;
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
  if (!Object.prototype.hasOwnProperty.call(meta, "usage")) return null;
  const usage = meta.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const num = (value, cost = false) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return cost ? Number(n.toFixed(6)) : Math.trunc(n);
  };
  const runs = num(usage.runs);
  const reported = Math.min(runs, num(usage.reported));
  return {
    input: num(usage.input),
    output: num(usage.output),
    cached: num(usage.cached),
    cost: num(usage.cost, true),
    runs,
    reported,
    unreported: Math.max(0, runs - reported),
  };
}

function usageLine(usage) {
  if (!usage) return "用量汇总: 未上报";
  return `用量汇总: input=${usage.input} output=${usage.output} cached=${usage.cached} cost=${usage.cost}（上报 ${usage.reported}/${usage.runs} 轮，未上报 ${usage.unreported} 轮）`;
}

function metaObject(rawMeta) {
  let meta = rawMeta;
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
  return meta;
}

// 没有 later 就不显示。已写 later_fired 表示这只时钟处理过，无论有没有建出新任务。
function laterView(rawMeta) {
  const meta = metaObject(rawMeta);
  if (!meta) return null;
  const later = meta.later;
  const fired = meta.later_fired;
  const hasLater = !!later && typeof later === "object" && !Array.isArray(later);
  const hasFired = !!fired && typeof fired === "object" && !Array.isArray(fired);
  if (!hasLater && !hasFired) return null;
  const reason = hasFired && typeof fired.reason === "string" ? fired.reason : "";
  const taskId = hasFired && typeof fired.task_id === "string" ? fired.task_id : "";
  let status = "pending";
  if (reason === "hop_limit") status = "skipped";
  else if (hasFired) status = "fired";
  return {
    status,
    at: hasLater && typeof later.at === "string" ? later.at : "",
    about: hasLater && typeof later.about === "string" ? later.about : "",
    task_id: taskId,
    fired_at: hasFired && typeof fired.at === "string" ? fired.at : "",
  };
}

function laterLine(later) {
  if (!later) return "";
  if (later.status === "fired") return `复查预约: 已触发 ${later.task_id || "(无任务号)"}`;
  if (later.status === "skipped") return "复查预约: 已跳过（跳数超限，未建复查任务）";
  const about = later.about ? ` ${later.about}` : "";
  return `复查预约: 待触发 ${later.at}${about}`;
}

// 事件类型在同一时刻下的自然逻辑顺序权重，保证时间戳相同时展示合理
const EVENT_ORDER_WEIGHT = {
  instruction: 10,
  "run-start": 20,
  question: 30,
  auth_request: 30,
  "run-pause": 40,
  answer: 50,
  auth_decision: 50,
  artifact: 60,
  result: 70,
  notice: 70,
  "run-finish": 80,
};

// 只读检查配置目录下是否有本地未落表的待补交文件
export function checkLocalOutbox(configDir, taskId) {
  const result = {
    kernel_outbox: null,
    inbox_outbox: null,
  };
  if (!configDir || !taskId || !/^[\w-]+$/.test(taskId)) {
    return result;
  }

  // 1. 检查节点内核 outbox (<configDir>/outbox/<taskId>.json)
  const kernelPath = path.join(configDir, "outbox", `${taskId}.json`);
  if (fs.existsSync(kernelPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(kernelPath, "utf8"));
      result.kernel_outbox = {
        path: kernelPath,
        task_id: data.taskId || taskId,
        outcome: data.outcome || "",
        run_id: data.runId || "",
        msg_id: data.msgId || "",
        art_id: data.artId || "",
        started: data.started || "",
        error: data.error || "",
      };
    } catch (e) {
      result.kernel_outbox = { path: kernelPath, error: "读取损坏: " + e.message };
    }
  }

  // 2. 检查独立 Agent 收件箱 outbox (<configDir>/inbox-outbox/<taskId>.json)
  const inboxPath = path.join(configDir, "inbox-outbox", `${taskId}.json`);
  if (fs.existsSync(inboxPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
      result.inbox_outbox = {
        path: inboxPath,
        task_id: data.taskId || taskId,
        op: data.op || "",
        msg_kind: data.msgKind || "",
        task_status: data.taskStatus || "",
        outcome: data.outcome || "",
        run_id: data.runId || "",
        msg_id: data.msgId || "",
        text: data.text ? data.text.slice(0, 100) : "",
      };
    } catch (e) {
      result.inbox_outbox = { path: inboxPath, error: "读取损坏: " + e.message };
    }
  }

  return result;
}

// 核心入口：从总线读取并拼装单任务全链事实
export async function getTaskWhy({ bus, configDir, taskId }) {
  const id = String(taskId ?? "").trim();
  if (!id) throw new Error("缺少 Task_ID");
  if (!bus?.tables?.tasks || !bus.tables.messages || !bus.tables.parts) {
    throw new Error("总线配置缺少 tasks / messages / parts 表");
  }

  // 1. 读取 Tasks
  const tasks = await bus.listRecords(bus.tables.tasks);
  const taskRow = tasks.find((t) => f1(t, "Task_ID") === id);
  if (!taskRow) throw new Error(`任务不存在：${id}`);

  const task = {
    task_id: id,
    title: f1(taskRow, "Title"),
    status: f1(taskRow, "Status"),
    claimed_by: f1(taskRow, "Claimed_By"),
    retry_count: Number(f1(taskRow, "Retry_Count")) || 0,
    status_msg: f1(taskRow, "Status_Msg"),
    hop_count: Number(f1(taskRow, "Hop_Count")) || 0,
    target_node: f1(taskRow, "Target_Node"),
    source: f1(taskRow, "Source"),
    skill_id: f1(taskRow, "Skill_ID"),
    worker_hint: f1(taskRow, "Worker_Hint"),
    context_id: f1(taskRow, "Context_ID"),
    approval_class: f1(taskRow, "Approval_Class"),
    heartbeat_at: f1(taskRow, "Heartbeat_At"),
    latest_run: f1(taskRow, "Latest_Run"),
    idempotency_key: f1(taskRow, "Idempotency_Key"),
  };
  const rawMeta = f1(taskRow, "Metadata");
  const usage = usageView(rawMeta);
  task.usage = usage;
  const later = laterView(rawMeta);
  task.later = later;

  // 2. 读取 Messages 与 Parts
  const allMessages = await bus.listRecords(bus.tables.messages);
  const rawMessages = allMessages.filter((m) => f1(m, "Task_ID") === id);
  const allParts = await bus.listRecords(bus.tables.parts);

  // 按 Created_At 排序，相同者按 Msg_ID 编号顺序
  rawMessages.sort((a, b) => {
    const diff = parseTimestamp(f1(a, "Created_At")) - parseTimestamp(f1(b, "Created_At"));
    if (diff !== 0) return diff;
    return String(f1(a, "Msg_ID") ?? "").localeCompare(String(f1(b, "Msg_ID") ?? ""));
  });

  const messages = [];
  for (const m of rawMessages) {
    const msgId = f1(m, "Msg_ID");
    const mParts = allParts
      .filter((p) => f1(p, "Parent_ID") === msgId && (f1(p, "Parent_Type") === "message" || !f1(p, "Parent_Type")))
      .sort((p1, p2) => (Number(f1(p1, "Seq")) || 0) - (Number(f1(p2, "Seq")) || 0));

    const partsSummary = [];
    for (const p of mParts) {
      const kind = f1(p, "Kind");
      const seq = Number(f1(p, "Seq")) || 0;
      const partId = f1(p, "Part_ID");
      if (kind === "text") {
        const text = summarizeText(f1(p, "Text"), 200);
        partsSummary.push({ part_id: partId, seq, kind: "text", text_summary: text });
      } else if (kind === "data") {
        const keys = extractDataKeys(f1(p, "Data"));
        partsSummary.push({ part_id: partId, seq, kind: "data", keys });
      } else if (kind === "file") {
        partsSummary.push({
          part_id: partId,
          seq,
          kind: "file",
          file_name: f1(p, "File_Name"),
          file_uri: f1(p, "File_URI"),
          mime_type: f1(p, "Mime_Type"),
        });
      } else {
        partsSummary.push({ part_id: partId, seq, kind: kind || "unknown" });
      }
    }

    const fromNode = f1(m, "From_Node");
    const toNode = f1(m, "To_Node");
    messages.push({
      msg_id: msgId,
      task_id: id,
      created_at: f1(m, "Created_At"),
      role: f1(m, "Role"),
      kind: f1(m, "Kind"),
      from: fromNode,
      to: toNode,
      direction: `${fromNode || "(未知)"} → ${toNode || "(未知)"}`,
      in_reply_to: f1(m, "In_Reply_To"),
      artifact_ref: f1(m, "Artifact_Ref"),
      ref_task_ids: f1(m, "Ref_Task_IDs"),
      parts: partsSummary,
    });
  }

  // 3. 读取 Runs 台账
  const allRuns = bus.tables.runs ? await bus.listRecords(bus.tables.runs) : [];
  const rawRuns = allRuns.filter((r) => f1(r, "Task_Ref") === id);
  rawRuns.sort((a, b) => {
    const diff = parseTimestamp(f1(a, "Started_At")) - parseTimestamp(f1(b, "Started_At"));
    if (diff !== 0) return diff;
    return String(f1(a, "Run_ID") ?? "").localeCompare(String(f1(b, "Run_ID") ?? ""));
  });

  const runs = rawRuns.map((r) => ({
    run_id: f1(r, "Run_ID"),
    node: f1(r, "Node"),
    worker: f1(r, "Worker"),
    outcome: f1(r, "Outcome"),
    started_at: f1(r, "Started_At"),
    finished_at: f1(r, "Finished_At"),
    error_log: f1(r, "Error_Log"),
  }));

  // 4. 读取 Artifacts 指针
  const allArtifacts = bus.tables.artifacts ? await bus.listRecords(bus.tables.artifacts) : [];
  const rawArtifacts = allArtifacts.filter((a) => f1(a, "Task_ID") === id);
  rawArtifacts.sort((a, b) => {
    const diff = parseTimestamp(f1(a, "Created_At")) - parseTimestamp(f1(b, "Created_At"));
    if (diff !== 0) return diff;
    return String(f1(a, "Artifact_ID") ?? "").localeCompare(String(f1(b, "Artifact_ID") ?? ""));
  });

  const artifacts = rawArtifacts.map((a) => {
    const artId = f1(a, "Artifact_ID");
    const aParts = allParts
      .filter((p) => f1(p, "Parent_ID") === artId && f1(p, "Parent_Type") === "artifact")
      .map((p) => ({
        part_id: f1(p, "Part_ID"),
        kind: f1(p, "Kind"),
        file_name: f1(p, "File_Name"),
        file_uri: f1(p, "File_URI"),
        mime_type: f1(p, "Mime_Type"),
      }));
    return {
      artifact_id: artId,
      name: f1(a, "Name"),
      description: f1(a, "Description"),
      is_final: f1(a, "Is_Final"),
      created_by: f1(a, "Created_By"),
      created_at: f1(a, "Created_At"),
      parts: aParts,
    };
  });

  // 5. 检查本地待补交 outbox
  const outbox = checkLocalOutbox(configDir, id);

  // 6. 汇编全链时间线
  const timeline = [];

  // Messages 事件
  for (const m of messages) {
    const textPart = m.parts.find((p) => p.kind === "text");
    const dataPart = m.parts.find((p) => p.kind === "data");
    const filePart = m.parts.find((p) => p.kind === "file");

    const segments = [];
    if (textPart?.text_summary) segments.push(`正文: ${textPart.text_summary}`);
    if (dataPart?.keys?.length) segments.push(`参数键: [${dataPart.keys.join(", ")}]`);
    if (filePart?.file_name) segments.push(`附件: ${filePart.file_name}`);
    if (m.artifact_ref) segments.push(`交付物: ${m.artifact_ref}`);

    timeline.push({
      time: m.created_at,
      timestamp: parseTimestamp(m.created_at),
      order_weight: EVENT_ORDER_WEIGHT[m.kind] ?? 35,
      type: "message",
      kind: m.kind,
      ref_id: m.msg_id,
      from: m.from,
      to: m.to,
      direction: m.direction,
      in_reply_to: m.in_reply_to,
      summary: `[${m.kind}] ${m.direction} (${m.msg_id})`,
      details: segments,
    });
  }

  // Runs 事件
  for (const r of runs) {
    if (r.started_at) {
      timeline.push({
        time: r.started_at,
        timestamp: parseTimestamp(r.started_at),
        order_weight: EVENT_ORDER_WEIGHT["run-start"],
        type: "run",
        action: "start",
        ref_id: r.run_id,
        node: r.node,
        worker: r.worker,
        summary: `[run-start] 节点 ${r.node || "(未知)"} 开始执行 (${r.run_id}) · worker: ${r.worker || "(默认)"}`,
        details: [],
      });
    }

    if (r.finished_at || r.outcome) {
      const outcome = r.outcome || "finished";
      const isPause = outcome === "paused";
      const weight = isPause ? EVENT_ORDER_WEIGHT["run-pause"] : EVENT_ORDER_WEIGHT["run-finish"];
      const outcomeDesc = outcome === "succeeded" ? "成功" : outcome === "paused" ? "暂停(待输入)" : outcome === "failed" ? "失败" : outcome;
      const details = [];
      if (r.error_log) details.push(`错误日志: ${summarizeText(r.error_log, 200)}`);

      timeline.push({
        time: r.finished_at || r.started_at,
        timestamp: parseTimestamp(r.finished_at) || (parseTimestamp(r.started_at) + 1),
        order_weight: weight,
        type: "run",
        action: isPause ? "pause" : "finish",
        ref_id: r.run_id,
        outcome,
        summary: `[run-${outcome}] 执行${outcomeDesc} (${outcome}) · ${r.run_id}`,
        details,
      });
    }
  }

  // Artifacts 事件
  for (const a of artifacts) {
    timeline.push({
      time: a.created_at,
      timestamp: parseTimestamp(a.created_at),
      order_weight: EVENT_ORDER_WEIGHT.artifact,
      type: "artifact",
      ref_id: a.artifact_id,
      name: a.name,
      created_by: a.created_by,
      summary: `[artifact] 生成产物 ${a.artifact_id} (${a.name || "未命名"}) · 创建者: ${a.created_by || "(未知)"}`,
      details: a.description ? [`说明: ${summarizeText(a.description, 200)}`] : [],
    });
  }

  // 严格按时间戳重排序；时间戳相同时使用业务逻辑权重排序
  timeline.sort((e1, e2) => {
    const diff = e1.timestamp - e2.timestamp;
    if (diff !== 0) return diff;
    return e1.order_weight - e2.order_weight;
  });

  return {
    task,
    usage,
    later,
    timeline,
    messages,
    runs,
    artifacts,
    outbox,
  };
}

// 格式化文本输出：清晰呈现来龙去脉全链
export function formatWhyText(data) {
  const { task, timeline, outbox } = data;
  const lines = [];

  lines.push("================================================================================");
  lines.push(`任务 ${task.task_id}：${task.title || "(无标题)"}`);
  lines.push("================================================================================");
  lines.push(`当前状态: ${task.status || "(空)"}`);
  lines.push(`认领节点: ${task.claimed_by || "(未认领)"}`);
  lines.push(`重试次数: ${task.retry_count}`);
  lines.push(usageLine(data.usage ?? task.usage));
  const laterText = laterLine(data.later ?? task.later);
  if (laterText) lines.push(laterText);
  lines.push(`提问/待批: ${task.status_msg || "(无)"}`);
  lines.push(`派生跳数: ${task.hop_count}`);
  lines.push(`目标节点: ${task.target_node || "(未指定)"}`);
  lines.push(`任务来源: ${task.source || "(未指定)"}`);
  lines.push(`技能/能力: ${task.skill_id || task.worker_hint || "(默认)"}`);
  lines.push(`会话编号: ${task.context_id || "(无)"}`);
  if (task.approval_class) lines.push(`审批等级: ${task.approval_class}`);
  if (task.heartbeat_at) lines.push(`心跳时间: ${task.heartbeat_at}`);
  lines.push("");

  lines.push("时间线：");
  lines.push("--------------------------------------------------------------------------------");
  if (!timeline.length) {
    lines.push("  (暂无时间线记录)");
  } else {
    for (const event of timeline) {
      const timeStr = formatTime(event.time);
      lines.push(`${timeStr.padEnd(21)} ${event.summary}`);
      if (event.in_reply_to) {
        lines.push(`${"".padEnd(22)} 回复: ${event.in_reply_to}`);
      }
      for (const d of event.details) {
        lines.push(`${"".padEnd(22)} ${d}`);
      }
      lines.push("");
    }
    // 移除末尾多余空行
    if (lines[lines.length - 1] === "") lines.pop();
  }
  lines.push("--------------------------------------------------------------------------------");

  lines.push("本地待补交队列：");
  let hasPending = false;
  if (outbox.kernel_outbox) {
    hasPending = true;
    const k = outbox.kernel_outbox;
    lines.push(`  - 内核 outbox: 待补交 (${k.error || `outcome=${k.outcome}, run=${k.run_id}, msg=${k.msg_id}`})`);
  }
  if (outbox.inbox_outbox) {
    hasPending = true;
    const i = outbox.inbox_outbox;
    lines.push(`  - 收件箱 outbox: 待补交 (${i.error || `op=${i.op}, status=${i.task_status}, outcome=${i.outcome}, run=${i.run_id}`})`);
  }
  if (!hasPending) {
    lines.push("  (无待补交条目)");
  }
  lines.push("================================================================================");

  return lines.join("\n");
}
