// 守住建单校验：控制键、跳数、名册都在第一笔写之前拒绝；成功时 Tasks 行最后写。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { createTask, parseCreateArgv, parseParams } from "../src/hub/create.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

function bus() {
  return new MockFeishuBus({ tables: TABLES });
}

function writes(mock) {
  return mock.journal.filter((item) => item.op === "create" || item.op === "update");
}

async function card(mock, fields) {
  await mock.createRecord(TABLES.agentCards, {
    Cap_ID: "CAP-node-a-echo",
    Node: "node-a",
    Skill_ID: "echo",
    Dispatchable: "Yes",
    Availability: "online",
    ...fields,
  });
}

// 红线：命令、目录、语境不能从建单参数带进来。拒绝发生在写表之前。
test("parseParams 与 createTask 拒收执行控制键且不写表", async () => {
  assert.throws(() => parseParams('{"command":"id"}'), /执行控制键/);
  assert.deepEqual(parseParams(""), undefined);
  const mock = bus();
  await card(mock);
  mock.journal.length = 0;
  await assert.rejects(
    () => createTask({ bus: mock, to: "node-a", cap: "echo", params: { cwd: "/tmp" } }),
    /执行控制键/,
  );
  assert.deepEqual(writes(mock), []);
});

// 红线：派生 Hop_Count = 父 + 1，超过 8 不落表。
test("派生跳数超过 8 时拒绝建单且不写表", async () => {
  const mock = bus();
  await card(mock);
  await mock.createRecord(TABLES.tasks, {
    Task_ID: "TASK-PARENT",
    Hop_Count: 8,
    Context_ID: "CTX-P",
    Status: "completed",
  });
  mock.journal.length = 0;
  await assert.rejects(
    () => createTask({
      bus: mock, to: "node-a", cap: "echo", ref: "TASK-PARENT", text: "接着做",
    }),
    /Hop_Count=9/,
  );
  assert.deepEqual(writes(mock), []);
});

// 红线：目标必须在名册里，停派名片不能派。离线仍可入队。
test("未登记节点与停派名片拒绝，离线名片仍可建单", async () => {
  const mock = bus();
  await card(mock, { Dispatchable: "No" });
  mock.journal.length = 0;
  await assert.rejects(() => createTask({ bus: mock, to: "missing", cap: "echo" }), /未在 AgentCards/);
  await assert.rejects(() => createTask({ bus: mock, to: "node-a", cap: "echo" }), /不可派/);
  assert.deepEqual(writes(mock), []);

  const live = bus();
  await card(live, { Availability: "offline" });
  live.journal.length = 0;
  const taskId = await createTask({ bus: live, to: "node-a", cap: "echo", text: "排队" });
  const row = (await live.findRecords(TABLES.tasks, "Task_ID", taskId))[0];
  assert.equal(f1(row, "Status"), "submitted");
});

// 红线：参数文件和命令行都只接受对象。--approval 只有三档。
test("parseCreateArgv 与非法 approval 在写表前失败", async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, "params.json");
    fs.writeFileSync(file, '{"n":1}', { mode: 0o600 });
    assert.deepEqual(parseParams("@" + file), { n: 1 });
    assert.throws(() => parseParams("@"), /缺少路径/);
    assert.throws(() => parseCreateArgv(["--to"]), /需要参数/);
    assert.throws(() => parseCreateArgv(["--text", "hi"]), /需要指定/);
    const mock = bus();
    await card(mock);
    mock.journal.length = 0;
    await assert.rejects(
      () => createTask({ bus: mock, to: "node-a", cap: "echo", approval: "yolo" }),
      /approval/,
    );
    assert.deepEqual(writes(mock), []);
  });
});

// 红线：先写 instruction 与 Parts，最后才写 Tasks 行。调用方给的幂等键原样落表。
test("建单写序是消息、Parts、任务行，幂等键保持不变", async () => {
  const mock = bus();
  await card(mock);
  mock.journal.length = 0;
  const taskId = await createTask({
    bus: mock,
    from: "hub",
    to: "node-a",
    cap: "echo",
    text: "跑一下",
    params: { n: 1 },
    idempotencyKey: "same-key",
    now: new Date("2026-01-15T01:00:00.000Z"),
  });
  const order = writes(mock).map((item) => `${item.op} ${item.table}`);
  assert.deepEqual(order, [
    `create ${TABLES.messages}`,
    `create ${TABLES.parts}`,
    `create ${TABLES.parts}`,
    `create ${TABLES.tasks}`,
  ]);
  const task = (await mock.findRecords(TABLES.tasks, "Task_ID", taskId))[0];
  assert.equal(f1(task, "Idempotency_Key"), "same-key");
  assert.equal(f1(task, "Status"), "submitted");
  const parts = await mock.findRecords(TABLES.parts, "Kind", "data");
  assert.equal(JSON.parse(f1(parts[0], "Data")).n, 1);
  assert.equal(JSON.stringify(parts).includes("command"), false);
});
