// 守住 L2 自检回执解析口径（标准 §11.2）：CHECK 行与 json checks 只在完成时收取，不猜自然语言。
import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentReceipt, parseJsonReceipt } from "../src/receipt.mjs";

function logsOf() {
  const lines = [];
  return { lines, log: (msg) => lines.push(String(msg)) };
}

test("agent CHECK 行：同 id 取最后一条、从摘要剔除、无 CHECK 时为 {}", () => {
  const quiet = logsOf();
  const empty = parseAgentReceipt("完成正文\n", quiet.log);
  assert.deepEqual(empty.checks, {});
  assert.equal(empty.summary, "完成正文");
  assert.deepEqual(quiet.lines, []);

  const ok = logsOf();
  const got = parseAgentReceipt([
    "第一行结论",
    "CHECK: c1 fail | 初次未过",
    "CHECK: c2 blocked | 等外部依赖",
    "CHECK: c1 PASS | 重跑已通过",
    "最后一行结论",
  ].join("\n"), ok.log);
  assert.deepEqual(got.checks, {
    c1: { verdict: "pass", evidence: "重跑已通过" },
    c2: { verdict: "blocked", evidence: "等外部依赖" },
  });
  assert.equal(got.summary, "第一行结论\n最后一行结论");
  assert.equal(got.summary.includes("CHECK:"), false);
  assert.deepEqual(ok.lines, []);
});

test("agent CHECK 行：围栏内同形行无效且留在正文，不合法行记日志忽略", () => {
  const forged = logsOf();
  const inFence = parseAgentReceipt([
    "正经结论",
    "```markdown",
    "CHECK: c1 fail | 示例里的假行",
    "```",
    "CHECK: c2 pass | 真实证据",
    "CHECK: c3 maybe | 非法判定",
    "CHECK: bad id pass | 非法 id",
  ].join("\n"), forged.log);

  assert.deepEqual(inFence.checks, {
    c2: { verdict: "pass", evidence: "真实证据" },
  });
  assert.equal(inFence.summary.includes("CHECK: c1 fail | 示例里的假行"), true);
  assert.equal(inFence.summary.includes("c2 pass"), false);
  assert.equal(inFence.summary.includes("c3 maybe"), false);
  assert.equal(forged.lines.length, 2);
  assert.match(forged.lines.join("\n"), /checks 忽略非法行/);
});

test("agent CHECK 行：提问、审批与无效回执上忽略并记日志，不挂到异常上", () => {
  const askLogs = logsOf();
  assert.throws(() => parseAgentReceipt([
    "```agent-ask",
    "请确认目录",
    "```",
    "CHECK: c1 pass | 顺便自检",
  ].join("\n"), askLogs.log), (err) => {
    assert.equal(err.message, "请确认目录");
    assert.equal("checks" in err, false);
    return true;
  });
  assert.match(askLogs.lines.join("\n"), /checks 在 input-required 上忽略/);

  const authLogs = logsOf();
  assert.throws(() => parseAgentReceipt([
    "```agent-auth",
    "要发送外发邮件",
    "```",
    "CHECK: c1 pass",
  ].join("\n"), authLogs.log), (err) => {
    assert.equal(err.message, "要发送外发邮件");
    assert.equal("checks" in err, false);
    return true;
  });
  assert.match(authLogs.lines.join("\n"), /checks 在 auth-required 上忽略/);

  const invalidLogs = logsOf();
  assert.throws(() => parseAgentReceipt("CHECK: c1 pass\n", invalidLogs.log), (err) => {
    assert.equal(err.name, "InvalidReceipt");
    assert.equal("checks" in err, false);
    return true;
  });
  assert.match(invalidLogs.lines.join("\n"), /checks 在 failed 上忽略/);
});

test("json checks：支持字符串与对象两种写法，非法项忽略，无 checks 时为 {}", () => {
  const quiet = logsOf();
  const missing = parseJsonReceipt({ summary: "ok" }, quiet.log);
  assert.deepEqual(missing.checks, {});
  assert.deepEqual(quiet.lines, []);

  const mixed = logsOf();
  const got = parseJsonReceipt({
    summary: "done",
    checks: {
      c1: "PASS",
      c2: { verdict: "fail", evidence: "x".repeat(600) },
      c3: "unknown",
      "bad id": { verdict: "pass" },
    },
  }, mixed.log);
  assert.deepEqual(got.checks, {
    c1: { verdict: "pass", evidence: "" },
    c2: { verdict: "fail", evidence: "x".repeat(500) },
  });
  assert.equal(mixed.lines.length, 2);
  assert.match(mixed.lines.join("\n"), /checks 忽略非法项/);
});

test("json checks：在 need_input 与 need_auth 上忽略并记日志", () => {
  const askLogs = logsOf();
  assert.throws(() => parseJsonReceipt({
    need_input: "缺路径",
    checks: { c1: "pass" },
  }, askLogs.log), (err) => err.message === "缺路径" && !("checks" in err));
  assert.match(askLogs.lines.join("\n"), /checks 在 input-required 上忽略/);

  const authLogs = logsOf();
  assert.throws(() => parseJsonReceipt({
    need_auth: "需要删除数据",
    checks: { c1: "pass" },
  }, authLogs.log), (err) => err.message === "需要删除数据" && !("checks" in err));
  assert.match(authLogs.lines.join("\n"), /checks 在 auth-required 上忽略/);
});
