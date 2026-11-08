// direct 槽只有一个。inbox 任务不占这个槽，扫表仍要给它续心跳，不能把在途 direct 当成回收 inbox 的理由。
// 会拉起短命的 node -e。用例结束时杀掉进程组，状态只放临时目录。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { readInbox } from "../src/inbox.mjs";
import { Kernel } from "../src/kernel.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

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

async function seedTask(mock, fields) {
  const taskId = fields.Task_ID;
  const msgId = `MSG-${taskId.replace("TASK-", "")}-01`;
  await mock.createRecord(TABLES.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: fields.Context_ID,
    From_Node: "hub",
    To_Node: "node-a",
    Role: "user",
    Kind: "instruction",
    Created_At: "2026-01-15T09:00:00+0800",
  });
  await mock.createRecord(TABLES.parts, {
    Part_ID: `${msgId}-P1`,
    Parent_ID: msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: fields.Title || taskId,
  });
  const created = await mock.createRecord(TABLES.tasks, {
    Source: "hub",
    Target_Node: "node-a",
    Status: "submitted",
    Hop_Count: 0,
    Retry_Count: 0,
    Claimed_By: "",
    Idempotency_Key: `key-${taskId}`,
    ...fields,
  });
  return created.record;
}

function taskOf(mock, taskId) {
  return mock.findRecords(TABLES.tasks, "Task_ID", taskId).then((rows) => rows[0]);
}

// 红线：direct 命令还在睡的时候，同节点 inbox 的旧心跳要被续上，不能送回 submitted。
test("direct 在途时 inbox 心跳仍刷新且不被回收", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const count = path.join(dir, "count");
      fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
        echo: {
          command: sleepJson(3000, count),
          mode: "json",
          context: "direct",
          timeout_sec: 30,
          cap_id: "CAP-test-echo",
          name: "echo",
        },
        agent: {
          command: nodeCommand("process.exit(0)"),
          mode: "inbox",
          context: "direct",
          timeout_sec: 30,
          inbox_timeout_sec: 86400,
          cap_id: "CAP-test-agent",
          name: "agent",
        },
      }), { mode: 0o600 });
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
      kernels.push(kernel);
      await seedTask(mock, {
        Task_ID: "TASK-INBOX-1",
        Context_ID: "CTX-INBOX-1",
        Skill_ID: "agent",
        Title: "交给本尊",
      });
      await kernel.sweepOnce();
      const queued = await taskOf(mock, "TASK-INBOX-1");
      assert.equal(f1(queued, "Status"), "working");
      assert.equal(f1(queued, "Claimed_By"), "node-a");
      assert.equal(readInbox(dir).find((item) => item.task_id === "TASK-INBOX-1")?.status, "pending");

      const stale = new Date(Date.now() - 30 * 60_000).toISOString();
      await mock.updateRecord(TABLES.tasks, queued.record_id, { Heartbeat_At: stale });
      await seedTask(mock, {
        Task_ID: "TASK-DIRECT-1",
        Context_ID: "CTX-DIRECT-1",
        Skill_ID: "echo",
        Title: "睡一会儿",
      });
      await seedTask(mock, {
        Task_ID: "TASK-DIRECT-2",
        Context_ID: "CTX-DIRECT-2",
        Skill_ID: "echo",
        Title: "不该同时跑",
      });
      const started = Date.now();
      await kernel.sweepOnce();
      assert.ok(Date.now() - started < 1000, "认领 direct 的扫表不应等命令结束");
      assert.equal(f1(await taskOf(mock, "TASK-DIRECT-1"), "Status"), "working");
      assert.equal(f1(await taskOf(mock, "TASK-DIRECT-2"), "Status"), "submitted");
      assert.equal(await waitFor(() => fs.existsSync(count)), true);
      assert.equal(fs.readFileSync(count, "utf8"), "1");

      await mock.updateRecord(TABLES.tasks, queued.record_id, { Heartbeat_At: stale });
      const during = Date.now();
      await kernel.sweepOnce();
      assert.ok(Date.now() - during < 1000, "在途 direct 不应堵住 inbox 心跳扫表");
      const inbox = await taskOf(mock, "TASK-INBOX-1");
      assert.equal(f1(inbox, "Status"), "working");
      assert.equal(f1(inbox, "Claimed_By"), "node-a");
      assert.equal(Number(f1(inbox, "Retry_Count")) || 0, 0);
      assert.notEqual(f1(inbox, "Heartbeat_At"), stale);
      const refreshed = Date.parse(f1(inbox, "Heartbeat_At"));
      assert.equal(Number.isNaN(refreshed), false);
      assert.ok(Date.now() - refreshed < 60_000);
      assert.equal(readInbox(dir).find((item) => item.task_id === "TASK-INBOX-1")?.status, "pending");
      assert.equal(f1(await taskOf(mock, "TASK-DIRECT-1"), "Status"), "working");
      assert.equal(f1(await taskOf(mock, "TASK-DIRECT-2"), "Status"), "submitted");
      assert.equal(fs.readFileSync(count, "utf8"), "1");
    } finally {
      reap(dir, kernels);
    }
  });
});
