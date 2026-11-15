// 守住验收层纯函数的口径（标准 §11）。不连总线，不写文件。
import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceIndex, acceptanceLine, buildAcceptance, clampVerifyTimeout, judgeChecks,
  normalizeJsonChecks, parseCheckFlag, parseCheckLine, parseCriteria, verifyEvidenceTail, verifyVerdict,
} from "../src/acceptance.mjs";

const quiet = () => {};

test("没有 acceptance 键是没清单，不是错误", () => {
  assert.deepEqual(parseCriteria({ text: "x" }), { ok: true, criteria: [] });
  assert.deepEqual(parseCriteria(null), { ok: true, criteria: [] });
});

test("清单校验：id、重复、长度、控制字符、数量上限", () => {
  assert.equal(parseCriteria({ acceptance: { criteria: [] } }).ok, false);
  assert.equal(parseCriteria({ acceptance: { criteria: [{ id: "a b", text: "x" }] } }).ok, false);
  assert.match(parseCriteria({ acceptance: { criteria: [{ id: "a", text: "x" }, { id: "a", text: "y" }] } }).error, /重复/);
  assert.equal(parseCriteria({ acceptance: { criteria: [{ id: "a", text: "  " }] } }).ok, false);
  assert.equal(parseCriteria({ acceptance: { criteria: [{ id: "a", text: "x\u0007" }] } }).ok, false);
  assert.equal(parseCriteria({ acceptance: { criteria: [{ id: "a", text: "x", evidence_required: "yes" }] } }).ok, false);
  const many = Array.from({ length: 21 }, (_, i) => ({ id: "c" + i, text: "t" }));
  assert.equal(parseCriteria({ acceptance: { criteria: many } }).ok, false);
  const ok = parseCriteria({ acceptance: { criteria: [{ id: "c1", text: " 有章节\n标题 ", evidence_required: true }] } });
  assert.deepEqual(ok, { ok: true, criteria: [{ id: "c1", text: "有章节\n标题", evidence_required: true }] });
});

test("CHECK 行解析", () => {
  assert.equal(parseCheckLine("ARTIFACT: x"), null);
  assert.deepEqual(parseCheckLine("CHECK: c1 PASS | 见 out.md 第 3 节"), { id: "c1", verdict: "pass", evidence: "见 out.md 第 3 节" });
  assert.deepEqual(parseCheckLine("CHECK: c2 fail"), { id: "c2", verdict: "fail", evidence: "" });
  assert.equal(parseCheckLine("CHECK: c2 maybe").invalid, true);
  assert.equal(parseCheckLine("CHECK: c2").invalid, true);
});

test("json checks 归一：对象或字符串，非法项丢掉", () => {
  const logs = [];
  const out = normalizeJsonChecks({ c1: "pass", c2: { verdict: "fail", evidence: "e" }, "bad id": "pass", c3: "ok" }, (m) => logs.push(m));
  assert.deepEqual(out, { c1: { verdict: "pass", evidence: "" }, c2: { verdict: "fail", evidence: "e" } });
  assert.equal(logs.length, 2);
  assert.deepEqual(normalizeJsonChecks([1], quiet), {});
});

test("--check 旗标解析", () => {
  assert.deepEqual(parseCheckFlag("c1=pass:链接 https://x/y"), { id: "c1", verdict: "pass", evidence: "链接 https://x/y" });
  assert.throws(() => parseCheckFlag("c1"), /--check/);
  assert.throws(() => parseCheckFlag("c1=ok"), /pass/);
});

test("逐条判定：missing、缺证据降级、清单外忽略", () => {
  const criteria = [{ id: "a", text: "t", evidence_required: true }, { id: "b", text: "t" }, { id: "c", text: "t" }];
  const logs = [];
  const checks = judgeChecks(criteria, { a: { verdict: "pass", evidence: "" }, b: { verdict: "fail", evidence: "x" }, z: { verdict: "pass" } }, (m) => logs.push(m));
  assert.deepEqual(checks.map((c) => c.verdict), ["uncertain", "fail", "missing"]);
  assert.ok(checks.every((c) => c.source === "self"));
  assert.match(logs[0], /z/);
});

test("overall 与 DataPart：verify 决定 fail，自检只影响 overall", () => {
  assert.equal(buildAcceptance({}), null);
  const v = buildAcceptance({ verify: { verdict: "fail", exit_code: 2, duration_ms: 10 } });
  assert.equal(v.overall, "fail");
  assert.equal(v.verify.evidence, "captured");
  const c = buildAcceptance({ verify: { verdict: "pass", exit_code: 0 }, criteriaRef: "MSG-1-01", checks: [{ id: "a", verdict: "pass", evidence: "" }, { id: "b", verdict: "missing", evidence: "" }] });
  assert.equal(c.overall, "uncertain");
  assert.equal(c.criteria_ref, "MSG-1-01");
  const idx = acceptanceIndex(c, "MSG-1-03");
  assert.deepEqual(idx, { version: 1, verify: { verdict: "pass", exit_code: 0 }, checks: [{ id: "a", verdict: "pass" }, { id: "b", verdict: "missing" }], overall: "uncertain", msg_id: "MSG-1-03" });
});

test("摘要文案能区分 verify 与自检", () => {
  assert.equal(acceptanceLine(null), "");
  assert.equal(acceptanceLine(buildAcceptance({ verify: { verdict: "fail", exit_code: 2 } })), "验收未通过：执行式验收未通过（verify，退出码 2）");
  const line = acceptanceLine(buildAcceptance({ checks: [{ id: "a", verdict: "pass" }, { id: "b", verdict: "fail" }, { id: "c", verdict: "missing" }] }));
  assert.equal(line, "验收未通过：自检 1/3 通过，1 失败，1 未报（执行方自述）");
});

test("verify 判定、超时夹紧与证据尾部", () => {
  assert.equal(verifyVerdict({ code: 0 }), "pass");
  assert.equal(verifyVerdict({ code: 1 }), "fail");
  assert.equal(verifyVerdict({ code: 0, timedOut: true }), "timeout");
  assert.equal(verifyVerdict({ error: true }), "error");
  assert.equal(clampVerifyTimeout(undefined), 120);
  assert.equal(clampVerifyTimeout(99999), 1800);
  assert.equal(clampVerifyTimeout("30"), 30);
  const tail = verifyEvidenceTail("a".repeat(3000), "ERR", 100);
  assert.equal(tail.length, 101);
  assert.ok(tail.endsWith("\nERR"));
});
