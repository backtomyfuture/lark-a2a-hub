// 可选用量与 direct 问答续接。总线是内存 mock，状态只进临时目录，结束时清掉进程组。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { doctor } from "../src/doctor.mjs";
import {
  addUsage,
  Kernel,
  parseAgentReceipt,
  parseJsonReceipt,
  substituteCommand,
} from "../src/kernel.mjs";
import { formatWhyText, getTaskWhy } from "../src/why.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

function shellSingleQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

function nodeCommand(script) {
  return `${JSON.stringify(process.execPath)} -e ${shellSingleQuote(script)}`;
}

function logsOf() {
  const lines = [];
  return { lines, log: (msg) => lines.push(String(msg)) };
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

function metaOf(task) {
  const raw = f1(task, "Metadata");
  if (!raw) return {};
  return JSON.parse(String(raw));
}

function plantSession(dir, taskId, session) {
  const dest = path.join(dir, "runs", taskId);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dest, "session.json"), JSON.stringify({ session }), { mode: 0o600 });
}

async function untilStatus(kernel, mock, taskId, status, { punch = false, phase = "" } = {}) {
  const exitPath = path.join(kernel.cfg.configDir, "runs", taskId, "exit");
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 8000) {
    if (punch && kernel._retryCache?.[taskId]) kernel._retryCache[taskId].not_before = 1;
    // 退出码文件还没改名发布时再扫，会把还在收尾的进程当成已死并重试。
    if (kernel._directFlight && !fs.existsSync(exitPath)) {
      await waitFor(() => !kernel._directFlight || fs.existsSync(exitPath));
    }
    await kernel.sweepOnce();
    last = f1(await taskOf(mock, taskId), "Status");
    if (last === status) return taskOf(mock, taskId);
    if (last === "completed" || last === "failed" || last === "rejected" || last === "canceled") break;
    const hold = kernel._retryCache?.[taskId]?.not_before;
    if (last === "submitted" && status !== "submitted" && hold > Date.now()) break;
    await sleep(20);
  }
  const phaseText = phase && fs.existsSync(phase) ? fs.readFileSync(phase, "utf8") : "";
  let reason = "";
  try {
    const runs = await mock.findRecords(TABLES.runs, "Task_Ref", taskId);
    reason = runs.map((row) => f1(row, "Error_Log")).filter(Boolean).join(" | ");
  } catch { /* 诊断拿不到台账时仍抛原来的状态 */ }
  throw new Error(`want ${status} got ${last} phase=${JSON.stringify(phaseText)} reason=${reason}`);
}

test("agent 的 USAGE 与 SESSION 只认围栏外整行", () => {
  const quiet = logsOf();
  const missing = parseAgentReceipt("done\n", quiet.log);
  assert.equal(missing.usage, null);
  assert.equal(missing.session, null);
  assert.equal(missing.summary, "done");
  assert.deepEqual(quiet.lines, []);

  const empty = logsOf();
  const zeros = parseAgentReceipt("done\nUSAGE:\n", empty.log);
  assert.deepEqual(zeros.usage, { input: 0, output: 0, cached: 0, cost: 0 });
  assert.equal(zeros.session, null);
  assert.deepEqual(empty.lines, []);

  const legal = logsOf();
  const row = parseAgentReceipt("done\nUSAGE: cost=1.23456789 input=1.9\nSESSION: ok-1\n", legal.log);
  assert.equal(row.summary, "done");
  assert.equal(row.usage.input, 1);
  assert.equal(row.usage.output, 0);
  assert.equal(row.usage.cost, 1.234568);
  assert.equal(row.session, "ok-1");
  assert.deepEqual(legal.lines, []);

  const cap = parseAgentReceipt("USAGE: input=1e12\ndone", () => {});
  assert.equal(cap.usage.input, 1e12);

  const bad = logsOf();
  const ignored = parseAgentReceipt("done\nUSAGE: input=1\nUSAGE: input=-1\nSESSION: a'b\n", bad.log);
  assert.equal(ignored.summary, "done");
  assert.equal(ignored.usage, null);
  assert.equal(ignored.session, null);
  assert.match(bad.lines.join("\n"), /usage/);
  assert.match(bad.lines.join("\n"), /session/);

  const over = logsOf();
  const capped = parseAgentReceipt("done\nUSAGE: input=1e13\nSESSION: ok-1\n", over.log);
  assert.equal(capped.summary, "done");
  assert.equal(capped.usage, null);
  assert.equal(capped.session, "ok-1");
  assert.match(over.lines.join("\n"), /usage/);

  const forged = logsOf();
  const outside = parseAgentReceipt([
    "done",
    "```txt",
    "USAGE: input=99",
    "SESSION: forged",
    "```",
    "USAGE: input=3",
    "SESSION: ok-1",
  ].join("\n"), forged.log);
  assert.equal(outside.usage.input, 3);
  assert.equal(outside.session, "ok-1");
  assert.equal(outside.summary.includes("done"), true);
  assert.deepEqual(forged.lines, []);

  const insideOnly = logsOf();
  const hidden = parseAgentReceipt([
    "done",
    "```",
    "USAGE: input=5",
    "SESSION: nope",
    "```",
  ].join("\n"), insideOnly.log);
  assert.equal(hidden.usage, null);
  assert.equal(hidden.session, null);
  assert.deepEqual(insideOnly.lines, []);

  const asked = logsOf();
  assert.throws(() => parseAgentReceipt([
    "```agent-ask",
    "USAGE: input=9",
    "SESSION: in-fence",
    "what?",
    "```",
    "USAGE: input=2",
    "SESSION: out-1",
  ].join("\n"), asked.log), (err) => {
    assert.match(err.message, /what\?/);
    assert.equal(err.usage.input, 2);
    assert.equal(err.session, "out-1");
    return true;
  });

  const blank = logsOf();
  assert.throws(() => parseAgentReceipt("USAGE: input=4\nSESSION: out-1\n", blank.log), (err) => {
    assert.match(err.message, /no output/);
    assert.equal(err.usage.input, 4);
    assert.equal(err.session, "out-1");
    return true;
  });
});

test("json 的 usage 与 session 可缺、可非法，非法不废回执", () => {
  const quiet = logsOf();
  const missing = parseJsonReceipt({ summary: "ok" }, quiet.log);
  assert.equal(missing.usage, null);
  assert.equal(missing.session, null);
  assert.deepEqual(quiet.lines, []);

  const legal = logsOf();
  const row = parseJsonReceipt({
    summary: "ok",
    usage: { input: 1.9, cost: 1.23456789, extra: 1 },
    session: "abc.def:g-1",
  }, legal.log);
  assert.equal(row.usage.input, 1);
  assert.equal(row.usage.cost, 1.234568);
  assert.equal(row.usage.output, 0);
  assert.equal(row.session, "abc.def:g-1");
  assert.deepEqual(legal.lines, []);

  const bad = logsOf();
  const kept = parseJsonReceipt({
    summary: "ok",
    usage: { input: "1" },
    session: "bad id",
    command: "rm",
  }, bad.log);
  assert.equal(kept.summary, "ok");
  assert.equal(kept.usage, null);
  assert.equal(kept.session, null);
  assert.match(bad.lines.join("\n"), /usage/);
  assert.match(bad.lines.join("\n"), /session/);

  const huge = logsOf();
  const capped = parseJsonReceipt({ summary: "ok", usage: { input: 1e12 + 1 } }, huge.log);
  assert.equal(capped.usage, null);
  assert.match(huge.lines.join("\n"), /usage/);
  const exact = parseJsonReceipt({ summary: "ok", usage: { cached: 1e12 } }, () => {});
  assert.equal(exact.usage.cached, 1e12);

  const asked = logsOf();
  assert.throws(() => parseJsonReceipt({
    need_input: "q",
    usage: { input: -1 },
    session: "ok-1",
  }, asked.log), (err) => {
    assert.equal(err.message, "q");
    assert.equal(err.usage, null);
    assert.equal(err.session, "ok-1");
    return true;
  });

  const summed = addUsage(
    { input: 10, output: 2, cached: 1, cost: 0.5, runs: 1, reported: 1 },
    { input: 3 },
  );
  assert.equal(summed.input, 13);
  assert.equal(summed.output, 2);
  assert.equal(summed.runs, 2);
  assert.equal(summed.reported, 2);
  const missed = addUsage(summed, null);
  assert.equal(missed.runs, 3);
  assert.equal(missed.reported, 2);
  assert.equal(missed.input, 13);
});

test("{session} 只替换一次，并用单引号挡住注入", async () => {
  assert.equal(substituteCommand("run {session}", { session: "abc-1" }), "run 'abc-1'");
  assert.equal(
    substituteCommand("run {session} {session}", { session: "abc-1" }),
    "run 'abc-1' {session}",
  );
  assert.equal(
    substituteCommand("run {prompt} {session}", { prompt: "hi {session}", session: "abc" }),
    "run 'hi {session}' 'abc'",
  );

  await withTemp(async (dir) => {
    const marker = path.join(dir, "pwned");
    const nasty = `'; touch ${marker}; echo '`;
    const cmd = substituteCommand("echo {session}", { session: nasty });
    const printed = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
    assert.equal(printed.status, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.match(printed.stdout, /touch/);

    const argvFile = path.join(dir, "argv.json");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv))`;
    const argvCmd = substituteCommand(
      `${JSON.stringify(process.execPath)} -e ${shellSingleQuote(script)} -- {session}`,
      { session: "abc-1" },
    );
    const run = spawnSync("sh", ["-c", argvCmd], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("abc-1"));
    assert.equal(argv.includes("abc"), false);
  });
});

test("buildPrompt 说明可选 USAGE，不把指令拼进提示", async () => {
  await withTemp(async (dir) => {
    const { kernel } = await setup(dir, {
      command: "echo {prompt}",
      mode: "agent",
      context: "direct",
    });
    const prompt = kernel.buildPrompt(path.join(dir, "runs", "TASK-X", "input.json"));
    assert.match(prompt, /USAGE: input=<n> output=<n> cached=<n> cost=<x>/);
    assert.match(prompt, /SESSION:/);
    // 续跑的 agent 要被告知 approvals 是已验签的批准记录，否则会把同一动作再申请一遍。
    assert.match(prompt, /agent-auth/);
    assert.match(prompt, /approvals 数组是节点已验过机主签名的批准记录/);
    assert.equal(prompt.includes("INSTRUCTION-SENTINEL"), false);
  });
});

test("task why 显示 usage 汇总与未上报轮数", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    await bus.createRecord(TABLES.tasks, {
      Task_ID: "TASK-WHY-USE",
      Title: "用量",
      Status: "completed",
      Target_Node: "node-a",
      Source: "hub",
      Metadata: JSON.stringify({
        note: "stay",
        usage: { input: 4, output: 1, cached: 0, cost: 1.5, runs: 2, reported: 1 },
      }),
    });
    await bus.createRecord(TABLES.messages, {
      Msg_ID: "MSG-WHY-USE-01",
      Task_ID: "TASK-WHY-USE",
      Kind: "instruction",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Created_At: "2026-01-15T09:00:00+0800",
    });
    const data = await getTaskWhy({ bus, configDir: dir, taskId: "TASK-WHY-USE" });
    assert.equal(data.usage.unreported, 1);
    assert.equal(data.usage.input, 4);
    assert.equal(data.task.usage.reported, 1);
    assert.equal(JSON.stringify(data).includes('"note"'), false);
    const text = formatWhyText(data);
    assert.match(text, /用量汇总: input=4 output=1 cached=0 cost=1\.5（上报 1\/2 轮，未上报 1 轮）/);

    await bus.createRecord(TABLES.tasks, {
      Task_ID: "TASK-WHY-NONE",
      Title: "无用量",
      Status: "submitted",
      Target_Node: "node-a",
    });
    const none = await getTaskWhy({ bus, configDir: dir, taskId: "TASK-WHY-NONE" });
    assert.equal(none.usage, null);
    assert.match(formatWhyText(none), /用量汇总: 未上报/);
  });
});

test("首次执行和失败重试不用 resume_command，用量累加且不覆盖其它键", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    const phase = path.join(dir, "phase");
    const count = path.join(dir, "count");
    try {
      const command = nodeCommand(`
        const fs = require("node:fs");
        const nPath = ${JSON.stringify(count)};
        const n = fs.existsSync(nPath) ? Number(fs.readFileSync(nPath, "utf8")) || 0 : 0;
        fs.writeFileSync(nPath, String(n + 1));
        fs.appendFileSync(${JSON.stringify(phase)}, ${JSON.stringify("command\n")});
        if (n === 0) process.exit(1);
        process.stdout.write(${JSON.stringify('{"summary":"ok","usage":{"input":4}}\n')});
      `);
      const resume = nodeCommand(`
        const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(phase)}, ${JSON.stringify("resume\n")});
        process.stdout.write(${JSON.stringify('{"summary":"resumed","usage":{"input":99}}\n')});
      `) + " -- {session}";
      const { mock, kernel } = await setup(dir, {
        command,
        resume_command: resume,
        mode: "json",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      const taskId = "TASK-USE-RETRY";
      plantSession(dir, taskId, "planted-1");
      const record = await seedTask(mock, { Task_ID: taskId, Context_ID: "CTX-USE-RETRY" });
      await mock.updateRecord(TABLES.tasks, record.record_id, {
        Metadata: JSON.stringify({ presented_keys: ["keep-me"], note: "stay" }),
      });
      await untilStatus(kernel, mock, taskId, "submitted", { phase });
      assert.equal(fs.readFileSync(phase, "utf8"), "command\n");
      kernel._retryCache[taskId].not_before = 1;
      const done = await untilStatus(kernel, mock, taskId, "completed", { punch: true, phase });
      assert.equal(fs.readFileSync(phase, "utf8"), "command\ncommand\n");
      const meta = metaOf(done);
      assert.equal(meta.note, "stay");
      assert.deepEqual(meta.presented_keys, ["keep-me"]);
      assert.equal(meta.usage.input, 4);
      assert.equal(meta.usage.output, 0);
      assert.equal(meta.usage.runs, 2);
      assert.equal(meta.usage.reported, 1);
      const why = await getTaskWhy({ bus: mock, configDir: dir, taskId });
      assert.equal(why.usage.unreported, 1);
      assert.match(formatWhyText(why), /未上报 1 轮/);
      assert.match(formatWhyText(why), /input=4/);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("问答续跑在已有 session 且配置了 resume_command 时替换命令", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    const phase = path.join(dir, "phase");
    const argvFile = path.join(dir, "argv.json");
    const taskId = "TASK-QA-1";
    try {
      const ask = "```agent-ask\nneed more\n```\nSESSION: sess-1\nUSAGE: input=10 output=2 cached=1 cost=0.5\n";
      const command = nodeCommand(`
        const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(phase)}, ${JSON.stringify("command\n")});
        process.stdout.write(${JSON.stringify(ask)});
      `);
      const resume = nodeCommand(`
        const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(phase)}, ${JSON.stringify("resume\n")});
        fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));
        process.stdout.write(${JSON.stringify("all done\nUSAGE: input=3\n")});
      `) + " -- {session}";
      const { mock, kernel } = await setup(dir, {
        command,
        resume_command: resume,
        mode: "agent",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      plantSession(dir, taskId, "planted-1");
      const record = await seedTask(mock, {
        Task_ID: taskId,
        Context_ID: "CTX-QA-1",
      }, { text: "INSTRUCTION-SENTINEL" });
      await mock.updateRecord(TABLES.tasks, record.record_id, {
        Metadata: JSON.stringify({ presented_keys: ["keep-me"], note: "stay" }),
      });
      await untilStatus(kernel, mock, taskId, "input-required", { phase });
      assert.equal(fs.readFileSync(phase, "utf8"), "command\n");
      const sessionFile = path.join(dir, "runs", taskId, "session.json");
      assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
      assert.equal(JSON.parse(fs.readFileSync(sessionFile, "utf8")).session, "sess-1");
      const question = (await mock.findRecords(TABLES.messages, "Kind", "question"))
        .find((row) => f1(row, "Task_ID") === taskId);
      const answerId = String(f1(question, "Msg_ID")).replace(/-(\d+)$/, (_, n) => "-" + String(Number(n) + 7).padStart(2, "0"));
      await mock.createRecord(TABLES.messages, {
        Msg_ID: answerId,
        Task_ID: taskId,
        Context_ID: "CTX-QA-1",
        From_Node: "hub",
        To_Node: "node-a",
        Role: "user",
        Kind: "answer",
        In_Reply_To: f1(question, "Msg_ID"),
        Created_At: "2026-11-08T12:00:00+0800",
      });
      await mock.createRecord(TABLES.parts, {
        Part_ID: `${answerId}-P1`,
        Parent_ID: answerId,
        Parent_Type: "message",
        Seq: 1,
        Kind: "text",
        Text: "就这样",
      });
      const done = await untilStatus(kernel, mock, taskId, "completed", { phase });
      assert.equal(fs.readFileSync(phase, "utf8"), "command\nresume\n");
      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      assert.ok(argv.includes("sess-1"));
      assert.equal(argv.filter((item) => item === "sess-1").length, 1);
      const meta = metaOf(done);
      assert.equal(meta.note, "stay");
      assert.deepEqual(meta.presented_keys, ["keep-me"]);
      assert.equal(meta.usage.input, 13);
      assert.equal(meta.usage.output, 2);
      assert.equal(meta.usage.cached, 1);
      assert.equal(meta.usage.cost, 0.5);
      assert.equal(meta.usage.runs, 2);
      assert.equal(meta.usage.reported, 2);
      assert.equal(fs.existsSync(sessionFile), false);
      const input = JSON.parse(fs.readFileSync(path.join(dir, "runs", taskId, "input.json"), "utf8"));
      assert.match(input.instruction, /INSTRUCTION-SENTINEL/);
      assert.match(JSON.stringify(input), /就这样/);
      const prompt = kernel.buildPrompt(path.join(dir, "runs", taskId, "input.json"));
      assert.equal(prompt.includes("INSTRUCTION-SENTINEL"), false);
      assert.equal(prompt.includes("就这样"), false);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("非法 session 被忽略，续跑仍走原命令", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    const phase = path.join(dir, "phase");
    const taskId = "TASK-BAD-SESS";
    try {
      const ask = "```agent-ask\nneed more\n```\nSESSION: bad id\nUSAGE: input=1\n";
      const command = nodeCommand(`
        const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(phase)}, ${JSON.stringify("command\n")});
        const nPath = ${JSON.stringify(path.join(dir, "count"))};
        const n = fs.existsSync(nPath) ? Number(fs.readFileSync(nPath, "utf8")) || 0 : 0;
        fs.writeFileSync(nPath, String(n + 1));
        if (n === 0) {
          process.stdout.write(${JSON.stringify(ask)});
        } else {
          process.stdout.write(${JSON.stringify("done\n")});
        }
      `);
      const resume = nodeCommand(`
        require("node:fs").appendFileSync(${JSON.stringify(phase)}, ${JSON.stringify("resume\n")});
        process.stdout.write(${JSON.stringify("resumed\n")});
      `) + " -- {session}";
      const { mock, kernel } = await setup(dir, {
        command,
        resume_command: resume,
        mode: "agent",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      await seedTask(mock, { Task_ID: taskId, Context_ID: "CTX-BAD-SESS" });
      await untilStatus(kernel, mock, taskId, "input-required", { phase });
      assert.equal(fs.existsSync(path.join(dir, "runs", taskId, "session.json")), false);
      const question = (await mock.findRecords(TABLES.messages, "Kind", "question"))
        .find((row) => f1(row, "Task_ID") === taskId);
      const answerId = String(f1(question, "Msg_ID")).replace(/-(\d+)$/, (_, n) => "-" + String(Number(n) + 7).padStart(2, "0"));
      await mock.createRecord(TABLES.messages, {
        Msg_ID: answerId,
        Task_ID: taskId,
        From_Node: "hub",
        To_Node: "node-a",
        Role: "user",
        Kind: "answer",
        Created_At: "2026-11-08T12:00:00+0800",
      });
      await mock.createRecord(TABLES.parts, {
        Part_ID: `${answerId}-P1`,
        Parent_ID: answerId,
        Parent_Type: "message",
        Seq: 1,
        Kind: "text",
        Text: "继续",
      });
      await untilStatus(kernel, mock, taskId, "completed", { phase });
      assert.equal(fs.readFileSync(phase, "utf8"), "command\ncommand\n");
    } finally {
      reap(dir, kernels);
    }
  });
});

test("Metadata 写失败不影响任务 completed", async () => {
  await withTemp(async (dir) => {
    const kernels = [];
    try {
      const command = nodeCommand(`
        process.stdout.write(${JSON.stringify('{"summary":"ok","usage":{"input":1,"cost":0.25}}\n')});
      `);
      const { mock, kernel } = await setup(dir, {
        command,
        mode: "json",
        context: "direct",
        timeout_sec: 30,
      });
      kernels.push(kernel);
      const taskId = "TASK-META-FAIL";
      const record = await seedTask(mock, { Task_ID: taskId, Context_ID: "CTX-META-FAIL" });
      await mock.updateRecord(TABLES.tasks, record.record_id, {
        Metadata: JSON.stringify({ note: "stay", presented_keys: ["keep-me"] }),
      });
      mock.failNext((ctx) => {
        if (ctx.op !== "update" || ctx.table !== TABLES.tasks) return false;
        const raw = ctx.fields?.Metadata;
        const text = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
        return text.includes('"usage"');
      }, new Error("metadata usage failed"));
      const done = await untilStatus(kernel, mock, taskId, "completed");
      const meta = metaOf(done);
      assert.equal(meta.note, "stay");
      assert.equal(Object.prototype.hasOwnProperty.call(meta, "usage"), false);
      const result = (await mock.findRecords(TABLES.messages, "Kind", "result"))
        .find((row) => f1(row, "Task_ID") === taskId);
      assert.ok(result);
    } finally {
      reap(dir, kernels);
    }
  });
});

test("doctor 对缺少 {session} 的 resume_command 报问题", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      echo: {
        command: "echo hi",
        resume_command: "echo resume",
        mode: "agent",
        context: "direct",
      },
    }), { mode: 0o600 });
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const code = await doctor(dir, dir);
      assert.equal(code, 1);
    } finally {
      console.log = orig;
    }
    const text = lines.join("\n");
    assert.match(text, /resume_command/);
    assert.match(text, /\{session\}/);
  });
});
