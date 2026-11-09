// Rules 观察镜像：只写自己的行，字段没变不重写，终态和 15 分钟才再写。
// 不读这些行来触发。总线是内存 mock。

import assert from "node:assert/strict";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { ScheduleMirror } from "../src/schedule-mirror.mjs";
import { withTemp } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const RULES = "tbl_rules";
const KEY = "2026-01-15T09:00:00+0800";
const NOW = Date.parse("2026-01-15T01:30:00.000Z");

function bus() {
  return new MockFeishuBus({ tables: { rules: RULES } });
}

function plan(extra = {}) {
  return {
    id: "DAILY",
    enabled: true,
    cron: "0 9 * * *",
    cap: "CAP-echo",
    text: "早报",
    ...extra,
  };
}

function mirror(mock, { node = "node-a", now, logs } = {}) {
  return new ScheduleMirror({
    bus: mock,
    node,
    now: () => now.value,
    log: (line) => logs.push(String(line)),
  });
}

function writes(mock, from) {
  return mock.journal.slice(from).filter((item) =>
    item.table === RULES && (item.op === "create" || item.op === "update"));
}

test("只写自己的行，字段不变不重写，15 分钟才刷新同步于", async () => {
  await withTemp(async () => {
    const mock = bus();
    const logs = [];
    const now = { value: NOW };
    await mock.createRecord(RULES, {
      Rule_ID: "node-b:DAILY",
      Target_Node: "node-b",
      Skill_ID: "echo",
      Schedule: "0 9 * * *",
      Text: "别人的",
      Enabled: "Yes",
      Last_Fired: "",
      Note: "别动",
    });
    const svc = mirror(mock, { now, logs });
    const plans = [plan()];
    const state = { DAILY: { cron: "0 9 * * *", last_fired: "", last_task: "" } };
    await svc.sync({ plans, state, tz: "Asia/Shanghai" });
    const mine = (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:DAILY");
    assert.ok(mine);
    assert.equal(f1(mine, "Target_Node"), "node-a");
    assert.equal(f1(mine, "Skill_ID"), "CAP-echo");
    assert.equal(f1(mine, "Schedule"), "0 9 * * *");
    assert.equal(f1(mine, "Text"), "早报");
    assert.equal(f1(mine, "Enabled"), "Yes");
    assert.equal(f1(mine, "Last_Fired"), "");
    assert.match(String(f1(mine, "Note")), /尚未运行；同步于 /);
    const created = mock.journal.find((item) => item.op === "create" && item.table === RULES && item.fields.Rule_ID);
    const keys = Object.keys(created.fields).filter((key) => created.fields[key] != null);
    assert.deepEqual(keys.sort(), ["Enabled", "Last_Fired", "Note", "Rule_ID", "Schedule", "Skill_ID", "Target_Node", "Text"]);

    const mark = mock.journal.length;
    await svc.sync({ plans, state, tz: "Asia/Shanghai" });
    assert.equal(writes(mock, mark).length, 0);
    const other = (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-b:DAILY");
    assert.equal(f1(other, "Note"), "别动");
    assert.equal(f1(other, "Enabled"), "Yes");
    assert.equal(f1(other, "Text"), "别人的");

    now.value += 15 * 60 * 1000 + 5000;
    const beforeRefresh = mock.journal.length;
    await svc.sync({ plans, state, tz: "Asia/Shanghai" });
    const refreshed = writes(mock, beforeRefresh);
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].op, "update");
    assert.match(String(f1((await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:DAILY"), "Note")), /尚未运行；同步于 /);
    assert.equal(f1(other, "Note"), "别动");
  });
});

test("上次运行到终态才改备注，计划删掉后只把自己的行标成 No", async () => {
  await withTemp(async () => {
    const mock = bus();
    const now = { value: NOW };
    const svc = mirror(mock, { now, logs: [] });
    const state = { DAILY: { cron: "0 9 * * *", last_fired: KEY, last_task: "TASK-1" } };
    await svc.sync({ plans: [plan()], state, tz: "Asia/Shanghai" });
    let mine = (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:DAILY");
    assert.match(String(f1(mine, "Note")), /上次运行 TASK-1 submitted；同步于 /);
    assert.equal(f1(mine, "Last_Fired"), KEY);

    const running = [{
      fields: {
        Task_ID: ["TASK-1"],
        Status: ["working"],
        Idempotency_Key: [`sched:node-a:DAILY:${KEY}`],
      },
    }];
    const beforeWorking = mock.journal.length;
    await svc.sync({ plans: [plan()], state, tasks: running, tz: "Asia/Shanghai" });
    assert.equal(writes(mock, beforeWorking).length, 1);
    mine = (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:DAILY");
    assert.match(String(f1(mine, "Note")), /上次运行 TASK-1 working；同步于 /);

    const done = [{
      fields: {
        Task_ID: ["TASK-1"],
        Status: ["completed"],
        Idempotency_Key: [`sched:node-a:DAILY:${KEY}`],
      },
    }];
    await svc.sync({ plans: [plan()], state, tasks: done, tz: "Asia/Shanghai" });
    mine = (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:DAILY");
    assert.match(String(f1(mine, "Note")), /上次运行 TASK-1 completed；同步于 /);
    const quiet = mock.journal.length;
    await svc.sync({ plans: [plan()], state, tasks: done, tz: "Asia/Shanghai" });
    assert.equal(writes(mock, quiet).length, 0);

    await mock.createRecord(RULES, {
      Rule_ID: "node-b:DAILY",
      Target_Node: "node-b",
      Skill_ID: "echo",
      Schedule: "1 1 * * *",
      Text: "别人的",
      Enabled: "Yes",
      Last_Fired: "keep",
      Note: "别动",
    });
    await svc.sync({ plans: [], state: {}, tz: "Asia/Shanghai" });
    mine = (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:DAILY");
    const other = (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-b:DAILY");
    assert.equal(f1(mine, "Enabled"), "No");
    assert.match(String(f1(mine, "Note")), /计划已不在本机 schedules.json/);
    assert.equal(f1(other, "Enabled"), "Yes");
    assert.equal(f1(other, "Note"), "别动");
    assert.equal(f1(other, "Text"), "别人的");
  });
});

test("停用计划镜像成 No，已下线行只写一次", async () => {
  await withTemp(async () => {
    const mock = bus();
    const now = { value: NOW };
    const svc = mirror(mock, { now, logs: [] });
    const state = {
      OFF: { cron: "0 9 * * *", last_fired: "", last_task: "" },
      LIVE: { cron: "0 9 * * *", last_fired: "", last_task: "" },
    };
    await svc.sync({
      plans: [plan({ id: "OFF", enabled: false, text: "停用" }), plan({ id: "LIVE", text: "在线" })],
      state,
      tz: "Asia/Shanghai",
    });
    const off = (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:OFF");
    assert.equal(f1(off, "Enabled"), "No");
    assert.equal(f1(off, "Text"), "停用");
    assert.equal(f1(off, "Skill_ID"), "CAP-echo");

    const beforeDrop = mock.journal.length;
    await svc.sync({
      plans: [plan({ id: "OFF", enabled: false, text: "停用" })],
      state: { OFF: state.OFF },
      tz: "Asia/Shanghai",
    });
    const dropped = writes(mock, beforeDrop);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].recordId, (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:LIVE").record_id);
    const live = (await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:LIVE");
    assert.equal(f1(live, "Enabled"), "No");
    assert.match(String(f1(live, "Note")), /计划已不在本机 schedules.json/);
    const note = f1(live, "Note");

    now.value += 15 * 60 * 1000 + 5000;
    const quiet = mock.journal.length;
    await svc.sync({
      plans: [plan({ id: "OFF", enabled: false, text: "停用" })],
      state: { OFF: state.OFF },
      tz: "Asia/Shanghai",
    });
    const again = writes(mock, quiet);
    assert.equal(again.some((item) => item.recordId === live.record_id), false);
    assert.equal(f1((await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:LIVE"), "Note"), note);
    assert.equal(f1((await mock.listRecords(RULES)).find((row) => f1(row, "Rule_ID") === "node-a:OFF"), "Enabled"), "No");
  });
});

test("缺少 tables.rules 时跳过并只记一次日志", async () => {
  const mock = new MockFeishuBus({ tables: { tasks: "tbl_tasks" } });
  const logs = [];
  const svc = new ScheduleMirror({ bus: mock, node: "node-a", log: (line) => logs.push(String(line)) });
  await assert.doesNotReject(() => svc.sync({ plans: [plan()], tz: "Asia/Shanghai" }));
  await svc.sync({ plans: [plan()], tz: "Asia/Shanghai" });
  assert.equal(logs.filter((line) => line.includes("tables.rules")).length, 1);
  assert.equal(mock.journal.filter((item) => item.op === "create" || item.op === "update").length, 0);
});
