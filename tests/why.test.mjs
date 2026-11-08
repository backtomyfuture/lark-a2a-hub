// 守住 task why 只读、文本截断，以及 DataPart 只露出键名、绝不露出值。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import {
  checkLocalOutbox,
  extractDataKeys,
  formatWhyText,
  getTaskWhy,
  summarizeText,
} from "../src/why.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const SECRET = "s3cret-value-should-not-leak";

// 红线：凭据和参数值不能进给人看的诊断输出。
test("extractDataKeys 只返回键名", () => {
  const keys = extractDataKeys(JSON.stringify({
    password: SECRET,
    nested: { token: "abc", names: ["a"] },
    list: [1],
  }));
  assert.deepEqual(keys, ["password", "nested.token", "nested.names[]", "list[]"]);
  assert.equal(keys.join(" ").includes(SECRET), false);
});

// 红线：正文截断，避免把整段指令或错误日志刷进终端。
test("summarizeText 超过 200 字加省略号", () => {
  assert.equal(summarizeText("  abc  "), "abc");
  assert.equal(summarizeText("x".repeat(201)).length, 203);
  assert.equal(summarizeText("x".repeat(201)).endsWith("..."), true);
});

// 红线：任务号若能逃出目录，诊断就会去读配置目录以外的文件。
test("checkLocalOutbox 拒绝非法任务号，损坏文件只报读失败", async () => {
  await withTemp(async (dir) => {
    assert.deepEqual(checkLocalOutbox(dir, "../etc/passwd"), { kernel_outbox: null, inbox_outbox: null });
    const kernelDir = path.join(dir, "outbox");
    fs.mkdirSync(kernelDir, { mode: 0o700 });
    fs.writeFileSync(path.join(kernelDir, "TASK-1.json"), "{", { mode: 0o600 });
    const got = checkLocalOutbox(dir, "TASK-1");
    assert.match(got.kernel_outbox.error, /读取损坏/);
    assert.equal(JSON.stringify(got).includes("password"), false);
  });
});

// 红线：DataPart 在时间线里只显示键名。文本照常摘要，但不把数据值拼进去。
test("formatWhyText 不包含 DataPart 的值", async () => {
  await withTemp(async (dir) => {
    const bus = new MockFeishuBus({ tables: TABLES });
    await bus.createRecord(TABLES.tasks, {
      Task_ID: "TASK-WHY-1",
      Title: "诊断",
      Status: "completed",
      Target_Node: "node-a",
      Source: "hub",
      Skill_ID: "echo",
      Hop_Count: 0,
      Retry_Count: 0,
      Context_ID: "CTX-1",
    });
    await bus.createRecord(TABLES.messages, {
      Msg_ID: "MSG-WHY-1-01",
      Task_ID: "TASK-WHY-1",
      Kind: "instruction",
      From_Node: "hub",
      To_Node: "node-a",
      Role: "user",
      Created_At: "2026-01-15T09:00:00+0800",
    });
    await bus.createRecord(TABLES.parts, {
      Part_ID: "MSG-WHY-1-01-P1",
      Parent_ID: "MSG-WHY-1-01",
      Parent_Type: "message",
      Seq: 1,
      Kind: "text",
      Text: "请处理",
    });
    await bus.createRecord(TABLES.parts, {
      Part_ID: "MSG-WHY-1-01-P2",
      Parent_ID: "MSG-WHY-1-01",
      Parent_Type: "message",
      Seq: 2,
      Kind: "data",
      Data: JSON.stringify({ password: SECRET, name: "visible-key" }),
    });
    const stored = (await bus.listRecords(TABLES.parts)).find((row) => f1(row, "Kind") === "data");
    assert.ok(Array.isArray(stored.fields.Data));

    bus.journal.length = 0;
    const data = await getTaskWhy({ bus, configDir: dir, taskId: "TASK-WHY-1" });
    const dataPart = data.messages[0].parts.find((part) => part.kind === "data");
    assert.deepEqual(dataPart.keys, ["password", "name"]);
    assert.equal(JSON.stringify(dataPart).includes(SECRET), false);
    const text = formatWhyText(data);
    assert.match(text, /参数键: \[password, name\]/);
    assert.equal(text.includes(SECRET), false);
    assert.equal(bus.journal.some((item) => item.op === "create" || item.op === "update"), false);
  });
});
