// 呈递归属：谁发起回给谁。Source=cron 不再让 hub 吞掉别的节点发起的单。
// 总线是内存 mock，队列只写临时目录。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PresentService } from "../src/hub/present.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

async function seed(bus, { taskId, from, source }) {
  await bus.createRecord(TABLES.tasks, {
    Task_ID: taskId,
    Title: taskId,
    Status: "completed",
    Source: source,
    Target_Node: "node-a",
  });
  if (from != null) {
    await bus.createRecord(TABLES.messages, {
      Msg_ID: `${taskId}-01`,
      Task_ID: taskId,
      Kind: "instruction",
      From_Node: from,
      To_Node: "node-a",
      Role: "user",
      Created_At: "2026-01-15T09:00:00+0800",
    });
  }
  await bus.createRecord(TABLES.messages, {
    Msg_ID: `${taskId}-02`,
    Task_ID: taskId,
    Kind: "result",
    From_Node: "node-a",
    To_Node: from || "hub",
    Role: "agent",
    Created_At: "2026-01-15T09:01:00+0800",
  });
}

function service(dir, bus, { nodeName, role }) {
  const statePath = path.join(dir, `present-${role}-${nodeName}.json`);
  // 空水位线：避免首次扫描把终态任务全部当成历史基线吞掉。
  fs.writeFileSync(statePath, JSON.stringify({ keys: [] }), { mode: 0o600 });
  return new PresentService({
    bus,
    nodeName,
    role,
    statePath,
    queuePath: path.join(dir, `queue-${role}-${nodeName}.jsonl`),
    log: () => {},
  });
}

function queuedIds(svc) {
  if (!fs.existsSync(svc.queuePath)) return [];
  return fs.readFileSync(svc.queuePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).task_id);
}

test("节点发起的 cron 单只由该节点入队，hub 不吞", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    await seed(bus, { taskId: "TASK-NODE-CRON", from: "node-a", source: "cron" });
    const node = service(dir, bus, { nodeName: "node-a", role: "node" });
    const hub = service(dir, bus, { nodeName: "hub", role: "hub" });
    // hub 先扫。若它仍因 Source=cron 入队，不能被节点先写的 presented_keys 掩盖。
    assert.equal(await hub.scan(), 0);
    assert.equal(await node.scan(), 1);
    assert.deepEqual(queuedIds(node), ["TASK-NODE-CRON"]);
    assert.deepEqual(queuedIds(hub), []);
  });
});

test("hub 本机发起的 cron 单由 hub 入队", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    await seed(bus, { taskId: "TASK-HUB-CRON", from: "hub", source: "cron" });
    const hub = service(dir, bus, { nodeName: "hub", role: "hub" });
    const other = service(dir, bus, { nodeName: "node-a", role: "node" });
    assert.equal(await hub.scan(), 1);
    assert.equal(await other.scan(), 0);
    assert.deepEqual(queuedIds(hub), ["TASK-HUB-CRON"]);
    assert.deepEqual(queuedIds(other), []);
  });
});

test("发起方为空的 cron 单由 hub 入队", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    await seed(bus, { taskId: "TASK-BARE-CRON", from: null, source: "cron" });
    const hub = service(dir, bus, { nodeName: "hub", role: "hub" });
    const node = service(dir, bus, { nodeName: "node-a", role: "node" });
    assert.equal(await hub.scan(), 1);
    assert.equal(await node.scan(), 0);
    assert.deepEqual(queuedIds(hub), ["TASK-BARE-CRON"]);
    assert.deepEqual(queuedIds(node), []);
  });
});

test("非 cron 的手动单仍只回给发起方", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    await seed(bus, { taskId: "TASK-MANUAL-NODE", from: "node-a", source: "user" });
    await seed(bus, { taskId: "TASK-MANUAL-HUB", from: "hub", source: "user" });
    const node = service(dir, bus, { nodeName: "node-a", role: "node" });
    const hub = service(dir, bus, { nodeName: "hub", role: "hub" });
    assert.equal(await node.scan(), 1);
    assert.equal(await hub.scan(), 1);
    assert.deepEqual(queuedIds(node), ["TASK-MANUAL-NODE"]);
    assert.deepEqual(queuedIds(hub), ["TASK-MANUAL-HUB"]);
  });
});
