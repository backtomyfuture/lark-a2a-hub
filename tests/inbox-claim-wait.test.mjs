// 关单等认领：守护认领迟到（VM 替换、接口抖动）时，lah inbox done/ask/fail 不应被
// 「认领者为空」直接拒掉。只对目标是本节点、尚未被认领的任务有界等待；
// 目标不对或已被他人认领时立刻按原错误失败，归属校验不放宽。

import assert from "node:assert/strict";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { handleInboxDone, handleInboxFail } from "../src/inbox.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

async function seedTask(mock, fields) {
  const created = await mock.createRecord(TABLES.tasks, {
    Source: "cron",
    Target_Node: "node-a",
    Status: "submitted",
    Hop_Count: 0,
    Retry_Count: 0,
    Claimed_By: "",
    Context_ID: "CTX-1",
    ...fields,
  });
  return created.record;
}

async function taskOf(mock, taskId) {
  const rows = await mock.findRecords(TABLES.tasks, "Task_ID", taskId);
  return rows[0];
}

// 在第 flipOn 次读 tasks 表时，先把任务改成 working + 本节点认领，再返回结果。
function flipToClaimedAfterLists(mock, recordId, flipOn) {
  const orig = mock.listRecords.bind(mock);
  let seen = 0;
  mock.listRecords = async (table) => {
    if (table === TABLES.tasks) {
      seen += 1;
      if (seen === flipOn) {
        await mock.updateRecord(TABLES.tasks, recordId, { Status: "working", Claimed_By: "node-a" });
      }
    }
    return orig(table);
  };
}

test("认领迟到时 done 等到认领落定后正常关单", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    const rec = await seedTask(mock, { Task_ID: "TASK-WAIT-1" });
    flipToClaimedAfterLists(mock, rec.record_id, 3);
    const started = Date.now();
    const receipt = await handleInboxDone({
      bus: mock, configDir: dir, node: "node-a",
      taskId: "TASK-WAIT-1", text: "办完了",
      claimWait: { waitMs: 5000, pollMs: 5 },
    });
    assert.equal(receipt.taskId, "TASK-WAIT-1");
    assert.ok(Date.now() - started < 5000);
    assert.equal(f1(await taskOf(mock, "TASK-WAIT-1"), "Status"), "completed");
  });
});

test("一直没人认领时等满上限后仍按原错误拒绝", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    await seedTask(mock, { Task_ID: "TASK-WAIT-2" });
    const started = Date.now();
    await assert.rejects(
      handleInboxFail({
        bus: mock, configDir: dir, node: "node-a",
        taskId: "TASK-WAIT-2", text: "终止",
        claimWait: { waitMs: 60, pollMs: 5 },
      }),
      /任务当前认领者是/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 55, `应等满上限再报错，实际 ${elapsed}ms`);
    assert.equal(f1(await taskOf(mock, "TASK-WAIT-2"), "Status"), "submitted");
  });
});

test("已被他人认领时不等待、立刻拒绝", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    await seedTask(mock, { Task_ID: "TASK-WAIT-3", Status: "working", Claimed_By: "node-b" });
    const started = Date.now();
    await assert.rejects(
      handleInboxDone({
        bus: mock, configDir: dir, node: "node-a",
        taskId: "TASK-WAIT-3", text: "办完了",
        claimWait: { waitMs: 5000, pollMs: 5 },
      }),
      /任务当前认领者是 node-b/,
    );
    assert.ok(Date.now() - started < 1000, "他人认领不应进入等待");
  });
});

test("目标不是本节点时不等待、立刻拒绝", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    await seedTask(mock, { Task_ID: "TASK-WAIT-4", Target_Node: "node-b" });
    const started = Date.now();
    await assert.rejects(
      handleInboxDone({
        bus: mock, configDir: dir, node: "node-a",
        taskId: "TASK-WAIT-4", text: "办完了",
        claimWait: { waitMs: 5000, pollMs: 5 },
      }),
      /任务目标节点是 node-b/,
    );
    assert.ok(Date.now() - started < 1000, "目标不对不应进入等待");
  });
});

test("已认领 working 的任务照常立即关单（回归）", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    await seedTask(mock, { Task_ID: "TASK-WAIT-5", Status: "working", Claimed_By: "node-a" });
    const started = Date.now();
    await handleInboxDone({
      bus: mock, configDir: dir, node: "node-a",
      taskId: "TASK-WAIT-5", text: "办完了",
      claimWait: { waitMs: 5000, pollMs: 5 },
    });
    assert.ok(Date.now() - started < 1000);
    assert.equal(f1(await taskOf(mock, "TASK-WAIT-5"), "Status"), "completed");
  });
});
