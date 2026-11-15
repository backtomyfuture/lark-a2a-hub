// carrier 语境已移除。doctor 对残留的 context=carrier 必须报问题并写明原因，不能只当成普通拼写错误放过。
// 状态只写临时目录，不读 ~/.hub-node。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { doctor } from "../src/doctor.mjs";
import { withTemp } from "./helpers.mjs";

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

test("doctor 对 context=carrier 的条目报问题并提示已移除", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ role: "node", node: "node-a" }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      lan: { command: "echo hi", mode: "json", context: "carrier" },
    }), { mode: 0o600 });
    const { text } = await captureAsync(() => doctor(dir, dir));
    assert.match(text, /✗ 能力 lan：context="carrier" 非法（carrier 语境已在本版本移除/);
  });
});
