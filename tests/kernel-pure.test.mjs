// 守住回执语法、控制键拒收、超时夹紧、失败退避水位。这些都是纯函数，不碰总线。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  clampTimeoutSec,
  controlKeysIn,
  loadRetryWatermark,
  parseAgentReceipt,
  parseJsonReceipt,
  retryBackoffMs,
  retryHoldUntil,
  saveRetryWatermark,
} from "../src/kernel.mjs";
import { InvalidReceipt, NeedAuth, NeedInput } from "../src/receipt.mjs";
import { withTemp } from "./helpers.mjs";

// 红线：失败立刻回到 submitted 会连打。第一次 60 秒，之后翻倍，封顶 10 分钟。
test("retryBackoffMs 从 60 秒翻倍并封顶", () => {
  assert.equal(retryBackoffMs(1), 60_000);
  assert.equal(retryBackoffMs(2), 120_000);
  assert.equal(retryBackoffMs(5), 600_000);
  assert.equal(retryBackoffMs(30), 600_000);
  assert.equal(retryBackoffMs("nope"), 60_000);
});

// 红线：水位未到本轮不认领。到点或缺失都返回 0，调用方据此放行。
test("retryHoldUntil 只在未到时刻返回水位", () => {
  const now = 1_700_000_000_000;
  assert.equal(retryHoldUntil({ "TASK-1": { not_before: now + 5 } }, "TASK-1", now), now + 5);
  assert.equal(retryHoldUntil({ "TASK-1": { not_before: now - 1 } }, "TASK-1", now), 0);
  assert.equal(retryHoldUntil({}, "TASK-1", now), 0);
  assert.equal(retryHoldUntil(null, "TASK-1", now), 0);
});

// 红线：水位文件权限 600，损坏或缺失按无水位，不能把守护进程打退出。
test("retry 水位往返、权限 600，损坏文件降级", async () => {
  await withTemp(async (dir) => {
    const logs = [];
    assert.deepEqual(loadRetryWatermark(dir, (msg) => logs.push(msg)), {});
    assert.ok(logs.some((msg) => msg.includes("缺失")));

    const state = { "TASK-9": { not_before: 123456 }, "skip-me": { not_before: "nope" } };
    saveRetryWatermark(dir, state);
    const file = path.join(dir, "retry_state.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(file + ".tmp"), false);
    assert.deepEqual(loadRetryWatermark(dir), { "TASK-9": { not_before: 123456 } });

    fs.writeFileSync(file, "{not json", { mode: 0o600 });
    const bad = [];
    assert.deepEqual(loadRetryWatermark(dir, (msg) => bad.push(msg)), {});
    assert.ok(bad.some((msg) => msg.includes("损坏")));

    fs.writeFileSync(file, "[]", { mode: 0o600 });
    assert.deepEqual(loadRetryWatermark(dir), {});

    fs.writeFileSync(file, JSON.stringify({
      "__proto__": { not_before: 1 },
      constructor: { not_before: 1 },
      "TASK-ok": { not_before: 9 },
      "TASK-bad": [],
    }), { mode: 0o600 });
    assert.deepEqual(loadRetryWatermark(dir), { "TASK-ok": { not_before: 9 } });
  });
});

// 红线：不猜自然语言。只有最后一个完整 agent-ask 围栏才是提问；围栏里的产物行不算。
test("parseAgentReceipt 只认最后一道提问围栏，围栏内产物行无效", () => {
  assert.throws(
    () => parseAgentReceipt("先不管\n```agent-ask\n第一问\n```\n```agent-ask\n第二问\n```\n"),
    (err) => err.message === "第二问",
  );
  const ok = parseAgentReceipt([
    "```",
    "ARTIFACT: /inside",
    "```",
    "做完了",
    "ARTIFACT: /outside",
    "ARTIFACT_NAME: 报告",
  ].join("\n"));
  assert.equal(ok.artifact, "/outside");
  assert.equal(ok.artifact_name, "报告");
  assert.equal(ok.summary.includes("做完了"), true);
});

// 红线：头尾截断后，头里没闭合的围栏不能把尾部回执吞掉。没有摘要是回执无效，不许重跑。
test("parseAgentReceipt 从省略标记之后解析，空摘要无效", () => {
  const text = [
    "```agent-ask",
    "这是头里没闭合的提问",
    "…[中间省略 12 字节]…",
    "尾部结论",
    "ARTIFACT: /tail",
  ].join("\n");
  const got = parseAgentReceipt(text);
  assert.equal(got.summary, "尾部结论");
  assert.equal(got.artifact, "/tail");

  assert.throws(
    () => parseAgentReceipt("…[中间省略 1 字节]…\nARTIFACT: /only"),
    (err) => err.name === "InvalidReceipt",
  );
});

// 红线：json 回执只认约定键。未知顶层键（包括 command）只记日志，不执行。
test("parseJsonReceipt 忽略未知键，need_input 才提问", () => {
  const notes = [];
  const got = parseJsonReceipt(
    { summary: "ok", artifact: "/a", command: "rm -rf /", extra: 1 },
    (msg) => notes.push(msg),
  );
  assert.equal(got.summary, "ok");
  assert.equal(got.artifact, "/a");
  assert.equal("command" in got, false);
  assert.ok(notes[0].includes("command"));
  assert.throws(
    () => parseJsonReceipt({ need_input: "缺参数" }),
    (err) => err.message === "缺参数",
  );
  assert.throws(
    () => parseJsonReceipt(null),
    (err) => err.name === "InvalidReceipt",
  );
});

// 红线：提问和执行中审批共用最后一道完整围栏。空审批说明、两个 JSON 键同时出现都是无效回执。
test("parseAgentReceipt 最后一道 agent-auth 或 agent-ask 才算数", () => {
  assert.throws(
    () => parseAgentReceipt("```agent-ask\n先问\n```\n```agent-auth\n给客户发消息\n```\n"),
    (err) => err instanceof NeedAuth && err.message === "给客户发消息",
  );
  assert.throws(
    () => parseAgentReceipt("```agent-auth\n先批\n```\n```agent-ask\n还缺参数\n```\n"),
    (err) => err instanceof NeedInput && err.message === "还缺参数",
  );
  assert.throws(
    () => parseAgentReceipt("```agent-auth\n\n```\n"),
    (err) => err instanceof InvalidReceipt,
  );
});

test("parseJsonReceipt 拒收同时出现的 need_input 与 need_auth", () => {
  assert.throws(
    () => parseJsonReceipt({ summary: "x", need_input: "问", need_auth: "批" }),
    (err) => err instanceof InvalidReceipt && err.message.includes("不能同时"),
  );
  const blank = parseJsonReceipt({ summary: "ok", need_auth: "  \n" });
  assert.equal(blank.summary, "ok");
  assert.throws(
    () => parseJsonReceipt({ need_auth: "给客户发消息" }),
    (err) => err instanceof NeedAuth && err.message === "给客户发消息",
  );
});

// 红线：命令、目录、语境、Agent、权限只来自 commands.json。唯一例外是 timeout_sec。
test("controlKeysIn 拒收执行控制键，放行 timeout_sec", () => {
  assert.deepEqual(controlKeysIn(null), []);
  assert.deepEqual(controlKeysIn([]), []);
  assert.deepEqual(controlKeysIn({ timeout_sec: 5, n: 1 }), []);
  assert.deepEqual(controlKeysIn({ Command: "id", cwd: "/tmp", context: "direct" }).sort(), ["Command", "context", "cwd"]);
});

// 红线：超时必须落在 [1, max]，避免 NaN 或超长超时占住主循环。
test("clampTimeoutSec 夹到条目上限", () => {
  assert.equal(clampTimeoutSec(undefined, {}), 600);
  assert.equal(clampTimeoutSec(0, { timeout_sec: 40 }), 40);
  assert.equal(clampTimeoutSec(0.2, { timeout_sec: 40 }), 1);
  assert.equal(clampTimeoutSec(100, { timeout_sec: 600, max_timeout_sec: 30 }), 30);
  assert.equal(clampTimeoutSec("nope", { timeout_sec: 15, max_timeout_sec: 30 }), 15);
});
