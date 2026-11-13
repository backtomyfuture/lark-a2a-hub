// 守住 doctor 的 Worker 分组与旧平表迁移提示口径（标准 v3.8）。
// 确保能力按 Worker 维度分组呈现，不暴露内部能力键，并给出旧平表升级指引。

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCommands } from "../src/config.mjs";
import { describeCommands } from "../src/doctor.mjs";

test("守住三层配置：按 Worker 分组展示通用执行与专长技能，本尊技能单列，不暴露内部能力键", () => {
  const cmds = {
    workers: {
      alpha: { command: "echo alpha {prompt}", mode: "agent", name: "Alpha", desc: "甲", timeout_sec: 30, approval_class: "auto" },
      beta: { command: "echo beta {prompt}", mode: "agent", name: "Beta", desc: "乙", timeout_sec: 30, approval_class: "approve" },
    },
    review: { workers: ["beta"], name: "评审", desc: "看一遍", side_effect: "read", approval_class: "auto" },
    local: { command: "echo local", mode: "json", timeout_sec: 30 },
  };
  const flat = normalizeCommands(cmds);
  const { summary, layout, hints } = describeCommands(cmds, flat, "test", "host");

  // summary 汇总行
  assert.strictEqual(summary, "commands.json：2 个 Worker、2 项技能，共 4 张名片");

  // hints 为空
  assert.strictEqual(hints.length, 0);

  // layout 含 Worker beta 且该行含 专长技能 review
  const betaLine = layout.find((l) => l.includes("Worker beta"));
  assert.ok(betaLine, "layout 应该包含 Worker beta 行");
  assert.ok(betaLine.includes("专长技能 review"), "beta 行应该列出专长技能 review");

  // alpha 那行含「无专长技能」
  const alphaLine = layout.find((l) => l.includes("Worker alpha"));
  assert.ok(alphaLine, "layout 应该包含 Worker alpha 行");
  assert.ok(alphaLine.includes("无专长技能"), "alpha 行应该标明无专长技能");

  // 含 节点本尊技能（非 Worker）：local
  const selfLine = layout.find((l) => l.includes("节点本尊技能（非 Worker）：local"));
  assert.ok(selfLine, "layout 应该包含节点本尊技能（非 Worker）：local");

  // 任何一行都不出现 alpha/agent 这种能力键
  for (const line of layout) {
    assert.strictEqual(line.includes("alpha/agent"), false, `行不应出现能力键 alpha/agent: ${line}`);
    assert.strictEqual(line.includes("beta/agent"), false, `行不应出现能力键 beta/agent: ${line}`);
  }
});

test("守住旧平表迁移：-agent 后缀条目建议迁移到 workers，Cap_ID 保持不变，排除 json 技能", () => {
  const cmds = {
    "agy-agent": { command: "x {prompt}", mode: "agent", cap_id: "CAP-mini-agy-agent" },
    "paseo-agent": { command: "y {prompt}" },
    briefing: { command: "z", mode: "json" },
  };
  const flat = normalizeCommands(cmds);
  const { summary, hints } = describeCommands(cmds, flat, "mini", "host");

  // summary 汇总行
  assert.strictEqual(summary, "commands.json：0 个 Worker、3 项技能，共 3 张名片");

  // 恰好 2 条 hint
  assert.strictEqual(hints.length, 2);

  // 分别含 workers.agy 和 workers.paseo，且都含「不变」
  const agyHint = hints.find((h) => h.includes("workers.agy"));
  const paseoHint = hints.find((h) => h.includes("workers.paseo"));
  assert.ok(agyHint, "应有针对 agy 的迁移提示");
  assert.ok(paseoHint, "应有针对 paseo 的迁移提示");
  assert.ok(agyHint.includes("不变"), "agy 的 Cap_ID 应该保持不变");
  assert.ok(paseoHint.includes("不变"), "paseo 的 Cap_ID 应该保持不变");

  // 每条提示都包含「专长技能」
  for (const h of hints) {
    assert.ok(h.includes("专长技能"), "每条提示都应包含「专长技能」指引");
  }

  // briefing 没有提示
  assert.ok(!hints.some((h) => h.includes("briefing")), "briefing (mode: json) 不应有迁移提示");
});

test("守住旧平表迁移：非 -agent 后缀条目推导建议名，提示 Cap_ID 变更及本地计划适配", () => {
  const cmds = {
    claude: { command: "c {prompt}", cap_id: "CAP-mini-claude" },
  };
  const flat = normalizeCommands(cmds);
  const { hints } = describeCommands(cmds, flat, "mini", "host");

  assert.strictEqual(hints.length, 1);
  const hint = hints[0];
  assert.ok(hint.includes("workers.claude"), "提示应建议迁到 workers.claude");
  assert.ok(hint.includes("变为 CAP-mini-claude-agent"), "提示应告知 Cap_ID 会变为 CAP-mini-claude-agent");
});

test("守住独立 Agent 节点：kind 为 agent 时无迁移提示，layout 标明本尊即 Worker", () => {
  const cmds = {
    agent: { mode: "inbox" },
  };
  const flat = normalizeCommands(cmds);
  const { summary, layout, hints } = describeCommands(cmds, flat, "mini", "agent");

  // summary 汇总行（含本尊）
  assert.strictEqual(summary, "commands.json：1 个 Worker（含本尊）、0 项技能，共 1 张名片");

  // 没有 hint
  assert.strictEqual(hints.length, 0);

  // layout 含「本尊即 Worker」
  assert.ok(layout.some((l) => l.includes("本尊即 Worker")), "layout 应包含「本尊即 Worker」");
});

test("守住重名冲突防范：建议 Worker 名与已有 workers 冲突时提示自选 Worker 名", () => {
  const cmds = {
    workers: {
      agy: { command: "a {prompt}" },
    },
    "agy-agent": { command: "x {prompt}" },
  };
  const flat = normalizeCommands(cmds);
  const { hints } = describeCommands(cmds, flat, "mini", "host");

  const agyAgentHint = hints.find((h) => h.includes("能力 agy-agent"));
  assert.ok(agyAgentHint, "应该对 agy-agent 给出迁移提示");
  assert.ok(agyAgentHint.includes("自选 Worker 名"), "冲突时不应给建议名，而应提示「自选 Worker 名」");
  assert.ok(!agyAgentHint.includes("workers.agy"), "不应建议迁到已存在的 workers.agy");
});
