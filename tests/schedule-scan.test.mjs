// ScheduleService.scan 的基线、到期建单与跳过条件。时钟由构造参数注入，不读宿主机时区。
// 总线是内存 mock。不读 ~/.hub-node，不连飞书。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { ScheduleService } from "../src/hub/schedule.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const tables = { ...TABLES, rules: "tbl_rules" };
const NINE = Date.parse("2026-01-15T01:30:00.000Z");
const NEXT_NINE = Date.parse("2026-01-16T01:30:00.000Z");
const KEY_NINE = "2026-01-15T09:00:00+0800";
const KEY_NEXT = "2026-01-16T09:00:00+0800";
const KEY_NINE_THIRTY = "2026-01-15T09:30:00+0800";

function bus() {
  return new MockFeishuBus({ tables });
}

async function rule(mock, fields) {
  const created = await mock.createRecord(tables.rules, {
    Rule_ID: "RULE-1",
    Skill_ID: "echo",
    Target_Node: "node-a",
    Enabled: "Yes",
    Schedule: "0 9 * * *",
    Text: "到点跑一下",
    Last_Fired: "",
    ...fields,
  });
  return created.record;
}

async function card(mock) {
  await mock.createRecord(tables.agentCards, {
    Cap_ID: "CAP-test-echo",
    Node: "node-a",
    Skill_ID: "echo",
    Dispatchable: "Yes",
    Availability: "online",
  });
}

function service(dir, mock, { now, tz = "Asia/Shanghai", logs }) {
  return new ScheduleService({
    bus: mock,
    log: (line) => logs.push(String(line)),
    now: () => now.value,
    tz,
    statePath: path.join(dir, "schedule_state.json"),
  });
}

function ruleOf(mock, ruleId) {
  return mock.findRecords(tables.rules, "Rule_ID", ruleId).then((rows) => rows[0]);
}

function tasks(mock) {
  return mock.listRecords(tables.tasks);
}

// 红线：没有基线时只锚 Last_Fired。到期后同一期次键只建一张单，重启再扫不再建。
test("首扫只回写水位，到期建单一次，再扫与重启不重复", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NINE };
    await card(mock);
    await rule(mock, { Rule_ID: "RULE-DAILY" });
    await rule(mock, {
      Rule_ID: "RULE-OFF",
      Enabled: "No",
      Schedule: "0 9 * * *",
      Text: "不该跑",
    });
    await rule(mock, {
      Rule_ID: "RULE-ROUTE",
      Enabled: "Yes",
      Schedule: "",
      Skill_ID: "echo",
      Text: "这是路由行",
    });
    const svc = service(dir, mock, { now, logs });

    assert.equal(await svc.scan(), 0);
    assert.equal((await tasks(mock)).length, 0);
    assert.equal(f1(await ruleOf(mock, "RULE-DAILY"), "Last_Fired"), KEY_NINE);
    assert.equal(f1(await ruleOf(mock, "RULE-OFF"), "Last_Fired"), "");
    assert.equal(f1(await ruleOf(mock, "RULE-ROUTE"), "Last_Fired"), "");
    const stateFile = path.join(dir, "schedule_state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.rules["RULE-DAILY"], "0 9 * * *");
    assert.equal(state.rules["RULE-OFF"], undefined);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    assert.equal(logs.some((line) => line.includes("schedule baseline RULE-DAILY")), true);

    assert.equal(await svc.scan(), 0);
    assert.equal((await tasks(mock)).length, 0);

    now.value = NEXT_NINE;
    assert.equal(await svc.scan(), 1);
    const created = await tasks(mock);
    assert.equal(created.length, 1);
    assert.equal(f1(created[0], "Idempotency_Key"), `sched:RULE-DAILY:${KEY_NEXT}`);
    assert.equal(f1(created[0], "Source"), "cron");
    assert.equal(f1(created[0], "Target_Node"), "node-a");
    assert.equal(f1(created[0], "Skill_ID"), "echo");
    assert.equal(f1(created[0], "Status"), "submitted");
    const instruction = (await mock.listRecords(tables.messages)).find((row) => f1(row, "Kind") === "instruction");
    assert.equal(f1(instruction, "From_Node"), "hub");
    assert.equal(f1(await ruleOf(mock, "RULE-DAILY"), "Last_Fired"), KEY_NEXT);
    assert.equal(f1(await ruleOf(mock, "RULE-OFF"), "Last_Fired"), "");

    assert.equal(await svc.scan(), 0);
    assert.equal((await tasks(mock)).length, 1);

    const restarted = service(dir, mock, { now, logs });
    assert.equal(await restarted.scan(), 0);
    assert.equal((await tasks(mock)).length, 1);
    assert.equal(f1(await ruleOf(mock, "RULE-DAILY"), "Last_Fired"), KEY_NEXT);

    fs.rmSync(stateFile);
    const lostState = service(dir, mock, { now, logs });
    assert.equal(await lostState.scan(), 0);
    assert.equal((await tasks(mock)).length, 1);
    assert.equal(f1(await ruleOf(mock, "RULE-DAILY"), "Last_Fired"), KEY_NEXT);
  });
});

// 红线：Schedule 文本变了就是新基线。这一轮只改水位，不把当前期次补成一张单。
test("Schedule 文本变化只重建基线，不建单", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NINE };
    await card(mock);
    const row = await rule(mock, { Rule_ID: "RULE-EDIT", Schedule: "0 9 * * *" });
    const svc = service(dir, mock, { now, logs });
    assert.equal(await svc.scan(), 0);
    assert.equal(f1(await ruleOf(mock, "RULE-EDIT"), "Last_Fired"), KEY_NINE);

    await mock.updateRecord(tables.rules, row.record_id, { Schedule: "30 9 * * *" });
    assert.equal(await svc.scan(), 0);
    assert.equal((await tasks(mock)).length, 0);
    assert.equal(f1(await ruleOf(mock, "RULE-EDIT"), "Last_Fired"), KEY_NINE_THIRTY);
    const state = JSON.parse(fs.readFileSync(path.join(dir, "schedule_state.json"), "utf8"));
    assert.equal(state.rules["RULE-EDIT"], "30 9 * * *");

    now.value = Date.parse("2026-01-16T01:30:00.000Z");
    assert.equal(await svc.scan(), 1);
    const created = await tasks(mock);
    assert.equal(created.length, 1);
    assert.equal(f1(created[0], "Idempotency_Key"), "sched:RULE-EDIT:2026-01-16T09:30:00+0800");
  });
});

// 红线：非法 IANA 名只记日志并跳过这一轮。不能抛出，也不能改用宿主机时区把水位推前。
test("非法时区跳过本轮且不抛", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NINE };
    await card(mock);
    await rule(mock, { Rule_ID: "RULE-TZ" });
    const good = service(dir, mock, { now, logs });
    assert.equal(await good.scan(), 0);
    assert.equal(f1(await ruleOf(mock, "RULE-TZ"), "Last_Fired"), KEY_NINE);

    now.value = NEXT_NINE;
    const bad = service(dir, mock, { now, tz: "Not/AZone", logs });
    await assert.doesNotReject(() => bad.scan());
    assert.equal(await bad.scan(), 0);
    assert.equal((await tasks(mock)).length, 0);
    assert.equal(f1(await ruleOf(mock, "RULE-TZ"), "Last_Fired"), KEY_NINE);
    assert.equal(logs.some((line) => line.includes("非法时区") && line.includes("Not/AZone")), true);
  });
});

// 红线：目标名片还没有时这一期不建单，水位停在原处。名片补上后下一轮才建。
test("目标名片缺失时不推进水位，补上名片后下一轮建单", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NINE };
    await rule(mock, { Rule_ID: "RULE-CARD" });
    const svc = service(dir, mock, { now, logs });
    assert.equal(await svc.scan(), 0);
    assert.equal(f1(await ruleOf(mock, "RULE-CARD"), "Last_Fired"), KEY_NINE);
    assert.equal((await tasks(mock)).length, 0);

    now.value = NEXT_NINE;
    assert.equal(await svc.scan(), 0);
    assert.equal((await tasks(mock)).length, 0);
    assert.equal(f1(await ruleOf(mock, "RULE-CARD"), "Last_Fired"), KEY_NINE);
    assert.equal(logs.some((line) => line.includes("调度建单失败") && line.includes("RULE-CARD")), true);

    await card(mock);
    assert.equal(await svc.scan(), 1);
    const created = await tasks(mock);
    assert.equal(created.length, 1);
    assert.equal(f1(created[0], "Idempotency_Key"), `sched:RULE-CARD:${KEY_NEXT}`);
    assert.equal(f1(await ruleOf(mock, "RULE-CARD"), "Last_Fired"), KEY_NEXT);
  });
});
