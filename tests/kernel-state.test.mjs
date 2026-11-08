// 守住内核状态机：认领后按 commands.json 执行，熔断、控制键、幂等、退避、非法语境、carrier 离线都不得真跑。
// 总线是 tests/mocks/mock-bus.mjs。不读 ~/.hub-node，不取凭据。run({ once: true }) 不打开长连接。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { f1 } from "../src/bus/feishu.mjs";
import { Kernel } from "../src/kernel.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ECHO = path.join(ROOT, "src", "executors", "echo.mjs");

function nodeCommand(script) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function echoCommand() {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(ECHO)}`;
}

async function setup(dir, commandEntry) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({ echo: commandEntry }), { mode: 0o600 });
  const mock = new MockFeishuBus({ tables: TABLES });
  const kernel = new Kernel({
    node: "node-a",
    role: "node",
    kind: "host",
    zone: "test",
    capPrefix: "test",
    events: false,
    configDir: dir,
    carrierSocket: path.join(dir, "missing.sock"),
    bus: mock,
  });
  return { mock, kernel };
}

async function seedTask(mock, fields, { text = "跑一下", params = { n: 1 }, from = "hub" } = {}) {
  const taskId = fields.Task_ID;
  const msgId = `MSG-${taskId.replace("TASK-", "")}-01`;
  await mock.createRecord(TABLES.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: fields.Context_ID,
    From_Node: from,
    To_Node: "node-a",
    Role: "user",
    Kind: "instruction",
    Created_At: fields.Created_At || "2026-01-15T09:00:00+0800",
  });
  if (text) {
    await mock.createRecord(TABLES.parts, {
      Part_ID: `${msgId}-P1`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: text,
    });
  }
  if (params) {
    await mock.createRecord(TABLES.parts, {
      Part_ID: `${msgId}-P2`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 2,
      Kind: "data",
      Data: JSON.stringify(params),
    });
  }
  const created = await mock.createRecord(TABLES.tasks, {
    Title: text || taskId,
    Source: from,
    Target_Node: "node-a",
    Skill_ID: "echo",
    Status: "submitted",
    Hop_Count: 0,
    Retry_Count: 0,
    Idempotency_Key: `key-${taskId}`,
    ...fields,
  });
  return created.record;
}

function taskOf(mock, taskId) {
  return mock.findRecords(TABLES.tasks, "Task_ID", taskId).then((rows) => rows[0]);
}

// 红线：json 模式只认 stdout 最后一行。完成时要有 result 消息和 Parts，To_Node 原路回到发起方。
test("submitted 认领 echo 后 completed，result 与 Parts 齐全", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = await setup(dir, {
      command: echoCommand(),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
      name: "echo",
    });
    await seedTask(mock, { Task_ID: "TASK-ECHO-1", Context_ID: "CTX-ECHO-1" });
    await kernel.run({ once: true });
    const task = await taskOf(mock, "TASK-ECHO-1");
    assert.equal(f1(task, "Status"), "completed");
    assert.equal(f1(task, "Claimed_By"), "node-a");
    const result = (await mock.findRecords(TABLES.messages, "Kind", "result"))[0];
    assert.ok(result);
    assert.equal(f1(result, "To_Node"), "hub");
    assert.equal(f1(result, "From_Node"), "node-a");
    assert.equal(f1(result, "Role"), "agent");
    const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(result, "Msg_ID"));
    assert.equal(parts.length >= 1, true);
    assert.match(f1(parts.find((part) => f1(part, "Kind") === "text"), "Text"), /echo from node "TASK-ECHO-1"/);
    const run = (await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-ECHO-1"))[0];
    assert.equal(f1(run, "Outcome"), "succeeded");
    const mutated = mock.journal.filter((item) =>
      (item.op === "update") && (item.table === TABLES.messages || item.table === TABLES.parts));
    assert.equal(mutated.length, 0);
  });
});

// 红线：任务参数里的执行控制键直接拒收，不能拿去拼命令。
test("任务参数含控制键时 rejected 且不执行", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    const { mock, kernel } = await setup(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
    });
    await seedTask(mock, { Task_ID: "TASK-CTL-1", Context_ID: "CTX-CTL-1" }, { params: { command: "id", n: 1 } });
    await kernel.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-CTL-1"), "Status"), "rejected");
    assert.equal(fs.existsSync(marker), false);
    const note = (await mock.findRecords(TABLES.messages, "Kind", "notice"))[0];
    assert.match(f1((await mock.findRecords(TABLES.parts, "Parent_ID", f1(note, "Msg_ID")))[0], "Text"), /执行控制键/);
  });
});

// 红线：Hop_Count > 8 只写 failed 台账和 notice，不执行。
test("Hop_Count 超过 8 时熔断为 failed 且不执行", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    const { mock, kernel } = await setup(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
    });
    await seedTask(mock, { Task_ID: "TASK-HOP-1", Context_ID: "CTX-HOP-1", Hop_Count: 9 });
    await kernel.run({ once: true });
    const task = await taskOf(mock, "TASK-HOP-1");
    assert.equal(f1(task, "Status"), "failed");
    assert.equal(fs.existsSync(marker), false);
    const run = (await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-HOP-1"))[0];
    assert.equal(f1(run, "Outcome"), "failed");
    assert.match(f1(run, "Error_Log"), /hop count 9/i);
  });
});

// 红线：同一个 Idempotency_Key 不得再执行。更早且非 failed/canceled 的任务占住这个键。
test("相同 Idempotency_Key 的后到任务被 rejected", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    const { mock, kernel } = await setup(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
    });
    await seedTask(mock, {
      Task_ID: "TASK-IDEM-1",
      Context_ID: "CTX-IDEM-1",
      Status: "completed",
      Idempotency_Key: "same",
      Created_At: "2026-01-15T08:00:00+0800",
    });
    await seedTask(mock, {
      Task_ID: "TASK-IDEM-2",
      Context_ID: "CTX-IDEM-2",
      Idempotency_Key: "same",
      Created_At: "2026-01-15T09:00:00+0800",
    });
    await kernel.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-IDEM-1"), "Status"), "completed");
    assert.equal(f1(await taskOf(mock, "TASK-IDEM-2"), "Status"), "rejected");
    assert.equal(fs.existsSync(marker), false);
  });
});

// 红线：执行失败先写退避水位，未到时刻的下一轮不得再认领。
test("执行失败后退避水位挡住下一轮认领", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = await setup(dir, {
      command: nodeCommand("process.exit(2)"),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
    });
    await seedTask(mock, { Task_ID: "TASK-RETRY-1", Context_ID: "CTX-RETRY-1" }, { params: null, text: "失败" });
    await kernel.run({ once: true });
    const once = await taskOf(mock, "TASK-RETRY-1");
    assert.equal(f1(once, "Status"), "submitted");
    assert.equal(f1(once, "Claimed_By"), "");
    assert.equal(Number(f1(once, "Retry_Count")), 1);
    const watermark = JSON.parse(fs.readFileSync(path.join(dir, "retry_state.json"), "utf8"));
    assert.ok(watermark["TASK-RETRY-1"].not_before > Date.now());
    assert.equal(fs.statSync(path.join(dir, "retry_state.json")).mode & 0o777, 0o600);
    await kernel.run({ once: true });
    const twice = await taskOf(mock, "TASK-RETRY-1");
    assert.equal(f1(twice, "Status"), "submitted");
    assert.equal(Number(f1(twice, "Retry_Count")), 1);
    assert.equal((await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-RETRY-1")).length, 1);
  });
});

// 红线：context 拼错不能静默改走 direct。
test("commands.json 的 context 非法时 rejected", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    const { mock, kernel } = await setup(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
      mode: "json",
      context: "carier",
      timeout_sec: 30,
    });
    await seedTask(mock, { Task_ID: "TASK-CTX-1", Context_ID: "CTX-CTX-1" });
    await kernel.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-CTX-1"), "Status"), "rejected");
    assert.equal(fs.existsSync(marker), false);
  });
});

// 红线：carrier 离线时能力标 offline，任务 rejected，绝不改走直跑。
test("carrier 离线时 rejected 且名片为 offline", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    const { mock, kernel } = await setup(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
      mode: "json",
      context: "carrier",
      timeout_sec: 30,
    });
    await seedTask(mock, { Task_ID: "TASK-CAR-1", Context_ID: "CTX-CAR-1" });
    await kernel.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-CAR-1"), "Status"), "rejected");
    assert.equal(fs.existsSync(marker), false);
    const card = (await mock.listRecords(TABLES.agentCards))[0];
    assert.equal(f1(card, "Availability"), "offline");
    const note = (await mock.findRecords(TABLES.messages, "Kind", "notice"))[0];
    const body = f1((await mock.findRecords(TABLES.parts, "Parent_ID", f1(note, "Msg_ID")))[0], "Text");
    assert.match(body, /carrier 当前离线/);
  });
});
