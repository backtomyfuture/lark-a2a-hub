// schedules.json 的自检只告警。坏计划、坏时区都不能让 doctor 改退出码。
// 状态只写临时目录，不读 ~/.hub-node。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { doctor, reportLocalSchedules } from "../src/doctor.mjs";
import { withTemp } from "./helpers.mjs";

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const value = fn();
    return { value, text: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

async function captureAsync(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const value = await fn();
    return { value, text: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("没有 schedules.json 时不增加任何输出", async () => {
  await withTemp(async (dir) => {
    const { value, text } = capture(() => reportLocalSchedules(dir, { tz: "Asia/Shanghai" }));
    assert.equal(value, 0);
    assert.equal(text, "");
  });
});

test("schedules.json 逐条打印，坏条目和坏时区只告警", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      echo: { command: "echo hi", cap_id: "echo", mode: "json", context: "direct" },
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ tz: "Not/AZone", role: "node" }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "schedules.json"), JSON.stringify({
      schedules: [
        { id: "DAILY", enabled: true, cron: "0 9 * * *", cap: "echo", text: "跑" },
        { id: "DAILY", enabled: true, cron: "0 10 * * *", cap: "echo", text: "重复" },
        { id: "BAD", enabled: false, cron: "nope", cap: "echo", text: "坏" },
        { id: "OTHER", enabled: true, cron: "0 8 * * *", cap: "missing", text: "无此能力", command: "echo no" },
      ],
    }), { mode: 0o600 });
    const { value, text } = capture(() => reportLocalSchedules(dir, { tz: "Not/AZone", role: "node" }));
    assert.equal(value, 0);
    assert.match(text, /告警：定时调度时区非法/);
    assert.match(text, /本地计划 DAILY：cron 0 9 \* \* \*，cap echo，启用/);
    assert.match(text, /告警：本地计划 DAILY：cron 0 10 \* \* \*，cap echo，启用；id 重复/);
    assert.match(text, /告警：本地计划 BAD：cron nope，cap echo，未启用；cron 无法解析/);
    assert.match(text, /告警：本地计划 OTHER：cron 0 8 \* \* \*，cap missing，启用；含执行控制键 command/);
    assert.equal(text.includes("✗"), false);
  });
});

test("schedules.json 损坏只告警", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "schedules.json"), "{", { mode: 0o600 });
    const { value, text } = capture(() => reportLocalSchedules(dir, { tz: "Asia/Shanghai" }));
    assert.equal(value, 0);
    assert.match(text, /告警：schedules\.json 损坏/);
    assert.match(text, /定时调度时区：Asia\/Shanghai/);
  });
});

test("doctor 不因 schedules.json 的问题改退出码", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
      role: "node",
      tz: "Not/AZone",
      node: "node-a",
    }), { mode: 0o600 });
    const before = await captureAsync(() => doctor(dir, dir));
    fs.writeFileSync(path.join(dir, "schedules.json"), JSON.stringify({
      schedules: [{ id: "BAD", enabled: true, cron: "nope", cap: "missing", text: "坏" }],
    }), { mode: 0o600 });
    const after = await captureAsync(() => doctor(dir, dir));
    assert.equal(before.value, after.value);
    assert.equal(before.text.includes("本地计划"), false);
    assert.match(after.text, /告警：本地计划 BAD/);
    assert.match(after.text, /告警：定时调度时区非法/);
    const count = (text) => Number(text.match(/doctor: (\d+) 个问题/)?.[1]);
    assert.equal(count(before.text), count(after.text));
  });
});
