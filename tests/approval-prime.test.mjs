// hub 不再在 submitted 阶段替节点写 auth_request。
// 行级 Approval_Class 与 commands.json 下限仍由目标节点在认领前落静态门。
// 总线是内存 mock。不读 ~/.hub-node，不打开长连接。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { f1 } from "../src/bus/feishu.mjs";
import { ApprovalService } from "../src/hub/approval.mjs";
import { Kernel } from "../src/kernel.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ECHO = path.join(ROOT, "src", "executors", "echo.mjs");
const OWNER = "ou_test_owner";

function nodeCommand(script) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function echoCommand() {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(ECHO)}`;
}

function kernelCfg(dir, mock, node, role) {
  return {
    node,
    role,
    kind: "host",
    zone: "test",
    capPrefix: "test",
    events: false,
    configDir: dir,
    carrierSocket: path.join(dir, "missing.sock"),
    bus: mock,
  };
}

function writeCommands(dir, entry) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({ echo: entry }), { mode: 0o600 });
}

async function seedTask(mock, fields, { text = "跑一下", params = { n: 1 } } = {}) {
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
    Title: text,
    Source: "hub",
    Target_Node: "node-a",
    Skill_ID: "echo",
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

async function authRequests(mock, taskId) {
  const rows = await mock.listRecords(TABLES.messages);
  return rows.filter((row) => f1(row, "Kind") === "auth_request" && f1(row, "Task_ID") === taskId);
}

function approvalFor(dir, mock, kernel) {
  return new ApprovalService({
    bus: mock,
    ownerOpenId: OWNER,
    statePath: path.join(dir, "approval_state.json"),
    log: () => {},
  });
}

async function decide(approval, task, statusMsg, decision) {
  const res = await approval.handleCardAction({
    operator: { open_id: OWNER },
    action: {
      value: {
        record_id: task.record_id,
        task_id: f1(task, "Task_ID"),
        status_msg: statusMsg,
        decision,
      },
    },
  });
  // 回调先交回终态卡，写表在后台。断言任务状态前要等这一轮结束。
  await approval.whenIdle();
  return res;
}

function cardText(mock) {
  return mock.sent.map((item) => String(item.content ?? "")).join("\n");
}

// 红线：submitted + 行级 approve 时 hub 只扫、不代写。静态门由目标节点在认领前落一条。
test("hub 扫描不抢跑，节点认领前只写一条静态 auth_request", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    writeCommands(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
      name: "echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const hub = new Kernel(kernelCfg(dir, mock, "hub", "hub"));
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, hub);
    await seedTask(mock, {
      Task_ID: "TASK-APR-1",
      Context_ID: "CTX-APR-1",
      Approval_Class: "approve",
    });

    assert.equal(await approval.scan(), 0);
    assert.equal((await authRequests(mock, "TASK-APR-1")).length, 0);
    assert.equal(f1(await taskOf(mock, "TASK-APR-1"), "Status"), "submitted");
    assert.equal(mock.sent.length, 0);

    await node.run({ once: true });
    const task = await taskOf(mock, "TASK-APR-1");
    const requests = await authRequests(mock, "TASK-APR-1");
    assert.equal(requests.length, 1);
    assert.equal(f1(requests[0], "To_Node"), "hub");
    assert.equal(f1(requests[0], "From_Node"), "node-a");
    assert.equal(f1(task, "Status"), "auth-required");
    assert.equal(f1(task, "Status_Msg"), f1(requests[0], "Msg_ID"));
    assert.equal(String(f1(task, "Claimed_By") ?? ""), "");
    assert.equal(fs.existsSync(marker), false);
    const dataParts = (await mock.findRecords(TABLES.parts, "Parent_ID", f1(requests[0], "Msg_ID")))
      .filter((part) => f1(part, "Kind") === "data");
    assert.equal(dataParts.length, 0);

    assert.equal(await approval.scan(), 1);
    assert.equal((await authRequests(mock, "TASK-APR-1")).length, 1);
    assert.match(cardText(mock), /待审批 · node-a\/echo/);
    assert.doesNotMatch(cardText(mock), /执行中请求授权/);
    assert.equal(mock.sent.length, 1);

    const restarted = approvalFor(dir, mock, new Kernel(kernelCfg(dir, mock, "hub", "hub")));
    assert.equal(await restarted.scan(), 0);
    assert.equal((await authRequests(mock, "TASK-APR-1")).length, 1);
    assert.equal(mock.sent.length, 1);
    assert.equal(f1(await taskOf(mock, "TASK-APR-1"), "Status"), "auth-required");
  });
});

// 红线：消息列表暂时看不见已有 auth_request 时，同一 client_token 仍只能命中原行。
test("静态门 client_token 在重扫看不见原消息时仍不插入第二条", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: echoCommand(),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    await seedTask(mock, {
      Task_ID: "TASK-TOK-1",
      Context_ID: "CTX-TOK-1",
      Approval_Class: "approve",
    });
    assert.equal(await node.askApproval(await taskOf(mock, "TASK-TOK-1")), true);
    assert.equal((await authRequests(mock, "TASK-TOK-1")).length, 1);

    await mock.updateRecord(TABLES.tasks, (await taskOf(mock, "TASK-TOK-1")).record_id, {
      Status: "submitted",
      Status_Msg: "",
      Claimed_By: "",
    });
    const origList = mock.listRecords.bind(mock);
    mock.listRecords = async (table) => {
      if (table === TABLES.messages) return [];
      return origList(table);
    };
    const idempotentBefore = mock.journal.filter((item) => item.op === "create" && item.idempotent).length;
    const again = await new Kernel(kernelCfg(dir, mock, "node-a", "node"))
      .askApproval(await taskOf(mock, "TASK-TOK-1"));
    assert.equal(again, true);
    const idempotentAfter = mock.journal.filter((item) => item.op === "create" && item.idempotent).length;
    assert.equal(idempotentAfter, idempotentBefore + 1);
    mock.listRecords = origList;
    const requests = await authRequests(mock, "TASK-TOK-1");
    assert.equal(requests.length, 1);
    assert.equal(f1(await taskOf(mock, "TASK-TOK-1"), "Status_Msg"), f1(requests[0], "Msg_ID"));
    assert.equal(f1(await taskOf(mock, "TASK-TOK-1"), "Status"), "auth-required");
  });
});

// 红线：认领前批准把任务放回 submitted。节点第二次才执行，全程仍只有一条静态请求。
test("节点静态门批准后才执行到 completed", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: echoCommand(),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
      name: "echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const hub = new Kernel(kernelCfg(dir, mock, "hub", "hub"));
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, hub);
    await seedTask(mock, {
      Task_ID: "TASK-GO-1",
      Context_ID: "CTX-GO-1",
      Approval_Class: "approve",
    });
    await node.run({ once: true });
    const pending = await taskOf(mock, "TASK-GO-1");
    const requestId = f1(pending, "Status_Msg");
    assert.equal(f1(pending, "Status"), "auth-required");
    assert.equal(String(f1(pending, "Claimed_By") ?? ""), "");

    const toast = await decide(approval, pending, requestId, "approve");
    assert.equal(toast.toast.type, "info");
    assert.equal(toast.toast.content, "已批准");
    assert.equal(toast.card.type, "raw");
    const released = await taskOf(mock, "TASK-GO-1");
    assert.equal(f1(released, "Status"), "submitted");
    assert.equal(f1(released, "Status_Msg"), requestId);
    const decision = (await mock.listRecords(TABLES.messages)).find((row) =>
      f1(row, "Kind") === "auth_decision" && f1(row, "Task_ID") === "TASK-GO-1");
    assert.equal(f1(decision, "From_Node"), "hub");
    assert.equal(f1(decision, "Role"), "user");
    assert.equal(f1(decision, "In_Reply_To"), requestId);
    const data = (await mock.findRecords(TABLES.parts, "Parent_ID", f1(decision, "Msg_ID")))
      .find((part) => f1(part, "Kind") === "data");
    assert.deepEqual(JSON.parse(f1(data, "Data")), { decision: "approve" });

    await node.run({ once: true });
    const done = await taskOf(mock, "TASK-GO-1");
    assert.equal(f1(done, "Status"), "completed");
    assert.equal(f1(done, "Claimed_By"), "node-a");
    assert.equal((await authRequests(mock, "TASK-GO-1")).length, 1);
    const result = (await mock.listRecords(TABLES.messages)).find((row) =>
      f1(row, "Kind") === "result" && f1(row, "Task_ID") === "TASK-GO-1");
    assert.ok(result);
    assert.equal(f1(result, "To_Node"), "hub");
  });
});

// 红线：驳回由 hub 写 canceled。节点扫表不得把这张单认领执行。
test("驳回后任务 canceled，节点不会认领", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    writeCommands(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const hub = new Kernel(kernelCfg(dir, mock, "hub", "hub"));
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, hub);
    await seedTask(mock, {
      Task_ID: "TASK-NO-1",
      Context_ID: "CTX-NO-1",
      Approval_Class: "approve",
    });
    await node.run({ once: true });
    const pending = await taskOf(mock, "TASK-NO-1");
    const toast = await decide(approval, pending, f1(pending, "Status_Msg"), "reject");
    assert.equal(toast.toast.type, "info");
    assert.equal(toast.toast.content, "已驳回");
    assert.equal(f1(await taskOf(mock, "TASK-NO-1"), "Status"), "canceled");

    await node.run({ once: true });
    const task = await taskOf(mock, "TASK-NO-1");
    assert.equal(f1(task, "Status"), "canceled");
    assert.equal(String(f1(task, "Claimed_By") ?? ""), "");
    assert.equal(fs.existsSync(marker), false);
    assert.equal((await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-NO-1")).length, 0);
    assert.equal((await authRequests(mock, "TASK-NO-1")).length, 1);
    const decision = (await mock.listRecords(TABLES.messages)).find((row) =>
      f1(row, "Kind") === "auth_decision" && f1(row, "Task_ID") === "TASK-NO-1");
    assert.equal(f1(decision, "From_Node"), "hub");
    assert.equal(f1(decision, "Role"), "user");
    assert.deepEqual(
      JSON.parse(f1(
        (await mock.findRecords(TABLES.parts, "Parent_ID", f1(decision, "Msg_ID")))
          .find((part) => f1(part, "Kind") === "data"),
        "Data",
      )),
      { decision: "reject" },
    );
  });
});

// 红线：Claimed_By 已有值时批准不得把任务打回 submitted。
test("执行中批准保持 auth-required，不写 submitted", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: echoCommand(),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const hub = new Kernel(kernelCfg(dir, mock, "hub", "hub"));
    const approval = approvalFor(dir, mock, hub);
    await seedTask(mock, {
      Task_ID: "TASK-DYN-1",
      Context_ID: "CTX-DYN-1",
      Approval_Class: "auto",
      Status: "auth-required",
      Claimed_By: "node-a",
      Status_Msg: "MSG-DYN-1-02",
    });
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-DYN-1-02",
      Task_ID: "TASK-DYN-1",
      Context_ID: "CTX-DYN-1",
      From_Node: "node-a",
      To_Node: "hub",
      Role: "agent",
      Kind: "auth_request",
      Created_At: "2026-01-15T09:05:00+0800",
    });
    const pending = await taskOf(mock, "TASK-DYN-1");
    const toast = await decide(approval, pending, "MSG-DYN-1-02", "approve");
    assert.equal(toast.toast.type, "info");
    assert.equal(toast.toast.content, "已批准");
    const after = await taskOf(mock, "TASK-DYN-1");
    assert.equal(f1(after, "Status"), "auth-required");
    assert.equal(f1(after, "Claimed_By"), "node-a");
    assert.equal(f1(after, "Status_Msg"), "MSG-DYN-1-02");
    assert.equal(mock.journal.some((item) =>
      item.op === "update" && item.table === TABLES.tasks && f1({ fields: item.fields }, "Status") === "submitted"), false);
  });
});

// 红线：不是行级 approve 的任务 hub 不提前写。本机 approval_class 只在节点认领时收紧。
test("非 approve 任务不提前审批，本地下限仍在认领时触发", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    writeCommands(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
      approval_class: "approve",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const hub = new Kernel(kernelCfg(dir, mock, "hub", "hub"));
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, hub);
    await seedTask(mock, {
      Task_ID: "TASK-AUTO-1",
      Context_ID: "CTX-AUTO-1",
      Approval_Class: "auto",
    });
    await seedTask(mock, {
      Task_ID: "TASK-NOTE-1",
      Context_ID: "CTX-NOTE-1",
      Approval_Class: "notify",
    });
    assert.equal(await approval.scan(), 0);
    assert.equal((await mock.listRecords(TABLES.messages)).some((row) => f1(row, "Kind") === "auth_request"), false);

    await node.run({ once: true });
    for (const taskId of ["TASK-AUTO-1", "TASK-NOTE-1"]) {
      const task = await taskOf(mock, taskId);
      assert.equal(f1(task, "Status"), "auth-required");
      assert.equal(String(f1(task, "Claimed_By") ?? ""), "");
      const requests = await authRequests(mock, taskId);
      assert.equal(requests.length, 1);
      assert.equal(f1(requests[0], "To_Node"), "hub");
      assert.equal(f1(requests[0], "From_Node"), "node-a");
      assert.equal(f1(task, "Status_Msg"), f1(requests[0], "Msg_ID"));
    }
    assert.equal(fs.existsSync(marker), false);

    assert.equal(await approval.scan(), 2);
    assert.match(cardText(mock), /待审批 · node-a\/echo/);
    assert.doesNotMatch(cardText(mock), /执行中请求授权/);
    assert.equal((await authRequests(mock, "TASK-AUTO-1")).length, 1);
    assert.equal((await authRequests(mock, "TASK-NOTE-1")).length, 1);
  });
});

// 红线：行上没有 approve、本机也没有下限时，认领路径直接执行，不写 auth_request。
test("行级与本机都不是 approve 时认领直接完成", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: echoCommand(),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const hub = new Kernel(kernelCfg(dir, mock, "hub", "hub"));
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, hub);
    await seedTask(mock, {
      Task_ID: "TASK-FREE-1",
      Context_ID: "CTX-FREE-1",
      Approval_Class: "notify",
    });
    await seedTask(mock, { Task_ID: "TASK-FREE-2", Context_ID: "CTX-FREE-2" });
    assert.equal(await approval.scan(), 0);
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-FREE-1"), "Status"), "completed");
    assert.equal(f1(await taskOf(mock, "TASK-FREE-2"), "Status"), "completed");
    assert.equal((await mock.listRecords(TABLES.messages)).some((row) => f1(row, "Kind") === "auth_request"), false);
  });
});
