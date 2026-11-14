// 执行中动态审批：NeedAuth、inbox auth、验签去重、竞态双检、槽忙与终态清理。
// 总线是内存 mock。不读 ~/.hub-node，不打开长连接。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadOrCreateHubKey } from "../src/approval-sign.mjs";
import { f1 } from "../src/bus/feishu.mjs";
import { ApprovalService } from "../src/hub/approval.mjs";
import {
  enqueueOrUpdateInbox,
  handleInboxAuth,
  markInboxStatus,
  popPendingInbox,
  readInbox,
} from "../src/inbox.mjs";
import { Kernel } from "../src/kernel.mjs";
import { formatWhyText, getTaskWhy } from "../src/why.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "ou_test_owner";

function nodeCommand(script) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function kernelCfg(dir, mock, node, role, extra = {}) {
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
    ...extra,
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

async function requestViews(mock, taskId) {
  const views = [];
  for (const req of await authRequests(mock, taskId)) {
    const parts = await mock.findRecords(TABLES.parts, "Parent_ID", f1(req, "Msg_ID"));
    const dataPart = parts.find((part) => f1(part, "Kind") === "data");
    views.push({
      id: f1(req, "Msg_ID"),
      to: f1(req, "To_Node"),
      text: parts.filter((part) => f1(part, "Kind") === "text").map((part) => f1(part, "Text")).join("\n"),
      data: dataPart ? JSON.parse(f1(dataPart, "Data")) : null,
    });
  }
  return views;
}

function approvalFor(dir, mock, kernel, signKey = null) {
  return new ApprovalService({
    bus: mock,
    ownerOpenId: OWNER,
    statePath: path.join(dir, "approval_state.json"),
    signKey,
    log: () => {},
  });
}

async function decide(approval, task, decision) {
  const res = await approval.handleCardAction({
    operator: { open_id: OWNER },
    action: {
      value: {
        record_id: task.record_id,
        task_id: f1(task, "Task_ID"),
        status_msg: f1(task, "Status_Msg"),
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

function scriptCommand(dir, name, source) {
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, source);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
}

// json 模式把信封放在标准输入。脚本放文件里，避免 shell 吃掉换行和反引号。
function jsonAuthCommand(dir, name, body) {
  return scriptCommand(dir, name, `
    import fs from "node:fs";
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      const env = JSON.parse(raw || "{}");
      const approvals = env._hub?.approvals ?? [];
      const marker = process.argv[2] || "";
      ${body}
    });
  `);
}

function listenCarrier(sock) {
  try { fs.unlinkSync(sock); } catch { /* 没有旧套接字 */ }
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === "ping") {
          socket.write(JSON.stringify({ type: "pong", pid: process.pid }) + "\n");
          continue;
        }
        if (frame.type !== "exec") continue;
        const child = spawn(frame.command, { shell: true, cwd: frame.cwd || undefined });
        child.stdin.end(frame.input ?? "");
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("close", (code) => {
          if (socket.destroyed) return;
          socket.write(JSON.stringify({
            id: frame.id, status: "done", code: code ?? 1, stdout, stderr,
          }) + "\n");
        });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => {
      resolve({
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function historicalToken(taskId, scope = "") {
  let input = "lah-auth-request\0" + taskId;
  if (scope) input += "\0" + scope;
  const hex = createHash("sha256").update(input).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

test("静态 client_token 与空 scope 历史哈希逐字节相同", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    assert.equal(node.authRequestToken("TASK-TOK-1"), historicalToken("TASK-TOK-1"));
    assert.equal(node.authRequestToken("TASK-TOK-1", ""), historicalToken("TASK-TOK-1"));
    const runId = "TASK-TOK-1-R1";
    assert.equal(node.authRequestToken("TASK-TOK-1", runId), historicalToken("TASK-TOK-1", runId));
    assert.notEqual(node.authRequestToken("TASK-TOK-1", runId), node.authRequestToken("TASK-TOK-1"));
  });
});

test("direct json 的 NeedAuth 批准后不回 submitted，续跑带上 approvals", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "approvals.json");
    writeCommands(dir, {
      command: `${jsonAuthCommand(dir, "once", `
        if (!approvals.length) {
          process.stdout.write(JSON.stringify({ need_auth: "给客户发消息" }) + "\\n");
          return;
        }
        fs.writeFileSync(marker, JSON.stringify(approvals));
        process.stdout.write(JSON.stringify({ summary: "done" }) + "\\n");
      `)} ${JSON.stringify(marker)}`,
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, node);
    await seedTask(mock, { Task_ID: "TASK-DJ-1", Context_ID: "CTX-DJ-1" });
    await node.run({ once: true });
    const pending = await taskOf(mock, "TASK-DJ-1");
    assert.equal(f1(pending, "Status"), "auth-required");
    assert.equal(f1(pending, "Claimed_By"), "node-a");
    assert.equal(String(f1(pending, "Heartbeat_At") ?? ""), "");
    const views = await requestViews(mock, "TASK-DJ-1");
    assert.equal(views.length, 1);
    assert.equal(views[0].data.scope, "dynamic");
    assert.equal(views[0].text, "给客户发消息");
    assert.equal(fs.existsSync(marker), false);

    const toast = await decide(approval, pending, "approve");
    assert.equal(toast.toast.content, "已批准");
    assert.equal(f1(await taskOf(mock, "TASK-DJ-1"), "Status"), "auth-required");
    assert.equal(await approval.scan(), 1);
    // 卡片要把执行方请求的具体动作写出来，机主批的是它，不是首条指令。
    assert.match(cardText(mock), /执行中请求授权（node-a）[^"]*给客户发消息/);

    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-DJ-1"), "Status"), "completed");
    const seen = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].decision, "approve");
    assert.equal(seen[0].scope, "dynamic");
    assert.equal(seen[0].run_id, views[0].data.run_id);
    assert.equal((await authRequests(mock, "TASK-DJ-1")).length, 1);
  });
});

test("direct agent 批准后续跑改走 resume_command", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "resumed");
    const resumeFile = path.join(dir, "resume.mjs");
    fs.writeFileSync(resumeFile, `import fs from "node:fs";\nfs.writeFileSync(process.argv[3], process.argv[2] || "");\nconsole.log("续跑完成");\n`);
    writeCommands(dir, {
      command: scriptCommand(dir, "agent-auth", 'process.stdout.write("```agent-auth\\n给客户发消息\\n```\\nSESSION: sess-auth-1\\n");\n'),
      resume_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resumeFile)} {session} ${JSON.stringify(marker)}`,
      mode: "agent",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, node);
    await seedTask(mock, { Task_ID: "TASK-DA-1", Context_ID: "CTX-DA-1" });
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-DA-1"), "Status"), "auth-required");
    assert.equal(fs.existsSync(path.join(dir, "runs", "TASK-DA-1", "session.json")), true);
    await decide(approval, await taskOf(mock, "TASK-DA-1"), "approve");
    assert.equal(f1(await taskOf(mock, "TASK-DA-1"), "Status"), "auth-required");
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-DA-1"), "Status"), "completed");
    assert.equal(fs.readFileSync(marker, "utf8"), "sess-auth-1");
    const input = JSON.parse(fs.readFileSync(path.join(dir, "runs", "TASK-DA-1", "input.json"), "utf8"));
    assert.equal(input.approvals.length, 1);
    assert.equal(input.approvals[0].decision, "approve");
  });
});

test("carrier 的 NeedAuth 用 openRunId 续跑并带上 approvals", async () => {
  const sock = path.join("/tmp", `lah-c-${process.pid}-${Date.now().toString(36)}.sock`);
  const carrier = await listenCarrier(sock);
  try {
    await withTemp(async (dir) => {
      const marker = path.join(dir, "approvals.json");
      writeCommands(dir, {
        command: `${jsonAuthCommand(dir, "carrier", `
          if (!approvals.length) {
            process.stdout.write(JSON.stringify({ need_auth: "经终端代发" }) + "\\n");
            return;
          }
          fs.writeFileSync(marker, JSON.stringify(approvals));
          process.stdout.write(JSON.stringify({ summary: "done" }) + "\\n");
        `)} ${JSON.stringify(marker)}`,
        mode: "json",
        context: "carrier",
        timeout_sec: 30,
        cap_id: "CAP-test-echo",
      });
      const mock = new MockFeishuBus({ tables: TABLES });
      const node = new Kernel(kernelCfg(dir, mock, "node-a", "node", { carrierSocket: sock }));
      const approval = approvalFor(dir, mock, node);
      await seedTask(mock, { Task_ID: "TASK-DC-1", Context_ID: "CTX-DC-1" });
      await node.run({ once: true });
      const pending = await taskOf(mock, "TASK-DC-1");
      assert.equal(f1(pending, "Status"), "auth-required");
      assert.equal(f1(pending, "Claimed_By"), "node-a");
      const views = await requestViews(mock, "TASK-DC-1");
      assert.equal(views[0].data.scope, "dynamic");
      assert.ok(views[0].data.run_id);
      await decide(approval, pending, "approve");
      assert.equal(f1(await taskOf(mock, "TASK-DC-1"), "Status"), "auth-required");
      await node.run({ once: true });
      assert.equal(f1(await taskOf(mock, "TASK-DC-1"), "Status"), "completed");
      const seen = JSON.parse(fs.readFileSync(marker, "utf8"));
      assert.equal(seen[0].run_id, views[0].data.run_id);
      assert.equal((await authRequests(mock, "TASK-DC-1")).length, 1);
    });
  } finally {
    await carrier.close();
    try { fs.unlinkSync(sock); } catch { /* 套接字已删 */ }
  }
});

test("inbox auth 写总线前即 waiting-auth，批准后刷新 pending", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: "true",
      mode: "inbox",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, node);
    await seedTask(mock, { Task_ID: "TASK-IN-1", Context_ID: "CTX-IN-1" });
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-IN-1"), "Status"), "working");
    assert.equal(popPendingInbox(dir).length, 1);

    const origCreate = mock.createRecord.bind(mock);
    mock.createRecord = async (table, fields, token) => {
      if (table === TABLES.messages && fields?.Kind === "auth_request") {
        assert.equal(readInbox(dir).find((row) => row.task_id === "TASK-IN-1").status, "waiting-auth");
        assert.equal(popPendingInbox(dir).length, 0);
      }
      return origCreate(table, fields, token);
    };
    await handleInboxAuth({
      bus: mock, configDir: dir, node: "node-a", taskId: "TASK-IN-1", text: "给客户发消息",
    });
    const pending = await taskOf(mock, "TASK-IN-1");
    assert.equal(f1(pending, "Status"), "auth-required");
    assert.equal(f1(pending, "Claimed_By"), "node-a");
    const views = await requestViews(mock, "TASK-IN-1");
    assert.equal(views.length, 1);
    assert.equal(views[0].to, "hub");
    assert.equal(views[0].data.scope, "dynamic");
    assert.equal(views[0].data.run_id, f1(pending, "Latest_Run"));
    assert.equal(views[0].text, "给客户发消息");
    assert.equal(popPendingInbox(dir).length, 0);

    const before = readInbox(dir).find((row) => row.task_id === "TASK-IN-1").claimed_at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const toast = await decide(approval, pending, "approve");
    assert.equal(toast.toast.content, "已批准");
    assert.equal(f1(await taskOf(mock, "TASK-IN-1"), "Status"), "auth-required");
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-IN-1"), "Status"), "working");
    const item = readInbox(dir).find((row) => row.task_id === "TASK-IN-1");
    assert.equal(item.status, "pending");
    assert.ok(item.claimed_at > before);
    assert.equal(item.auth_decision.status, "approved");
    assert.equal(item.auth_decision.request_msg_id, views[0].id);
    assert.equal(item.approvals.length, 1);
    assert.equal(popPendingInbox(dir).length, 1);
  });
});

test("同一任务两次动态审批使用不同 runId，paused 重试仍复用 flight.runId", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: jsonAuthCommand(dir, "multi", `
        if (approvals.length === 0) {
          process.stdout.write(JSON.stringify({ need_auth: "第一笔：给客户甲发消息" }) + "\\n");
          return;
        }
        if (approvals.length === 1) {
          process.stdout.write(JSON.stringify({ need_auth: "第二笔：给客户乙转账" }) + "\\n");
          return;
        }
        process.stdout.write(JSON.stringify({ summary: "两笔都批了" }) + "\\n");
      `),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, node);
    await seedTask(mock, { Task_ID: "TASK-MULTI-1", Context_ID: "CTX-MULTI-1" });
    await node.run({ once: true });
    assert.equal(await approval.scan(), 1);
    await decide(approval, await taskOf(mock, "TASK-MULTI-1"), "approve");
    await node.run({ once: true });
    assert.equal(await approval.scan(), 1);
    assert.equal(mock.sent.length, 2);
    await decide(approval, await taskOf(mock, "TASK-MULTI-1"), "approve");
    const views = await requestViews(mock, "TASK-MULTI-1");
    assert.equal(views.length, 2);
    assert.notEqual(views[0].data.run_id, views[1].data.run_id);
    assert.notEqual(
      node.authRequestToken("TASK-MULTI-1", views[0].data.run_id),
      node.authRequestToken("TASK-MULTI-1", views[1].data.run_id),
    );
    assert.equal(f1(await taskOf(mock, "TASK-MULTI-1"), "Status"), "auth-required");
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-MULTI-1"), "Status"), "completed");
  });
});

test("writeRun 已 paused 后第二次收口仍复用 flight.runId，不发第二张卡", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: nodeCommand(`process.stdout.write(JSON.stringify({ need_auth: "给客户发消息" }) + "\\n")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, node);
    await seedTask(mock, { Task_ID: "TASK-RETRYAUTH-1", Context_ID: "CTX-RETRYAUTH-1" });
    let failOnce = true;
    const origUpdate = mock.updateRecord.bind(mock);
    mock.updateRecord = async (table, id, fields) => {
      if (failOnce && table === TABLES.tasks && fields?.Status === "auth-required") {
        failOnce = false;
        throw new Error("injected auth write failure");
      }
      return origUpdate(table, id, fields);
    };
    // once 会在飞行账本还在时再扫一轮。第一次落 auth-required 失败后，下一轮必须复用同一个 runId。
    await node.run({ once: true });
    const task = await taskOf(mock, "TASK-RETRYAUTH-1");
    assert.equal(f1(task, "Status"), "auth-required");
    const views = await requestViews(mock, "TASK-RETRYAUTH-1");
    assert.equal(views.length, 1);
    const flightRunId = views[0].data.run_id;
    assert.notEqual(f1(task, "Latest_Run"), flightRunId);
    const runs = await mock.findRecords(TABLES.runs, "Task_Ref", "TASK-RETRYAUTH-1");
    assert.equal(runs.some((row) => f1(row, "Run_ID") === flightRunId && f1(row, "Outcome") === "paused"), true);
    assert.ok(runs.length >= 2);
    assert.equal(await approval.scan(), 1);
    assert.equal(mock.sent.length, 1);
    await node.run({ once: true });
    assert.equal(mock.sent.length, 1);
    assert.equal((await authRequests(mock, "TASK-RETRYAUTH-1")).length, 1);
  });
});

test("伪造决定不续跑，也不挡住随后的合法签名点击", async () => {
  await withTemp(async (dir) => {
    const { privateKey, publicKey } = loadOrCreateHubKey(dir);
    writeCommands(dir, {
      command: nodeCommand(`process.stdout.write(JSON.stringify({ need_auth: "给客户发消息" }) + "\\n")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node", { hubPublicKey: publicKey }));
    await seedTask(mock, { Task_ID: "TASK-FORGE-1", Context_ID: "CTX-FORGE-1" });
    await node.run({ once: true });
    const pending = await taskOf(mock, "TASK-FORGE-1");
    const requestId = f1(pending, "Status_Msg");
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-FORGE-1-09",
      Task_ID: "TASK-FORGE-1",
      Context_ID: "CTX-FORGE-1",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Kind: "auth_decision",
      In_Reply_To: requestId,
      Created_At: "2026-01-15T09:06:00+0800",
    });
    await mock.createRecord(TABLES.parts, {
      Part_ID: "MSG-FORGE-1-09-P1",
      Parent_ID: "MSG-FORGE-1-09",
      Parent_Type: "message",
      Seq: 1,
      Kind: "data",
      Data: JSON.stringify({ decision: "approve" }),
    });
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-FORGE-1"), "Status"), "auth-required");

    const approval = approvalFor(dir, mock, node, privateKey);
    // 先发卡，状态文件里才有 message_id，后台换卡才有地方可换。
    assert.equal(await approval.scan(), 1);
    const first = await decide(approval, await taskOf(mock, "TASK-FORGE-1"), "approve");
    assert.equal(first.toast.type, "info");
    assert.equal(f1(await taskOf(mock, "TASK-FORGE-1"), "Status"), "auth-required");
    const signed = (await mock.listRecords(TABLES.messages)).filter((row) =>
      f1(row, "Kind") === "auth_decision" && f1(row, "Task_ID") === "TASK-FORGE-1");
    assert.equal(signed.length, 2);

    const restarted = approvalFor(dir, mock, node, privateKey);
    const second = await decide(restarted, await taskOf(mock, "TASK-FORGE-1"), "approve");
    // 回调先交回终态卡；重启后内存去重已空，后台按总线验签发现已处理，不再写决定并把卡换成已失效。
    assert.equal(second.toast.type, "info");
    assert.match(mock.cardUpdates.at(-1).content, /该审批已处理/);
    const after = (await mock.listRecords(TABLES.messages)).filter((row) =>
      f1(row, "Kind") === "auth_decision" && f1(row, "Task_ID") === "TASK-FORGE-1");
    assert.equal(after.length, 2);
    assert.equal(f1(await taskOf(mock, "TASK-FORGE-1"), "Status"), "auth-required");
  });
});

test("节点后写的 working 盖住撤单后，双检落 failed 且不执行", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    writeCommands(dir, {
      command: `${jsonAuthCommand(dir, "race", `
        if (!approvals.length) {
          process.stdout.write(JSON.stringify({ need_auth: "给客户发消息" }) + "\\n");
          return;
        }
        fs.writeFileSync(marker, "ran");
        process.stdout.write(JSON.stringify({ summary: "done" }) + "\\n");
      `)} ${JSON.stringify(marker)}`,
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, node);
    await seedTask(mock, { Task_ID: "TASK-RACE-1", Context_ID: "CTX-RACE-1" });
    await node.run({ once: true });
    const pending = await taskOf(mock, "TASK-RACE-1");
    await decide(approval, pending, "approve");
    const statusMsg = f1(pending, "Status_Msg");
    const origUpdate = mock.updateRecord.bind(mock);
    let armed = false;
    mock.updateRecord = async (table, id, fields) => {
      if (!armed && table === TABLES.tasks && fields?.Status === "working") {
        armed = true;
        await mock.createRecord(TABLES.messages, {
          Msg_ID: "MSG-RACE-1-90",
          Task_ID: "TASK-RACE-1",
          Context_ID: "CTX-RACE-1",
          From_Node: "hub",
          To_Node: "node-a",
          Role: "agent",
          Kind: "notice",
          In_Reply_To: statusMsg,
          Created_At: "2026-01-15T09:07:00+0800",
        });
        await origUpdate(TABLES.tasks, id, { Status: "canceled" });
      }
      return origUpdate(table, id, fields);
    };
    await node.run({ once: true });
    const task = await taskOf(mock, "TASK-RACE-1");
    assert.equal(armed, true);
    assert.equal(f1(task, "Status"), "failed");
    assert.equal(fs.existsSync(marker), false);
    const notes = (await mock.listRecords(TABLES.messages)).filter((row) =>
      f1(row, "Kind") === "notice" && f1(row, "Task_ID") === "TASK-RACE-1" && f1(row, "From_Node") === "node-a");
    assert.equal(notes.length, 1);
    assert.notEqual(f1(notes[0], "In_Reply_To"), statusMsg);
  });
});

test("inbox 续跑被撤单双检拦住时不放回 pending", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: "true",
      mode: "inbox",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, node);
    await seedTask(mock, { Task_ID: "TASK-INR-1", Context_ID: "CTX-INR-1" });
    await node.run({ once: true });
    await handleInboxAuth({
      bus: mock, configDir: dir, node: "node-a", taskId: "TASK-INR-1", text: "给客户发消息",
    });
    const pending = await taskOf(mock, "TASK-INR-1");
    await decide(approval, pending, "approve");
    const statusMsg = f1(pending, "Status_Msg");
    const origUpdate = mock.updateRecord.bind(mock);
    mock.updateRecord = async (table, id, fields) => {
      if (table === TABLES.tasks && fields?.Status === "working") {
        await mock.createRecord(TABLES.messages, {
          Msg_ID: "MSG-INR-1-90",
          Task_ID: "TASK-INR-1",
          Context_ID: "CTX-INR-1",
          From_Node: "hub",
          To_Node: "node-a",
          Role: "agent",
          Kind: "notice",
          In_Reply_To: statusMsg,
          Created_At: "2026-01-15T09:08:00+0800",
        });
        await origUpdate(TABLES.tasks, id, { Status: "canceled" });
      }
      return origUpdate(table, id, fields);
    };
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-INR-1"), "Status"), "failed");
    assert.notEqual(readInbox(dir).find((row) => row.task_id === "TASK-INR-1").status, "pending");
    assert.equal(popPendingInbox(dir).length, 0);
  });
});

test("direct 槽忙时推迟 auth 续跑", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    writeCommands(dir, {
      command: `${jsonAuthCommand(dir, "slot", `
        if (!approvals.length) {
          process.stdout.write(JSON.stringify({ need_auth: "给客户发消息" }) + "\\n");
          return;
        }
        fs.writeFileSync(marker, "ran");
        process.stdout.write(JSON.stringify({ summary: "done" }) + "\\n");
      `)} ${JSON.stringify(marker)}`,
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, node);
    await seedTask(mock, { Task_ID: "TASK-SLOT-1", Context_ID: "CTX-SLOT-1" });
    await node.run({ once: true });
    await decide(approval, await taskOf(mock, "TASK-SLOT-1"), "approve");
    node._directFlight = { taskId: "BUSY" };
    await node.resumeAuthCheck(await taskOf(mock, "TASK-SLOT-1"));
    assert.equal(f1(await taskOf(mock, "TASK-SLOT-1"), "Status"), "auth-required");
    assert.equal(fs.existsSync(marker), false);
    node._directFlight = null;
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-SLOT-1"), "Status"), "completed");
    assert.equal(fs.existsSync(marker), true);
  });
});

test("canceled 后清掉 session 与收件箱，pop 不再返回", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: nodeCommand(`process.stdout.write(JSON.stringify({ summary: "idle" }) + "\\n")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    await seedTask(mock, {
      Task_ID: "TASK-CLEAN-1",
      Context_ID: "CTX-CLEAN-1",
      Status: "canceled",
      Claimed_By: "node-a",
    });
    enqueueOrUpdateInbox(dir, { task_id: "TASK-CLEAN-1", text: "还在" });
    const sessionDir = path.join(dir, "runs", "TASK-CLEAN-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({ session: "sess-clean" }));
    fs.writeFileSync(path.join(sessionDir, "session.json.tmp"), "{}");
    await node.run({ once: true });
    assert.equal(fs.existsSync(path.join(sessionDir, "session.json")), false);
    assert.equal(fs.existsSync(path.join(sessionDir, "session.json.tmp")), false);
    assert.equal(readInbox(dir).find((row) => row.task_id === "TASK-CLEAN-1").status, "canceled");
    assert.equal(popPendingInbox(dir).length, 0);
  });
});

test("input-required 上的静态门因 Claimed_By 非空走续跑", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    writeCommands(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdout.write(JSON.stringify({ summary: "done" }) + "\\n")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
      approval_class: "approve",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const approval = approvalFor(dir, mock, node);
    await seedTask(mock, {
      Task_ID: "TASK-INP-1",
      Context_ID: "CTX-INP-1",
      Status: "input-required",
      Claimed_By: "node-a",
      Status_Msg: "MSG-INP-1-02",
      Approval_Class: "auto",
    });
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-INP-1-02",
      Task_ID: "TASK-INP-1",
      Context_ID: "CTX-INP-1",
      From_Node: "node-a",
      To_Node: "hub",
      Role: "agent",
      Kind: "question",
      Created_At: "2026-01-15T09:02:00+0800",
    });
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-INP-1-03",
      Task_ID: "TASK-INP-1",
      Context_ID: "CTX-INP-1",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Kind: "answer",
      Created_At: "2026-01-15T09:03:00+0800",
    });
    await node.run({ once: true });
    const gated = await taskOf(mock, "TASK-INP-1");
    assert.equal(f1(gated, "Status"), "auth-required");
    assert.equal(f1(gated, "Claimed_By"), "node-a");
    const views = await requestViews(mock, "TASK-INP-1");
    assert.equal(views.length, 1);
    assert.equal(views[0].data, null);
    assert.equal(fs.existsSync(marker), false);
    const toast = await decide(approval, gated, "approve");
    assert.equal(toast.toast.content, "已批准");
    assert.equal(f1(await taskOf(mock, "TASK-INP-1"), "Status"), "auth-required");
    await node.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-INP-1"), "Status"), "completed");
    assert.equal(fs.existsSync(marker), true);
    assert.equal((await authRequests(mock, "TASK-INP-1")).length, 1);
  });
});

test("why 显示 waiting-auth，已批准时提示续跑且不泄露 DataPart 值", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    await seedTask(mock, {
      Task_ID: "TASK-WHY-1",
      Context_ID: "CTX-WHY-1",
      Status: "auth-required",
      Claimed_By: "node-a",
      Status_Msg: "MSG-WHY-1-02",
    });
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-WHY-1-02",
      Task_ID: "TASK-WHY-1",
      Context_ID: "CTX-WHY-1",
      From_Node: "node-a",
      To_Node: "hub",
      Role: "agent",
      Kind: "auth_request",
      Created_At: "2026-01-15T09:04:00+0800",
    });
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-WHY-1-03",
      Task_ID: "TASK-WHY-1",
      Context_ID: "CTX-WHY-1",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Kind: "auth_decision",
      In_Reply_To: "MSG-WHY-1-02",
      Created_At: "2026-01-15T09:05:00+0800",
    });
    await mock.createRecord(TABLES.parts, {
      Part_ID: "MSG-WHY-1-03-P1",
      Parent_ID: "MSG-WHY-1-03",
      Parent_Type: "message",
      Seq: 1,
      Kind: "data",
      Data: JSON.stringify({ decision: "approve", sig: "SUPERSECRET" }),
    });
    enqueueOrUpdateInbox(dir, { task_id: "TASK-WHY-1", text: "待批" });
    const { markInboxStatus } = await import("../src/inbox.mjs");
    markInboxStatus(dir, "TASK-WHY-1", "waiting-auth", { auth_reason: "给客户发消息" });
    const data = await getTaskWhy({ bus: mock, configDir: dir, taskId: "TASK-WHY-1" });
    assert.equal(data.inbox.status, "waiting-auth");
    assert.equal(data.inbox.auth_reason, "给客户发消息");
    assert.equal(data.auth_hint, "已批准，等待原节点续跑");
    const text = formatWhyText(data);
    assert.match(text, /已批准，等待原节点续跑/);
    assert.match(text, /waiting-auth/);
    assert.match(text, /给客户发消息/);
    assert.equal(text.includes("SUPERSECRET"), false);
    const decision = data.messages.find((row) => row.kind === "auth_decision");
    const dataPart = decision.parts.find((part) => part.kind === "data");
    assert.deepEqual(dataPart.keys.sort(), ["decision", "sig"]);
  });
});

test("静态门不认动态批准：本机下限要求 approve 时仍另写一条静态请求", async () => {
  await withTemp(async (dir) => {
    const marker = path.join(dir, "ran");
    writeCommands(dir, {
      command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdout.write(JSON.stringify({ summary: "done" }) + "\\n")`),
      mode: "json",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
      approval_class: "approve",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    await seedTask(mock, { Task_ID: "TASK-STAT-1", Context_ID: "CTX-STAT-1", Approval_Class: "auto" });
    // 先前某次执行段留下的、已被批准的动态请求。它不是这条本机下限要的那一次审批。
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-STAT-1-02", Task_ID: "TASK-STAT-1", Context_ID: "CTX-STAT-1",
      From_Node: "node-a", To_Node: "hub", Role: "agent", Kind: "auth_request",
      Created_At: "2026-01-15T09:01:00+0800",
    });
    await mock.createRecord(TABLES.parts, {
      Part_ID: "MSG-STAT-1-02-P1", Parent_ID: "MSG-STAT-1-02", Parent_Type: "message",
      Seq: 1, Kind: "data", Data: JSON.stringify({ scope: "dynamic", run_id: "TASK-STAT-1-R1" }),
    });
    await mock.createRecord(TABLES.messages, {
      Msg_ID: "MSG-STAT-1-03", Task_ID: "TASK-STAT-1", Context_ID: "CTX-STAT-1",
      From_Node: "hub", To_Node: "node-a", Role: "user", Kind: "auth_decision",
      In_Reply_To: "MSG-STAT-1-02", Created_At: "2026-01-15T09:02:00+0800",
    });
    await mock.createRecord(TABLES.parts, {
      Part_ID: "MSG-STAT-1-03-P1", Parent_ID: "MSG-STAT-1-03", Parent_Type: "message",
      Seq: 1, Kind: "data", Data: JSON.stringify({ decision: "approve" }),
    });

    await node.run({ once: true });
    const gated = await taskOf(mock, "TASK-STAT-1");
    assert.equal(f1(gated, "Status"), "auth-required");
    assert.equal(fs.existsSync(marker), false);
    const views = await requestViews(mock, "TASK-STAT-1");
    assert.equal(views.length, 2);
    const fresh = views.find((view) => view.id !== "MSG-STAT-1-02");
    assert.equal(fresh.data, null);
    assert.equal(f1(gated, "Status_Msg"), fresh.id);
  });
});

test("inbox 条目在 waiting-auth 时，总线仍是 working 也不被心跳回收", async () => {
  await withTemp(async (dir) => {
    writeCommands(dir, {
      command: "true",
      mode: "inbox",
      context: "direct",
      timeout_sec: 30,
      cap_id: "CAP-test-echo",
    });
    const mock = new MockFeishuBus({ tables: TABLES });
    const node = new Kernel(kernelCfg(dir, mock, "node-a", "node"));
    const staleHeartbeat = "2026-01-15T09:00:00+0800";
    await seedTask(mock, {
      Task_ID: "TASK-WAIT-1", Context_ID: "CTX-WAIT-1",
      Status: "working", Claimed_By: "node-a", Heartbeat_At: staleHeartbeat,
    });
    enqueueOrUpdateInbox(dir, { task_id: "TASK-WAIT-1", from_node: "hub", claimed_at: Date.now() });
    markInboxStatus(dir, "TASK-WAIT-1", "waiting-auth");

    await node.run({ once: true });
    const row = await taskOf(mock, "TASK-WAIT-1");
    assert.equal(f1(row, "Status"), "working");
    assert.equal(f1(row, "Claimed_By"), "node-a");
    assert.equal(Number(f1(row, "Retry_Count")) || 0, 0);
    assert.notEqual(f1(row, "Heartbeat_At"), staleHeartbeat);
  });
});
