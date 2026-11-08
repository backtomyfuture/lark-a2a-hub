// direct 在途账本：扫表不被长命令堵住，守护重启后续租而不是再跑一遍。
// 总线是内存 mock。每个用例都要清掉自己拉起的进程组，不留在临时目录外面。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { Kernel } from "../src/kernel.mjs";
import { ApprovalService } from "../src/hub/approval.mjs";
import { HubRuntime } from "../src/hub/index.mjs";
import { PresentService } from "../src/hub/present.mjs";
import { ScheduleService } from "../src/hub/schedule.mjs";
import { StaleService } from "../src/hub/stale.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

// commands.json 的 command 会交给 sh -c。单引号才能保住脚本里的引号和换行；
// JSON.stringify 的 \" 与 \n 会被 shell 拆开，node -e 收到的不是原脚本。
function shellSingleQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

function nodeCommand(script) {
  return `${JSON.stringify(process.execPath)} -e ${shellSingleQuote(script)}`;
}

function sleepJson(ms, countPath) {
  return nodeCommand(`
    const fs = require("node:fs");
    const p = ${JSON.stringify(countPath)};
    const n = fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) || 0 : 0;
    fs.writeFileSync(p, String(n + 1));
    setTimeout(() => {
      console.log(JSON.stringify({ summary: "ok" }));
    }, ${Number(ms)});
  `);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await sleep(40);
  }
  return false;
}

function entryOf(dir, taskId) {
  return JSON.parse(fs.readFileSync(path.join(dir, "runs", taskId, "entry.json"), "utf8"));
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

async function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("direct 命令在途时 sweepOnce 很快返回，且不认领第二条", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const count = path.join(dir, "count");
      const { mock, kernel } = await setup(dir, {
        command: sleepJson(2500, count),
        mode: "json",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-SLOW-1", Context_ID: "CTX-SLOW-1" }, { text: "LEDGER-SECRET-TEXT" });
      await seedTask(mock, { Task_ID: "TASK-SLOW-2", Context_ID: "CTX-SLOW-2" }, { text: "第二条" });
      const started = Date.now();
      await kernel.sweepOnce();
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1000, `sweepOnce took ${elapsed}ms`);
      assert.equal(f1(await taskOf(mock, "TASK-SLOW-1"), "Status"), "working");
      const second = await taskOf(mock, "TASK-SLOW-2");
      assert.equal(f1(second, "Status"), "submitted");
      assert.equal(String(f1(second, "Claimed_By") ?? ""), "");
      const entry = entryOf(dir, "TASK-SLOW-1");
      assert.equal(entry.task_id, "TASK-SLOW-1");
      assert.equal(entry.attempt, 0);
      assert.equal(entry.state, "running");
      assert.equal(typeof entry.pid, "number");
      assert.ok(entry.pgid);
      assert.equal(typeof entry.started_ms, "number");
      assert.equal(entry.timeout_sec, 30);
      assert.ok(entry.stdout_path && entry.stderr_path && entry.exit_path);
      assert.ok(entry.proc_start_ms === null || typeof entry.proc_start_ms === "number");
      assert.equal(JSON.stringify(entry).includes("LEDGER-SECRET-TEXT"), false);
      assert.equal(fs.statSync(path.join(dir, "runs", "TASK-SLOW-1", "entry.json")).mode & 0o777, 0o600);
      assert.equal(await alive(entry.pid), true);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("direct 命令结束后由下一轮扫表收口为 completed", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const count = path.join(dir, "count");
      const { mock, kernel } = await setup(dir, {
        command: sleepJson(600, count),
        mode: "json",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-DONE-1", Context_ID: "CTX-DONE-1" });
      const started = Date.now();
      await kernel.sweepOnce();
      assert.ok(Date.now() - started < 1000);
      assert.equal(f1(await taskOf(mock, "TASK-DONE-1"), "Status"), "working");
      assert.equal(await waitFor(() => kernel._wakeFlag || fs.existsSync(path.join(dir, "runs", "TASK-DONE-1", "exit"))), true);
      kernel._wakeFlag = false;
      await kernel.sweepOnce();
      const task = await taskOf(mock, "TASK-DONE-1");
      assert.equal(f1(task, "Status"), "completed");
      assert.equal(fs.readFileSync(count, "utf8"), "1");
      const result = (await mock.findRecords(TABLES.messages, "Kind", "result"))[0];
      assert.ok(result);
      assert.equal(f1(result, "To_Node"), "hub");
      assert.equal(f1(result, "From_Node"), "node-a");
      const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(result, "Msg_ID"));
      assert.equal(parts.some((part) => f1(part, "Kind") === "text" && String(f1(part, "Text")).includes("ok")), true);
      const run = (await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-DONE-1"))[0];
      assert.equal(f1(run, "Outcome"), "succeeded");
      assert.equal(fs.existsSync(path.join(dir, "runs", "TASK-DONE-1", "entry.json")), false);
      assert.equal(fs.existsSync(path.join(dir, "runs", "TASK-DONE-1", "stdout.txt")), false);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("守护重启后续上仍在跑的进程，不第二次 spawn", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const count = path.join(dir, "count");
      const command = sleepJson(1800, count);
      const { mock, kernel } = await setup(dir, {
        command,
        mode: "json",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-KEEP-1", Context_ID: "CTX-KEEP-1" });
      await kernel.sweepOnce();
      assert.equal(await waitFor(() => fs.existsSync(count)), true);
      const before = entryOf(dir, "TASK-KEEP-1");
      await mock.updateRecord(TABLES.tasks, (await taskOf(mock, "TASK-KEEP-1")).record_id, {
        Heartbeat_At: "2020-01-01T00:00:00+0800",
      });
      kernel.abandonLocalFlight();
      const next = new Kernel({
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
      kernels.push(next);
      await next.sweepOnce();
      const task = await taskOf(mock, "TASK-KEEP-1");
      assert.equal(f1(task, "Status"), "working");
      assert.notEqual(f1(task, "Heartbeat_At"), "2020-01-01T00:00:00+0800");
      assert.equal(fs.readFileSync(count, "utf8"), "1");
      assert.equal(entryOf(dir, "TASK-KEEP-1").pid, before.pid);
      assert.equal(await waitFor(() => fs.existsSync(path.join(dir, "runs", "TASK-KEEP-1", "exit"))), true);
      await next.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-KEEP-1"), "Status"), "completed");
      assert.equal(fs.readFileSync(count, "utf8"), "1");
      const runs = await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-KEEP-1");
      assert.equal(runs.length, 1);
      assert.equal(f1(runs[0], "Outcome"), "succeeded");
    } finally {
      reap(dir, kernels);
    }
  });
});

test("进程在守护缺席时已经退出且退出码文件还在，重启后直接收口", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const count = path.join(dir, "count");
      const { mock, kernel } = await setup(dir, {
        command: sleepJson(800, count),
        mode: "json",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-EXIT-1", Context_ID: "CTX-EXIT-1" });
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-EXIT-1"), "Status"), "working");
      kernel.abandonLocalFlight();
      assert.equal(await waitFor(() => fs.existsSync(path.join(dir, "runs", "TASK-EXIT-1", "exit"))), true);
      const next = new Kernel({
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
      kernels.push(next);
      await next.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-EXIT-1"), "Status"), "completed");
      assert.equal(fs.readFileSync(count, "utf8"), "1");
      assert.equal((await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-EXIT-1")).length, 1);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("进程被 SIGKILL 且没有退出码文件时按执行失败计入 Retry_Count", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const count = path.join(dir, "count");
      const { mock, kernel } = await setup(dir, {
        command: sleepJson(30000, count),
        mode: "json",
        context: "direct",
        timeout_sec: 60,
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-KILL-1", Context_ID: "CTX-KILL-1" });
      await kernel.sweepOnce();
      assert.equal(await waitFor(() => fs.existsSync(count)), true);
      const entry = entryOf(dir, "TASK-KILL-1");
      kernel.abandonLocalFlight();
      try { process.kill(-entry.pgid, "SIGKILL"); } catch { /* 组已经退出 */ }
      assert.equal(await waitFor(async () => !(await alive(entry.pid))), true);
      for (const file of [entry.exit_path, `${entry.exit_path}.tmp`]) {
        try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
      }
      const next = new Kernel({
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
      kernels.push(next);
      await next.sweepOnce();
      const task = await taskOf(mock, "TASK-KILL-1");
      assert.equal(f1(task, "Status"), "submitted");
      assert.equal(Number(f1(task, "Retry_Count")), 1);
      assert.equal(fs.readFileSync(count, "utf8"), "1");
      const watermark = JSON.parse(fs.readFileSync(path.join(dir, "retry_state.json"), "utf8"));
      assert.ok(watermark["TASK-KILL-1"].not_before > Date.now());
      const run = (await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-KILL-1"))[0];
      assert.equal(f1(run, "Outcome"), "failed");
    } finally {
      reap(dir, kernels);
    }
  });
});

test("没有账本的遗留 working 任务仍按心跳回收", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const marker = path.join(dir, "ran");
      const { mock, kernel } = await setup(dir, {
        command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
        mode: "json",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      const row = await seedTask(mock, { Task_ID: "TASK-OLD-1", Context_ID: "CTX-OLD-1" });
      await mock.updateRecord(TABLES.tasks, row.record_id, {
        Status: "working",
        Claimed_By: "node-a",
        Heartbeat_At: "2020-01-01T00:00:00+0800",
      });
      await kernel.sweepOnce();
      const task = await taskOf(mock, "TASK-OLD-1");
      assert.equal(f1(task, "Status"), "submitted");
      assert.equal(Number(f1(task, "Retry_Count")), 1);
      assert.equal(String(f1(task, "Claimed_By") ?? ""), "");
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(path.join(dir, "runs", "TASK-OLD-1", "entry.json")), false);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("超时从账本里的启动时间接着算，而不是从重启时重算", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const count = path.join(dir, "count");
      const { mock, kernel } = await setup(dir, {
        command: sleepJson(30000, count),
        mode: "json",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-TIME-1", Context_ID: "CTX-TIME-1" });
      await kernel.sweepOnce();
      assert.equal(await waitFor(() => fs.existsSync(count)), true);
      const entry = entryOf(dir, "TASK-TIME-1");
      assert.equal(await alive(entry.pid), true);
      kernel.abandonLocalFlight();
      entry.started_ms = Date.now() - 31_000;
      fs.writeFileSync(path.join(dir, "runs", "TASK-TIME-1", "entry.json"), JSON.stringify(entry), { mode: 0o600 });
      const next = new Kernel({
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
      kernels.push(next);
      const started = Date.now();
      await next.sweepOnce();
      const gone = await waitFor(async () => !(await alive(entry.pid)), 4000);
      assert.equal(gone, true);
      assert.ok(Date.now() - started < 8000);
      if (f1(await taskOf(mock, "TASK-TIME-1"), "Status") === "working") {
        await next.sweepOnce();
      }
      const task = await taskOf(mock, "TASK-TIME-1");
      assert.equal(f1(task, "Status"), "submitted");
      assert.equal(Number(f1(task, "Retry_Count")), 1);
      assert.equal(fs.readFileSync(count, "utf8"), "1");
    } finally {
      reap(dir, kernels);
    }
  });
});

test("hub 的审批、呈递、陈旧回收和定时扫描不被 direct 命令堵住", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const count = path.join(dir, "count");
      const tables = { ...TABLES, rules: "tbl_rules" };
      fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
        echo: {
          command: sleepJson(4000, count),
          mode: "json",
          context: "direct",
          timeout_sec: 30,
        },
      }), { mode: 0o600 });
      const mock = new MockFeishuBus({ tables });
      const cfg = {
        node: "node-a",
        role: "hub",
        kind: "host",
        zone: "test",
        capPrefix: "test",
        events: false,
        configDir: dir,
        carrierSocket: path.join(dir, "missing.sock"),
        bus: mock,
        tables,
      };
      const approval = new ApprovalService({
        bus: mock,
        ownerOpenId: "ou_owner",
        statePath: path.join(dir, "approval_state.json"),
        log: () => {},
      });
      const present = new PresentService({
        bus: mock,
        nodeName: "node-a",
        role: "hub",
        statePath: path.join(dir, "present_state.json"),
        queuePath: path.join(dir, "present_queue.jsonl"),
        log: () => {},
      });
      const stale = new StaleService({
        bus: mock,
        ownerOpenId: "ou_owner",
        statePath: path.join(dir, "stale_state.json"),
        log: () => {},
      });
      const schedule = new ScheduleService({
        bus: mock,
        tz: "Asia/Shanghai",
        statePath: path.join(dir, "schedule_state.json"),
        log: () => {},
      });
      const runtime = new HubRuntime({ cfg, approval, present, stale, schedule, log: () => {} });
      kernels.push(runtime.kernel);
      await seedTask(mock, { Task_ID: "TASK-HUB-1", Context_ID: "CTX-HUB-1" });
      await seedTask(mock, { Task_ID: "TASK-HUB-2", Context_ID: "CTX-HUB-2" });
      const swept = Date.now();
      await runtime.kernel.sweepOnce();
      assert.ok(Date.now() - swept < 1000);
      assert.equal(f1(await taskOf(mock, "TASK-HUB-1"), "Status"), "working");
      assert.equal(f1(await taskOf(mock, "TASK-HUB-2"), "Status"), "submitted");
      const scanned = Date.now();
      const approved = await approval.scan();
      const presented = await present.scan();
      const staled = await stale.scan();
      const scheduled = await schedule.scan();
      assert.ok(Date.now() - scanned < 1000);
      assert.equal(typeof approved, "number");
      assert.equal(typeof presented, "number");
      assert.equal(typeof staled, "number");
      assert.equal(typeof scheduled, "number");
      const entry = entryOf(dir, "TASK-HUB-1");
      assert.equal(await alive(entry.pid), true);
      assert.equal(f1(await taskOf(mock, "TASK-HUB-1"), "Status"), "working");
    } finally {
      reap(dir, kernels);
    }
  });
});
