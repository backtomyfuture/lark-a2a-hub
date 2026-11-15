// 守住 L2 声明式验收的建单与 inbox 回执入口（标准 §11.2、§11.3）。
// 使用内存总线与临时目录；另用子进程验 CLI 的错误退出不碰总线。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { f1 } from "../src/bus/feishu.mjs";
import { createTask, parseCreateArgv, parseCriteriaInput } from "../src/hub/create.mjs";
import { enqueueOrUpdateInbox, handleInboxDone, readInbox } from "../src/inbox.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const LAH_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/lah.mjs");

function writes(mock) {
  return mock.journal.filter((item) => item.op === "create" || item.op === "update");
}

async function seedCard(mock, fields = {}) {
  await mock.createRecord(TABLES.agentCards, {
    Cap_ID: "CAP-node-a-agent",
    Node: "node-a",
    Skill_ID: "agent",
    Dispatchable: "Yes",
    Availability: "online",
    ...fields,
  });
}

async function seedWorkingInboxTask(mock, dir, { taskId = "TASK-INBOX-ACC-1", criteria = null, metadata = "" } = {}) {
  const msgId = `MSG-${taskId.replace(/^TASK-/, "")}-01`;
  await mock.createRecord(TABLES.messages, {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: "CTX-ACC-1",
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
    Text: "按清单完成检查",
  });
  if (criteria) {
    await mock.createRecord(TABLES.parts, {
      Part_ID: `${msgId}-P2`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: 2,
      Kind: "data",
      Data: JSON.stringify({ acceptance: { criteria } }),
    });
  }
  await mock.createRecord(TABLES.runs, {
    Run_ID: `${taskId}-R1`,
    Task_Ref: taskId,
    Node: "node-a",
    Worker: "daemon",
    Started_At: "2026-01-15T09:00:05+0800",
  });
  const created = await mock.createRecord(TABLES.tasks, {
    Task_ID: taskId,
    Title: "验收任务",
    Source: "hub",
    Target_Node: "node-a",
    Skill_ID: "agent",
    Status: "working",
    Claimed_By: "node-a",
    Latest_Run: `${taskId}-R1`,
    Context_ID: "CTX-ACC-1",
    Hop_Count: 0,
    Retry_Count: 0,
    Metadata: metadata,
  });
  enqueueOrUpdateInbox(dir, { task_id: taskId, title: "验收任务" });
  return { task: created.record, instrMsgId: msgId };
}

test("createTask：--criteria 支持内联数组与 @文件写入首条 instruction DataPart", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    await seedCard(mock);

    const file = path.join(dir, "criteria.json");
    const list = [
      { id: "c1", text: "输出包含摘要", evidence_required: true },
      { id: "c2", text: "无未决报错" },
    ];
    fs.writeFileSync(file, JSON.stringify(list), { mode: 0o600 });

    const parsedArgv = parseCreateArgv(["--to", "node-a", "--text", "跑单", "--criteria", "@" + file]);
    assert.equal(parsedArgv.criteriaRaw, "@" + file);
    assert.equal(parseCriteriaInput("@" + file).length, 2);

    const taskId = await createTask({
      bus: mock,
      to: "node-a",
      text: "跑单",
      params: { target: "prod" },
      criteria: "@" + file,
    });
    const instrMsgId = `MSG-${taskId.slice("TASK-".length)}-01`;
    const parts = (await mock.findRecords(TABLES.parts, "Parent_ID", instrMsgId))
      .filter((p) => f1(p, "Kind") === "data");
    assert.equal(parts.length, 1);
    const data = JSON.parse(f1(parts[0], "Data"));
    assert.equal(data.target, "prod");
    assert.deepEqual(data.acceptance, {
      criteria: [
        { id: "c1", text: "输出包含摘要", evidence_required: true },
        { id: "c2", text: "无未决报错", evidence_required: false },
      ],
    });

    const inlineId = await createTask({
      bus: mock,
      to: "node-a",
      text: "内联清单",
      criteria: JSON.stringify([{ id: "ok1", text: "单测通过" }]),
    });
    const inlineParts = (await mock.findRecords(TABLES.parts, "Parent_ID", `MSG-${inlineId.slice("TASK-".length)}-01`))
      .filter((p) => f1(p, "Kind") === "data");
    assert.deepEqual(JSON.parse(f1(inlineParts[0], "Data")), {
      acceptance: { criteria: [{ id: "ok1", text: "单测通过", evidence_required: false }] },
    });
  });
});

test("createTask：非法 --criteria 与非法 params.acceptance 在第一笔写之前拒绝", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    await seedCard(mock);
    const badFile = path.join(dir, "bad.json");
    fs.writeFileSync(badFile, JSON.stringify([{ id: "bad id", text: "x" }]), { mode: 0o600 });

    mock.journal.length = 0;
    await assert.rejects(
      () => createTask({ bus: mock, to: "node-a", text: "x", criteria: "[]" }),
      /非空数组/,
    );
    await assert.rejects(
      () => createTask({ bus: mock, to: "node-a", text: "x", criteria: "@" + badFile }),
      /id 不合法/,
    );
    await assert.rejects(
      () => createTask({ bus: mock, to: "node-a", text: "x", criteria: '{"a":1}' }),
      /JSON 数组/,
    );
    await assert.rejects(
      () => createTask({
        bus: mock,
        to: "node-a",
        text: "x",
        params: { acceptance: { criteria: [{ id: "c1", text: " " }] } },
      }),
      /text/,
    );
    await assert.rejects(
      () => createTask({
        bus: mock,
        to: "node-a",
        text: "x",
        params: { acceptance: { criteria: [{ id: "c1", text: "ok" }] } },
        criteria: [{ id: "c2", text: "ok" }],
      }),
      /不能同时/,
    );
    assert.deepEqual(writes(mock), []);
  });
});

test("inbox done --check：写出 Seq 2 DataPart 与 Tasks.Metadata.acceptance，且保留已有 Metadata", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    const criteria = [
      { id: "c1", text: "提供截图路径", evidence_required: true },
      { id: "c2", text: "日志已核对" },
      { id: "c3", text: "额外复核" },
    ];
    const { task, instrMsgId } = await seedWorkingInboxTask(mock, dir, {
      criteria,
      metadata: JSON.stringify({ custom: "keep-me" }),
    });
    const logs = [];
    const res = await handleInboxDone({
      bus: mock,
      configDir: dir,
      node: "node-a",
      taskId: "TASK-INBOX-ACC-1",
      text: "已完成处理",
      checks: [
        "c1=pass:见 /tmp/shot.png",
        "c2=fail:第一轮未过",
        "c2=pass",
      ],
      log: (m) => logs.push(m),
    });

    const freshTask = await mock.getRecord(TABLES.tasks, task.record_id);
    assert.equal(f1(freshTask, "Status"), "completed");
    assert.equal(f1(freshTask, "Status_Msg"), res.msgId);

    const msgParts = (await mock.findRecords(TABLES.parts, "Parent_ID", res.msgId))
      .sort((a, b) => Number(f1(a, "Seq")) - Number(f1(b, "Seq")));
    assert.equal(msgParts.length, 2);
    assert.equal(f1(msgParts[0], "Kind"), "text");
    assert.equal(f1(msgParts[1], "Seq"), 2);
    assert.equal(f1(msgParts[1], "Kind"), "data");

    const acc = JSON.parse(f1(msgParts[1], "Data")).acceptance;
    assert.equal(acc.version, 1);
    assert.equal(acc.verify, null);
    assert.equal(acc.criteria_ref, instrMsgId);
    assert.equal(acc.overall, "uncertain");
    assert.deepEqual(acc.checks, [
      { id: "c1", verdict: "pass", evidence: "见 /tmp/shot.png", source: "self" },
      { id: "c2", verdict: "pass", evidence: "", source: "self" },
      { id: "c3", verdict: "missing", evidence: "", source: "self" },
    ]);

    const meta = JSON.parse(f1(freshTask, "Metadata"));
    assert.equal(meta.custom, "keep-me");
    assert.deepEqual(meta.acceptance, {
      version: 1,
      verify: null,
      checks: [
        { id: "c1", verdict: "pass" },
        { id: "c2", verdict: "pass" },
        { id: "c3", verdict: "missing" },
      ],
      overall: "uncertain",
      msg_id: res.msgId,
    });
    assert.equal(readInbox(dir).find((i) => i.task_id === "TASK-INBOX-ACC-1")?.status, "done");
    assert.deepEqual(logs, []);
  });
});

test("inbox done：DataPart 中途失败重跑走 outbox 幂等补齐；Metadata 写失败只记日志", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    const { task } = await seedWorkingInboxTask(mock, dir, {
      taskId: "TASK-INBOX-RETRY-1",
      criteria: [{ id: "c1", text: "单测通过" }],
    });

    // 第一次：在写 Seq 2 DataPart 时故障，消息与 Seq 1 已落表，outbox 应保留供补齐。
    mock.failNext((ctx) => ctx.op === "create" && ctx.table === TABLES.parts && ctx.fields?.Seq === 2);
    await assert.rejects(
      () => handleInboxDone({
        bus: mock,
        configDir: dir,
        node: "node-a",
        taskId: "TASK-INBOX-RETRY-1",
        text: "完成",
        checks: ["c1=pass:264/264"],
      }),
      /1254291/,
    );
    const outboxFile = path.join(dir, "inbox-outbox", "TASK-INBOX-RETRY-1.json");
    assert.equal(fs.existsSync(outboxFile), true);

    // 第二次补齐时注入 Tasks.Metadata 更新失败，应不阻断收口，DataPart 仍在。
    mock.failNext((ctx) => ctx.op === "update" && ctx.table === TABLES.tasks && "Metadata" in (ctx.fields || {}));
    const logs = [];
    const res = await handleInboxDone({
      bus: mock,
      configDir: dir,
      node: "node-a",
      taskId: "TASK-INBOX-RETRY-1",
      text: "完成",
      checks: ["c1=pass:264/264"],
      log: (m) => logs.push(m),
    });

    assert.equal(fs.existsSync(outboxFile), false);
    assert.equal(f1(await mock.getRecord(TABLES.tasks, task.record_id), "Status"), "completed");
    const msgParts = await mock.findRecords(TABLES.parts, "Parent_ID", res.msgId);
    assert.equal(msgParts.length, 2);
    assert.equal(JSON.parse(f1(msgParts[1], "Data")).acceptance.overall, "pass");
    assert.match(logs.join("\n"), /Tasks\.Metadata\.acceptance 写失败/);
  });
});

test("inbox done --check：非法格式与无清单时拒绝且不写任何表", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    await seedWorkingInboxTask(mock, dir, { taskId: "TASK-NO-CRITERIA-1", criteria: null });
    mock.journal.length = 0;

    await assert.rejects(
      () => handleInboxDone({
        bus: mock,
        configDir: dir,
        node: "node-a",
        taskId: "TASK-NO-CRITERIA-1",
        text: "完成",
        checks: ["c1=bad"],
      }),
      /pass \/ fail \/ blocked/,
    );
    await assert.rejects(
      () => handleInboxDone({
        bus: mock,
        configDir: dir,
        node: "node-a",
        taskId: "TASK-NO-CRITERIA-1",
        text: "完成",
        checks: ["c1=pass"],
      }),
      /没有验收清单/,
    );
    assert.deepEqual(writes(mock), []);

    // CLI 入口在读配置或写总线之前就应拒绝非法 --check 与非法 --criteria。
    const badCheckCli = spawnSync(
      process.execPath,
      [LAH_BIN, "inbox", "done", "--config", dir, "--task", "TASK-NO-CRITERIA-1", "--text", "ok", "--check", "c1=nope"],
      { encoding: "utf8" },
    );
    assert.notEqual(badCheckCli.status, 0);
    assert.match(badCheckCli.stderr, /--check/);

    const badCriteriaCli = spawnSync(
      process.execPath,
      [LAH_BIN, "task", "create", "--config", dir, "--to", "node-a", "--text", "ok", "--criteria", "[]"],
      { encoding: "utf8" },
    );
    assert.notEqual(badCriteriaCli.status, 0);
    assert.match(badCriteriaCli.stderr, /非空数组/);
  });
});
