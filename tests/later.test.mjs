// 事项级 later：回执只在完成时写入 Metadata，复查单只由 hub 扫表建一次。
// 总线是内存 mock，状态只进临时目录，结束时清掉进程组。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { ScheduleService } from "../src/hub/schedule.mjs";
import { Kernel, parseAgentReceipt, parseJsonReceipt, parseLaterInstant } from "../src/kernel.mjs";
import { formatWhyText, getTaskWhy } from "../src/why.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const NOW = Date.parse("2026-06-15T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const HUB_TABLES = { ...TABLES, agentCards: "tbl_cards" };

function logsOf() {
  const lines = [];
  return { lines, log: (msg) => lines.push(String(msg)) };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function shellSingleQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

function nodeCommand(script) {
  return `${JSON.stringify(process.execPath)} -e ${shellSingleQuote(script)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await sleep(15);
  }
  return false;
}

function reap(dir, kernels) {
  for (const kernel of kernels) {
    try { kernel?.abandonLocalFlight?.(); } catch { /* 已经丢掉 */ }
  }
  const marker = path.join(dir, "runs");
  let out = "";
  try {
    out = spawnSync("ps", ["-ax", "-o", "pid=", "-o", "command="], { encoding: "utf8" }).stdout || "";
  } catch { /* 没有 ps 时只能靠账本里的 pid */ }
  const pids = new Set();
  for (const line of String(out).split("\n")) {
    if (!line.includes(marker)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid > 0) pids.add(pid);
  }
  if (fs.existsSync(marker)) {
    for (const name of fs.readdirSync(marker)) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(marker, name, "entry.json"), "utf8"));
        const pgid = Number(entry.pgid || entry.pid);
        if (pgid > 0) pids.add(pgid);
      } catch { /* 没有账本 */ }
    }
  }
  for (const pid of pids) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* 组已经没了 */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* 进程已经没了 */ }
  }
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
    Created_At: "2026-06-01T00:00:00Z",
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

function metaOf(task) {
  const raw = f1(task, "Metadata");
  if (!raw) return {};
  return JSON.parse(String(raw));
}

async function untilStatus(kernel, mock, taskId, status) {
  const exitPath = path.join(kernel.cfg.configDir, "runs", taskId, "exit");
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 8000) {
    if (kernel._directFlight && !fs.existsSync(exitPath)) {
      await waitFor(() => !kernel._directFlight || fs.existsSync(exitPath));
    }
    await kernel.sweepOnce();
    last = f1(await taskOf(mock, taskId), "Status");
    if (last === status) return taskOf(mock, taskId);
    if (last === "completed" || last === "failed" || last === "rejected" || last === "canceled") break;
    await sleep(20);
  }
  throw new Error(`want ${status} got ${last}`);
}

function service(bus, dir, { role = "hub", now = () => NOW, log = () => {} } = {}) {
  return new ScheduleService({
    bus,
    log,
    now,
    tz: "Asia/Shanghai",
    statePath: path.join(dir, "schedule_state.json"),
    role,
  });
}

async function seedCard(bus) {
  await bus.createRecord(HUB_TABLES.agentCards, {
    Cap_ID: "CAP-node-a-echo",
    Node: "node-a",
    Skill_ID: "echo",
    Dispatchable: "Yes",
    Availability: "online",
  });
}

async function seedDone(bus, fields, later) {
  const created = await bus.createRecord(HUB_TABLES.tasks, {
    Title: "前任",
    Source: "hub",
    Target_Node: "node-a",
    Skill_ID: "echo",
    Status: "completed",
    Hop_Count: 2,
    Retry_Count: 0,
    Context_ID: "CTX-LATER",
    Approval_Class: "approve",
    Idempotency_Key: `key-${fields.Task_ID}`,
    Metadata: JSON.stringify({
      note: "stay",
      presented_keys: ["keep-me"],
      later,
    }),
    ...fields,
  });
  return created.record;
}

function childRows(rows, parentId) {
  return rows.filter((row) => f1(row, "Idempotency_Key") === `later:${parentId}`);
}

// 红线：不靠 Date.parse 认日期。2027 不是闰年，2 月 29 日必须整条作废。
test("LATER 时刻核日历与时区，非法整条忽略", () => {
  assert.equal(parseLaterInstant("2024-02-29T00:00:00Z"), Date.UTC(2024, 1, 29));
  assert.equal(parseLaterInstant("2027-02-29T00:00:00Z"), null);
  assert.equal(parseLaterInstant("2026-02-29T00:00:00Z"), null);
  assert.equal(parseLaterInstant("2026-06-02T00:00:00"), null);
  assert.equal(parseLaterInstant("2026-06-02T08:00:00+0800"), Date.UTC(2026, 5, 2));
  assert.equal(parseLaterInstant("2026-06-02T08:00:00+08:00"), Date.UTC(2026, 5, 2));

  const now = Date.UTC(2026, 5, 1);
  const okAt = iso(now + 60_000);
  const quiet = logsOf();
  const row = parseAgentReceipt(`做完了\nLATER: ${okAt} | 看磁盘\n`, quiet.log, now);
  assert.equal(row.summary, "做完了");
  assert.deepEqual(row.later, { at: okAt, about: "看磁盘" });
  assert.deepEqual(quiet.lines, []);

  const edge = logsOf();
  const maxAt = iso(now + 30 * DAY);
  const maxed = parseAgentReceipt(`做完了\nLATER: ${maxAt} | 刚好三十天\n`, edge.log, now);
  assert.equal(maxed.later.about, "刚好三十天");
  assert.deepEqual(edge.lines, []);
  const chars = parseAgentReceipt(`做完了\nLATER: ${okAt} | ${"字".repeat(200)}\n`, () => {}, now);
  assert.equal([...chars.later.about].length, 200);

  const cases = [
    [`LATER: 2026-06-02T00:00:00 | 无时区`, /时区|日历/],
    [`LATER: ${iso(now - DAY)} | 过去`, /1 分钟/],
    [`LATER: ${iso(now + 59_000)} | 差一秒`, /1 分钟/],
    [`LATER: ${iso(now + 30 * DAY + 1000)} | 超窗`, /30 天/],
    ["LATER: 2027-02-29T00:00:00Z | 闰日", /日历/],
    [`LATER: ${okAt} | ${"字".repeat(201)}`, /200/],
    [`LATER: ${okAt} | 看\u0007磁盘`, /控制字符/],
    [`LATER: ${okAt}`, /时刻 \| 说明/],
  ];
  for (const [line, pattern] of cases) {
    const bad = logsOf();
    const got = parseAgentReceipt(`做完了\n${line}\n`, bad.log, now);
    assert.equal(got.later, null, line);
    assert.equal(got.summary, "做完了");
    assert.match(bad.lines.join("\n"), pattern);
  }

  const multi = logsOf();
  const last = parseAgentReceipt([
    "做完了",
    `LATER: ${iso(now + 2 * DAY)} | 第一条`,
    `LATER: ${okAt} | 最后一条`,
  ].join("\n"), multi.log, now);
  assert.equal(last.later.about, "最后一条");
  assert.match(multi.lines.join("\n"), /最后一条|多条/);

  const forged = logsOf();
  const hidden = parseAgentReceipt([
    "做完了",
    "```txt",
    `LATER: ${okAt} | 伪造`,
    "```",
  ].join("\n"), forged.log, now);
  assert.equal(hidden.later, null);
  assert.deepEqual(forged.lines, []);
});

test("json later 与 LATER 行同一套窗口", () => {
  const now = Date.UTC(2026, 5, 1);
  const okAt = iso(now + 120_000);
  const quiet = logsOf();
  const row = parseJsonReceipt({
    summary: "ok",
    later: { at: okAt, about: "看磁盘", command: "rm" },
  }, quiet.log, now);
  assert.equal(row.summary, "ok");
  assert.deepEqual(row.later, { at: okAt, about: "看磁盘" });
  assert.equal("command" in row, false);
  assert.deepEqual(quiet.lines, []);

  const bad = logsOf();
  const ignored = parseJsonReceipt({
    summary: "ok",
    later: { at: "2027-02-29T00:00:00Z", about: "闰日" },
  }, bad.log, now);
  assert.equal(ignored.later, null);
  assert.equal(ignored.summary, "ok");
  assert.match(bad.lines.join("\n"), /日历/);

  const ask = logsOf();
  assert.throws(() => parseJsonReceipt({
    summary: "ok",
    need_input: "还缺什么",
    later: { at: okAt, about: "看磁盘" },
  }, ask.log, now), (err) => err.message === "还缺什么");
  assert.match(ask.lines.join("\n"), /input-required/);

  const agentAsk = logsOf();
  assert.throws(() => parseAgentReceipt([
    "```agent-ask",
    "还缺什么",
    "```",
    `LATER: ${okAt} | 看磁盘`,
  ].join("\n"), agentAsk.log, now), (err) => err.message === "还缺什么");
  assert.match(agentAsk.lines.join("\n"), /input-required/);

  const failed = logsOf();
  assert.throws(() => parseAgentReceipt(`LATER: ${okAt} | 看磁盘\n`, failed.log, now), (err) => err.name === "InvalidReceipt");
  assert.match(failed.lines.join("\n"), /failed/);
});

test("完成回执把 later 写入 Metadata，且不覆盖其它键", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const at = iso(Date.now() + 120_000);
      const command = nodeCommand(`
        process.stdout.write(${JSON.stringify(`做完了\nLATER: ${at} | 看磁盘\n`)});
      `);
      const { mock, kernel } = await setup(dir, {
        command, mode: "agent", context: "direct", timeout_sec: 30,
      });
      kernels.push(kernel);
      const taskId = "TASK-LATER-OK";
      const record = await seedTask(mock, { Task_ID: taskId, Context_ID: "CTX-LATER-OK" });
      await mock.updateRecord(TABLES.tasks, record.record_id, {
        Metadata: JSON.stringify({ note: "stay", presented_keys: ["keep-me"] }),
      });
      const done = await untilStatus(kernel, mock, taskId, "completed");
      await kernel.sweepOnce();
      const meta = metaOf(done);
      assert.equal(meta.note, "stay");
      assert.deepEqual(meta.presented_keys, ["keep-me"]);
      assert.deepEqual(meta.later, { at, about: "看磁盘" });
      assert.equal((await mock.listRecords(TABLES.tasks)).length, 1);
      const fresh = metaOf(await taskOf(mock, taskId));
      assert.deepEqual(fresh.later, { at, about: "看磁盘" });
    } finally {
      reap(dir, kernels);
    }
  });
});

test("json 完成回执同样写入 later", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const at = iso(Date.now() + 180_000);
      const command = nodeCommand(`
        process.stdout.write(${JSON.stringify(JSON.stringify({ summary: "ok", later: { at, about: "看磁盘" } }) + "\n")});
      `);
      const { mock, kernel } = await setup(dir, {
        command, mode: "json", context: "direct", timeout_sec: 30,
      });
      kernels.push(kernel);
      const taskId = "TASK-LATER-JSON";
      await seedTask(mock, { Task_ID: taskId, Context_ID: "CTX-LATER-JSON" });
      const done = await untilStatus(kernel, mock, taskId, "completed");
      assert.deepEqual(metaOf(done).later, { at, about: "看磁盘" });
      assert.equal((await mock.listRecords(TABLES.tasks)).length, 1);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("failed 与 input-required 上的 later 不写入", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.map(String).join(" "));
    try {
      const at = iso(Date.now() + 120_000);
      const ask = nodeCommand(`
        process.stdout.write(${JSON.stringify("```agent-ask\n还缺什么\n```\nLATER: " + at + " | 看磁盘\n")});
      `);
      const { mock, kernel } = await setup(dir, {
        command: ask, mode: "agent", context: "direct", timeout_sec: 30,
      });
      kernels.push(kernel);
      const askId = "TASK-LATER-ASK";
      const askRow = await seedTask(mock, { Task_ID: askId, Context_ID: "CTX-ASK" });
      await mock.updateRecord(TABLES.tasks, askRow.record_id, {
        Metadata: JSON.stringify({ note: "stay" }),
      });
      const asked = await untilStatus(kernel, mock, askId, "input-required");
      assert.equal(metaOf(asked).note, "stay");
      assert.equal(Object.prototype.hasOwnProperty.call(metaOf(asked), "later"), false);
      assert.match(lines.join("\n"), /later 在 input-required 上忽略/);

      const fail = nodeCommand(`
        process.stdout.write(${JSON.stringify("LATER: " + at + " | 看磁盘\n")});
        process.exit(1);
      `);
      fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
        echo: { command: fail, mode: "agent", context: "direct", timeout_sec: 30 },
      }), { mode: 0o600 });
      kernel.commands = JSON.parse(fs.readFileSync(path.join(dir, "commands.json"), "utf8"));
      const failId = "TASK-LATER-FAIL";
      await seedTask(mock, { Task_ID: failId, Context_ID: "CTX-FAIL", Retry_Count: 2 });
      const failed = await untilStatus(kernel, mock, failId, "failed");
      assert.equal(Object.prototype.hasOwnProperty.call(metaOf(failed), "later"), false);
      assert.match(lines.join("\n"), /later 在 failed 上忽略/);
      assert.equal((await mock.listRecords(TABLES.tasks)).length, 2);
    } finally {
      console.log = orig;
      reap(dir, kernels);
    }
  });
});

test("Metadata.later 写失败不影响 completed", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const at = iso(Date.now() + 120_000);
      const command = nodeCommand(`
        process.stdout.write(${JSON.stringify(JSON.stringify({ summary: "ok", later: { at, about: "看磁盘" } }) + "\n")});
      `);
      const { mock, kernel } = await setup(dir, {
        command, mode: "json", context: "direct", timeout_sec: 30,
      });
      kernels.push(kernel);
      const taskId = "TASK-LATER-META";
      const record = await seedTask(mock, { Task_ID: taskId, Context_ID: "CTX-META" });
      await mock.updateRecord(TABLES.tasks, record.record_id, {
        Metadata: JSON.stringify({ note: "stay", presented_keys: ["keep-me"] }),
      });
      mock.failNext((ctx) => {
        if (ctx.op !== "update" || ctx.table !== TABLES.tasks) return false;
        const raw = ctx.fields?.Metadata;
        const text = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
        return text.includes('"later"');
      }, new Error("metadata later failed"));
      const done = await untilStatus(kernel, mock, taskId, "completed");
      const meta = metaOf(done);
      assert.equal(meta.note, "stay");
      assert.deepEqual(meta.presented_keys, ["keep-me"]);
      assert.equal(Object.prototype.hasOwnProperty.call(meta, "later"), false);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("hub 到点建复查任务恰好一次，未到期、缺名片、跳数和 node 角色都不推进", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: HUB_TABLES });
    const dueAt = "2026-06-01T00:00:00Z";
    const waitAt = "2026-07-01T00:00:00Z";
    const due = await seedDone(bus, { Task_ID: "TASK-DUE" }, { at: dueAt, about: "看磁盘" });
    await seedDone(bus, { Task_ID: "TASK-WAIT", Idempotency_Key: "key-TASK-WAIT" }, { at: waitAt, about: "还没到" });
    await seedDone(bus, {
      Task_ID: "TASK-HOP",
      Hop_Count: 8,
      Idempotency_Key: "key-TASK-HOP",
    }, { at: dueAt, about: "链尾" });
    const notes = logsOf();
    const nodeSvc = service(bus, dir, { role: "node", log: notes.log });
    assert.equal(await nodeSvc.scan(), 0);
    assert.equal((await bus.listRecords(HUB_TABLES.tasks)).length, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(metaOf(await bus.getRecord(HUB_TABLES.tasks, due.record_id)), "later_fired"), false);

    const hub = service(bus, dir, { log: notes.log });
    assert.equal(await hub.scan(), 0);
    assert.equal((await bus.listRecords(HUB_TABLES.tasks)).length, 3);
    assert.match(notes.lines.join("\n"), /下一轮重试/);
    assert.equal(metaOf(await bus.getRecord(HUB_TABLES.tasks, due.record_id)).later_fired, undefined);

    await seedCard(bus);
    assert.equal(await hub.scan(), 0);
    await hub.scan();
    const after = await bus.listRecords(HUB_TABLES.tasks);
    const children = childRows(after, "TASK-DUE");
    assert.equal(children.length, 1);
    const child = children[0];
    assert.equal(f1(child, "Context_ID"), "CTX-LATER");
    assert.equal(f1(child, "Hop_Count"), 3);
    assert.equal(f1(child, "Approval_Class"), "approve");
    assert.equal(f1(child, "Target_Node"), "node-a");
    assert.equal(f1(child, "Skill_ID"), "echo");
    assert.equal(f1(child, "Source"), "cron");
    assert.equal(f1(child, "Status"), "submitted");
    const msg = (await bus.findRecords(HUB_TABLES.messages, "Task_ID", f1(child, "Task_ID")))
      .find((row) => f1(row, "Kind") === "instruction");
    assert.equal(f1(msg, "Ref_Task_IDs"), "TASK-DUE");
    const part = (await bus.findRecords(HUB_TABLES.parts, "Parent_ID", f1(msg, "Msg_ID")))
      .find((row) => f1(row, "Kind") === "text");
    assert.equal(f1(part, "Text"), "复查：看磁盘（承接任务 TASK-DUE）");
    const marked = metaOf(await bus.getRecord(HUB_TABLES.tasks, due.record_id));
    assert.equal(marked.note, "stay");
    assert.deepEqual(marked.presented_keys, ["keep-me"]);
    assert.equal(marked.later.at, dueAt);
    assert.equal(marked.later_fired.task_id, f1(child, "Task_ID"));

    const wait = (await bus.listRecords(HUB_TABLES.tasks)).find((row) => f1(row, "Task_ID") === "TASK-WAIT");
    assert.equal(metaOf(wait).later_fired, undefined);
    const hop = (await bus.listRecords(HUB_TABLES.tasks)).find((row) => f1(row, "Task_ID") === "TASK-HOP");
    assert.equal(metaOf(hop).later_fired.reason, "hop_limit");
    assert.equal(childRows(await bus.listRecords(HUB_TABLES.tasks), "TASK-HOP").length, 0);

    const restarted = service(bus, dir);
    await restarted.scan();
    assert.equal(childRows(await bus.listRecords(HUB_TABLES.tasks), "TASK-DUE").length, 1);

    const healed = metaOf(await bus.getRecord(HUB_TABLES.tasks, due.record_id));
    delete healed.later_fired;
    await bus.updateRecord(HUB_TABLES.tasks, due.record_id, { Metadata: JSON.stringify(healed) });
    await restarted.scan();
    assert.equal(childRows(await bus.listRecords(HUB_TABLES.tasks), "TASK-DUE").length, 1);
    const again = metaOf(await bus.getRecord(HUB_TABLES.tasks, due.record_id));
    assert.equal(again.later_fired.task_id, f1(child, "Task_ID"));
    assert.equal(again.note, "stay");
  });
});

test("task why 显示 later 待触发、已触发和跳数熔断", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    await bus.createRecord(TABLES.tasks, {
      Task_ID: "TASK-WHY-LATER",
      Title: "复查",
      Status: "completed",
      Target_Node: "node-a",
      Source: "hub",
      Skill_ID: "echo",
      Context_ID: "CTX-WHY",
      Metadata: JSON.stringify({ later: { at: "2026-06-20T00:00:00Z", about: "看磁盘" }, note: "stay" }),
    });
    await bus.createRecord(TABLES.messages, {
      Msg_ID: "MSG-WHY-LATER-01",
      Task_ID: "TASK-WHY-LATER",
      Kind: "instruction",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Created_At: "2026-06-01T00:00:00Z",
    });
    const pending = await getTaskWhy({ bus, configDir: dir, taskId: "TASK-WHY-LATER" });
    assert.equal(pending.later.status, "pending");
    assert.match(formatWhyText(pending), /复查预约: 待触发 2026-06-20T00:00:00Z 看磁盘/);
    assert.equal(formatWhyText(pending).includes("stay"), false);

    const row = (await bus.listRecords(TABLES.tasks))[0];
    const meta = metaOf(row);
    meta.later_fired = { task_id: "TASK-NEXT", at: "2026-06-20T00:01:00Z" };
    await bus.updateRecord(TABLES.tasks, row.record_id, { Metadata: JSON.stringify(meta) });
    const fired = await getTaskWhy({ bus, configDir: dir, taskId: "TASK-WHY-LATER" });
    assert.equal(fired.later.status, "fired");
    assert.equal(fired.later.task_id, "TASK-NEXT");
    assert.match(formatWhyText(fired), /复查预约: 已触发 TASK-NEXT/);

    meta.later_fired = { task_id: "", at: "2026-06-20T00:01:00Z", reason: "hop_limit" };
    await bus.updateRecord(TABLES.tasks, row.record_id, { Metadata: JSON.stringify(meta) });
    const skipped = await getTaskWhy({ bus, configDir: dir, taskId: "TASK-WHY-LATER" });
    assert.equal(skipped.later.status, "skipped");
    assert.match(formatWhyText(skipped), /已跳过（跳数超限，未建复查任务）/);
  });
});
