// 审批卡只展示一次指令。auth_request 正文会把标题和指令再抄一遍，不能再读进卡片。

import assert from "node:assert/strict";
import test from "node:test";
import { buildCard, buildStatusCard } from "../src/hub/cards.mjs";
import { approvalMethods } from "../src/kernel-approval.mjs";

const TASK_ID = "TASK-CARD-1";
const AUTH_ECHO = "任务：重复一遍\n指令摘要：重复一遍\n参数摘要：{}";

function taskRow(fields, recordId = "rec_card") {
  return { record_id: recordId, fields };
}

function cardOf({ title, text, params, worker = "", context = "CTX-SHOULD-STAY-OFF" } = {}) {
  const messages = [
    { fields: { Msg_ID: "MSG-CARD-01", Task_ID: TASK_ID, Kind: "instruction", Created_At: "2026-01-01T00:00:00+0800" } },
    { fields: { Msg_ID: "MSG-CARD-02", Task_ID: TASK_ID, Kind: "auth_request", Created_At: "2026-01-01T00:00:01+0800" } },
  ];
  const parts = [
    { fields: { Parent_ID: "MSG-CARD-01", Kind: "text", Seq: 1, Text: text } },
    { fields: { Parent_ID: "MSG-CARD-02", Kind: "text", Seq: 1, Text: AUTH_ECHO } },
  ];
  if (params) {
    parts.push({ fields: { Parent_ID: "MSG-CARD-01", Kind: "data", Seq: 2, Data: JSON.stringify(params) } });
  }
  const task = taskRow({
    Task_ID: TASK_ID,
    Title: title,
    Target_Node: "grokbot",
    Skill_ID: "agent",
    Worker_Hint: worker,
    Context_ID: context,
    Status_Msg: "MSG-CARD-02",
  });
  return buildCard(task, messages, parts);
}

function bodyOf(card) {
  return card.body.elements.find((el) => el.tag === "markdown").content;
}

function buttonsOf(card) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.tag === "button") found.push(node);
    for (const value of Object.values(node)) walk(value);
  };
  walk(card);
  return found;
}

test("指令只出现一次，不读 auth_request 正文", () => {
  const text = "向飞书 Agent 群发送一条测试消息";
  const card = cardOf({ title: "另一标题", text });
  const body = bodyOf(card);
  assert.equal(body.split(text).length - 1, 1);
  assert.equal(body.includes("指令摘要"), false);
  assert.equal(body.includes("待执行内容"), false);
  assert.equal(JSON.stringify(card).includes(AUTH_ECHO), false);
  assert.equal(JSON.stringify(card).includes("CTX-SHOULD-STAY-OFF"), false);
  assert.equal(card.header.title.content, "待审批 · grokbot/agent");
  assert.equal(card.header.subtitle.content, TASK_ID);
  assert.equal(card.header.template, "orange");
  assert.equal(card.config.update_multi, true);
});

test("标题是指令前缀时不再单独成行", () => {
  const text = "审批流程测试（第二单）：向飞书发一条消息";
  const same = bodyOf(cardOf({ title: text, text }));
  assert.equal(same, text);
  const prefixed = bodyOf(cardOf({ title: "审批流程测试（第二单）", text }));
  assert.equal(prefixed, text);
  const other = bodyOf(cardOf({ title: "第二单", text }));
  assert.deepEqual(other.split("\n"), [text, "第二单"]);
});

test("空参数不显示，有参数时脱敏并截断", () => {
  const text = "发一条消息";
  const empty = bodyOf(cardOf({ title: "别的标题", text }));
  assert.equal(empty.includes("参数"), false);
  const secret = "sk-live-should-not-show";
  const shown = bodyOf(cardOf({
    title: "别的标题",
    text,
    params: { api_key: secret, password: "p@ss", note: "hello" },
  }));
  assert.match(shown, /api_key: \*\*\*/);
  assert.match(shown, /password: \*\*\*/);
  assert.match(shown, /note: hello/);
  assert.equal(shown.includes(secret), false);
  assert.equal(shown.includes("p@ss"), false);
  const long = bodyOf(cardOf({
    title: text,
    text,
    params: { note: "值".repeat(400) },
  }));
  const paramBody = long.split("参数：\n")[1];
  assert.ok(paramBody.length <= 301);
  assert.equal(paramBody.endsWith("…"), true);
});

test("超长指令截断到 300，并指向 lah task why", () => {
  const text = "字".repeat(301);
  const body = bodyOf(cardOf({ title: "短标题", text }));
  assert.equal(body.split("\n")[0], `${"字".repeat(300)}…（全文：lah task why ${TASK_ID}）`);
  assert.equal(body.includes("字".repeat(301)), false);
});

test("执行者只在有 Worker 时出现，按钮带上标题、目标和技能", () => {
  const text = "发一条消息";
  const plain = cardOf({ title: "短标题", text });
  assert.equal(bodyOf(plain).includes("执行者"), false);
  const withWorker = cardOf({ title: "短标题", text, worker: "codex" });
  assert.equal(withWorker.header.title.content, "待审批 · grokbot/codex/agent");
  assert.match(bodyOf(withWorker), /执行者：codex/);
  const buttons = buttonsOf(withWorker);
  assert.deepEqual(buttons.map((btn) => btn.behaviors[0].value.decision), ["approve", "reject"]);
  const approve = buttons[0].behaviors[0].value;
  assert.equal(approve.record_id, "rec_card");
  assert.equal(approve.task_id, TASK_ID);
  assert.equal(approve.status_msg, "MSG-CARD-02");
  assert.equal(approve.title, "短标题");
  assert.equal(approve.target, "grokbot");
  assert.equal(approve.skill, "codex/agent");
  const longTitle = "题".repeat(80);
  const clipped = buttonsOf(cardOf({ title: longTitle, text }))[0].behaviors[0].value.title;
  assert.equal(clipped, "题".repeat(60));
});

test("buildStatusCard 四种状态的颜色与按钮", () => {
  const info = {
    decision: "approve",
    record_id: "rec_card",
    task_id: TASK_ID,
    status_msg: "MSG-CARD-02",
    title: "短标题",
    target: "grokbot",
    skill: "agent",
  };
  const cases = [
    ["approved", "green", "已批准", false],
    ["rejected", "red", "已驳回", false],
    ["expired", "grey", "已失效（任务状态已变化）", false],
    ["failed", "red", "处理失败，可重试", true],
  ];
  for (const [state, template, header, hasButtons] of cases) {
    const note = state === "failed" ? "写表失败" : (state === "expired" ? "状态已是 working" : "");
    const card = buildStatusCard(info, { state, operator: "ou_owner", at: "2026-01-15T10:00:00+0800", note });
    assert.equal(card.schema, "2.0");
    assert.equal(card.config.update_multi, true);
    assert.equal(card.header.template, template);
    assert.equal(card.header.title.content, header);
    assert.equal(card.header.subtitle.content, TASK_ID);
    const buttons = buttonsOf(card);
    assert.equal(buttons.length, hasButtons ? 2 : 0);
    if (state === "approved") assert.match(bodyOf(card), /2026-01-15T10:00:00\+0800/);
    if (state === "expired" || state === "failed") assert.ok(bodyOf(card).includes(note));
    assert.equal(bodyOf(card).includes("ou_owner"), false);
    if (!hasButtons) continue;
    assert.deepEqual(buttons.map((btn) => btn.behaviors[0].value.decision), ["approve", "reject"]);
    const retry = buttons[1].behaviors[0].value;
    assert.equal(retry.title, info.title);
    assert.equal(retry.target, info.target);
    assert.equal(retry.skill, info.skill);
    assert.equal(retry.record_id, info.record_id);
    assert.equal(retry.task_id, info.task_id);
    assert.equal(retry.status_msg, info.status_msg);
  }
  const quiet = buildStatusCard(info, { state: "expired", operator: "ou_owner", at: "t" });
  assert.equal(bodyOf(quiet).includes("ou_owner"), false);
});

test("approvalBody 不重复标题和指令，空参数不写", async () => {
  const title = "审批流程测试（第二单）";
  const instruction = `${title}：向飞书发一条消息`;
  const body = await approvalMethods.approvalBody.call({
    commands: { agent: { name: "agent" } },
    capLabel: () => "agent",
    capKeyOf: () => "agent",
    instructionText: async () => instruction,
    getParams: async () => ({}),
  }, { fields: { Title: title, Skill_ID: "agent" } });
  assert.equal(body.split("\n")[0], "需机主批准后执行");
  assert.match(body, /^能力：agent$/m);
  assert.equal(body.split(instruction).length - 1, 1);
  assert.equal(body.includes("标题："), false);
  assert.equal(body.includes("参数"), false);
  assert.equal(body.includes("指令摘要"), false);

  const secret = await approvalMethods.approvalBody.call({
    commands: {},
    capLabel: () => "codex/agent",
    capKeyOf: () => "",
    instructionText: async () => "去做别的事",
    getParams: async () => ({ token: "sek", n: 1 }),
  }, { fields: { Title: "不相关的标题" } });
  assert.match(secret, /参数：\{/);
  assert.equal(secret.includes("sek"), false);
  assert.match(secret, /标题：不相关的标题/);
  assert.equal(secret.split("去做别的事").length - 1, 1);
});
