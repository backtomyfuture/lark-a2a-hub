// 守住定时调度的期次按配置时区的墙钟算，不用宿主机时区，日与周的组合沿用 Vixie 语义。

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SCHEDULE_TZ,
  formatOccurrenceKey,
  latestOccurrence,
  parseCron,
  resolveScheduleTz,
  wallClock,
} from "../src/hub/schedule.mjs";

// 红线：非法表达式在建单前失败，不能算出一个错位的期次。
test("parseCron 只接受五段，步长和星期 7 可解析", () => {
  assert.throws(() => parseCron("0 9 * *"), /五段/);
  assert.throws(() => parseCron("99 0 * * *"), /越界/);
  const parsed = parseCron("*/15 9 1-2 * 7");
  assert.equal(parsed.minute.has(0), true);
  assert.equal(parsed.minute.has(15), true);
  assert.equal(parsed.minute.has(1), false);
  assert.equal(parsed.dow.has(0), true);
  assert.equal(parsed.dow.has(7), false);
});

// 红线：非法 IANA 名必须抛错。悄悄改用宿主机时区会把北京时间表达式错位 8 小时。
test("resolveScheduleTz 缺省上海，非法时区抛错", () => {
  assert.equal(resolveScheduleTz(""), DEFAULT_SCHEDULE_TZ);
  assert.equal(resolveScheduleTz(" Asia/Shanghai "), "Asia/Shanghai");
  assert.throws(() => resolveScheduleTz("Not/AZone"), /非法时区/);
});

// 红线：同一绝对时刻在上海和 UTC 的墙钟不同，期次键偏移不带冒号。
test("wallClock 与期次键按传入时区而不是本机时区", () => {
  const instant = new Date("2026-01-15T01:45:00.000Z");
  const shanghai = wallClock(instant, "Asia/Shanghai");
  const utc = wallClock(instant, "UTC");
  assert.equal(shanghai.hour, 9);
  assert.equal(shanghai.minute, 45);
  assert.equal(utc.hour, 1);
  assert.equal(utc.minute, 45);
  assert.equal(formatOccurrenceKey(instant, "Asia/Shanghai"), "2026-01-15T09:45:00+0800");
  assert.equal(formatOccurrenceKey(instant, "UTC"), "2026-01-15T01:45:00+0000");
});

// 红线：只触发不晚于 now 的最近一期。上海 09:30 与 UTC 09:00 不是同一个瞬间。
test("latestOccurrence 按配置时区回退到最近一期", () => {
  const now = new Date("2026-01-15T01:45:00.000Z");
  const shanghai = latestOccurrence(parseCron("30 9 * * *"), now, "Asia/Shanghai");
  const utc = latestOccurrence(parseCron("0 9 * * *"), now, "UTC");
  assert.equal(shanghai.toISOString(), "2026-01-15T01:30:00.000Z");
  assert.equal(utc.toISOString(), "2026-01-14T09:00:00.000Z");
});

// 红线：日和周都写了限制时，命中任意一侧即可，不能要求两侧同时满足。
test("latestOccurrence 在日与周都受限时取并集", () => {
  const tuesdayNoon = new Date("2026-01-06T04:30:00.000Z");
  const hit = latestOccurrence(parseCron("0 12 15 * 1"), tuesdayNoon, "Asia/Shanghai");
  assert.equal(hit.toISOString(), "2026-01-05T04:00:00.000Z");
});
