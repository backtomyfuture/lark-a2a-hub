// 守住撤单红线：node 只能撤自己发起的单，终态不能改，notice 先写、Tasks 行最后改。

import assert from "node:assert/strict";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { cancelTask, WORKING_CANCEL_HINT } from "../src/hub/cancel.mjs";
import { TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

function bus() {
  return new MockFeishuBus({ tables: TABLES });
}

async function seed(mock, status, from = "node-a") {
  await mock.createRecord(TABLES.messages, {
    Msg_ID: "MSG-CXL-01",
    Task_ID: "TASK-CXL",
    Kind: "instruction",
    From_Node: from,
    To_Node: "node-b",
    Role: "user",
    Context_ID: "CTX-CXL",
    Created_At: "2026-01-15T09:00:00+0800",
  });
  const created = await mock.createRecord(TABLES.tasks, {
    Task_ID: "TASK-CXL",
    Status: status,
    Source: from,
    Target_Node: "node-b",
    Context_ID: "CTX-CXL",
    Status_Msg: "MSG-CXL-01",
    Skill_ID: "echo",
  });
  return created.record.record_id;
}

function writes(mock) {
  return mock.journal
    .filter((item) => item.op === "create" || item.op === "update")
    .map((item) => `${item.op} ${item.table}`);
}

// 红线：空任务号、不存在的单、终态单都不能写 canceled。
test("终态和不存在的任务直接拒绝", async () => {
  const mock = bus();
  await assert.rejects(() => cancelTask({ bus: mock, node: "node-a", role: "node", taskId: "  " }), /用法/);
  await assert.rejects(() => cancelTask({ bus: mock, node: "node-a", role: "node", taskId: "TASK-NO" }), /不存在/);
  await seed(mock, "completed");
  mock.journal.length = 0;
  await assert.rejects(
    () => cancelTask({ bus: mock, node: "node-a", role: "node", taskId: "TASK-CXL" }),
    /终态/,
  );
  assert.deepEqual(writes(mock), []);
});

// 红线：守护进程的 node 角色不能撤别人的单。发起方只认 instruction.From_Node。
test("node 角色不能取消其他节点发起的任务", async () => {
  const mock = bus();
  await seed(mock, "submitted", "node-b");
  mock.journal.length = 0;
  await assert.rejects(
    () => cancelTask({ bus: mock, node: "node-a", role: "node", taskId: "TASK-CXL" }),
    /只能取消本节点发起的任务/,
  );
  assert.deepEqual(writes(mock), []);
});

// 红线：先 notice 与 Parts，最后才把 Tasks 行改成 canceled。Messages 只追加。
test("发起方取消时按 notice、Part、任务行的顺序写", async () => {
  const mock = bus();
  const recordId = await seed(mock, "submitted", "node-a");
  mock.journal.length = 0;
  const result = await cancelTask({
    bus: mock, node: "node-a", role: "node", taskId: "TASK-CXL", text: "不跑了",
  });
  assert.equal(result.previousStatus, "submitted");
  assert.equal(result.workingHint, "");
  assert.deepEqual(writes(mock), [
    `create ${TABLES.messages}`,
    `create ${TABLES.parts}`,
    `update ${TABLES.tasks}`,
  ]);
  assert.equal(f1(await mock.getRecord(TABLES.tasks, recordId), "Status"), "canceled");
  const notes = await mock.findRecords(TABLES.messages, "Kind", "notice");
  assert.equal(notes.length, 1);
  assert.equal(f1(notes[0], "To_Node"), "node-a");
  assert.equal(f1(notes[0], "In_Reply_To"), "MSG-CXL-01");
  const text = await mock.findRecords(TABLES.parts, "Parent_ID", f1(notes[0], "Msg_ID"));
  assert.equal(f1(text[0], "Text"), "不跑了");
});

// 红线：hub 可以撤任意单。working 只保证状态终结，并提示迟到回执会被丢掉。
test("hub 可以取消 working 任务并给出迟到回执提示", async () => {
  const mock = bus();
  await seed(mock, "working", "someone-else");
  const result = await cancelTask({ bus: mock, node: "hub-node", role: "hub", taskId: "TASK-CXL" });
  assert.equal(result.previousStatus, "working");
  assert.equal(result.workingHint, WORKING_CANCEL_HINT);
  const note = (await mock.findRecords(TABLES.messages, "Kind", "notice"))[0];
  assert.equal(f1(note, "From_Node"), "hub");
  assert.equal(f1(note, "To_Node"), "someone-else");
});

// 红线：notice 落表后若任务已进终态，不能再把别人的终态盖成 canceled。已写的 notice 不删。
test("notice 写完后任务已终态则不再改任务行", async () => {
  const mock = bus();
  const recordId = await seed(mock, "submitted", "node-a");
  const orig = mock.getRecord.bind(mock);
  let reads = 0;
  mock.getRecord = async (table, id) => {
    reads += 1;
    if (reads === 3) await orig(table, id).then(() => mock.updateRecord(table, id, { Status: "completed" }));
    return orig(table, id);
  };
  await assert.rejects(
    () => cancelTask({ bus: mock, node: "node-a", role: "node", taskId: "TASK-CXL" }),
    /未改任务行/,
  );
  assert.equal(f1(await orig(TABLES.tasks, recordId), "Status"), "completed");
  assert.equal((await mock.findRecords(TABLES.messages, "Kind", "notice")).length, 1);
});
