// 扫表驱动的心跳有最小间隔。时钟用 mock.timers 的 Date，不睡真实的 90 秒。
// direct 用例会拉起短命的 node -e，结束时杀掉进程组。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { Kernel, HEARTBEAT_MIN_SEC, STALE_MIN } from "../src/kernel.mjs";
import { STALE_MIN as HUB_STALE_MIN, isStaleWorking } from "../src/hub/stale.mjs";
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

function kernelCfg(dir, mock) {
  return {
    node: "node-a",
    role: "node",
    kind: "host",
    zone: "test",
    capPrefix: "test",
    events: false,
    configDir: dir,
    carrierSocket: path.join(dir, "missing.sock"),
    bus: mock,
  };
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
    Created_At: "2026-01-15T09:00:00+0800",
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
    Skill_ID: fields.Skill_ID || "echo",
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

function heartbeatWrites(mock) {
  return mock.journal.filter((entry) => {
    if (entry.op !== "update" || entry.table !== TABLES.tasks) return false;
    const value = [entry.fields?.Heartbeat_At].flat()[0];
    return value != null && String(value) !== "";
  }).length;
}

function writeCommands(dir, commands) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(commands), { mode: 0o600 });
}

test.describe("心跳降频", { concurrency: false }, () => {
  test("inbox 认领后连续扫表不再写心跳", async () => {
    await withTemp(async (dir) => {
      writeCommands(dir, {
        agent: {
          command: nodeCommand("process.exit(0)"),
          mode: "inbox",
          context: "direct",
          timeout_sec: 30,
          inbox_timeout_sec: 86400,
          cap_id: "CAP-test-agent",
          name: "agent",
        },
      });
      const mock = new MockFeishuBus({ tables: TABLES });
      const kernel = new Kernel(kernelCfg(dir, mock));
      await seedTask(mock, {
        Task_ID: "TASK-INBOX-HB",
        Context_ID: "CTX-INBOX-HB",
        Skill_ID: "agent",
        Title: "交给本尊",
      });
      await kernel.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-INBOX-HB"), "Status"), "working");
      const afterClaim = heartbeatWrites(mock);
      assert.ok(afterClaim >= 1);
      for (let i = 0; i < 5; i++) await kernel.sweepOnce();
      assert.equal(heartbeatWrites(mock), afterClaim);
    });
  });

  test("心跳年龄差 1 秒是写与不写的边界", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-06-01T00:00:00.000Z") });
    await withTemp(async (dir) => {
      writeCommands(dir, {
        agent: {
          command: nodeCommand("process.exit(0)"),
          mode: "inbox",
          context: "direct",
          timeout_sec: 30,
          inbox_timeout_sec: 86400,
          cap_id: "CAP-test-agent",
          name: "agent",
        },
      });
      const mock = new MockFeishuBus({ tables: TABLES });
      const kernel = new Kernel(kernelCfg(dir, mock));
      const created = await seedTask(mock, {
        Task_ID: "TASK-INBOX-EDGE",
        Context_ID: "CTX-INBOX-EDGE",
        Skill_ID: "agent",
      });
      await kernel.sweepOnce();
      const claimedAt = f1(await taskOf(mock, "TASK-INBOX-EDGE"), "Heartbeat_At");
      const claimedMs = Date.parse(claimedAt);
      assert.equal(Number.isNaN(claimedMs), false);
      const base = heartbeatWrites(mock);

      t.mock.timers.setTime(claimedMs + (HEARTBEAT_MIN_SEC - 1) * 1000);
      await kernel.sweepOnce();
      assert.equal(heartbeatWrites(mock), base);

      t.mock.timers.setTime(claimedMs + HEARTBEAT_MIN_SEC * 1000);
      await kernel.sweepOnce();
      assert.equal(heartbeatWrites(mock), base + 1);

      await mock.updateRecord(TABLES.tasks, created.record_id, { Heartbeat_At: claimedAt });
      const mid = heartbeatWrites(mock);
      t.mock.timers.setTime(claimedMs + (HEARTBEAT_MIN_SEC + 1) * 1000);
      await kernel.sweepOnce();
      assert.equal(heartbeatWrites(mock), mid + 1);
    });
  });

  test("心跳为空、不可解析或在未来时都要写", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-06-01T00:00:00.000Z") });
    await withTemp(async (dir) => {
      writeCommands(dir, {
        agent: {
          command: nodeCommand("process.exit(0)"),
          mode: "inbox",
          context: "direct",
          timeout_sec: 30,
          inbox_timeout_sec: 86400,
          cap_id: "CAP-test-agent",
          name: "agent",
        },
      });
      const mock = new MockFeishuBus({ tables: TABLES });
      const kernel = new Kernel(kernelCfg(dir, mock));
      const created = await seedTask(mock, {
        Task_ID: "TASK-INBOX-BAD",
        Context_ID: "CTX-INBOX-BAD",
        Skill_ID: "agent",
      });
      await kernel.sweepOnce();
      const future = new Date(Date.now() + 3600_000).toISOString();
      for (const value of ["", "garbage", future]) {
        await mock.updateRecord(TABLES.tasks, created.record_id, { Heartbeat_At: value });
        const before = heartbeatWrites(mock);
        await kernel.sweepOnce();
        assert.equal(heartbeatWrites(mock), before + 1, value || "(empty)");
      }
    });
  });

  test("direct 在途时扫表不续心跳，心跳过期后只补一次", async () => {
    await withTemp(async (dir) => {
      const kernels = [];
      try {
        const count = path.join(dir, "count");
        writeCommands(dir, {
          echo: {
            command: sleepJson(15000, count),
            mode: "json",
            context: "direct",
            timeout_sec: 30,
            cap_id: "CAP-test-echo",
            name: "echo",
          },
        });
        const mock = new MockFeishuBus({ tables: TABLES });
        const kernel = new Kernel(kernelCfg(dir, mock));
        kernels.push(kernel);
        await seedTask(mock, { Task_ID: "TASK-DIRECT-HB", Context_ID: "CTX-DIRECT-HB" });
        await kernel.sweepOnce();
        assert.equal(await waitFor(() => fs.existsSync(count)), true);
        assert.equal(f1(await taskOf(mock, "TASK-DIRECT-HB"), "Status"), "working");
        for (let i = 0; i < 3; i++) await kernel.sweepOnce();
        assert.equal(heartbeatWrites(mock), 1);
        const row = await taskOf(mock, "TASK-DIRECT-HB");
        const stale = new Date(Date.now() - 30 * 60_000).toISOString();
        await mock.updateRecord(TABLES.tasks, row.record_id, { Heartbeat_At: stale });
        const mid = heartbeatWrites(mock);
        await kernel.sweepOnce();
        assert.equal(heartbeatWrites(mock), mid + 1);
        assert.notEqual(f1(await taskOf(mock, "TASK-DIRECT-HB"), "Heartbeat_At"), stale);
      } finally {
        reap(dir, kernels);
      }
    });
  });

  test("touchHeartbeat 新鲜不写、过期才写、写失败只记日志", async () => {
    await withTemp(async (dir) => {
      writeCommands(dir, {});
      const mock = new MockFeishuBus({ tables: TABLES });
      const kernel = new Kernel(kernelCfg(dir, mock));
      const created = await mock.createRecord(TABLES.tasks, {
        Task_ID: "TASK-TOUCH",
        Status: "working",
        Claimed_By: "node-a",
        Heartbeat_At: new Date().toISOString(),
      });
      const fresh = {
        record_id: created.record.record_id,
        fields: { Heartbeat_At: new Date().toISOString() },
      };
      await kernel.touchHeartbeat(fresh);
      assert.equal(heartbeatWrites(mock), 0);

      const stale = {
        record_id: created.record.record_id,
        fields: { Heartbeat_At: new Date(Date.now() - 30 * 60_000).toISOString() },
      };
      await kernel.touchHeartbeat(stale);
      assert.equal(heartbeatWrites(mock), 1);

      mock.failNext({ op: "update", table: TABLES.tasks }, new Error("boom"));
      const logs = [];
      const orig = console.log;
      console.log = (...args) => { logs.push(args.map(String).join(" ")); };
      try {
        await kernel.touchHeartbeat(stale);
      } finally {
        console.log = orig;
      }
      assert.equal(heartbeatWrites(mock), 1);
      assert.match(logs.join("\n"), /heartbeat refresh failed: boom/);
    });
  });

  test("心跳间隔、陈旧阈值和 60 秒定时心跳满足不等式", () => {
    // 90＋900＝990，距 20 分钟还剩 210 秒。扫表耗时没有硬上界，所以必须严格小于。
    assert.ok(HEARTBEAT_MIN_SEC + 900 < STALE_MIN * 60);
    assert.equal(STALE_MIN * 60 - HEARTBEAT_MIN_SEC - 900, 210);
    assert.ok(HEARTBEAT_MIN_SEC + 900 + 180 < STALE_MIN * 60);
    assert.equal(STALE_MIN, HUB_STALE_MIN);
    assert.ok(HEARTBEAT_MIN_SEC >= 60);
  });

  test("最不利时序下心跳年龄不超过 hub 的陈旧告警", async (t) => {
    // 首次扫表比最小间隔早 1 秒，这一拍不写心跳。时刻从 HEARTBEAT_MIN_SEC 推出，
    // 间隔改成 91 到 119 之间时，跳过点跟着变，不会被写死的 119 秒放过。
    // 下一轮隔满 900 秒对账，扫表再耗 180 秒，hub 比节点落笔早 2 秒。
    // 行上年龄是 (HEARTBEAT_MIN_SEC−1)＋900＋180＋2。
    const skipSec = HEARTBEAT_MIN_SEC - 1;
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-06-01T00:00:00.000Z") });
    await withTemp(async (dir) => {
      writeCommands(dir, {
        agent: {
          command: nodeCommand("process.exit(0)"),
          mode: "inbox",
          context: "direct",
          timeout_sec: 30,
          inbox_timeout_sec: 86400,
          cap_id: "CAP-test-agent",
          name: "agent",
        },
      });
      const mock = new MockFeishuBus({ tables: TABLES });
      const kernel = new Kernel(kernelCfg(dir, mock));
      await seedTask(mock, {
        Task_ID: "TASK-WORST-HB",
        Context_ID: "CTX-WORST-HB",
        Skill_ID: "agent",
      });
      await kernel.sweepOnce();
      const claimedAt = f1(await taskOf(mock, "TASK-WORST-HB"), "Heartbeat_At");
      const claimedMs = Date.parse(claimedAt);
      assert.equal(Number.isNaN(claimedMs), false);

      const expectFresh = async (label) => {
        const row = await taskOf(mock, "TASK-WORST-HB");
        assert.equal(f1(row, "Status"), "working", label);
        assert.equal(isStaleWorking(f1(row, "Heartbeat_At"), new Date()), false, label);
      };
      await expectFresh("认领后");

      const beforeSkip = heartbeatWrites(mock);
      t.mock.timers.setTime(claimedMs + skipSec * 1000);
      await expectFresh(`距心跳 ${skipSec} 秒、扫表前`);
      await kernel.sweepOnce();
      assert.equal(heartbeatWrites(mock), beforeSkip, "比最小间隔早 1 秒不写心跳");
      await expectFresh(`距心跳 ${skipSec} 秒扫表后`);

      t.mock.timers.setTime(Date.now() + 900_000);
      await expectFresh("再隔 900 秒对账、尚未写心跳");
      t.mock.timers.setTime(Date.now() + 180_000);
      await expectFresh("扫表耗时 180 秒、尚未写心跳");
      t.mock.timers.setTime(Date.now() + 2_000);
      await expectFresh("hub 比节点写入早 2 秒");

      await kernel.sweepOnce();
      await expectFresh("节点扫表写完心跳后仍未回收");
    });
  });
});
