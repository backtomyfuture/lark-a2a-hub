// 审批卡回调先回读一次再交回终态卡。写表在后台，不能堵住飞书的 3 秒预算。
// 总线是内存 mock。写操作被人为拖慢，用来证明 handleCardAction 不会等它们。

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { ApprovalService } from "../src/hub/approval.mjs";
import { buildStatusCard } from "../src/hub/cards.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const OWNER = "ou_test_owner";
const NOW = "2026-01-15T10:00:00+0800";
const MESSAGE_ID = "om_clicked";
const STORED_ID = "om_from_state";
const VERIFY = "verify-token-not-for-update";
const STALE = "任务状态已变化或审批已过期，未处理。";

function hasButton(card) {
  const stack = [card];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (cur.tag === "button") return true;
    for (const value of Object.values(cur)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return false;
}

function assertStatusCard(actual, info, patch) {
  assert.deepEqual(actual, buildStatusCard(info, patch));
  assert.equal(hasButton(actual), patch.state === "failed");
}

function slowWrites(bus, ms = 2000) {
  for (const op of ["createRecord", "updateRecord"]) {
    const orig = bus[op].bind(bus);
    bus[op] = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return orig(...args);
    };
  }
}

function valueOf(record, decision, taskId = "TASK-CB-1", statusMsg = "MSG-CB-1-02") {
  return {
    decision,
    record_id: record.record_id,
    task_id: taskId,
    status_msg: statusMsg,
    title: "待批任务",
    target: "node-a",
    skill: "echo",
  };
}

function click(record, decision, { operator = OWNER, eventId = "ev-1", taskId, statusMsg, messageId = MESSAGE_ID } = {}) {
  const event = {
    operator: { open_id: operator },
    token: "c-delay-token-not-used",
    action: { value: valueOf(record, decision, taskId, statusMsg) },
  };
  if (messageId) event.context = { open_message_id: messageId };
  return {
    _source: "test",
    header: { event_id: eventId, token: VERIFY, event_type: "card.action.trigger" },
    event,
  };
}

async function seed(bus, { taskId = "TASK-CB-1", status = "auth-required", statusMsg = "MSG-CB-1-02" } = {}) {
  await bus.createRecord(TABLES.messages, {
    Msg_ID: "MSG-CB-1-01",
    Task_ID: taskId,
    Context_ID: "CTX-CB",
    From_Node: "hub",
    To_Node: "node-a",
    Role: "user",
    Kind: "instruction",
    Created_At: NOW,
  });
  await bus.createRecord(TABLES.messages, {
    Msg_ID: statusMsg,
    Task_ID: taskId,
    Context_ID: "CTX-CB",
    From_Node: "node-a",
    To_Node: "hub",
    Role: "agent",
    Kind: "auth_request",
    Created_At: NOW,
  });
  const created = await bus.createRecord(TABLES.tasks, {
    Task_ID: taskId,
    Title: "待批任务",
    Source: "hub",
    Target_Node: "node-a",
    Skill_ID: "echo",
    Status: status,
    Status_Msg: statusMsg,
    Context_ID: "CTX-CB",
    Hop_Count: 0,
    Retry_Count: 0,
  });
  return created.record;
}

function service(dir, bus) {
  return new ApprovalService({
    bus,
    ownerOpenId: OWNER,
    statePath: path.join(dir, "approval_state.json"),
    log: () => {},
    now: () => NOW,
  });
}

async function decisions(bus, taskId) {
  const rows = await bus.listRecords(TABLES.messages);
  return rows.filter((row) => f1(row, "Kind") === "auth_decision" && f1(row, "Task_ID") === taskId);
}

function assertPatched(bus, info, patch, messageId = MESSAGE_ID) {
  assert.equal(bus.cardUpdates.length, 1);
  assert.equal(bus.cardUpdates[0].message_id, messageId);
  assert.equal(bus.cardUpdates[0].content, JSON.stringify(bus.cardUpdates[0].card));
  assertStatusCard(bus.cardUpdates[0].card, info, patch);
}

test("回读通过后立即返回终态卡，写表拖慢也不卡住", { timeout: 30_000 }, async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const approval = service(dir, bus);
    const record = await seed(bus);
    slowWrites(bus);
    const info = valueOf(record, "approve");
    const patch = { state: "approved", operator: OWNER, at: NOW, note: "" };
    const started = Date.now();
    const first = await approval.handleCardAction(click(record, "approve", { eventId: "ev-fast" }));
    const second = await approval.handleCardAction(click(record, "approve", { eventId: "ev-again" }));
    assert.ok(Date.now() - started < 1000);
    assert.equal(first.toast.type, "info");
    assert.equal(first.toast.content, "已批准");
    assert.equal(first.card.type, "raw");
    assertStatusCard(first.card.data, info, patch);
    assert.equal(second.toast.content, "该审批已处理");
    assert.equal(second.card.type, "raw");
    assertStatusCard(second.card.data, info, patch);
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 0);
    assert.equal(bus.cardUpdates.length, 0);

    await approval.whenIdle();
    assert.equal(approval._inflight.size, 0);
    assert.equal(f1((await bus.findRecords(TABLES.tasks, "Task_ID", "TASK-CB-1"))[0], "Status"), "submitted");
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 1);
    assert.equal(bus.cardUpdates.length, 0);

    const repeat = await approval.handleCardAction(click(record, "approve", { eventId: "ev-done" }));
    assert.equal(repeat.toast.content, "该审批已处理");
    assertStatusCard(repeat.card.data, info, patch);
    await approval.whenIdle();
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 1);
    assert.equal(bus.cardUpdates.length, 0);
  });
});

test("后台写表失败时 PATCH 成可重试的失败卡，并清掉已决定标记", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const approval = service(dir, bus);
    const record = await seed(bus);
    const info = valueOf(record, "approve");
    bus.failNext({ op: "create" }, new Error("write conflict 1254291"));
    const res = await approval.handleCardAction(click(record, "approve", { eventId: "ev-fail" }));
    assert.equal(res.toast.content, "已批准");
    assertStatusCard(res.card.data, info, { state: "approved", operator: OWNER, at: NOW, note: "" });
    await approval.whenIdle();
    assert.equal(approval._inflight.size, 0);
    assert.equal(approval._decidedCards.size, 0);
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 0);
    assert.equal(f1((await bus.findRecords(TABLES.tasks, "Task_ID", "TASK-CB-1"))[0], "Status"), "auth-required");
    assertPatched(bus, info, {
      state: "failed",
      operator: OWNER,
      at: NOW,
      note: "write conflict 1254291",
    });

    const retry = await approval.handleCardAction(click(record, "approve", { eventId: "ev-retry" }));
    assert.equal(retry.toast.content, "已批准");
    await approval.whenIdle();
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 1);
    assert.equal(f1((await bus.findRecords(TABLES.tasks, "Task_ID", "TASK-CB-1"))[0], "Status"), "submitted");
    assert.equal(approval._inflight.size, 0);
    assert.equal(bus.cardUpdates.length, 1);
  });
});

test("决定写下但改任务行失败，改点驳回时追加新决定并以驳回收口", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const approval = service(dir, bus);
    const record = await seed(bus);
    bus.failNext({ op: "update", table: TABLES.tasks }, new Error("write conflict 1254291"));
    await approval.handleCardAction(click(record, "approve", { eventId: "ev-a" }));
    await approval.whenIdle();
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 1);
    assert.equal(f1((await bus.findRecords(TABLES.tasks, "Task_ID", "TASK-CB-1"))[0], "Status"), "auth-required");

    const res = await approval.handleCardAction(click(record, "reject", { eventId: "ev-r" }));
    assert.equal(res.toast.content, "已驳回");
    await approval.whenIdle();
    const rows = await decisions(bus, "TASK-CB-1");
    assert.equal(rows.length, 2);
    const latest = rows.map((row) => f1(row, "Msg_ID")).sort().at(-1);
    const parts = await bus.listRecords(TABLES.parts);
    const data = parts.find((p) => f1(p, "Parent_ID") === latest && f1(p, "Kind") === "data");
    assert.equal(JSON.parse(f1(data, "Data")).decision, "reject");
    const msgs = await bus.listRecords(TABLES.messages);
    assert.ok(msgs.some((m) => f1(m, "Kind") === "notice" && f1(m, "Task_ID") === "TASK-CB-1"));
    assert.equal(f1((await bus.findRecords(TABLES.tasks, "Task_ID", "TASK-CB-1"))[0], "Status"), "canceled");
  });
});

test("过期卡在同步路径返回 expired，不写表也不 PATCH", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const approval = service(dir, bus);
    const record = await seed(bus, { status: "working" });
    const info = valueOf(record, "reject");
    const res = await approval.handleCardAction(click(record, "reject", { eventId: "ev-stale" }));
    assert.equal(res.toast.type, "info");
    assert.equal(res.toast.content, STALE);
    assert.equal(res.card.type, "raw");
    assertStatusCard(res.card.data, info, { state: "expired", operator: OWNER, at: NOW, note: STALE });
    await approval.whenIdle();
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 0);
    assert.equal(f1((await bus.findRecords(TABLES.tasks, "Task_ID", "TASK-CB-1"))[0], "Status"), "working");
    assert.equal(approval._decidedCards.size, 0);
    assert.equal(approval._inflight.size, 0);
    assert.equal(bus.cardUpdates.length, 0);
  });
});

test("写前再次回读发现任务已变时 PATCH 成 expired，并用状态文件里的 message_id", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const approval = service(dir, bus);
    const record = await seed(bus);
    const info = valueOf(record, "approve");
    approval.saveState({
      [record.record_id]: { card_sent: true, message_id: STORED_ID, status_msg: "MSG-CB-1-02" },
    });
    const orig = bus.getRecord.bind(bus);
    let calls = 0;
    bus.getRecord = async (table, recordId) => {
      calls += 1;
      if (calls >= 2) {
        const row = bus._rows.get(table)?.find((item) => item.record_id === recordId);
        if (row) row.fields = { ...row.fields, Status: ["working"] };
      }
      return orig(table, recordId);
    };
    const res = await approval.handleCardAction(click(record, "approve", { eventId: "ev-race", messageId: null }));
    assert.equal(res.toast.content, "已批准");
    await approval.whenIdle();
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 0);
    assert.equal(approval._decidedCards.size, 0);
    assert.equal(f1((await bus.findRecords(TABLES.tasks, "Task_ID", "TASK-CB-1"))[0], "Status"), "working");
    assertPatched(bus, info, {
      state: "expired",
      operator: OWNER,
      at: NOW,
      note: STALE,
    }, STORED_ID);
  });
});

test("回读失败或超时不标记已决定，卡片保持不变", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const approval = service(dir, bus);
    const record = await seed(bus);
    const before = bus.journal.length;
    bus.getRecord = async () => { throw new Error("network down"); };
    const res = await approval.handleCardAction(click(record, "approve", { eventId: "ev-read" }));
    assert.equal(res.toast.type, "error");
    assert.equal(res.toast.content, "处理失败，请重试");
    assert.equal(res.card, undefined);
    assert.equal(approval._decidedCards.size, 0);
    assert.equal(approval._inflight.size, 0);
    await approval.whenIdle();
    assert.equal(bus.journal.length, before);
    assert.equal(bus.cardUpdates.length, 0);
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 0);
  });
});

test("回读超过 2 秒就放弃，不标记已决定", { timeout: 10_000 }, async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const approval = service(dir, bus);
    const record = await seed(bus);
    bus.getRecord = () => new Promise(() => {});
    const started = Date.now();
    const res = await approval.handleCardAction(click(record, "approve", { eventId: "ev-slow-read" }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1800, `elapsed ${elapsed}`);
    assert.ok(elapsed < 4000, `elapsed ${elapsed}`);
    assert.equal(res.toast.content, "处理失败，请重试");
    assert.equal(res.card, undefined);
    assert.equal(approval._decidedCards.size, 0);
    assert.equal(bus.cardUpdates.length, 0);
  });
});

test("非机主的点击被拒绝，不写表也不改卡", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const approval = service(dir, bus);
    const record = await seed(bus);
    const before = bus.journal.length;
    const res = await approval.handleCardAction(click(record, "approve", { operator: "ou_other", eventId: "ev-stranger" }));
    assert.equal(res.toast.type, "error");
    assert.equal(res.toast.content, "只有机主可以审批。");
    assert.equal(res.card, undefined);
    assert.equal(approval._inflight.size, 0);
    await approval.whenIdle();
    assert.equal(bus.journal.length, before);
    assert.equal(bus.cardUpdates.length, 0);
    assert.equal((await decisions(bus, "TASK-CB-1")).length, 0);
    assert.equal(f1((await bus.findRecords(TABLES.tasks, "Task_ID", "TASK-CB-1"))[0], "Status"), "auth-required");
  });
});
