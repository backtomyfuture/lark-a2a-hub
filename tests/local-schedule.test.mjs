// 节点本地调度：基线、补期、时区、幂等键、坏计划和内核同一轮认领。
// 时钟由构造参数注入。总线是内存 mock。不读 ~/.hub-node，不连飞书。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { f1 } from "../src/bus/feishu.mjs";
import { createTask } from "../src/hub/create.mjs";
import { Kernel } from "../src/kernel.mjs";
import { LocalScheduleService } from "../src/local-schedule.mjs";
import { HubRuntime } from "../src/hub/index.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ECHO = path.join(ROOT, "src", "executors", "echo.mjs");
const NINE = Date.parse("2026-01-15T01:30:00.000Z");
const NEXT_NINE = Date.parse("2026-01-16T01:30:00.000Z");
const JAN17 = Date.parse("2026-01-17T01:30:00.000Z");
const KEY_NINE = "2026-01-15T09:00:00+0800";
const KEY_NEXT = "2026-01-16T09:00:00+0800";
const KEY_17 = "2026-01-17T09:00:00+0800";
const KEY_NINE_THIRTY = "2026-01-15T09:30:00+0800";
const CAP = "CAP-echo";

function echoCommand() {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(ECHO)}`;
}

function bus() {
  return new MockFeishuBus({ tables: TABLES });
}

function writeSchedules(file, schedules) {
  fs.writeFileSync(file, JSON.stringify({ schedules }, null, 1), { mode: 0o600 });
}

function plan(id, extra = {}) {
  return {
    id,
    enabled: true,
    cron: "0 9 * * *",
    cap: CAP,
    text: `跑 ${id}`,
    ...extra,
  };
}

async function card(mock, node, extra = {}) {
  const created = await mock.createRecord(TABLES.agentCards, {
    Cap_ID: CAP,
    Node: node,
    Skill_ID: "echo",
    Dispatchable: "Yes",
    Availability: "online",
    ...extra,
  });
  return created.record;
}

function service(dir, mock, { node = "node-a", now, tz = "Asia/Shanghai", logs, schedules = "schedules.json", state = "schedule_local_state.json" } = {}) {
  return new LocalScheduleService({
    bus: mock,
    node,
    tz,
    schedulesPath: path.join(dir, schedules),
    statePath: path.join(dir, state),
    now: () => now.value,
    log: (line) => logs.push(String(line)),
    createTask,
    commandsOf: () => new Set([CAP]),
    notify: () => {},
  });
}

function tasksOf(mock) {
  return mock.listRecords(TABLES.tasks);
}

function stateOf(dir, name = "schedule_local_state.json") {
  return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("T6 新建计划与改 cron 后首轮只锚基线", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NINE };
    await card(mock, "node-a");
    writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY")]);
    const svc = service(dir, mock, { now, logs });
    assert.equal((await svc.tick(), (await tasksOf(mock)).length), 0);
    const anchored = stateOf(dir);
    assert.equal(anchored.schedules.DAILY.cron, "0 9 * * *");
    assert.equal(anchored.schedules.DAILY.last_fired, KEY_NINE);
    assert.equal(fs.statSync(path.join(dir, "schedule_local_state.json")).mode & 0o777, 0o600);
    assert.equal(logs.some((line) => line.includes("schedule baseline DAILY")), true);

    await svc.tick();
    assert.equal((await tasksOf(mock)).length, 0);

    writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY", { cron: "30 9 * * *" })]);
    await svc.tick();
    assert.equal((await tasksOf(mock)).length, 0);
    assert.equal(stateOf(dir).schedules.DAILY.cron, "30 9 * * *");
    assert.equal(stateOf(dir).schedules.DAILY.last_fired, KEY_NINE_THIRTY);

    now.value = Date.parse("2026-01-16T01:30:00.000Z");
    await svc.tick();
    const created = await tasksOf(mock);
    assert.equal(created.length, 1);
    assert.equal(f1(created[0], "Idempotency_Key"), "sched:node-a:DAILY:2026-01-16T09:30:00+0800");
    assert.equal(f1(created[0], "Status"), "submitted");
  });
});

test("T2 重启后只补最近一期，且只补一次", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NINE };
    await card(mock, "node-a");
    writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY", { text: "早报" })]);
    const mk = () => service(dir, mock, { now, logs });
    await mk().tick();
    assert.equal((await tasksOf(mock)).length, 0);

    now.value = JAN17;
    await mk().tick();
    let created = await tasksOf(mock);
    assert.equal(created.length, 1);
    assert.equal(f1(created[0], "Idempotency_Key"), `sched:node-a:DAILY:${KEY_17}`);
    assert.equal(created.some((row) => String(f1(row, "Idempotency_Key")).includes("2026-01-16")), false);
    assert.equal(f1(created[0], "Status"), "submitted");
    assert.equal(f1(created[0], "Source"), "cron");

    await mk().tick();
    created = await tasksOf(mock);
    assert.equal(created.length, 1);
    await mk().tick();
    assert.equal((await tasksOf(mock)).length, 1);
    assert.equal(stateOf(dir).schedules.DAILY.last_fired, KEY_17);
  });
});

test("T4 两个节点同 id 同 cron 各建一行，幂等键含各自 Node_ID", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const now = { value: NINE };
    await card(mock, "node-a");
    await card(mock, "node-b");
    for (const node of ["node-a", "node-b"]) {
      const sub = path.join(dir, node);
      fs.mkdirSync(sub);
      writeSchedules(path.join(sub, "schedules.json"), [plan("DAILY", { text: "同一计划" })]);
    }
    const mk = (node) => new LocalScheduleService({
      bus: mock,
      node,
      tz: "Asia/Shanghai",
      schedulesPath: path.join(dir, node, "schedules.json"),
      statePath: path.join(dir, node, "schedule_local_state.json"),
      now: () => now.value,
      log: () => {},
      createTask,
      commandsOf: () => new Set([CAP]),
    });
    await mk("node-a").tick();
    await mk("node-b").tick();
    assert.equal((await tasksOf(mock)).length, 0);

    now.value = NEXT_NINE;
    await mk("node-a").tick();
    await mk("node-b").tick();
    const created = await tasksOf(mock);
    assert.equal(created.length, 2);
    const keys = created.map((row) => f1(row, "Idempotency_Key")).sort();
    assert.deepEqual(keys, [
      `sched:node-a:DAILY:${KEY_NEXT}`,
      `sched:node-b:DAILY:${KEY_NEXT}`,
    ]);
    assert.deepEqual(created.map((row) => f1(row, "Target_Node")).sort(), ["node-a", "node-b"]);
    const froms = [];
    for (const row of await mock.listRecords(TABLES.messages)) {
      if (f1(row, "Kind") === "instruction") froms.push(f1(row, "From_Node"));
    }
    assert.deepEqual(froms.sort(), ["node-a", "node-b"]);

    await mk("node-a").tick();
    await mk("node-b").tick();
    assert.equal((await tasksOf(mock)).length, 2);
  });
});

test("T5 到点任务带审批级别，状态保持 submitted", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const now = { value: NINE };
    await card(mock, "node-a");
    writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY", { text: "对外发", approval_class: "approve" })]);
    const svc = service(dir, mock, { now, logs: [] });
    await svc.tick();
    now.value = NEXT_NINE;
    const before = mock.journal.length;
    await svc.tick();
    const created = await tasksOf(mock);
    assert.equal(created.length, 1);
    assert.equal(f1(created[0], "Status"), "submitted");
    assert.equal(f1(created[0], "Approval_Class"), "approve");
    assert.equal(f1(created[0], "Source"), "cron");
    assert.equal(f1(created[0], "Target_Node"), "node-a");
    assert.equal(f1(created[0], "Skill_ID"), "echo");
    const creates = mock.journal.slice(before).filter((item) => item.op === "create").map((item) => item.table);
    const msgAt = creates.indexOf(TABLES.messages);
    const partAt = creates.indexOf(TABLES.parts);
    const taskAt = creates.indexOf(TABLES.tasks);
    assert.ok(msgAt >= 0 && msgAt < partAt && partAt < taskAt);
    const instruction = (await mock.listRecords(TABLES.messages)).find((row) => f1(row, "Kind") === "instruction");
    assert.equal(f1(instruction, "From_Node"), "node-a");
    const part = (await mock.listRecords(TABLES.parts)).find((row) => f1(row, "Kind") === "text");
    assert.equal(f1(part, "Text"), "对外发");
  });
});

test("T7 node.json 的 tz 决定期次键，改 process.env.TZ 不影响", async () => {
  const prev = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    await withTemp(async (dir) => {
      const mock = bus();
      const now = { value: NINE };
      await card(mock, "node-a");
      writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY")]);
      const shanghai = service(dir, mock, { now, logs: [], tz: "Asia/Shanghai" });
      await shanghai.tick();
      assert.equal(stateOf(dir).schedules.DAILY.last_fired, KEY_NINE);

      const nyDir = path.join(dir, "ny");
      fs.mkdirSync(nyDir);
      writeSchedules(path.join(nyDir, "schedules.json"), [plan("DAILY")]);
      const ny = new LocalScheduleService({
        bus: mock,
        node: "node-a",
        tz: "America/New_York",
        schedulesPath: path.join(nyDir, "schedules.json"),
        statePath: path.join(nyDir, "schedule_local_state.json"),
        now: () => now.value,
        log: () => {},
        createTask,
        commandsOf: () => new Set([CAP]),
      });
      await ny.tick();
      assert.equal(stateOf(nyDir).schedules.DAILY.last_fired, "2026-01-14T09:00:00-0500");
      assert.equal((await tasksOf(mock)).length, 0);
    });
  } finally {
    if (prev == null) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test("同键任务已在表里时只补水位线，不重复建单", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const now = { value: NINE };
    await card(mock, "node-a");
    writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY")]);
    const svc = service(dir, mock, { now, logs: [] });
    await svc.tick();
    now.value = NEXT_NINE;
    await mock.createRecord(TABLES.tasks, {
      Task_ID: "TASK-ALREADY",
      Status: "submitted",
      Target_Node: "node-a",
      Skill_ID: "echo",
      Source: "cron",
      Idempotency_Key: `sched:node-a:DAILY:${KEY_NEXT}`,
    });
    await svc.tick();
    const created = await tasksOf(mock);
    assert.equal(created.length, 1);
    assert.equal(f1(created[0], "Task_ID"), "TASK-ALREADY");
    assert.equal(stateOf(dir).schedules.DAILY.last_fired, KEY_NEXT);
  });
});

test("schedules.json 整体损坏、单条非法、控制键拒收都只停用对应范围", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NINE };
    await card(mock, "node-a");
    const file = path.join(dir, "schedules.json");
    fs.writeFileSync(file, "{", { mode: 0o600 });
    const broken = service(dir, mock, { now, logs });
    await assert.doesNotReject(() => broken.tick());
    await broken.tick();
    assert.equal((await tasksOf(mock)).length, 0);
    assert.equal(logs.filter((line) => line.includes("schedules.json 损坏")).length, 1);

    logs.length = 0;
    writeSchedules(file, [
      plan("BAD", { cron: "not a cron" }),
      plan("GOOD", { text: "好的" }),
      plan("DUP", { text: "第一" }),
      plan("DUP", { text: "第二" }),
      plan("CTL", { text: "不该跑", command: "rm -rf /", mode: "agent" }),
      plan("NOCAP", { cap: "CAP-missing", text: "没有这能力" }),
    ]);
    const svc = service(dir, mock, { now, logs });
    await svc.tick();
    await svc.tick();
    assert.equal((await tasksOf(mock)).length, 0);
    assert.equal(stateOf(dir).schedules.GOOD.last_fired, KEY_NINE);
    assert.equal(stateOf(dir).schedules.BAD, undefined);
    assert.equal(stateOf(dir).schedules.CTL, undefined);
    assert.equal(logs.filter((line) => line.includes("BAD") && line.includes("cron 无法解析")).length, 1);
    assert.equal(logs.filter((line) => line.includes("DUP") && line.includes("id 重复")).length, 1);
    assert.equal(logs.filter((line) => line.includes("CTL") && line.includes("执行控制键")).length, 1);
    assert.equal(logs.filter((line) => line.includes("NOCAP") && line.includes("cap 不在本机")).length, 1);

    now.value = NEXT_NINE;
    await svc.tick();
    const created = await tasksOf(mock);
    const keys = created.map((row) => f1(row, "Idempotency_Key")).sort();
    // 重复 id 只停用后出现的那条，先出现的 DUP 仍是合法计划。
    assert.deepEqual(keys, [`sched:node-a:DUP:${KEY_NEXT}`, `sched:node-a:GOOD:${KEY_NEXT}`]);
    const texts = (await mock.listRecords(TABLES.parts)).map((row) => f1(row, "Text")).sort();
    assert.deepEqual(texts, ["第一", "好的"].sort());
  });
});

test("非法时区不抛出且不触发", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NEXT_NINE };
    await card(mock, "node-a");
    writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY")]);
    fs.writeFileSync(path.join(dir, "schedule_local_state.json"), JSON.stringify({
      schedules: { DAILY: { cron: "0 9 * * *", last_fired: KEY_NINE } },
    }), { mode: 0o600 });
    const svc = service(dir, mock, { now, logs, tz: "Not/AZone" });
    await assert.doesNotReject(() => svc.tick());
    await svc.tick();
    assert.equal((await tasksOf(mock)).length, 0);
    assert.equal(stateOf(dir).schedules.DAILY.last_fired, KEY_NINE);
    assert.equal(logs.filter((line) => line.includes("时区非法") && line.includes("Not/AZone")).length, 1);
  });
});

test("基线写失败时本轮不触发", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NEXT_NINE };
    await card(mock, "node-a");
    writeSchedules(path.join(dir, "schedules.json"), [
      plan("NEW", { text: "新的" }),
      plan("DUE", { text: "到期" }),
    ]);
    fs.writeFileSync(path.join(dir, "schedule_local_state.json"), JSON.stringify({
      schedules: { DUE: { cron: "0 9 * * *", last_fired: KEY_NINE } },
    }), { mode: 0o600 });
    try {
      fs.chmodSync(dir, 0o500);
      const svc = service(dir, mock, { now, logs });
      await assert.doesNotReject(() => svc.tick());
      assert.equal((await tasksOf(mock)).length, 0);
      assert.equal(logs.some((line) => line.includes("schedule_local_state.json 写失败")), true);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.equal(stateOf(dir).schedules.DUE.last_fired, KEY_NINE);
    assert.equal(stateOf(dir).schedules.NEW, undefined);
  });
});

test("同批一条建单失败不影响其余，同一期次的失败日志只记一次", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NEXT_NINE };
    await card(mock, "node-a");
    writeSchedules(path.join(dir, "schedules.json"), [
      plan("BAD", { text: "失败的" }),
      plan("GOOD", { text: "成功的" }),
    ]);
    fs.writeFileSync(path.join(dir, "schedule_local_state.json"), JSON.stringify({
      schedules: {
        BAD: { cron: "0 9 * * *", last_fired: KEY_NINE },
        GOOD: { cron: "0 9 * * *", last_fired: KEY_NINE },
      },
    }), { mode: 0o600 });
    const svc = new LocalScheduleService({
      bus: mock,
      node: "node-a",
      tz: "Asia/Shanghai",
      schedulesPath: path.join(dir, "schedules.json"),
      statePath: path.join(dir, "schedule_local_state.json"),
      now: () => now.value,
      log: (line) => logs.push(String(line)),
      createTask: async (args) => {
        if (String(args.idempotencyKey).includes(":BAD:")) throw new Error("暂不可派");
        return createTask(args);
      },
      commandsOf: () => new Set([CAP]),
      notify: () => {},
    });
    await svc.tick();
    await svc.tick();
    await svc.tick();
    const created = await tasksOf(mock);
    assert.equal(created.length, 1);
    assert.equal(f1(created[0], "Idempotency_Key"), `sched:node-a:GOOD:${KEY_NEXT}`);
    assert.equal(stateOf(dir).schedules.GOOD.last_fired, KEY_NEXT);
    assert.equal(stateOf(dir).schedules.BAD.last_fired, KEY_NINE);
    const failLogs = () => logs.filter((line) => line.includes("调度建单失败") && line.includes("BAD"));
    assert.equal(failLogs().length, 1);
    assert.deepEqual(
      [...svc._logged].filter((key) => key.startsWith("create-fail:")),
      [`create-fail:BAD:${KEY_NEXT}`],
    );

    now.value = JAN17;
    await svc.tick();
    await svc.tick();
    assert.equal(failLogs().length, 2);
    assert.deepEqual(
      [...svc._logged].filter((key) => key.startsWith("create-fail:")),
      [`create-fail:BAD:${KEY_17}`],
    );
    assert.equal(stateOf(dir).schedules.BAD.last_fired, KEY_NINE);
    const tasks = await tasksOf(mock);
    assert.equal(tasks.filter((row) => String(f1(row, "Idempotency_Key")).includes(":BAD:")).length, 0);
    assert.equal(stateOf(dir).schedules.GOOD.last_fired, KEY_17);
  });
});

test("名片不可派时不推进水位，恢复后下一轮建单", async () => {
  await withTemp(async (dir) => {
    const mock = bus();
    const logs = [];
    const now = { value: NINE };
    const row = await card(mock, "node-a");
    writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY")]);
    const svc = service(dir, mock, { now, logs });
    await svc.tick();
    await mock.updateRecord(TABLES.agentCards, row.record_id, { Dispatchable: "No" });
    now.value = NEXT_NINE;
    await svc.tick();
    assert.equal((await tasksOf(mock)).length, 0);
    assert.equal(stateOf(dir).schedules.DAILY.last_fired, KEY_NINE);
    assert.equal(logs.some((line) => line.includes("调度建单失败") && line.includes("DAILY")), true);

    await mock.updateRecord(TABLES.agentCards, row.record_id, { Dispatchable: "Yes" });
    await svc.tick();
    const created = await tasksOf(mock);
    assert.equal(created.length, 1);
    assert.equal(f1(created[0], "Status"), "submitted");
    assert.equal(stateOf(dir).schedules.DAILY.last_fired, KEY_NEXT);
  });
});

test("分钟定时器到点抬醒，requestStop 与 once 模式都不留下定时器", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      echo: { command: echoCommand(), mode: "json", context: "direct", cap_id: CAP },
    }), { mode: 0o600 });
    const mock = bus();
    const kernel = new Kernel({
      node: "node-a",
      role: "node",
      configDir: dir,
      bus: mock,
      carrierSocket: path.join(dir, "missing.sock"),
      events: false,
    });
    await kernel.run({ once: true });
    assert.equal(kernel._minuteTimerOn, false);
    assert.equal(kernel._minuteTimer, null);

    let woke = 0;
    kernel._stopping = false;
    kernel._wakeFlag = false;
    kernel._notifyWake = () => { woke += 1; };
    kernel._minuteDelayMs = () => 30;
    kernel.startMinuteTimer();
    await delay(80);
    // 没有 schedules.json，连续几个整分都不该扫表。
    assert.equal(kernel._wakeFlag, false);
    assert.equal(woke, 0);
    kernel.requestStop();
    const seen = woke;
    await delay(80);
    assert.equal(woke, seen);
    assert.equal(kernel._minuteTimer, null);
    assert.equal(kernel._minuteTimerOn, false);
  });
});

test("分钟回调只在到期那一分钟唤醒，锚上水位或时区非法则不叫醒", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      echo: { command: echoCommand(), mode: "json", context: "direct", cap_id: CAP },
    }), { mode: 0o600 });
    const mock = bus();
    const logs = [];
    const kernel = new Kernel({
      node: "node-a",
      role: "node",
      configDir: dir,
      bus: mock,
      carrierSocket: path.join(dir, "missing.sock"),
      events: false,
      tz: "Asia/Shanghai",
    });
    kernel.localSchedule.log = (line) => logs.push(String(line));
    writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY")]);
    fs.writeFileSync(path.join(dir, "schedule_local_state.json"), JSON.stringify({
      schedules: { DAILY: { cron: "0 9 * * *", last_fired: KEY_NINE } },
    }), { mode: 0o600 });
    await card(mock, "node-a");
    const quiet = [
      Date.parse("2026-01-15T01:01:00.000Z"),
      Date.parse("2026-01-15T01:02:00.000Z"),
      Date.parse("2026-01-16T00:59:00.000Z"),
    ];
    for (const at of quiet) {
      kernel._wakeFlag = false;
      kernel._scheduleNowMs = () => at;
      const mark = mock.journal.length;
      kernel._onMinute();
      assert.equal(kernel._wakeFlag, false);
      assert.equal(mock.journal.length, mark);
    }
    const due = Date.parse("2026-01-16T01:00:00.000Z");
    kernel._wakeFlag = false;
    kernel._scheduleNowMs = () => due;
    const beforeDue = mock.journal.length;
    kernel._onMinute();
    assert.equal(kernel._wakeFlag, true);
    assert.equal(mock.journal.length, beforeDue);

    kernel.localSchedule.now = () => due;
    await kernel.localSchedule.tick();
    assert.equal(stateOf(dir).schedules.DAILY.last_fired, KEY_NEXT);
    kernel._wakeFlag = false;
    kernel._scheduleNowMs = () => due + 60_000;
    kernel._onMinute();
    assert.equal(kernel._wakeFlag, false);

    kernel.localSchedule.tz = "Not/AZone";
    kernel._wakeFlag = false;
    kernel._scheduleNowMs = () => due;
    assert.doesNotThrow(() => kernel._onMinute());
    kernel._onMinute();
    assert.equal(kernel._wakeFlag, false);
    assert.equal(logs.filter((line) => line.includes("时区非法")).length, 1);
  });
});

test("hub 的 run 会启动分钟定时器，退出时清掉", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), "{}", { mode: 0o600 });
    const mock = bus();
    const runtime = new HubRuntime({
      cfg: {
        node: "hub",
        role: "hub",
        configDir: dir,
        bus: mock,
        carrierSocket: path.join(dir, "missing.sock"),
        events: false,
      },
      log: () => {},
    });
    let started = 0;
    const orig = runtime.kernel.startMinuteTimer.bind(runtime.kernel);
    runtime.kernel._minuteDelayMs = () => 60_000;
    runtime.kernel.startMinuteTimer = () => {
      started += 1;
      orig();
    };
    runtime._stopped = true;
    await runtime.run();
    assert.equal(started, 1);
    assert.equal(runtime.kernel._minuteTimerOn, false);
    assert.equal(runtime.kernel._minuteTimer, null);
  });
});

test("sweepOnce 里 tick 建出的任务在同一轮被认领，tick 抛错不影响认领", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      echo: {
        command: echoCommand(),
        mode: "json",
        context: "direct",
        timeout_sec: 30,
        cap_id: CAP,
        name: "echo",
      },
    }), { mode: 0o600 });
    const mock = bus();
    const kernel = new Kernel({
      node: "node-a",
      role: "node",
      kind: "host",
      zone: "test",
      capPrefix: "test",
      events: false,
      tz: "Asia/Shanghai",
      configDir: dir,
      carrierSocket: path.join(dir, "missing.sock"),
      bus: mock,
    });
    writeSchedules(path.join(dir, "schedules.json"), [plan("DAILY", { text: "同一轮" })]);
    fs.writeFileSync(path.join(dir, "schedule_local_state.json"), JSON.stringify({
      schedules: { DAILY: { cron: "0 9 * * *", last_fired: KEY_NINE } },
    }), { mode: 0o600 });
    kernel.localSchedule.now = () => NEXT_NINE;
    await kernel.sweepOnce();
    const scheduled = await tasksOf(mock);
    assert.equal(scheduled.length, 1);
    assert.equal(f1(scheduled[0], "Source"), "cron");
    assert.equal(f1(scheduled[0], "Idempotency_Key"), `sched:node-a:DAILY:${KEY_NEXT}`);
    assert.equal(f1(scheduled[0], "Claimed_By"), "node-a");
    assert.notEqual(f1(scheduled[0], "Status"), "submitted");
    for (let i = 0; i < 20 && kernel._directFlight; i++) {
      await delay(25);
      await kernel.sweepOnce();
    }
    kernel.requestStop();
  });
});

test("tick 抛错时 sweepOnce 仍认领已在表里的 submitted 任务", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      echo: {
        command: echoCommand(),
        mode: "json",
        context: "direct",
        timeout_sec: 30,
        cap_id: CAP,
        name: "echo",
      },
    }), { mode: 0o600 });
    const mock = bus();
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
    const msgId = "MSG-SEED-1";
    await mock.createRecord(TABLES.messages, {
      Msg_ID: msgId,
      Task_ID: "TASK-SEED",
      Context_ID: "CTX-SEED",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Kind: "instruction",
    });
    await mock.createRecord(TABLES.parts, {
      Part_ID: `${msgId}-P1`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: "手工单",
    });
    await mock.createRecord(TABLES.tasks, {
      Task_ID: "TASK-SEED",
      Context_ID: "CTX-SEED",
      Title: "手工单",
      Source: "hub",
      Target_Node: "node-a",
      Skill_ID: "echo",
      Status: "submitted",
      Hop_Count: 0,
      Retry_Count: 0,
      Idempotency_Key: "key-seed",
    });
    kernel.localSchedule.tick = async () => { throw new Error("tick-boom"); };
    await assert.doesNotReject(() => kernel.sweepOnce());
    const seeded = (await mock.listRecords(TABLES.tasks)).find((row) => f1(row, "Task_ID") === "TASK-SEED");
    assert.equal(f1(seeded, "Claimed_By"), "node-a");
    assert.notEqual(f1(seeded, "Status"), "submitted");
    for (let i = 0; i < 20 && kernel._directFlight; i++) {
      await delay(25);
      await kernel.sweepOnce();
    }
    kernel.requestStop();
  });
});
