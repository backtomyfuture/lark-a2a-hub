// 守住审批签名（标准 §8.3 第 5 条）：总线不认证写入者，行上的 From_Node=hub 是自报的。
// 节点配了 hub 公钥后，只有 hub 私钥签过的决定才算数；冒写的、抄来的、被改过的都当作不存在。
// 总线是 tests/mocks/mock-bus.mjs。密钥只生成在临时目录。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isHubPublicKey, loadOrCreateHubKey, readHubPublicKey, signDecision, verifyDecision } from "../src/approval-sign.mjs";
import { f1 } from "../src/bus/feishu.mjs";
import { ApprovalService } from "../src/hub/approval.mjs";
import { Kernel } from "../src/kernel.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ECHO = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "src", "executors", "echo.mjs"))}`;
const OWNER = "ou_test_owner";

function kernelFor(dir, mock, node, role, extra = {}) {
  return new Kernel({
    node, role, kind: "host", zone: "test", capPrefix: "test", events: false,
    configDir: dir, carrierSocket: path.join(dir, "missing.sock"), bus: mock, ...extra,
  });
}

async function seedApproveTask(mock, taskId) {
  const msgId = `MSG-${taskId.replace("TASK-", "")}-01`;
  await mock.createRecord(TABLES.messages, {
    Msg_ID: msgId, Task_ID: taskId, Context_ID: "CTX-S", From_Node: "hub", To_Node: "node-a",
    Role: "user", Kind: "instruction", Created_At: "2026-01-15T09:00:00+0800",
  });
  await mock.createRecord(TABLES.parts, {
    Part_ID: `${msgId}-P1`, Parent_ID: msgId, Parent_Type: "message", Seq: 1, Kind: "text", Text: "跑一下",
  });
  await mock.createRecord(TABLES.tasks, {
    Task_ID: taskId, Title: taskId, Source: "hub", Target_Node: "node-a", Skill_ID: "echo",
    Status: "submitted", Context_ID: "CTX-S", Hop_Count: 0, Retry_Count: 0,
    Idempotency_Key: `key-${taskId}`, Approval_Class: "approve",
  });
}

async function taskOf(mock, taskId) {
  return (await mock.findRecords(TABLES.tasks, "Task_ID", taskId))[0];
}

// 任何能写总线的身份都写得出这样一行：字段全对，只是没有 hub 的私钥。
async function forgeDecision(mock, task, data, seq = "90") {
  const taskId = f1(task, "Task_ID");
  const msgId = `MSG-${taskId.replace("TASK-", "")}-${seq}`;
  await mock.createRecord(TABLES.messages, {
    Msg_ID: msgId, Task_ID: taskId, Context_ID: "CTX-S", From_Node: "hub", To_Node: "node-a",
    Role: "user", Kind: "auth_decision", In_Reply_To: f1(task, "Status_Msg"), Created_At: "2026-01-15T09:05:00+0800",
  });
  await mock.createRecord(TABLES.parts, {
    Part_ID: `${msgId}-P1`, Parent_ID: msgId, Parent_Type: "message", Seq: 1, Kind: "data", Data: JSON.stringify(data),
  });
  await mock.updateRecord(TABLES.tasks, task.record_id, { Status: "submitted" });
}

// 起一套 hub + node：node 认领后停在 auth-required。返回各方与待批任务。
async function pendingApproval(dir, { pinned = true } = {}) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({ echo: { command: ECHO, mode: "json", timeout_sec: 30 } }));
  const hubDir = path.join(dir, "hub");
  fs.mkdirSync(hubDir);
  fs.writeFileSync(path.join(hubDir, "commands.json"), "{}");
  const key = loadOrCreateHubKey(hubDir);
  const mock = new MockFeishuBus({ tables: TABLES });
  const node = kernelFor(dir, mock, "node-a", "node", pinned ? { hubPublicKey: key.publicKey } : {});
  const hub = kernelFor(hubDir, mock, "hub", "hub", { hubPublicKey: key.publicKey });
  const approval = new ApprovalService({
    bus: mock, ownerOpenId: OWNER, statePath: path.join(hubDir, "approval_state.json"),
    kernel: hub, log: () => {}, signKey: key.privateKey,
  });
  await seedApproveTask(mock, "TASK-SIG-1");
  await node.run({ once: true });
  const task = await taskOf(mock, "TASK-SIG-1");
  assert.equal(f1(task, "Status"), "auth-required");
  return { mock, node, approval, key, task };
}

test("密钥：首次生成 600 权限的私钥，再读得到同一把公钥", async () => {
  await withTemp(async (dir) => {
    assert.equal(readHubPublicKey(dir), "");
    const first = loadOrCreateHubKey(dir);
    assert.equal(fs.statSync(path.join(dir, "approval_key.pem")).mode & 0o777, 0o600);
    assert.equal(loadOrCreateHubKey(dir).publicKey, first.publicKey);
    assert.equal(readHubPublicKey(dir), first.publicKey);
    assert.equal(isHubPublicKey(first.publicKey), true);
    assert.equal(isHubPublicKey("not-a-key"), false);
  });
});

// 红线：签名绑定任务、请求与决定值。换任何一项都失效，抄别的任务的批准用不了。
test("签名绑定 Task_ID、请求 Msg_ID 与决定值", async () => {
  await withTemp(async (dir) => {
    const key = loadOrCreateHubKey(dir);
    const fields = { taskId: "TASK-1", requestId: "MSG-1-02", decision: "approve" };
    const sig = signDecision(key.privateKey, fields);
    assert.equal(verifyDecision(key.publicKey, fields, sig), true);
    assert.equal(verifyDecision(key.publicKey, { ...fields, taskId: "TASK-2" }, sig), false);
    assert.equal(verifyDecision(key.publicKey, { ...fields, requestId: "MSG-1-04" }, sig), false);
    assert.equal(verifyDecision(key.publicKey, { ...fields, decision: "reject" }, sig), false);
    assert.equal(verifyDecision(key.publicKey, fields, ""), false);
    assert.equal(verifyDecision("garbage", fields, sig), false);
  });
});

// 红线：hub 签过的批准，配了公钥的节点照常执行。
test("hub 签名的批准通过验签，任务执行完成", async () => {
  await withTemp(async (dir) => {
    const { mock, node, approval, task } = await pendingApproval(dir);
    await approval.handleCardAction({
      operator: { open_id: OWNER },
      action: { value: { record_id: task.record_id, task_id: "TASK-SIG-1", status_msg: f1(task, "Status_Msg"), decision: "approve" } },
    });
    const decision = (await mock.findRecords(TABLES.messages, "Kind", "auth_decision"))[0];
    const data = JSON.parse(f1((await mock.findRecords(TABLES.parts, "Parent_ID", f1(decision, "Msg_ID"))).find((p) => f1(p, "Kind") === "data"), "Data"));
    assert.equal(data.alg, "ed25519");
    assert.ok(data.sig);
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-SIG-1"), "Status"), "completed");
  });
});

// 红线：冒写的批准不生效。没签名、乱签、拿别的任务的真签名来贴，都不执行，任务回到 auth-required。
test("冒写的 auth_decision 不执行：无签名、假签名、挪用别的任务的签名", async () => {
  await withTemp(async (dir) => {
    const { mock, node, key, task } = await pendingApproval(dir);
    const stolen = signDecision(key.privateKey, { taskId: "TASK-OTHER", requestId: f1(task, "Status_Msg"), decision: "approve" });
    const forgeries = [
      { decision: "approve" },
      { decision: "approve", alg: "ed25519", sig: Buffer.from("x".repeat(64)).toString("base64") },
      { decision: "approve", alg: "ed25519", sig: stolen },
    ];
    for (const [i, data] of forgeries.entries()) {
      await forgeDecision(mock, await taskOf(mock, "TASK-SIG-1"), data, String(90 + i));
      await node.run({ once: true });
      assert.equal(f1(await taskOf(mock, "TASK-SIG-1"), "Status"), "auth-required", `forgery ${i}`);
    }
    assert.equal((await mock.listRecords(TABLES.runs)).length, 0);
  });
});

// 红线：后写的冒牌决定盖不掉 hub 的真决定。无效的不参与「最新一条」的比较。
test("更晚的冒写驳回不影响已签名的批准", async () => {
  await withTemp(async (dir) => {
    const { mock, node, approval, task } = await pendingApproval(dir);
    await approval.handleCardAction({
      operator: { open_id: OWNER },
      action: { value: { record_id: task.record_id, task_id: "TASK-SIG-1", status_msg: f1(task, "Status_Msg"), decision: "approve" } },
    });
    await forgeDecision(mock, await taskOf(mock, "TASK-SIG-1"), { decision: "reject" }, "95");
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-SIG-1"), "Status"), "completed");
  });
});

// 兼容：没配公钥的节点行为不变（只做前四条校验）。这正是 doctor 要提醒的缺口。
test("未配置 hubPublicKey 的节点仍按自报字段放行", async () => {
  await withTemp(async (dir) => {
    const { mock, node } = await pendingApproval(dir, { pinned: false });
    await forgeDecision(mock, await taskOf(mock, "TASK-SIG-1"), { decision: "approve" });
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-SIG-1"), "Status"), "completed");
  });
});
