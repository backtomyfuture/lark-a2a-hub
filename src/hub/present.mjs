// hub 角色的结果呈递。把需要机主知道的状态发到机主私聊。
// 去重键：中断态是 (Task_ID, Status_Msg)；终态再带上 Status。终态的 Status_Msg
// 经常被清空，或仍指向旧的 question，只按消息号去重会把续跑后的结果吞掉。
// 已发送的键写在配置目录的 present_state.json，不回写 Tasks，也不进仓库。
// 调用方每次对账都扫全表做兜底；事件只是提前叫醒。

import fs from "node:fs";
import path from "node:path";
import { f1 } from "../bus/feishu.mjs";
import { messageText } from "./cards.mjs";

const PRESENT_STATUSES = new Set([
  "completed", "failed", "rejected", "input-required",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "rejected"]);
const MSG_KINDS = new Set([
  "result", "question", "auth_request", "notice", "answer", "auth_decision",
]);
// 优先取和当前状态配套的那条消息。表的返回顺序不能当「最新」。
const PREFERRED_KIND = {
  completed: "result",
  failed: "notice",
  rejected: "notice",
  "input-required": "question",
};
const STATUS_LABEL = {
  completed: "已完成",
  failed: "失败",
  rejected: "已拒收",
  "input-required": "需要补充信息",
};

export function shouldPresent(task, messages, { nodeName = "", role = "hub" } = {}) {
  const taskId = String(f1(task, "Task_ID") ?? "");
  const taskMsgs = messages.filter((m) => String(f1(m, "Task_ID") ?? "") === taskId);
  const instr = taskMsgs.find((m) => f1(m, "Kind") === "instruction");
  const from = instr ? String(f1(instr, "From_Node") ?? "").trim() : "";
  const source = String(f1(task, "Source") ?? "").trim();
  const initiator = from || source;

  if (nodeName && initiator === nodeName) return true;
  if (role === "hub" && (!initiator || initiator === "hub" || initiator === "cron" || source === "cron")) {
    return true;
  }
  return false;
}

export function presentKey(taskId, status, statusMsg) {
  const msg = statusMsg || "";
  if (TERMINAL_STATUSES.has(status)) return `${taskId}\t${status}\t${msg}`;
  return `${taskId}\t${msg}`;
}

function loadMeta(raw) {
  // 坏 JSON 不当作已呈递，避免一格脏数据把新结果永久吞掉。
  const text = typeof raw === "string" ? raw : (raw == null ? "" : String(raw));
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const obj = JSON.parse(trimmed);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function metaKeys(task) {
  const keys = loadMeta(f1(task, "Metadata")).presented_keys;
  if (typeof keys === "string") return [keys];
  if (Array.isArray(keys)) return keys.filter((k) => typeof k === "string");
  return [];
}

function msgSeq(msg) {
  const id = String(f1(msg, "Msg_ID") ?? "");
  const matched = id.match(/-(\d+)$/);
  return matched ? Number(matched[1]) : -1;
}

function compareMsg(a, b) {
  const ds = msgSeq(a) - msgSeq(b);
  if (ds !== 0) return ds;
  const ca = String(f1(a, "Created_At") ?? "");
  const cb = String(f1(b, "Created_At") ?? "");
  if (ca < cb) return -1;
  if (ca > cb) return 1;
  const ia = String(f1(a, "Msg_ID") ?? "");
  const ib = String(f1(b, "Msg_ID") ?? "");
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function latestMessage(messages, taskId, status) {
  const rows = messages.filter((msg) => {
    return String(f1(msg, "Task_ID") ?? "") === String(taskId) && MSG_KINDS.has(f1(msg, "Kind"));
  });
  const preferred = PREFERRED_KIND[status];
  const pool = preferred ? rows.filter((msg) => f1(msg, "Kind") === preferred) : [];
  const chosen = (pool.length ? pool : rows).slice().sort(compareMsg);
  return chosen.length ? chosen[chosen.length - 1] : null;
}

function clip(text, limit) {
  const value = String(text ?? "").trim();
  if (value.length <= limit) return value;
  return value.slice(0, limit).trimEnd() + "…";
}

function runOf(runs, task) {
  const latest = String(f1(task, "Latest_Run") ?? "");
  if (latest) {
    const hit = runs.find((row) => String(f1(row, "Run_ID") ?? "") === latest);
    if (hit) return hit;
  }
  const taskId = String(f1(task, "Task_ID") ?? "");
  const mine = runs.filter((row) => String(f1(row, "Task_Ref") ?? "") === taskId);
  return mine.length ? mine[mine.length - 1] : null;
}

export function presentBody({ taskId, title, status, statusMsg, target, message, outcome, error }) {
  const lines = [
    `【任务${STATUS_LABEL[status] || status}】`,
    `任务：${title || "-"}`,
    `编号：${taskId}`,
    `状态：${status}`,
    `目标节点：${target || "-"}`,
  ];
  if (statusMsg) lines.push(`状态消息：${statusMsg}`);
  if (message) lines.push("", clip(message, 2000));
  if (outcome) lines.push("", "执行结果：" + clip(outcome, 500));
  if (error) lines.push("错误：" + clip(error, 500));
  return lines.join("\n").slice(0, 3500);
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const keys = Array.isArray(parsed?.keys) ? parsed.keys.filter((k) => typeof k === "string") : [];
    return { keys, exists: true };
  } catch (e) {
    if (e.code === "ENOENT") return { keys: [], exists: false };
    // 读坏了就当没有发过。重发一次好过把新结果永久吞掉。
    return { keys: [], broken: e.message, exists: false };
  }
}

function writeState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ keys: state.keys }, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export class PresentService {
  constructor({ bus, ownerOpenId = "", nodeName = "", role = "hub", statePath, queuePath, log }) {
    this.bus = bus;
    this.ownerOpenId = String(ownerOpenId ?? "").trim();
    this.nodeName = String(nodeName ?? "").trim();
    this.role = String(role ?? "hub").trim();
    this.statePath = statePath;
    this.queuePath = queuePath || (statePath ? path.join(path.dirname(statePath), "present_queue.jsonl") : null);
    // 呈递门铃：本轮有新回执落盘时更新此文件（mtime 即信号），供本机 Agent 的
    // hook/轮询低成本感知「有新结果」，不必反复全量读队列。队列仍是真相，门铃
    // 丢了只退化为下次主动 pop 时发现，不丢数据。
    this.bellPath = statePath ? path.join(path.dirname(statePath), "present_bell") : null;
    this.log = log ?? (() => {});
  }

  async scan() {
    if (!this.statePath || !this.queuePath) {
      this.log("结果呈递没有状态文件路径或队列文件路径，本轮跳过");
      return 0;
    }
    const state = readState(this.statePath);
    if (state.broken) {
      this.log("present_state.json 读失败，本轮按未呈递处理：" + state.broken);
    }
    const seen = new Set(state.keys);
    const tasks = await this.bus.listRecords(this.bus.tables.tasks);
    const messages = await this.bus.listRecords(this.bus.tables.messages);

    // 装机水位线（baseline）：若是首次运行（本地不存在 present_state.json），
    // 将线上存量的终态任务（completed / failed / rejected / canceled）或 Metadata 里
    // 已有 presented_keys 的任务直接视为已呈递历史基线，记录到 present_state.json 中，
    // 防止首次启动向本地队列倾倒全部历史回执。（Presented 列 v3.5 已废弃，不再读。）
    if (!state.exists) {
      for (const task of tasks) {
        const status = String(f1(task, "Status") ?? "");
        const taskId = String(f1(task, "Task_ID") ?? "");
        if (!taskId) continue;
        const isTerminal = TERMINAL_STATUSES.has(status) || status === "canceled";
        if (isTerminal || metaKeys(task).length > 0) {
          const statusMsg = String(f1(task, "Status_Msg") ?? "");
          const key = presentKey(taskId, status, statusMsg);
          seen.add(key);
          if (!state.keys.includes(key)) state.keys.push(key);
          for (const mk of metaKeys(task)) {
            seen.add(mk);
            if (!state.keys.includes(mk)) state.keys.push(mk);
          }
        }
      }
      try {
        writeState(this.statePath, state);
        this.log(`首次启动建立结果呈递水位线（baseline）：已标记 ${state.keys.length} 项历史存量终态任务`);
      } catch (e) {
        this.log("首次写入 present_state.json baseline 失败：" + (e?.message ?? e));
      }
    }

    const pending = [];
    for (const task of tasks) {
      const status = String(f1(task, "Status") ?? "");
      if (!PRESENT_STATUSES.has(status)) continue;
      const taskId = String(f1(task, "Task_ID") ?? "");
      if (!taskId) continue;
      const statusMsg = String(f1(task, "Status_Msg") ?? "");
      const key = presentKey(taskId, status, statusMsg);
      if (seen.has(key) || metaKeys(task).includes(key)) continue;

      if (!shouldPresent(task, messages, { nodeName: this.nodeName, role: this.role })) {
        continue;
      }
      pending.push({ task, taskId, status, statusMsg, key });
    }
    if (!pending.length) return 0;

    const parts = await this.bus.listRecords(this.bus.tables.parts);
    const runs = await this.bus.listRecords(this.bus.tables.runs);
    let sent = 0;
    for (const item of pending) {
      const msg = latestMessage(messages, item.taskId, item.status);
      const run = runOf(runs, item.task);
      const taskMsgs = messages.filter((m) => String(f1(m, "Task_ID") ?? "") === item.taskId);
      const instr = taskMsgs.find((m) => f1(m, "Kind") === "instruction");
      const fromNode = instr ? String(f1(instr, "From_Node") ?? "").trim() : String(f1(item.task, "Source") ?? "");
      const msgBody = msg ? messageText(parts, f1(msg, "Msg_ID")) : "";
      const outcome = run ? String(f1(run, "Outcome") ?? "") : "";
      const error = run ? String(f1(run, "Error_Log") ?? "") : "";
      const title = String(f1(item.task, "Title") ?? "");
      const targetNode = String(f1(item.task, "Target_Node") ?? "");
      const source = String(f1(item.task, "Source") ?? "");
      const artifactRef = msg ? String(f1(msg, "Artifact_Ref") ?? "") : "";

      const text = presentBody({
        taskId: item.taskId,
        title,
        status: item.status,
        statusMsg: item.statusMsg,
        target: targetNode,
        message: msgBody,
        outcome,
        error,
      });

      const queueItem = {
        ts: new Date().toISOString(),
        present_key: item.key,
        record_id: item.task.record_id,
        task_id: item.taskId,
        title,
        source,
        from_node: fromNode,
        target_node: targetNode,
        status: item.status,
        status_msg: item.statusMsg,
        message: msgBody,
        artifact_ref: artifactRef,
        outcome,
        error,
        text,
      };

      try {
        fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });
        fs.appendFileSync(this.queuePath, JSON.stringify(queueItem) + "\n", { mode: 0o600 });
      } catch (e) {
        this.log(`写入 present_queue 失败 ${item.taskId}：${e?.message ?? e}`);
        continue;
      }

      if (!seen.has(item.key)) {
        seen.add(item.key);
        state.keys.push(item.key);
      }
      try {
        writeState(this.statePath, state);
      } catch (e) {
        this.log("present_state.json 写失败：" + (e?.message ?? e));
      }

      // 写线上 Tasks 元数据的 presented_keys（先读再合并；Presented 列 v3.5 起不再写）
      try {
        const meta = loadMeta(f1(item.task, "Metadata"));
        const pkeys = Array.isArray(meta.presented_keys) ? meta.presented_keys.filter((k) => typeof k === "string") : [];
        if (!pkeys.includes(item.key)) pkeys.push(item.key);
        meta.presented_keys = pkeys;
        await this.bus.updateRecord(this.bus.tables.tasks, item.task.record_id, {
          Metadata: JSON.stringify(meta),
        });
      } catch (e) {
        this.log(`update task ${item.taskId} metadata failed (ignored): ${e?.message ?? e}`);
      }

      sent += 1;
      this.log("presented " + item.taskId + " " + item.status + " -> " + this.queuePath);
    }
    if (sent > 0 && this.bellPath) {
      try {
        fs.writeFileSync(this.bellPath, new Date().toISOString() + "\n", { mode: 0o600 });
      } catch (e) {
        this.log("present_bell 写失败（忽略，队列为准）：" + (e?.message ?? e));
      }
    }
    return sent;
  }
}
