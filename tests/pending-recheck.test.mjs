// 挂起任务的复查节奏：本节点有 input-required / auth-required 时缩短等待，挂久了回到对账周期。
// 不连真实 Base，唤醒器用假时钟驱动。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Kernel, PENDING_RECHECK, pendingRecheckCapMs } from "../src/kernel.mjs";
import { createWsWaker } from "../src/transport/ws.mjs";
import { createPollWaker } from "../src/transport/poll.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

function fakeClock() {
  let ticks = 0;
  return {
    get ticks() { return ticks; },
    async sleep(ms) {
      assert.equal(ms, 1000);
      ticks += 1;
    },
  };
}

function makeKernel(dir) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({ echo: { command: "true", mode: "json" } }), { mode: 0o600 });
  return new Kernel({
    node: "node-a",
    role: "node",
    kind: "host",
    zone: "test",
    capPrefix: "test",
    events: false,
    configDir: dir,
    carrierSocket: path.join(dir, "missing.sock"),
    bus: new MockFeishuBus({ tables: TABLES }),
  });
}

function row(fields) {
  return { record_id: "rec-" + fields.Task_ID, fields };
}

test("pendingRecheckCapMs：按挂起时长分档，超过最后一档不缩短", () => {
  const now = 10_000_000;
  assert.equal(pendingRecheckCapMs([], now), Infinity);
  assert.equal(pendingRecheckCapMs([now - 5_000], now), 60_000);
  assert.equal(pendingRecheckCapMs([now - 30 * 60_000], now), 180_000);
  const last = PENDING_RECHECK[PENDING_RECHECK.length - 1][0];
  assert.equal(pendingRecheckCapMs([now - last * 1000], now), Infinity);
  // 多个挂起任务取最紧的一档。
  assert.equal(pendingRecheckCapMs([now - 30 * 60_000, now - 1_000], now), 60_000);
});

test("Kernel.trackPending：只记本节点名下的挂起任务，Status_Msg 变了重新计时", async () => {
  await withTemp(async (dir) => {
    const kernel = makeKernel(dir);
    const t0 = 1_000_000;
    kernel.trackPending([
      row({ Task_ID: "TASK-A", Target_Node: "node-a", Status: "auth-required", Status_Msg: "MSG-A-02", Claimed_By: "node-a" }),
      row({ Task_ID: "TASK-B", Target_Node: "node-b", Status: "auth-required", Status_Msg: "MSG-B-02" }),
      row({ Task_ID: "TASK-C", Target_Node: "node-a", Status: "working" }),
    ], t0);
    assert.equal(kernel._pendingSince.size, 1);
    assert.equal(kernel.pendingWaitCapMs(t0 + 1000), 60_000);

    // 挂了 70 分钟：回到不缩短。
    const late = t0 + 70 * 60_000;
    kernel.trackPending([
      row({ Task_ID: "TASK-A", Target_Node: "node-a", Status: "auth-required", Status_Msg: "MSG-A-02", Claimed_By: "node-a" }),
    ], late);
    assert.equal(kernel.pendingWaitCapMs(late), Infinity);

    // 同一任务又提问：新 Status_Msg 重新计时。
    kernel.trackPending([
      row({ Task_ID: "TASK-A", Target_Node: "node-a", Status: "input-required", Status_Msg: "MSG-A-04", Claimed_By: "node-a" }),
    ], late);
    assert.equal(kernel.pendingWaitCapMs(late + 1000), 60_000);

    // 挂起解除后不再缩短。
    kernel.trackPending([
      row({ Task_ID: "TASK-A", Target_Node: "node-a", Status: "completed", Status_Msg: "MSG-A-05" }),
    ], late + 2000);
    assert.equal(kernel.pendingWaitCapMs(late + 2000), Infinity);
  });
});

test("WsWaker.wait：capMs 只缩短等待，不拉长", async () => {
  const clients = [];
  const clock = fakeClock();
  const waker = createWsWaker(
    { role: "node", appId: "cli_1", appSecret: "sec", pollSec: 45, sweepSec: 900 },
    {
      sleep: clock.sleep,
      createClient: (opts) => {
        const c = { opts, start: () => Promise.resolve(), close() {} };
        clients.push(c);
        return c;
      },
    },
  );
  waker.start(() => {});
  clients[0].opts.onReady();
  await waker.wait(() => false, { capMs: 60_000 });
  assert.equal(clock.ticks, 60);
  let start = clock.ticks;
  await waker.wait(() => false, { capMs: Infinity });
  assert.equal(clock.ticks - start, 900);
  start = clock.ticks;
  await waker.wait(() => false, { capMs: 5_000_000 });
  assert.equal(clock.ticks - start, 900);
  waker.stop();
});

test("PollWaker.wait：capMs 小于 pollSec 时按 capMs", async () => {
  const waker = createPollWaker({ pollSec: 2 });
  waker.start(() => {});
  const t0 = Date.now();
  await waker.wait(() => false, { capMs: 1000 });
  const spent = Date.now() - t0;
  assert.ok(spent >= 900 && spent < 1900, "spent " + spent);
  waker.stop();
});
