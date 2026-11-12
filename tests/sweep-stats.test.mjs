// 扫表结束要留下一行计数。状态只写临时目录，不连飞书。
// 串行：都在改 console.log，并行会把行混在一起。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Kernel } from "../src/kernel.mjs";
import { HubRuntime } from "../src/hub/index.mjs";
import { ApprovalService } from "../src/hub/approval.mjs";
import { PresentService } from "../src/hub/present.mjs";
import { StaleService } from "../src/hub/stale.mjs";
import { ScheduleService } from "../src/hub/schedule.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";
import { TABLES, withTemp } from "./helpers.mjs";

function kernelCfg(dir, mock) {
  return {
    node: "node-a",
    role: "node",
    kind: "host",
    zone: "test",
    capPrefix: "test",
    events: false,
    configDir: dir,
    carrierSocket: path.join(dir, "missing.sock"),
    bus: mock,
  };
}

function linesOf(logMock) {
  return logMock.mock.calls.map((call) => call.arguments.map(String).join(" "));
}

function field(line, key) {
  const matched = line.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
  return matched ? matched[1] : "";
}

function listOps(mock) {
  return mock.journal.filter((entry) => entry.op === "list").length;
}

test.describe("扫表统计行", { concurrency: false }, () => {
  test("空闲一轮恰有一行 sweep end，list 等于本轮 listRecords", async (t) => {
    await withTemp(async (dir) => {
      fs.writeFileSync(path.join(dir, "commands.json"), "{}\n", { mode: 0o600 });
      const mock = new MockFeishuBus({ tables: TABLES });
      const kernel = new Kernel(kernelCfg(dir, mock));
      const logMock = t.mock.method(console, "log");
      const before = listOps(mock);
      await kernel.sweepOnce();
      const delta = listOps(mock) - before;
      const sweeps = linesOf(logMock).filter((line) => line.includes(" sweep end "));
      assert.equal(sweeps.length, 1);
      assert.match(sweeps[0], /sweep end ms=\d+ ok=1 list=\d+ get=\d+ write=\d+ other=\d+ backoff=\d+/);
      // 计划按 Tasks×3 + Messages×1 + AgentCards×1 估成 5。实际第一次空闲扫表是 7：
      // serviceDirectFlight 与 present.scan 各多拉一次 Tasks，首次对账再多拉一次 AgentCards。
      // 组成：Tasks×4（在途账本、陈旧回收、认领、呈递）+ AgentCards×2（对账、本机能力）+ Messages×1（呈递）。
      // 第二次起名片哈希已对齐，不再对账，变成 6。这里锁定实测，不把扫表改成 5 次。
      assert.equal(Number(field(sweeps[0], "list")), delta);
      assert.equal(delta, 7);
      assert.equal(field(sweeps[0], "ok"), "1");
    });
  });

  test("计数是自上一行以来的增量", async (t) => {
    await withTemp(async (dir) => {
      fs.writeFileSync(path.join(dir, "commands.json"), "{}\n", { mode: 0o600 });
      const mock = new MockFeishuBus({ tables: TABLES });
      const kernel = new Kernel(kernelCfg(dir, mock));
      const logMock = t.mock.method(console, "log");
      await kernel.sweepOnce();
      const first = linesOf(logMock).filter((line) => line.includes(" sweep end "));
      assert.equal(first.length, 1);
      await mock.getRecord(TABLES.tasks, "rec_missing");
      const before = listOps(mock);
      await kernel.sweepOnce();
      const delta = listOps(mock) - before;
      const second = linesOf(logMock).filter((line) => line.includes(" sweep end ")).slice(1);
      assert.equal(second.length, 1);
      assert.equal(Number(field(second[0], "list")), delta);
      assert.equal(delta, 6);
      assert.equal(Number(field(second[0], "get")), 1);
      assert.notEqual(Number(field(second[0], "list")), Number(field(first[0], "list")) + delta);
    });
  });

  test("扫表抛错仍留下 ok=0", async (t) => {
    await withTemp(async (dir) => {
      fs.writeFileSync(path.join(dir, "commands.json"), "{}\n", { mode: 0o600 });
      const mock = new MockFeishuBus({ tables: TABLES });
      const kernel = new Kernel(kernelCfg(dir, mock));
      // 第一次 Tasks 列表在 serviceDirectFlight 里被吞掉，不会让 sweepOnce 抛错。
      // 第二次是 reclaimStale，异常会冒出来。
      let seen = 0;
      mock.failNext((ctx) => {
        if (ctx.op !== "list" || ctx.table !== TABLES.tasks) return false;
        seen += 1;
        return seen === 2;
      }, new Error("boom"));
      const logMock = t.mock.method(console, "log");
      await assert.rejects(() => kernel.sweepOnce(), /boom/);
      const sweeps = linesOf(logMock).filter((line) => line.includes(" sweep end "));
      assert.equal(sweeps.length, 1);
      assert.equal(field(sweeps[0], "ok"), "0");
      assert.match(sweeps[0], /sweep end ms=\d+ ok=0 /);
      assert.equal(mock.journal.filter((entry) => entry.op === "list" && entry.table === TABLES.tasks).length, 1);
    });
  });

  test("hub 四段各一行，失败段 ok=0 且保留原文案", async () => {
    await withTemp(async (dir) => {
      fs.writeFileSync(path.join(dir, "commands.json"), "{}\n", { mode: 0o600 });
      const tables = { ...TABLES, rules: "tbl_rules" };
      const mock = new MockFeishuBus({ tables });
      const cfg = {
        node: "node-a",
        role: "hub",
        kind: "host",
        zone: "test",
        capPrefix: "test",
        events: false,
        configDir: dir,
        carrierSocket: path.join(dir, "missing.sock"),
        bus: mock,
        tables,
      };
      const lines = [];
      const log = (msg) => lines.push(String(msg));
      const approval = new ApprovalService({
        bus: mock,
        ownerOpenId: "ou_owner",
        statePath: path.join(dir, "approval_state.json"),
        log,
      });
      const present = new PresentService({
        bus: mock,
        nodeName: "node-a",
        role: "hub",
        statePath: path.join(dir, "present_state.json"),
        queuePath: path.join(dir, "present_queue.jsonl"),
        log,
      });
      const stale = new StaleService({
        bus: mock,
        ownerOpenId: "ou_owner",
        statePath: path.join(dir, "stale_state.json"),
        log,
      });
      const schedule = new ScheduleService({ bus: mock, log });
      const runtime = new HubRuntime({ cfg, approval, present, stale, schedule, log });
      await runtime.scanSections();
      const scans = lines.filter((line) => /^scan (approval|present|stale|schedule) /.test(line));
      assert.deepEqual(scans.map((line) => line.split(" ")[1]), ["approval", "present", "stale", "schedule"]);
      for (const line of scans) {
        assert.match(line, /ms=\d+ ok=1 /);
      }
      lines.length = 0;
      present.scan = async () => { throw new Error("present broke"); };
      await runtime.scanSections();
      const text = lines.join("\n");
      assert.match(text, /present scan failed: present broke/);
      const again = lines.filter((line) => /^scan (approval|present|stale|schedule) /.test(line));
      assert.equal(again.length, 4);
      const failed = again.find((line) => line.startsWith("scan present "));
      assert.match(failed, /ok=0/);
      for (const name of ["approval", "stale", "schedule"]) {
        const line = again.find((item) => item.startsWith(`scan ${name} `));
        assert.match(line, /ok=1/);
      }
    });
  });
});
