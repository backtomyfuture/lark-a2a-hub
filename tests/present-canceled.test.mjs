// hub 审批驳回写的 canceled 要回到发起方本机队列，否则 lah present --wait 等不到终态。
// 总线是内存 mock，队列只写临时目录。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PresentService } from "../src/hub/present.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

async function seedCanceled(bus, taskId, from = "node-a") {
  await bus.createRecord(TABLES.tasks, {
    Task_ID: taskId,
    Title: taskId,
    Status: "canceled",
    Status_Msg: `MSG-${taskId}-02`,
    Source: from,
    Target_Node: "node-b",
  });
  await bus.createRecord(TABLES.messages, {
    Msg_ID: `MSG-${taskId}-01`,
    Task_ID: taskId,
    Kind: "instruction",
    From_Node: from,
    To_Node: "node-b",
    Role: "user",
    Created_At: "2026-01-15T09:00:00+0800",
  });
  await bus.createRecord(TABLES.messages, {
    Msg_ID: `MSG-${taskId}-02`,
    Task_ID: taskId,
    Kind: "auth_request",
    From_Node: "node-b",
    To_Node: "hub",
    Role: "agent",
    Created_At: "2026-01-15T09:01:00+0800",
  });
  await bus.createRecord(TABLES.messages, {
    Msg_ID: `MSG-${taskId}-03`,
    Task_ID: taskId,
    Kind: "auth_decision",
    From_Node: "hub",
    To_Node: "node-b",
    Role: "user",
    In_Reply_To: `MSG-${taskId}-02`,
    Created_At: "2026-01-15T09:02:00+0800",
  });
  await bus.createRecord(TABLES.messages, {
    Msg_ID: `MSG-${taskId}-04`,
    Task_ID: taskId,
    Kind: "notice",
    From_Node: "hub",
    To_Node: "node-b",
    Role: "agent",
    In_Reply_To: `MSG-${taskId}-02`,
    Created_At: "2026-01-15T09:02:01+0800",
  });
  await bus.createRecord(TABLES.parts, {
    Part_ID: `MSG-${taskId}-04-P1`,
    Parent_ID: `MSG-${taskId}-04`,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: "机主已在审批卡驳回，任务取消。",
  });
}

function service(dir, bus, state) {
  const statePath = path.join(dir, "present_state.json");
  if (state) fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  return new PresentService({
    bus,
    nodeName: "node-a",
    role: "node",
    statePath,
    queuePath: path.join(dir, "present_queue.jsonl"),
    log: () => {},
  });
}

function queued(svc) {
  if (!fs.existsSync(svc.queuePath)) return [];
  return fs.readFileSync(svc.queuePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("审批驳回的 canceled 落入发起方队列，正文取 notice，且只呈递一次", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const svc = service(dir, bus, { keys: [], canceledBaseline: true });
    await seedCanceled(bus, "TASK-REJ-1");
    assert.equal(await svc.scan(), 1);
    const items = queued(svc);
    assert.equal(items.length, 1);
    assert.equal(items[0].task_id, "TASK-REJ-1");
    assert.equal(items[0].status, "canceled");
    assert.match(items[0].message, /驳回/);
    assert.match(items[0].text, /已取消/);
    assert.equal(await svc.scan(), 0);
  });
});

test("旧版状态文件升级：历史 canceled 只建水位线，之后的新撤单照常呈递", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    await seedCanceled(bus, "TASK-OLD-1");
    // 旧版本写出的状态文件没有 canceledBaseline。
    const svc = service(dir, bus, { keys: [] });
    assert.equal(await svc.scan(), 0);
    assert.deepEqual(queued(svc), []);
    const saved = JSON.parse(fs.readFileSync(svc.statePath, "utf8"));
    assert.equal(saved.canceledBaseline, true);

    await seedCanceled(bus, "TASK-NEW-1");
    assert.equal(await svc.scan(), 1);
    assert.deepEqual(queued(svc).map((i) => i.task_id), ["TASK-NEW-1"]);
  });
});

test("首次启动的水位线同样吞掉存量 canceled，并写上 canceledBaseline", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    await seedCanceled(bus, "TASK-HIST-1");
    const svc = service(dir, bus, null);
    assert.equal(await svc.scan(), 0);
    const saved = JSON.parse(fs.readFileSync(svc.statePath, "utf8"));
    assert.equal(saved.canceledBaseline, true);
  });
});
