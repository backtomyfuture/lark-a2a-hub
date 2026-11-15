// 守住验收结果的展示口径（标准 §11.3）：why 以回执 DataPart 为权威，呈递只带去掉证据的索引。
// 数据直接写进内存总线，不依赖内核收口。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { acceptanceFromParts, acceptanceLine } from "../src/acceptance.mjs";
import { PresentService, presentBody } from "../src/hub/present.mjs";
import { formatWhyText, getTaskWhy } from "../src/why.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const EVIDENCE = "证".repeat(150);

function part(fields) {
  return { fields };
}

test("acceptanceFromParts 取 Data.acceptance，坏 JSON 为 null，多条优先 Seq 2", () => {
  assert.equal(acceptanceFromParts([part({ Kind: "data", Seq: 2, Data: "{" })]), null);
  assert.equal(acceptanceFromParts([part({ Kind: "text", Seq: 1, Text: "x" })]), null);
  const seq3 = { version: 1, overall: "pass", verify: null, checks: [] };
  const seq2 = { version: 1, overall: "fail", verify: { verdict: "fail", exit_code: 1 }, checks: [] };
  const got = acceptanceFromParts([
    part({ Kind: "data", Seq: 3, Data: JSON.stringify({ acceptance: seq3 }) }),
    part({ Kind: "data", Seq: 2, Data: JSON.stringify({ acceptance: seq2 }) }),
  ]);
  assert.equal(got.overall, "fail");
});

async function seedTask(bus, taskId, { status, metadata, receipt }) {
  await bus.createRecord(TABLES.tasks, {
    Task_ID: taskId,
    Title: taskId,
    Status: status,
    Target_Node: "node-b",
    Source: "node-a",
    Skill_ID: "echo",
    Hop_Count: 0,
    Retry_Count: 0,
    Context_ID: "CTX-1",
    Metadata: metadata ? JSON.stringify(metadata) : "",
  });
  await bus.createRecord(TABLES.messages, {
    Msg_ID: `MSG-${taskId}-01`,
    Task_ID: taskId,
    Kind: "instruction",
    From_Node: "node-a",
    To_Node: "node-b",
    Role: "user",
    Created_At: "2026-01-15T09:00:00+0800",
  });
  if (!receipt) return;
  await bus.createRecord(TABLES.messages, {
    Msg_ID: receipt.msgId,
    Task_ID: taskId,
    Kind: receipt.kind,
    From_Node: "node-b",
    To_Node: "node-a",
    Role: "agent",
    Created_At: "2026-01-15T09:05:00+0800",
  });
  await bus.createRecord(TABLES.parts, {
    Part_ID: `${receipt.msgId}-P1`,
    Parent_ID: receipt.msgId,
    Parent_Type: "message",
    Seq: 1,
    Kind: "text",
    Text: receipt.text,
  });
  if (receipt.acceptance) {
    await bus.createRecord(TABLES.parts, {
      Part_ID: `${receipt.msgId}-P2`,
      Parent_ID: receipt.msgId,
      Parent_Type: "message",
      Seq: 2,
      Kind: "data",
      Data: JSON.stringify({ acceptance: receipt.acceptance }),
    });
  }
}

test("why 有 DataPart 时 JSON 用原对象，文本标出捕获与自述", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const taskId = "TASK-ACC-PART";
    const msgId = `MSG-${taskId}-02`;
    const acceptance = {
      version: 1,
      verify: { verdict: "fail", exit_code: 2, duration_ms: 15, evidence: "captured" },
      criteria_ref: `MSG-${taskId}-01`,
      checks: [{ id: "c1", verdict: "fail", evidence: EVIDENCE, source: "self" }],
      overall: "fail",
    };
    await seedTask(bus, taskId, {
      status: "failed",
      metadata: { acceptance: { version: 1, overall: "pass", verify: { verdict: "pass", exit_code: 0 }, checks: [], msg_id: "STALE" } },
      receipt: { msgId, kind: "notice", text: "验收未通过", acceptance },
    });
    const data = await getTaskWhy({ bus, configDir: dir, taskId });
    assert.deepEqual(data.acceptance, acceptance);
    assert.equal(JSON.stringify(data.acceptance).includes("evidence_required"), false);
    const text = formatWhyText(data);
    assert.match(text, new RegExp("^" + acceptanceLine(acceptance).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m"));
    assert.match(text, /执行式验收: fail，退出码 2（证据：守护进程捕获）/);
    assert.match(text, new RegExp(`自检 c1: fail ${"证".repeat(120)}（执行方自述）`));
    assert.equal(text.includes("证".repeat(121)), false);
    assert.equal(text.includes("STALE"), false);
  });
});

test("why 只有 Metadata 时退回索引，都没有则显示未配置", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const indexed = {
      version: 1,
      verify: { verdict: "pass", exit_code: 0 },
      checks: [{ id: "c1", verdict: "pass" }],
      overall: "pass",
      msg_id: "MSG-TASK-ACC-META-02",
    };
    await seedTask(bus, "TASK-ACC-META", {
      status: "completed",
      metadata: { acceptance: indexed, note: "stay" },
      receipt: { msgId: "MSG-TASK-ACC-META-02", kind: "result", text: "做完了" },
    });
    await seedTask(bus, "TASK-ACC-NONE", {
      status: "completed",
      receipt: { msgId: "MSG-TASK-ACC-NONE-02", kind: "result", text: "做完了" },
    });

    const meta = await getTaskWhy({ bus, configDir: dir, taskId: "TASK-ACC-META" });
    assert.deepEqual(meta.acceptance, indexed);
    const metaText = formatWhyText(meta);
    assert.match(metaText, /执行式验收: pass，退出码 0（证据：守护进程捕获）/);
    assert.match(metaText, /自检 c1: pass（执行方自述）/);
    assert.equal(metaText.includes("stay"), false);

    const none = await getTaskWhy({ bus, configDir: dir, taskId: "TASK-ACC-NONE" });
    assert.equal(none.acceptance, null);
    const noneText = formatWhyText(none);
    assert.match(noneText, /验收: 未配置/);
    assert.equal(noneText.includes("验收通过"), false);
    assert.equal(noneText.includes("执行式验收:"), false);
  });
});

function presentService(dir, bus) {
  const statePath = path.join(dir, "present_state.json");
  fs.writeFileSync(statePath, JSON.stringify({ keys: [], canceledBaseline: true }), { mode: 0o600 });
  return new PresentService({
    bus,
    nodeName: "node-a",
    role: "node",
    statePath,
    queuePath: path.join(dir, "present_queue.jsonl"),
    log: () => {},
  });
}

test("呈递在验收失败时带索引，正文首行是验收未通过", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    const taskId = "TASK-ACC-PRESENT";
    const msgId = `MSG-${taskId}-02`;
    const acceptance = {
      version: 1,
      verify: { verdict: "fail", exit_code: 2, duration_ms: 8, evidence: "captured" },
      criteria_ref: `MSG-${taskId}-01`,
      checks: [{ id: "c1", verdict: "fail", evidence: "不应进队列", source: "self" }],
      overall: "fail",
    };
    await seedTask(bus, taskId, {
      status: "failed",
      receipt: { msgId, kind: "notice", text: "验收未通过：执行式验收未通过", acceptance },
    });
    await bus.createRecord(TABLES.runs, {
      Run_ID: "RUN-ACC-1",
      Task_Ref: taskId,
      Outcome: "failed",
      Error_Log: "verify exit 2",
    });
    await seedTask(bus, "TASK-EXEC-FAIL", {
      status: "failed",
      receipt: { msgId: "MSG-TASK-EXEC-FAIL-02", kind: "notice", text: "命令退出码 1" },
    });

    const svc = presentService(dir, bus);
    assert.equal(await svc.scan(), 2);
    const items = fs.readFileSync(svc.queuePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const accItem = items.find((item) => item.task_id === taskId);
    const execItem = items.find((item) => item.task_id === "TASK-EXEC-FAIL");
    assert.deepEqual(accItem.acceptance, {
      version: 1,
      verify: { verdict: "fail", exit_code: 2 },
      checks: [{ id: "c1", verdict: "fail" }],
      overall: "fail",
      msg_id: msgId,
    });
    assert.equal(JSON.stringify(accItem.acceptance).includes("不应进队列"), false);
    assert.match(accItem.text.split("\n")[0], /^【验收未通过】【任务失败】$/);
    assert.match(accItem.text, /执行结果：failed/);
    assert.match(accItem.text, /验收未通过：执行式验收未通过（verify，退出码 2）/);
    assert.equal(execItem.acceptance, null);
    assert.match(execItem.text.split("\n")[0], /^【任务失败】$/);
    assert.equal(execItem.text.includes("验收未通过"), false);

    const plain = presentBody({
      taskId: "TASK-X",
      title: "x",
      status: "failed",
      message: "执行失败",
      outcome: "failed",
    });
    assert.match(plain.split("\n")[0], /^【任务失败】$/);
  });
});
