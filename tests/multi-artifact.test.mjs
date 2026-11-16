// 一次回执多个产物：编号在 planned 之前冻住，旧 outbox 不重新展开，verify 仍把第一条放在 LAH_ARTIFACT。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { verifyChannels } from "../src/direct-ledger.mjs";
import { Kernel } from "../src/kernel.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

function shellSingleQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

function nodeCommand(script) {
  return `${JSON.stringify(process.execPath)} -e ${shellSingleQuote(script)}`;
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

async function seedTask(mock, fields, { text = "跑一下", skill = "echo" } = {}) {
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
    Text: text,
  });
  const created = await mock.createRecord(TABLES.tasks, {
    Title: text,
    Source: "hub",
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

function reap(dir, kernels) {
  for (const kernel of kernels) {
    try { kernel?.abandonLocalFlight?.(); } catch { /* 已经释放 */ }
  }
  const marker = path.join(dir, "runs");
  let out = "";
  try {
    out = spawnSync("ps", ["-ax", "-o", "pid=", "-o", "command="], { encoding: "utf8" }).stdout || "";
  } catch { /* 没有 ps */ }
  const pids = new Set();
  for (const line of String(out).split("\n")) {
    if (!line.includes(marker)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid > 0) pids.add(pid);
  }
  for (const pid of pids) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* 组已经没了 */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* 进程已经没了 */ }
  }
}

async function artifactRows(mock, taskId) {
  const rows = await mock.findRecords(TABLES.artifacts, "Task_ID", taskId);
  return rows.sort((a, b) => String(f1(a, "Artifact_ID")).localeCompare(String(f1(b, "Artifact_ID"))));
}

test("verifyChannels：标量合成一条，数组优先，LAH_ARTIFACT 只保留第一条", () => {
  const one = verifyChannels({
    summary: "s",
    artifact: "/a",
    artifact_name: "n",
    checks: { c1: { verdict: "pass" } },
  }, "TASK-1");
  assert.equal(one.LAH_ARTIFACT, "/a");
  assert.equal(one.LAH_ARTIFACTS, JSON.stringify(["/a"]));
  assert.deepEqual(one.stdin.artifacts, [{ uri: "/a", name: "n" }]);

  const many = verifyChannels({
    summary: "s",
    artifact: "/old",
    artifacts: [{ uri: "/a", name: "n" }, { uri: "/b" }],
  }, "TASK-2");
  assert.equal(many.stdin.artifact, "/a");
  assert.equal(many.stdin.artifact_name, "n");
  assert.deepEqual(many.stdin.artifacts, [{ uri: "/a", name: "n" }, { uri: "/b" }]);
  assert.equal(many.LAH_ARTIFACT, "/a");
  assert.equal(many.LAH_ARTIFACTS, JSON.stringify(["/a", "/b"]));

  const none = verifyChannels({ artifact: "/old", artifacts: [] }, "TASK-3");
  assert.equal(none.LAH_ARTIFACT, "");
  assert.deepEqual(none.stdin.artifacts, []);
  assert.equal(none.LAH_ARTIFACTS, "[]");
});

test("两个产物各占一行 Artifact 与一块 FilePart，Artifact_Ref 是 -A1；单产物 Name 仍是 Skill_ID", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const command = nodeCommand(`
        console.log("两份都交");
        console.log("ARTIFACT: /tmp/build/iCTRL.ipa");
        console.log("ARTIFACT_NAME: iCTRL.ipa");
        console.log("ARTIFACT: /tmp/build/runner.ipa");
        console.log("ARTIFACT_NAME: iCTRL.ipa");
      `);
      const { mock, kernel } = setup(dir, {
        echo: { command, mode: "agent", context: "direct", timeout_sec: 30 },
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-MULTI-1", Context_ID: "CTX-MULTI-1" });
      await kernel.run({ once: true });

      const task = (await mock.findRecords(TABLES.tasks, "Task_ID", "TASK-MULTI-1"))[0];
      assert.equal(f1(task, "Status"), "completed");
      const arts = await artifactRows(mock, "TASK-MULTI-1");
      assert.deepEqual(arts.map((row) => f1(row, "Artifact_ID")), ["TASK-MULTI-1-A1", "TASK-MULTI-1-A2"]);
      assert.deepEqual(arts.map((row) => f1(row, "Name")), ["iCTRL.ipa", "iCTRL.ipa"]);
      assert.deepEqual(arts.map((row) => f1(row, "Is_Final")), ["Yes", "Yes"]);
      const result = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-MULTI-1"))
        .find((row) => f1(row, "Kind") === "result");
      assert.equal(f1(result, "Artifact_Ref"), "TASK-MULTI-1-A1");
      for (const row of arts) {
        const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(row, "Artifact_ID"));
        assert.equal(parts.length, 1);
        assert.equal(f1(parts[0], "Parent_Type"), "artifact");
        assert.equal(f1(parts[0], "Seq"), 1);
        assert.equal(f1(parts[0], "Kind"), "file");
      }
      assert.equal(f1((await mock.findRecords(TABLES.parts, "Parent_ID", "TASK-MULTI-1-A1"))[0], "File_URI"), "/tmp/build/iCTRL.ipa");
      assert.equal(f1((await mock.findRecords(TABLES.parts, "Parent_ID", "TASK-MULTI-1-A2"))[0], "File_URI"), "/tmp/build/runner.ipa");
      assert.ok(logs.some((line) => line.includes("同名产物按修订谱系登记：iCTRL.ipa")));

      const solo = nodeCommand(`
        console.log("只有一份");
        console.log("ARTIFACT: /tmp/only.bin");
      `);
      const soloDir = path.join(dir, "solo");
      fs.mkdirSync(soloDir);
      const soloRun = setup(soloDir, {
        echo: { command: solo, mode: "agent", context: "direct", timeout_sec: 30 },
      });
      kernels.push(soloRun.kernel);
      await seedTask(soloRun.mock, { Task_ID: "TASK-SOLO-1", Context_ID: "CTX-SOLO-1" });
      await soloRun.kernel.run({ once: true });
      const soloArts = await artifactRows(soloRun.mock, "TASK-SOLO-1");
      assert.equal(soloArts.length, 1);
      assert.equal(f1(soloArts[0], "Name"), "echo");
      assert.equal(f1(soloArts[0], "Artifact_ID"), "TASK-SOLO-1-A1");
    } finally {
      console.log = orig;
      reap(dir, kernels);
    }
  });
});

test("第二件产物写入失败后续写沿用同一组 ID，不重复插入第一行", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const command = nodeCommand(`
        console.log(JSON.stringify({
          summary: "two",
          artifacts: [
            { uri: "/tmp/a.ipa", name: "a" },
            { uri: "/tmp/b.ipa", name: "b" }
          ]
        }));
      `);
      const { mock, kernel } = setup(dir, {
        echo: { command, mode: "json", context: "direct", timeout_sec: 30 },
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: "TASK-CRASH-1", Context_ID: "CTX-CRASH-1" });
      let seen = 0;
      mock.failNext((ctx) => {
        if (ctx.op !== "create" || ctx.table !== TABLES.artifacts) return false;
        seen += 1;
        return seen === 2;
      });
      await kernel.run({ once: true });

      const boxPath = path.join(dir, "outbox", "TASK-CRASH-1.json");
      const box = JSON.parse(fs.readFileSync(boxPath, "utf8"));
      assert.equal(box.planned, true);
      assert.deepEqual(box.artifacts.map((item) => item.id), ["TASK-CRASH-1-A1", "TASK-CRASH-1-A2"]);
      assert.equal(box.artId, "TASK-CRASH-1-A1");
      assert.equal(box.res.artifact, "/tmp/a.ipa");
      const frozen = box.artifacts.map((item) => ({ id: item.id, token: item.token, partToken: item.partToken }));
      const midway = await artifactRows(mock, "TASK-CRASH-1");
      assert.deepEqual(midway.map((row) => f1(row, "Artifact_ID")), ["TASK-CRASH-1-A1"]);
      assert.equal(f1((await mock.findRecords(TABLES.tasks, "Task_ID", "TASK-CRASH-1"))[0], "Status"), "working");

      await kernel.flushOutbox();
      assert.equal(fs.existsSync(boxPath), false);
      const done = await artifactRows(mock, "TASK-CRASH-1");
      assert.deepEqual(done.map((row) => f1(row, "Artifact_ID")), ["TASK-CRASH-1-A1", "TASK-CRASH-1-A2"]);
      assert.equal(done.filter((row) => f1(row, "Artifact_ID") === "TASK-CRASH-1-A1").length, 1);
      assert.deepEqual(frozen.map((item) => item.id), ["TASK-CRASH-1-A1", "TASK-CRASH-1-A2"]);
      const parts = [];
      for (const id of ["TASK-CRASH-1-A1", "TASK-CRASH-1-A2"]) {
        const rows = await mock.findRecords(TABLES.parts, "Parent_ID", id);
        assert.equal(rows.length, 1);
        parts.push(f1(rows[0], "File_URI"));
      }
      assert.deepEqual(parts, ["/tmp/a.ipa", "/tmp/b.ipa"]);
      const result = (await mock.findRecords(TABLES.messages, "Task_ID", "TASK-CRASH-1"))
        .find((row) => f1(row, "Kind") === "result");
      assert.equal(f1(result, "Artifact_Ref"), "TASK-CRASH-1-A1");
    } finally {
      reap(dir, kernels);
    }
  });
});

test("旧 outbox 只有 artId 时沿用该编号，不按已有最大序号另开一行", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, { echo: { command: "echo 1", mode: "json" } });
    const { task } = await seedTask(mock, { Task_ID: "TASK-LEGACY", Context_ID: "CTX-LEGACY" });
    await mock.updateRecord(TABLES.tasks, task.record_id, { Status: "working", Claimed_By: "node-a" });
    await mock.createRecord(TABLES.artifacts, {
      Artifact_ID: "TASK-LEGACY-A9",
      Task_ID: "TASK-LEGACY",
      Name: "already",
    });
    fs.mkdirSync(path.join(dir, "outbox"), { recursive: true });
    fs.writeFileSync(path.join(dir, "outbox", "TASK-LEGACY.json"), JSON.stringify({
      taskId: "TASK-LEGACY",
      outcome: "succeeded",
      res: { summary: "legacy", artifact: "/tmp/legacy.bin", artifact_name: "legacy.bin" },
      raw: "",
      error: "",
      started: "2026-01-15T09:00:00+0800",
      planned: false,
      artId: "TASK-LEGACY-A4",
      runId: "",
      msgId: "",
      tokens: { artifact: "t-a", artifactPart: "t-ap", run: "t-r", message: "t-m", partText: "t-pt", partData: "t-pd" },
    }), { mode: 0o600 });

    await kernel.flushOutbox();
    const ids = (await artifactRows(mock, "TASK-LEGACY")).map((row) => f1(row, "Artifact_ID"));
    assert.deepEqual(ids, ["TASK-LEGACY-A4", "TASK-LEGACY-A9"]);
    assert.equal(ids.includes("TASK-LEGACY-A10"), false);
    const part = (await mock.findRecords(TABLES.parts, "Parent_ID", "TASK-LEGACY-A4"))[0];
    assert.equal(f1(part, "File_URI"), "/tmp/legacy.bin");
    assert.equal(f1(part, "File_Name"), "legacy.bin");
  });
});

test("产物超过 16 个不登记半截，verify 的 stdin 与 LAH_ARTIFACTS 带上全部 URI", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const many = [];
      for (let i = 0; i < 17; i++) many.push({ uri: `/tmp/f${i}` });
      const overCmd = nodeCommand(`console.log(JSON.stringify({ summary: "too many", artifacts: ${JSON.stringify(many)} }));`);
      const over = setup(dir, {
        echo: { command: overCmd, mode: "json", context: "direct", timeout_sec: 30 },
      });
      kernels.push(over.kernel);
      await seedTask(over.mock, { Task_ID: "TASK-CAP-1", Context_ID: "CTX-CAP-1" });
      await over.kernel.run({ once: true });
      const capped = (await over.mock.findRecords(TABLES.tasks, "Task_ID", "TASK-CAP-1"))[0];
      assert.equal(f1(capped, "Status"), "failed");
      assert.equal(Number(f1(capped, "Retry_Count")), 0);
      assert.equal((await artifactRows(over.mock, "TASK-CAP-1")).length, 0);

      const probePath = path.join(dir, "verify-probe.json");
      const command = nodeCommand(`
        console.log(JSON.stringify({
          summary: "checked",
          artifacts: [
            { uri: "/tmp/a.txt", name: "a.txt" },
            { uri: "/tmp/b.txt" }
          ]
        }));
      `);
      const verify = nodeCommand(`
        const fs = require("node:fs");
        fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({
          stdin: JSON.parse(fs.readFileSync(0, "utf8")),
          LAH_ARTIFACT: process.env.LAH_ARTIFACT,
          LAH_ARTIFACTS: process.env.LAH_ARTIFACTS,
        }));
      `);
      const verifyDir = path.join(dir, "verify");
      fs.mkdirSync(verifyDir);
      const run = setup(verifyDir, {
        echo: { command, verify, mode: "json", context: "direct", timeout_sec: 30, verify_timeout_sec: 30 },
      });
      kernels.push(run.kernel);
      await seedTask(run.mock, { Task_ID: "TASK-V-MULTI", Context_ID: "CTX-V-MULTI" });
      await run.kernel.run({ once: true });
      const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
      assert.deepEqual(probe.stdin, {
        task_id: "TASK-V-MULTI",
        summary: "checked",
        artifact: "/tmp/a.txt",
        artifact_name: "a.txt",
        artifacts: [{ uri: "/tmp/a.txt", name: "a.txt" }, { uri: "/tmp/b.txt" }],
        checks: {},
      });
      assert.equal(probe.LAH_ARTIFACT, "/tmp/a.txt");
      assert.equal(probe.LAH_ARTIFACTS, JSON.stringify(["/tmp/a.txt", "/tmp/b.txt"]));
      const task = (await run.mock.findRecords(TABLES.tasks, "Task_ID", "TASK-V-MULTI"))[0];
      assert.equal(f1(task, "Status"), "completed");
    } finally {
      reap(dir, kernels);
    }
  });
});
