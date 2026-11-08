// 守住内存总线的字段形态和失败注入：写冲突必须在落库前抛出，不能留下半行。

import assert from "node:assert/strict";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

function bus() {
  return new MockFeishuBus({ tables: TABLES });
}

// 红线：线上字段是单元素数组。测试若存成裸字符串，f1 的调用方会和真实总线分叉。
test("标量写入后以单元素数组读出，f1 取回原值", async () => {
  const mock = bus();
  const created = await mock.createRecord(TABLES.tasks, { Task_ID: "TASK-1", Status: "submitted", Hop_Count: 0 });
  assert.deepEqual(created.record.fields.Status, ["submitted"]);
  assert.equal(f1(created.record, "Status"), "submitted");
  assert.equal(f1(created.record, "Hop_Count"), 0);
  const found = await mock.findRecords(TABLES.tasks, "Status", "submitted");
  assert.equal(found.length, 1);
  await mock.updateRecord(TABLES.tasks, created.record.record_id, { Status: "working" });
  assert.equal(f1(await mock.getRecord(TABLES.tasks, created.record.record_id), "Status"), "working");
});

// 红线：client_token 重试不能插出第二行。Messages 只追加，重复创建必须命中原行。
test("相同 client_token 不插入第二行", async () => {
  const mock = bus();
  const first = await mock.createRecord(TABLES.messages, { Msg_ID: "MSG-1" }, "tok-1");
  const second = await mock.createRecord(TABLES.messages, { Msg_ID: "MSG-2" }, "tok-1");
  assert.equal(second.record.record_id, first.record.record_id);
  assert.equal(f1(second.record, "Msg_ID"), "MSG-1");
  assert.equal((await mock.listRecords(TABLES.messages)).length, 1);
});

// 红线：1254291 一类写冲突由调用方决定是否重试。钩子抛出时表内容保持原样。
test("failNext 在落库前抛出写冲突", async () => {
  const mock = bus();
  const created = await mock.createRecord(TABLES.tasks, { Status: "submitted" });
  mock.failNext({ op: "update", table: TABLES.tasks });
  await assert.rejects(
    () => mock.updateRecord(TABLES.tasks, created.record.record_id, { Status: "working" }),
    /1254291/,
  );
  assert.equal(f1(await mock.getRecord(TABLES.tasks, created.record.record_id), "Status"), "submitted");
  assert.equal(mock.journal.some((item) => item.op === "update"), false);
});
