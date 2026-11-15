// L1 执行式验收（verify）与 L2 清单在内核、账本、outbox、Metadata、doctor 的端到端测试。
// 总线是内存 mock；所有子进程组均在 finally 里清理。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { controlKeysIn, normalizeCommands } from "../src/config.mjs";
import { describeCommands, doctor } from "../src/doctor.mjs";
import { Kernel } from "../src/kernel.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

function shellSingleQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

function nodeCommand(script) {
  return `${JSON.stringify(process.execPath)} -e ${shellSingleQuote(script)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await sleep(30);
  }
  return false;
}

function entryOf(dir, taskId) {
  return JSON.parse(fs.readFileSync(path.join(dir, "runs", taskId, "entry.json"), "utf8"));
}

function reap(dir, kernels) {
  for (const kernel of kernels) {
    try { kernel?.abandonLocalFlight?.(); } catch { /* 已经释放 */ }
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
        for (const pgid of [Number(entry.pgid || entry.pid), Number(entry.verify?.pgid || entry.verify?.pid)]) {
          if (pgid > 0) pids.add(pgid);
        }
      } catch { /* 没有账本 */ }
    }
  }
  for (const pid of pids) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* 组已经没了 */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* 进程已经没了 */ }
  }
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

function setup(dir, commands) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(commands), { mode: 0o600 });
  const mock = new MockFeishuBus({ tables: TABLES });
  const kernel = new Kernel({
    node: "node-a",
    role: "node",
    kind: "host",
    zone: "test",
    capPrefix: "test",
    events: false,
    configDir: dir,
    bus: mock,
  });
  return { mock, kernel };
}

async function seedTask(mock, fields, { text = "跑一下", params = { n: 1 }, from = "hub", skill = "echo" } = {}) {
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
  if (params !== undefined) {
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
    Skill_ID: skill,
    Status: "submitted",
    Hop_Count: 0,
    Retry_Count: 0,
    Idempotency_Key: `key-${taskId}`,
    ...fields,
  });
  return { task: created.record, msgId };
}

async function taskOf(mock, taskId) {
  return (await mock.findRecords(TABLES.tasks, "Task_ID", taskId))[0];
}

async function captureAsync(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const value = await fn();
    return { value, text: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("verify 退出 0 → completed 且 result 带 Seq 2 DataPart、Metadata.acceptance.overall=pass，并正确传 stdin 与环境变量", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const workCwd = path.join(dir, "workdir");
      fs.mkdirSync(workCwd, { recursive: true });
      const probePath = path.join(dir, "verify-probe.json");
      const artPath = path.join(dir, "report.txt");
      fs.writeFileSync(artPath, "artifact body");

      const command = nodeCommand(`
        console.log(JSON.stringify({
          summary: "work done",
          artifact: ${JSON.stringify(artPath)},
          artifact_name: "report.txt",
          usage: { input: 10, output: 5, cached: 0, cost: 0.01 }
        }));
      `);
      const verify = nodeCommand(`
        const fs = require("node:fs");
        const stdin = fs.readFileSync(0, "utf8");
        const mainStdout = fs.readFileSync(process.env.LAH_MAIN_STDOUT, "utf8");
        fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({
          stdin: JSON.parse(stdin),
          cwd: fs.realpathSync(process.cwd()),
          env: {
            LAH_TASK_ID: process.env.LAH_TASK_ID,
            LAH_ARTIFACT: process.env.LAH_ARTIFACT,
            LAH_RUN_DIR: process.env.LAH_RUN_DIR,
            LAH_MAIN_STDOUT: process.env.LAH_MAIN_STDOUT,
          },
          mainStdout,
        }));
        console.log("verify ok");
      `);

      const { mock, kernel } = setup(dir, {
        echo: { command, verify, mode: "json", context: "direct", cwd: workCwd, timeout_sec: 30, verify_timeout_sec: 30 },
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-V-PASS", Context_ID: "CTX-V-PASS" });

      await kernel.run({ once: true });

      const task = await taskOf(mock, "TASK-V-PASS");
      assert.equal(f1(task, "Status"), "completed");
      assert.equal(Number(f1(task, "Retry_Count")), 0);

      const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
      assert.equal(probe.cwd, fs.realpathSync(workCwd));
      assert.deepEqual(probe.stdin, {
        task_id: "TASK-V-PASS",
        summary: "work done",
        artifact: artPath,
        artifact_name: "report.txt",
        checks: {},
      });
      assert.equal(probe.env.LAH_TASK_ID, "TASK-V-PASS");
      assert.equal(probe.env.LAH_ARTIFACT, artPath);
      assert.equal(probe.env.LAH_RUN_DIR, path.join(dir, "runs", "TASK-V-PASS"));
      assert.equal(probe.env.LAH_MAIN_STDOUT, path.join(dir, "runs", "TASK-V-PASS", "stdout.txt"));
      assert.match(probe.mainStdout, /work done/);

      const resultMsg = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-V-PASS"))
        .find((m) => f1(m, "Kind") === "result");
      assert.ok(resultMsg);
      const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(resultMsg, "Msg_ID"));
      const textPart = parts.find((p) => f1(p, "Kind") === "text");
      const dataPart = parts.find((p) => f1(p, "Kind") === "data");
      assert.equal(f1(textPart, "Seq"), 1);
      assert.equal(f1(textPart, "Text"), "work done");
      assert.equal(f1(dataPart, "Seq"), 2);
      const acc = JSON.parse(f1(dataPart, "Data")).acceptance;
      assert.equal(acc.version, 1);
      assert.equal(acc.overall, "pass");
      assert.equal(acc.verify.verdict, "pass");
      assert.equal(acc.verify.exit_code, 0);
      assert.equal(acc.verify.evidence, "captured");
      assert.deepEqual(acc.checks, []);

      const meta = JSON.parse(f1(task, "Metadata"));
      assert.equal(meta.acceptance.overall, "pass");
      assert.equal(meta.acceptance.verify.verdict, "pass");
      assert.equal(meta.acceptance.msg_id, f1(resultMsg, "Msg_ID"));
      assert.equal(meta.usage.runs, 1);

      const art = (await mock.findRecords(TABLES.artifacts, "Task_ID", "TASK-V-PASS"))[0];
      assert.equal(f1(art, "Is_Final"), "Yes");
      assert.equal(fs.existsSync(path.join(dir, "runs", "TASK-V-PASS", "entry.json")), false);
      assert.equal(fs.existsSync(path.join(dir, "runs", "TASK-V-PASS", "verify-exit")), false);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("verify 非 0 → failed，notice 首行「验收未通过」、含输出尾部，Artifacts Is_Final=No，不计 Retry_Count、清 retry 水位与 session，主命令只跑一次", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const countPath = path.join(dir, "main-count");
      const command = nodeCommand(`
        const fs = require("node:fs");
        const p = ${JSON.stringify(countPath)};
        const n = fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) || 0 : 0;
        fs.writeFileSync(p, String(n + 1));
        console.log(JSON.stringify({
          summary: "agent did work",
          artifact: "/tmp/build.tar.gz",
          artifact_name: "build.tar.gz",
          session: "sess-vfail"
        }));
      `);
      const verify = nodeCommand(`
        console.log("CHECK_OUT_TAIL");
        console.error("CHECK_ERR_BOOM");
        process.exit(2);
      `);
      fs.writeFileSync(path.join(dir, "retry_state.json"), JSON.stringify({
        "TASK-V-FAIL": { not_before: Date.now() - 1000 },
      }), { mode: 0o600 });

      const { mock, kernel } = setup(dir, {
        echo: { command, verify, mode: "json", context: "direct", timeout_sec: 30 },
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-V-FAIL", Context_ID: "CTX-V-FAIL" });

      await kernel.run({ once: true });

      const task = await taskOf(mock, "TASK-V-FAIL");
      assert.equal(f1(task, "Status"), "failed");
      assert.equal(Number(f1(task, "Retry_Count")), 0);
      assert.equal(fs.readFileSync(countPath, "utf8"), "1");

      const run = (await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-V-FAIL"))[0];
      assert.equal(f1(run, "Outcome"), "failed");
      assert.match(f1(run, "Error_Log"), /^验收未通过：verify fail 退出码 2/);

      const art = (await mock.findRecords(TABLES.artifacts, "Task_ID", "TASK-V-FAIL"))[0];
      assert.equal(f1(art, "Is_Final"), "No");

      const notice = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-V-FAIL"))
        .find((m) => f1(m, "Kind") === "notice");
      assert.ok(notice);
      const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(notice, "Msg_ID"));
      const text = f1(parts.find((p) => f1(p, "Kind") === "text"), "Text");
      assert.match(text.split("\n")[0], /^验收未通过/);
      assert.match(text, /退出码 2/);
      assert.match(text, /agent did work/);
      assert.match(text, /CHECK_OUT_TAIL/);
      assert.match(text, /CHECK_ERR_BOOM/);

      const acc = JSON.parse(f1(parts.find((p) => f1(p, "Kind") === "data"), "Data")).acceptance;
      assert.equal(acc.overall, "fail");
      assert.equal(acc.verify.verdict, "fail");
      assert.equal(acc.verify.exit_code, 2);

      const meta = JSON.parse(f1(task, "Metadata"));
      assert.equal(meta.acceptance.overall, "fail");
      assert.equal(meta.acceptance.msg_id, f1(notice, "Msg_ID"));

      assert.equal(fs.existsSync(path.join(dir, "runs", "TASK-V-FAIL", "session.json")), false);
      const retryState = JSON.parse(fs.readFileSync(path.join(dir, "retry_state.json"), "utf8"));
      assert.equal(retryState["TASK-V-FAIL"], undefined);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("verify 超时（verify_timeout_sec=1，sleep 5）→ failed 且判 timeout，主循环不卡死", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const command = nodeCommand(`console.log(JSON.stringify({ summary: "ok" }));`);
      const verify = nodeCommand(`setTimeout(() => process.exit(0), 5000);`);
      const { mock, kernel } = setup(dir, {
        echo: { command, verify, mode: "json", context: "direct", timeout_sec: 30, verify_timeout_sec: 1 },
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-V-TMO", Context_ID: "CTX-V-TMO" });

      const t0 = Date.now();
      await kernel.run({ once: true });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 4500, `verify timeout took too long: ${elapsed}ms`);

      const task = await taskOf(mock, "TASK-V-TMO");
      assert.equal(f1(task, "Status"), "failed");
      assert.equal(Number(f1(task, "Retry_Count")), 0);

      const run = (await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-V-TMO"))[0];
      assert.equal(f1(run, "Outcome"), "failed");
      assert.match(f1(run, "Error_Log"), /^验收未通过：verify timeout/);

      const notice = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-V-TMO"))
        .find((m) => f1(m, "Kind") === "notice");
      const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(notice, "Msg_ID"));
      const acc = JSON.parse(f1(parts.find((p) => f1(p, "Kind") === "data"), "Data")).acceptance;
      assert.equal(acc.verify.verdict, "timeout");
      assert.equal(acc.overall, "fail");
    } finally {
      reap(dir, kernels);
    }
  });
});

test("verifying 阶段模拟守护崩溃后新内核接管仍在跑的 verify，主命令不重跑", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const mainCount = path.join(dir, "main-count");
      const verifyCount = path.join(dir, "verify-count");
      const command = nodeCommand(`
        const fs = require("node:fs");
        const p = ${JSON.stringify(mainCount)};
        const n = fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) || 0 : 0;
        fs.writeFileSync(p, String(n + 1));
        console.log(JSON.stringify({ summary: "ok" }));
      `);
      const verify = nodeCommand(`
        const fs = require("node:fs");
        const p = ${JSON.stringify(verifyCount)};
        const n = fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) || 0 : 0;
        fs.writeFileSync(p, String(n + 1));
        setTimeout(() => process.exit(0), 1200);
      `);
      const { mock, kernel } = setup(dir, {
        echo: { command, verify, mode: "json", context: "direct", timeout_sec: 30, verify_timeout_sec: 30 },
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-V-CRASH", Context_ID: "CTX-V-CRASH" });

      await kernel.sweepOnce();
      assert.equal(await waitFor(() => fs.existsSync(path.join(dir, "runs", "TASK-V-CRASH", "exit"))), true);
      await kernel.sweepOnce();
      assert.equal(await waitFor(() => fs.existsSync(verifyCount)), true);
      const entry = entryOf(dir, "TASK-V-CRASH");
      assert.equal(entry.state, "verifying");
      assert.equal(await alive(entry.verify.pid), true);

      kernel.abandonLocalFlight();
      const next = new Kernel({
        node: "node-a", role: "node", kind: "host", zone: "test", capPrefix: "test",
        events: false, configDir: dir, bus: mock,
      });
      kernels.push(next);
      await next.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-V-CRASH"), "Status"), "working");
      assert.equal(fs.readFileSync(mainCount, "utf8"), "1");
      assert.equal(fs.readFileSync(verifyCount, "utf8"), "1");

      assert.equal(await waitFor(() => fs.existsSync(path.join(dir, "runs", "TASK-V-CRASH", "verify-exit"))), true);
      await next.sweepOnce();
      assert.equal(f1(await taskOf(mock, "TASK-V-CRASH"), "Status"), "completed");
      assert.equal(fs.readFileSync(mainCount, "utf8"), "1");
      assert.equal(fs.readFileSync(verifyCount, "utf8"), "1");
    } finally {
      reap(dir, kernels);
    }
  });
});

test("verifying 阶段重启后无法确认时重跑 verify，超过 VERIFY_MAX_LAUNCHES 判 error 且主命令不重跑", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const mainCount = path.join(dir, "main-count");
      const verifyCount = path.join(dir, "verify-count");
      const command = nodeCommand(`
        const fs = require("node:fs");
        const p = ${JSON.stringify(mainCount)};
        const n = fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) || 0 : 0;
        fs.writeFileSync(p, String(n + 1));
        console.log(JSON.stringify({ summary: "ok" }));
      `);
      const verify = nodeCommand(`
        const fs = require("node:fs");
        const p = ${JSON.stringify(verifyCount)};
        const n = fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) || 0 : 0;
        fs.writeFileSync(p, String(n + 1));
        setTimeout(() => process.exit(0), 1500);
      `);
      const { mock, kernel } = setup(dir, {
        echo: { command, verify, mode: "json", context: "direct", timeout_sec: 30, verify_timeout_sec: 30 },
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-V-RELAUNCH", Context_ID: "CTX-V-RELAUNCH" });

      await kernel.sweepOnce();
      assert.equal(await waitFor(() => fs.existsSync(path.join(dir, "runs", "TASK-V-RELAUNCH", "exit"))), true);
      await kernel.sweepOnce();
      assert.equal(await waitFor(() => fs.existsSync(verifyCount)), true);
      const entry = entryOf(dir, "TASK-V-RELAUNCH");
      kernel.abandonLocalFlight();
      try { process.kill(-entry.verify.pgid, "SIGKILL"); } catch { /* 已退出 */ }
      assert.equal(await waitFor(async () => !(await alive(entry.verify.pid))), true);
      try { fs.unlinkSync(entry.verify.exit_path); } catch { /* 没有 */ }

      const second = new Kernel({
        node: "node-a", role: "node", kind: "host", zone: "test", capPrefix: "test",
        events: false, configDir: dir, bus: mock,
      });
      kernels.push(second);
      await second.sweepOnce();
      assert.equal(fs.readFileSync(mainCount, "utf8"), "1");
      assert.equal(await waitFor(() => fs.readFileSync(verifyCount, "utf8") === "2"), true);
      const afterSecond = entryOf(dir, "TASK-V-RELAUNCH");
      assert.equal(afterSecond.verify.launches, 2);

      // 模拟 launches 已达上限 3 且再次死掉无 exit：新内核必须直接判 error，不再拉起第 4 次。
      second.abandonLocalFlight();
      try { process.kill(-afterSecond.verify.pgid, "SIGKILL"); } catch { /* 已退出 */ }
      assert.equal(await waitFor(async () => !(await alive(afterSecond.verify.pid))), true);
      try { fs.unlinkSync(afterSecond.verify.exit_path); } catch { /* 没有 */ }
      afterSecond.verify.launches = 3;
      fs.writeFileSync(path.join(dir, "runs", "TASK-V-RELAUNCH", "entry.json"), JSON.stringify(afterSecond), { mode: 0o600 });

      const third = new Kernel({
        node: "node-a", role: "node", kind: "host", zone: "test", capPrefix: "test",
        events: false, configDir: dir, bus: mock,
      });
      kernels.push(third);
      await third.sweepOnce();
      const task = await taskOf(mock, "TASK-V-RELAUNCH");
      assert.equal(f1(task, "Status"), "failed");
      assert.equal(fs.readFileSync(mainCount, "utf8"), "1");
      assert.equal(fs.readFileSync(verifyCount, "utf8"), "2");
      const notice = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-V-RELAUNCH"))
        .find((m) => f1(m, "Kind") === "notice");
      const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(notice, "Msg_ID"));
      const acc = JSON.parse(f1(parts.find((p) => f1(p, "Kind") === "data"), "Data")).acceptance;
      assert.equal(acc.verify.verdict, "error");
      assert.equal(acc.overall, "fail");
    } finally {
      reap(dir, kernels);
    }
  });
});

test("未配 verify 且无清单的回归：result 不带 Seq 2 acceptance DataPart，Metadata 不写 acceptance", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const command = nodeCommand(`console.log(JSON.stringify({ summary: "plain ok" }));`);
      const { mock, kernel } = setup(dir, {
        echo: { command, mode: "json", context: "direct", timeout_sec: 30 },
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-PLAIN", Context_ID: "CTX-PLAIN" });

      await kernel.run({ once: true });
      const task = await taskOf(mock, "TASK-PLAIN");
      assert.equal(f1(task, "Status"), "completed");
      assert.equal(JSON.parse(f1(task, "Metadata")).acceptance, undefined);
      const resultMsg = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-PLAIN"))
        .find((m) => f1(m, "Kind") === "result");
      const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(resultMsg, "Msg_ID"));
      assert.equal(parts.length, 1);
      assert.equal(f1(parts[0], "Kind"), "text");
    } finally {
      reap(dir, kernels);
    }
  });
});

test("安全与预检拒收：params 带 verify/verify_timeout_sec、inbox+verify、非法清单均 rejected + notice", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      assert.deepEqual(controlKeysIn({ verify: "true", verify_timeout_sec: 10, timeout_sec: 30 }).sort(), ["verify", "verify_timeout_sec"]);
      const marker = path.join(dir, "ran");
      const command = nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1")`);
      const { mock, kernel } = setup(dir, {
        echo: { command, mode: "json", context: "direct", timeout_sec: 30 },
        agent: { mode: "inbox", verify: "echo bad" },
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-BAD-PARAM", Context_ID: "CTX-1" }, { params: { verify: "echo pwn" } });
      await seedTask(mock, { Task_ID: "TASK-BAD-TMO", Context_ID: "CTX-2" }, { params: { verify_timeout_sec: 5 } });
      await seedTask(mock, { Task_ID: "TASK-INBOX-V", Context_ID: "CTX-3" }, { skill: "agent", params: {} });
      await seedTask(mock, { Task_ID: "TASK-BAD-CRIT", Context_ID: "CTX-4" }, { params: { acceptance: { criteria: [] } } });

      await kernel.run({ once: true });

      assert.equal(fs.existsSync(marker), false);
      for (const id of ["TASK-BAD-PARAM", "TASK-BAD-TMO", "TASK-INBOX-V", "TASK-BAD-CRIT"]) {
        assert.equal(f1(await taskOf(mock, id), "Status"), "rejected");
        const notice = (await mock.findRecords(TABLES.messages, "Task_ID", id)).find((m) => f1(m, "Kind") === "notice");
        assert.ok(notice, `${id} should have notice`);
      }
      const critNotice = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-BAD-CRIT"))
        .find((m) => f1(m, "Kind") === "notice");
      const critPart = (await mock.findRecords(TABLES.parts, "Parent_ID", f1(critNotice, "Msg_ID")))[0];
      assert.match(f1(critPart, "Text"), /acceptance\.criteria/);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("带清单 + json checks（及 agent CHECK 行与 buildPrompt）逐条判定正确", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const jsonCmd = nodeCommand(`
        console.log(JSON.stringify({
          summary: "checked json",
          checks: {
            c1: { verdict: "pass", evidence: "ok-1" },
            c2: "pass",
            c3: "blocked",
            extra: "pass"
          }
        }));
      `);
      const agentCmd = nodeCommand(`
        console.log("agent checked");
        console.log("CHECK: c1 pass | 见日志");
        console.log("CHECK: c2 pass | 证据2");
      `);
      const { mock, kernel } = setup(dir, {
        echo: { command: jsonCmd, mode: "json", context: "direct", timeout_sec: 30 },
        ag: { command: agentCmd, mode: "agent", context: "direct", timeout_sec: 30 },
      });
      kernels.push(kernel);

      const inputWith = path.join(dir, "with.json");
      const inputWithout = path.join(dir, "without.json");
      fs.writeFileSync(inputWith, JSON.stringify({
        params: { acceptance: { criteria: [{ id: "c1", text: "第一条" }] } },
      }));
      fs.writeFileSync(inputWithout, JSON.stringify({ params: { n: 1 } }));
      assert.match(kernel.buildPrompt(inputWith), /CHECK: <id> <pass\|fail\|blocked> \| <证据>/);
      assert.doesNotMatch(kernel.buildPrompt(inputWithout), /CHECK: <id>/);

      const criteria = [
        { id: "c1", text: "证据齐全", evidence_required: true },
        { id: "c2", text: "需要证据", evidence_required: true },
        { id: "c3", text: "受阻项" },
        { id: "c4", text: "漏报项" },
      ];
      const seededJson = await seedTask(mock, { Task_ID: "TASK-L2-JSON", Context_ID: "CTX-L2-1" }, {
        params: { acceptance: { criteria } },
      });
      await seedTask(mock, { Task_ID: "TASK-L2-AG", Context_ID: "CTX-L2-2" }, {
        skill: "ag",
        params: { acceptance: { criteria: criteria.slice(0, 2) } },
      });

      await kernel.run({ once: true });

      const jsonTask = await taskOf(mock, "TASK-L2-JSON");
      assert.equal(f1(jsonTask, "Status"), "completed");
      const jsonResult = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-L2-JSON"))
        .find((m) => f1(m, "Kind") === "result");
      const jsonParts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(jsonResult, "Msg_ID"));
      const jsonAcc = JSON.parse(f1(jsonParts.find((p) => f1(p, "Kind") === "data"), "Data")).acceptance;
      assert.equal(jsonAcc.verify, null);
      assert.equal(jsonAcc.criteria_ref, seededJson.msgId);
      assert.equal(jsonAcc.overall, "uncertain");
      assert.deepEqual(jsonAcc.checks, [
        { id: "c1", verdict: "pass", evidence: "ok-1", source: "self" },
        { id: "c2", verdict: "uncertain", evidence: "", source: "self" },
        { id: "c3", verdict: "blocked", evidence: "", source: "self" },
        { id: "c4", verdict: "missing", evidence: "", source: "self" },
      ]);

      const agTask = await taskOf(mock, "TASK-L2-AG");
      assert.equal(f1(agTask, "Status"), "completed");
      const agResult = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-L2-AG"))
        .find((m) => f1(m, "Kind") === "result");
      const agParts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(agResult, "Msg_ID"));
      const agAcc = JSON.parse(f1(agParts.find((p) => f1(p, "Kind") === "data"), "Data")).acceptance;
      assert.equal(agAcc.overall, "pass");
      assert.deepEqual(agAcc.checks.map((c) => c.verdict), ["pass", "pass"]);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("config 继承与 doctor 校验 verify / verify_timeout_sec / inbox+verify 及能力展示", async () => {
  await withTemp(async (dir) => {
    const layered = {
      workers: {
        codex: { command: "echo {prompt}", mode: "agent", verify: "echo worker-verify", verify_timeout_sec: 45 },
      },
      inheritSkill: { workers: ["codex"] },
      overrideSkill: { workers: ["codex"], verify: "echo skill-verify", verify_timeout_sec: 90 },
      selfSkill: { command: "echo self", mode: "json", verify: "echo self-verify" },
    };
    const flat = normalizeCommands(layered);
    assert.equal(flat["codex/inheritSkill"].verify, "echo worker-verify");
    assert.equal(flat["codex/inheritSkill"].verify_timeout_sec, 45);
    assert.equal(flat["codex/overrideSkill"].verify, "echo skill-verify");
    assert.equal(flat["codex/overrideSkill"].verify_timeout_sec, 90);
    assert.equal(flat.selfSkill.verify, "echo self-verify");

    const { layout } = describeCommands(layered, flat, "test", "host");
    assert.equal(layout.some((line) => line.includes("已配 verify")), true);

    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ role: "node", node: "node-a" }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      badEmpty: { command: "echo 1", mode: "json", verify: "   " },
      badTmo: { command: "echo 2", mode: "json", verify: "echo ok", verify_timeout_sec: 0 },
      badInbox: { mode: "inbox", verify: "echo nope" },
    }), { mode: 0o600 });
    const { text } = await captureAsync(() => doctor(dir, dir));
    assert.match(text, /✗ 能力 badEmpty：verify 必须是非空字符串/);
    assert.match(text, /✗ 能力 badTmo：verify_timeout_sec=0 非法/);
    assert.match(text, /✗ 能力 badInbox：mode=inbox 不支持执行式验收（verify）/);
  });
});

test("老 outbox 缺失 tokens.partData 时自动补齐并落 Seq 2 DataPart", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, { echo: { command: "echo 1", mode: "json" } });
    const { task, msgId } = await seedTask(mock, { Task_ID: "TASK-OLD-BOX", Context_ID: "CTX-OLD-BOX" });
    await mock.updateRecord(TABLES.tasks, task.record_id, { Status: "working", Claimed_By: "node-a" });
    fs.mkdirSync(path.join(dir, "outbox"), { recursive: true });
    fs.writeFileSync(path.join(dir, "outbox", "TASK-OLD-BOX.json"), JSON.stringify({
      taskId: "TASK-OLD-BOX",
      outcome: "succeeded",
      res: { summary: "legacy ok" },
      raw: "",
      error: "",
      started: "2026-01-15T09:00:00+0800",
      planned: false,
      artId: "",
      runId: "",
      msgId: "",
      usage: null,
      usage_noted: false,
      later: null,
      later_noted: false,
      acceptance: {
        version: 1,
        verify: { verdict: "pass", exit_code: 0, duration_ms: 5, evidence: "captured" },
        criteria_ref: msgId,
        checks: [],
        overall: "pass",
      },
      tokens: {
        artifact: "t-a", artifactPart: "t-ap", run: "t-r", message: "t-m", partText: "t-pt",
      },
    }), { mode: 0o600 });

    await kernel.flushOutbox();
    const settled = await taskOf(mock, "TASK-OLD-BOX");
    assert.equal(f1(settled, "Status"), "completed");
    const resultMsg = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-OLD-BOX"))
      .find((m) => f1(m, "Kind") === "result");
    const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(resultMsg, "Msg_ID"));
    const dataPart = parts.find((p) => f1(p, "Kind") === "data");
    assert.ok(dataPart);
    assert.equal(f1(dataPart, "Seq"), 2);
    assert.equal(JSON.parse(f1(dataPart, "Data")).acceptance.verify.verdict, "pass");
  });
});
