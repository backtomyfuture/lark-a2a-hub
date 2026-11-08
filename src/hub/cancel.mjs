// 发起方或 hub 角色显式取消任务（标准 §10.1）。
// 这是 CLI 动作，不是守护进程扫表：kernel 与 inbox 仍然不写 canceled。
// 写序对齐审批驳回：先 notice 与 Parts，最后才改 Tasks 行（Tasks 行是触发信号）。
// 不从 approval.mjs 抽函数：那边的 notice 写死「机主驳回」，From_Node 固定 hub、
// To_Node 指向 Target_Node，并且和 auth_decision 绑在同一条回调队列里。
// 取消要按回执原路把 notice 给发起方，语义不同；这里只按同一口径重写序号、
// In_Reply_To=当前 Status_Msg、任务行只改 Status 不改 Status_Msg。

import { f1 } from "../bus/feishu.mjs";
import { initiatorOf } from "../inbox.mjs";

const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);
const CANCELLABLE = new Set(["submitted", "auth-required", "input-required", "working"]);
const DEFAULT_TEXT = "发起方已取消任务";
// 命令输出用。working 置终态后，执行进程的迟到回执由 kernel.submitOutbox 的终态守卫丢掉。
export const WORKING_CANCEL_HINT = "任务可能已在执行，取消只保证状态终结，迟到回执由终态守卫吞掉";

function nowIso() {
  // 与 kernel.nowStr / approval 同一口径：本地时间 ISO 8601 带时区偏移。
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}`;
}

function msgSeq(msg) {
  const id = String(f1(msg, "Msg_ID") ?? "");
  const matched = id.match(/-(\d+)$/);
  return matched ? Number(matched[1]) : -1;
}

// 用已有最大序号 + 1。按条数 + 1 会在缺号时撞上已有 Msg_ID。
function nextMsgId(taskId, msgs) {
  let max = 0;
  for (const msg of msgs) {
    const n = msgSeq(msg);
    if (n > max) max = n;
  }
  const seq = max + 1;
  return `MSG-${String(taskId).replace("TASK-", "")}-${String(seq).padStart(2, "0")}`;
}

function assertCancellable(status) {
  if (TERMINAL.has(status)) {
    throw new Error(`任务已是终态 ${status}，不能取消。`);
  }
  if (!CANCELLABLE.has(status)) {
    throw new Error(`任务当前状态为 ${status || "空"}，不能取消。`);
  }
}

export async function cancelTask({ bus, node, role, taskId, text }) {
  const id = String(taskId ?? "").trim();
  if (!id) throw new Error("用法：lah task cancel --task <Task_ID> [--text <说明>]");
  const tasks = await bus.listRecords(bus.tables.tasks);
  const listed = tasks.find((t) => f1(t, "Task_ID") === id);
  if (!listed) throw new Error(`任务不存在：${id}`);
  const recordId = listed.record_id;
  if (!recordId) throw new Error(`任务行缺少 record_id，无法回读：${id}`);

  // 列表快照和判定之间再读一次，避免用过期状态盖掉并发的终态。
  const fresh = await bus.getRecord(bus.tables.tasks, recordId);
  if (!fresh || f1(fresh, "Task_ID") !== id) throw new Error(`任务不存在：${id}`);

  const messages = (await bus.listRecords(bus.tables.messages))
    .filter((m) => f1(m, "Task_ID") === id);
  // Tasks 没有 From_Node。发起方用 inbox.initiatorOf：instruction.From_Node，否则 Source，否则 hub。
  const initiator = initiatorOf(fresh, messages);
  const isHub = role === "hub";
  if (!isHub && initiator !== String(node ?? "").trim()) {
    throw new Error(`拒绝取消：node 角色只能取消本节点发起的任务（发起方 ${initiator}，本节点 ${node}）。`);
  }
  assertCancellable(String(f1(fresh, "Status") ?? ""));

  const again = await bus.getRecord(bus.tables.tasks, recordId);
  if (!again || f1(again, "Task_ID") !== id) throw new Error(`任务不存在：${id}`);
  const status = String(f1(again, "Status") ?? "");
  assertCancellable(status);

  const statusMsg = String(f1(again, "Status_Msg") ?? "").trim();
  const note = String(text ?? "").trim() || DEFAULT_TEXT;
  const msgId = nextMsgId(id, messages);
  await bus.createRecord(bus.tables.messages, {
    Msg_ID: msgId,
    Task_ID: id,
    Context_ID: f1(again, "Context_ID"),
    From_Node: isHub ? "hub" : String(node ?? "").trim(),
    To_Node: initiator,
    Role: "agent",
    Kind: "notice",
    In_Reply_To: statusMsg,
    Created_At: nowIso(),
  });
  await bus.createRecord(bus.tables.parts, {
    Part_ID: `${msgId}-P1`,
    Parent_ID: msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: note.slice(0, 4000),
  });

  // 消息落表后再读。若已变成终态就停手，不把别人刚写的终态盖成 canceled。
  // 已写出的 notice 不删：Messages 只追加。调用方收到错误，不能当成取消成功。
  const committed = await bus.getRecord(bus.tables.tasks, recordId);
  if (!committed || f1(committed, "Task_ID") !== id) {
    throw new Error(`任务不存在：${id}。notice ${msgId} 已写入，任务行未改。`);
  }
  const finalStatus = String(f1(committed, "Status") ?? "");
  // 仍可撤（例如刚被认领成 working）就按最新状态收口；已进终态则停手，不覆盖。
  if (!CANCELLABLE.has(finalStatus)) {
    throw new Error(`任务状态已变为 ${finalStatus || "空"}，未改任务行。notice ${msgId} 已写入。`);
  }
  await bus.updateRecord(bus.tables.tasks, recordId, { Status: "canceled" });
  return {
    taskId: id,
    msgId,
    previousStatus: finalStatus,
    workingHint: finalStatus === "working" ? WORKING_CANCEL_HINT : "",
  };
}
