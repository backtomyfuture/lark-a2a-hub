// 守住三层寻址（标准 v3.7）：Node / Worker / Skill。
// Worker 只是本机 commands.json 白名单里的选择键；写了就是硬约束，留空由节点取默认并在认领时回填。
// 总线是 tests/mocks/mock-bus.mjs。不读 ~/.hub-node，不取凭据。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { f1 } from "../src/bus/feishu.mjs";
import { capIdOf, capIdsOf, controlKeysIn, normalizeCommands, resolveCapKey } from "../src/config.mjs";
import { createTask, parseCreateArgv } from "../src/hub/create.mjs";
import { Kernel } from "../src/kernel.mjs";
import { buildAgentCommands } from "../src/setup.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ECHO = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "src", "executors", "echo.mjs"))}`;

// 两个 json 型 Worker，都用 echo 当启动模板，方便看是谁跑的。
function layered() {
  return {
    workers: {
      alpha: { command: ECHO, mode: "json", name: "Alpha", desc: "甲", timeout_sec: 30, approval_class: "auto" },
      beta: { command: ECHO, mode: "json", name: "Beta", desc: "乙", timeout_sec: 30, approval_class: "approve" },
    },
    review: { workers: ["beta", "alpha"], name: "评审", desc: "看一遍", side_effect: "read", approval_class: "auto" },
    local: { command: ECHO, mode: "json", timeout_sec: 30 },
  };
}

function setup(dir, commands) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(commands), { mode: 0o600 });
  const mock = new MockFeishuBus({ tables: TABLES });
  const kernel = new Kernel({
    node: "node-a", role: "node", kind: "host", zone: "test", capPrefix: "test",
    events: false, configDir: dir, carrierSocket: path.join(dir, "missing.sock"), bus: mock,
  });
  return { mock, kernel };
}

async function seedTask(mock, fields) {
  const taskId = fields.Task_ID;
  const msgId = `MSG-${taskId.replace("TASK-", "")}-01`;
  await mock.createRecord(TABLES.messages, {
    Msg_ID: msgId, Task_ID: taskId, Context_ID: "CTX-W", From_Node: "hub", To_Node: "node-a",
    Role: "user", Kind: "instruction", Created_At: "2026-01-15T09:00:00+0800",
  });
  await mock.createRecord(TABLES.parts, {
    Part_ID: `${msgId}-P1`, Parent_ID: msgId, Parent_Type: "message", Seq: 1, Kind: "text", Text: "跑一下",
  });
  await mock.createRecord(TABLES.tasks, {
    Title: taskId, Source: "hub", Target_Node: "node-a", Status: "submitted", Context_ID: "CTX-W",
    Hop_Count: 0, Retry_Count: 0, Idempotency_Key: `key-${taskId}`, ...fields,
  });
}

async function taskOf(mock, taskId) {
  return (await mock.findRecords(TABLES.tasks, "Task_ID", taskId))[0];
}

// 红线：没有 workers 键的旧配置含义不变，Cap_ID 不变。
test("旧的扁平 commands.json 归一后原样通过", () => {
  const flat = { echo: { command: "x", cap_id: "CAP-old-echo" }, plain: { command: "y" } };
  assert.deepEqual(normalizeCommands(flat), flat);
  assert.deepEqual([...capIdsOf(flat, "p")].sort(), ["CAP-old-echo", "CAP-p-plain"]);
  assert.equal(resolveCapKey(flat, "plain"), "plain");
});

// 红线：启动方式只归 Worker；本地审批下限取 Worker 与 Skill 中更严者，技能条目不能放松。
test("归一：专长技能绑定 Worker，通用技能 agent 自动生成，审批取严", () => {
  const flat = normalizeCommands(layered());
  assert.deepEqual(Object.keys(flat), ["beta/review", "alpha/review", "local", "alpha/agent", "beta/agent"]);
  assert.equal(flat["beta/review"].command, ECHO);
  assert.equal(flat["beta/review"].worker, "beta");
  assert.equal(flat["beta/review"].skill, "review");
  assert.equal(flat["beta/review"].name, "评审");
  assert.equal(flat["beta/review"].approval_class, "approve");
  assert.equal(flat["alpha/review"].approval_class, "auto");
  assert.equal(flat["alpha/agent"].name, "Alpha");
  assert.equal(capIdOf("alpha/agent", flat["alpha/agent"], "p"), "CAP-p-alpha-agent");
  assert.equal(capIdOf("beta/review", flat["beta/review"], "p"), "CAP-p-beta-review");
  // 归一是幂等的：再归一一遍不变。
  assert.deepEqual(normalizeCommands(flat), flat);
});

// 红线：坏掉的那一项不登记并报出来，其余能力照常。
test("归一：未定义的 Worker、缺 command、command 与 workers 并写都只废掉那一项", () => {
  const problems = [];
  const flat = normalizeCommands({
    workers: { ok: { command: "run {prompt}" }, broken: { name: "没命令" }, "bad name": { command: "x" } },
    a: { workers: ["ok", "ghost"] },
    b: { workers: ["ok"], command: "also" },
  }, (msg) => problems.push(msg));
  assert.deepEqual(Object.keys(flat), ["ok/a", "ok/agent"]);
  assert.equal(problems.length, 4);
});

// 红线：指定 Worker 是硬约束；留空时节点本尊优先，否则取第一个登记了该技能的 Worker。
test("resolveCapKey：硬约束与默认 Worker", () => {
  const flat = normalizeCommands(layered());
  assert.equal(resolveCapKey(flat, "review", "alpha"), "alpha/review");
  assert.equal(resolveCapKey(flat, "review", "ghost"), "");
  assert.equal(resolveCapKey(flat, "local", "alpha"), "");
  assert.equal(resolveCapKey(flat, "review"), "beta/review");
  assert.equal(resolveCapKey(flat, "agent"), "alpha/agent");
  assert.equal(resolveCapKey(flat, "local"), "local");
  assert.equal(resolveCapKey(flat, "nope"), "");
});

// 红线：Worker 不能从任务参数里点。
test("任务参数里的 worker 是执行控制键", () => {
  assert.deepEqual(controlKeysIn({ worker: "alpha", n: 1 }), ["worker"]);
});

// 红线：名片一行是 Node × Worker × Skill，Worker 留空＝节点本尊。
// v3.8：通用能力不登记名片，名册只有真实 Skill。
test("名片登记带 Worker 列，Skill_ID 是技能名而不是能力键", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, layered());
    await kernel.run({ once: true });
    const cards = await mock.listRecords(TABLES.agentCards);
    const row = (capId) => cards.find((c) => f1(c, "Cap_ID") === capId);
    assert.equal(cards.length, 3);
    assert.equal(f1(row("CAP-test-alpha-review"), "Worker"), "alpha");
    assert.equal(f1(row("CAP-test-alpha-review"), "Skill_ID"), "review");
    assert.equal(f1(row("CAP-test-beta-review"), "Worker"), "beta");
    assert.equal(row("CAP-test-alpha-agent"), undefined);
    assert.equal(row("CAP-test-beta-agent"), undefined);
    assert.equal(f1(row("CAP-test-local"), "Worker"), "");
  });
});

// v3.8 迁移：v3.7 登记过的通用卡，升级后由名片对账自动停派（行保留，不删）。
// 注：run({ once: true }) 是一次性对账模式、按设计跳过停派段，这里直接调常驻对账路径。
test("旧通用卡被对账置 Dispatchable=No", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, layered());
    await mock.createRecord(TABLES.agentCards, {
      Cap_ID: "CAP-test-alpha-agent", Node: "node-a", Skill_ID: "agent", Worker: "alpha", Dispatchable: "Yes",
    });
    await kernel.reconcileCards(false);
    const cards = await mock.listRecords(TABLES.agentCards);
    const old = cards.find((c) => f1(c, "Cap_ID") === "CAP-test-alpha-agent");
    assert.equal(f1(old, "Dispatchable"), "No");
  });
});

// v3.8：独立 Agent 节点的本尊即 Worker，配了 workerName 就写进名片 Worker 列。
test("kind=agent 的名片 Worker 列写 workerName", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables: TABLES });
    const kernel = new Kernel({
      node: "hub", role: "hub", kind: "agent", zone: "test", capPrefix: "hub",
      events: false, configDir: dir, carrierSocket: path.join(dir, "missing.sock"), bus: mock,
      workerName: "muse",
    });
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({ agent: { mode: "inbox" } }), { mode: 0o600 });
    await kernel.run({ once: true });
    const cards = await mock.listRecords(TABLES.agentCards);
    assert.equal(cards.length, 1);
    assert.equal(f1(cards[0], "Cap_ID"), "CAP-hub-agent");
    assert.equal(f1(cards[0], "Worker"), "muse");
  });
});

// 红线：指定的 Worker 执行，Runs.Worker 记实际执行者。
test("指定 Worker 的任务由该 Worker 执行，Runs.Worker 如实记录", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, layered());
    await seedTask(mock, { Task_ID: "TASK-W-1", Skill_ID: "review", Worker_Hint: "alpha" });
    await kernel.run({ once: true });
    const task = await taskOf(mock, "TASK-W-1");
    assert.equal(f1(task, "Status"), "completed");
    assert.equal(f1(task, "Worker_Hint"), "alpha");
    const run = (await mock.listRecords(TABLES.runs)).find((r) => f1(r, "Task_Ref") === "TASK-W-1");
    assert.equal(f1(run, "Worker"), "alpha");
  });
});

// 红线：留空由节点取默认，并在认领时回填，后续重试与续跑钉在同一个 Worker 上。
test("未指定 Worker 时取默认并回填 Worker_Hint", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, layered());
    await seedTask(mock, { Task_ID: "TASK-W-2", Skill_ID: "agent" });
    await kernel.run({ once: true });
    const task = await taskOf(mock, "TASK-W-2");
    assert.equal(f1(task, "Status"), "completed");
    assert.equal(f1(task, "Worker_Hint"), "alpha");
  });
});

// 红线：节点本尊直接执行的能力不回填 Worker，Runs.Worker 记 daemon。
test("节点本尊的能力不回填 Worker_Hint", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, layered());
    await seedTask(mock, { Task_ID: "TASK-W-3", Skill_ID: "local" });
    await kernel.run({ once: true });
    const task = await taskOf(mock, "TASK-W-3");
    assert.equal(f1(task, "Status"), "completed");
    assert.equal(f1(task, "Worker_Hint"), "");
    const run = (await mock.listRecords(TABLES.runs)).find((r) => f1(r, "Task_Ref") === "TASK-W-3");
    assert.equal(f1(run, "Worker"), "daemon");
  });
});

// 红线：失败要响。点名的 Worker 没有这项技能就拒收，不换别的 Worker 代跑。
test("指定了本机没有的 Worker × Skill 直接 rejected，不执行", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, layered());
    await seedTask(mock, { Task_ID: "TASK-W-4", Skill_ID: "review", Worker_Hint: "ghost" });
    await seedTask(mock, { Task_ID: "TASK-W-5", Skill_ID: "local", Worker_Hint: "alpha" });
    await kernel.run({ once: true });
    for (const id of ["TASK-W-4", "TASK-W-5"]) {
      assert.equal(f1(await taskOf(mock, id), "Status"), "rejected");
    }
    assert.equal((await mock.listRecords(TABLES.runs)).length, 0);
    const notices = await mock.findRecords(TABLES.messages, "Kind", "notice");
    assert.equal(notices.length, 2);
  });
});

// 红线：Worker 的审批下限不能被技能条目放松。beta 是 approve，它的 review 必须停在 auth-required。
test("Worker 的审批下限对它的专长技能生效", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, layered());
    await seedTask(mock, { Task_ID: "TASK-W-6", Skill_ID: "review", Worker_Hint: "beta" });
    await kernel.run({ once: true });
    assert.equal(f1(await taskOf(mock, "TASK-W-6"), "Status"), "auth-required");
    assert.equal((await mock.listRecords(TABLES.runs)).length, 0);
  });
});

// 红线：专长技能的名字与说明来自本机配置，进受信模板；通用技能不加这一行。
test("buildPrompt 只在专长技能时带技能行", async () => {
  await withTemp(async (dir) => {
    const { kernel } = setup(dir, layered());
    const file = path.join(dir, "runs", "TASK-X", "input.json");
    const skilled = kernel.buildPrompt(file, kernel.commands["alpha/review"]);
    assert.match(skilled, /本次任务使用技能：review（评审）。看一遍/);
    assert.doesNotMatch(kernel.buildPrompt(file, kernel.commands["alpha/agent"]), /本次任务使用技能/);
    assert.doesNotMatch(kernel.buildPrompt(file, kernel.commands.local), /本次任务使用技能/);
  });
});

async function card(mock, fields) {
  await mock.createRecord(TABLES.agentCards, { Node: "node-a", Dispatchable: "Yes", Availability: "online", ...fields });
}

async function roster() {
  const mock = new MockFeishuBus({ tables: TABLES });
  await card(mock, { Cap_ID: "CAP-a-alpha-agent", Worker: "alpha", Skill_ID: "agent" });
  await card(mock, { Cap_ID: "CAP-a-beta-agent", Worker: "beta", Skill_ID: "agent" });
  await card(mock, { Cap_ID: "CAP-a-beta-review", Worker: "beta", Skill_ID: "review" });
  await card(mock, { Cap_ID: "CAP-a-local", Worker: "", Skill_ID: "local" });
  return mock;
}

async function created(mock, taskId) {
  return (await mock.findRecords(TABLES.tasks, "Task_ID", taskId))[0];
}

// 红线：建单按名册校验 Worker；只点 Worker 取其通用技能；按 Cap_ID 点名时 Worker 跟名片走。
test("task create：--worker 的三种写法", async () => {
  assert.equal(parseCreateArgv(["--to", "node-a", "--worker", "beta"]).worker, "beta");
  const mock = await roster();
  const onlyWorker = await created(mock, await createTask({ bus: mock, to: "node-a", worker: "beta", text: "x" }));
  assert.equal(f1(onlyWorker, "Skill_ID"), "agent");
  assert.equal(f1(onlyWorker, "Worker_Hint"), "beta");
  const both = await created(mock, await createTask({ bus: mock, to: "node-a", worker: "beta", cap: "review", text: "x" }));
  assert.equal(f1(both, "Skill_ID"), "review");
  assert.equal(f1(both, "Worker_Hint"), "beta");
  const byCap = await created(mock, await createTask({ bus: mock, cap: "CAP-a-alpha-agent", text: "x" }));
  assert.equal(f1(byCap, "Target_Node"), "node-a");
  assert.equal(f1(byCap, "Skill_ID"), "agent");
  assert.equal(f1(byCap, "Worker_Hint"), "alpha");
  // 只按技能名点：Worker 留空，交给目标节点取默认。
  const bySkill = await created(mock, await createTask({ bus: mock, to: "node-a", cap: "review", text: "x" }));
  assert.equal(f1(bySkill, "Worker_Hint"), "");
});

// v3.8：只点 Worker 时名册证明不了它不存在（通用能力不在名册），照常建单，
// 存在性交目标节点认领时按硬约束校验；但 Worker × Skill 组合能被名册证伪时写表前拒绝。
test("task create：只点 Worker 照常建单，能证伪的组合在写表前拒绝", async () => {
  const mock = await roster();
  const ghost = await created(mock, await createTask({ bus: mock, to: "node-a", worker: "ghost", text: "x" }));
  assert.equal(f1(ghost, "Skill_ID"), "agent");
  assert.equal(f1(ghost, "Worker_Hint"), "ghost");
  mock.journal.length = 0;
  await assert.rejects(() => createTask({ bus: mock, to: "node-a", worker: "alpha", cap: "review", text: "x" }), /Worker "alpha" 未登记能力 "review"/);
  await assert.rejects(() => createTask({ bus: mock, to: "node-a", worker: "ghost", cap: "review", text: "x" }), /Worker "ghost" 未登记能力 "review"/);
  assert.deepEqual(mock.journal.filter((item) => item.op === "create"), []);
});

// v3.8：名册里完全没有通用卡时，只点 Worker 也能建单（v3.8 名册的常态）。
test("task create：名册无通用卡时只点 Worker 建单", async () => {
  const mock = new MockFeishuBus({ tables: TABLES });
  await card(mock, { Cap_ID: "CAP-a-beta-review", Worker: "beta", Skill_ID: "review" });
  const t = await created(mock, await createTask({ bus: mock, to: "node-a", worker: "beta", text: "x" }));
  assert.equal(f1(t, "Skill_ID"), "agent");
  assert.equal(f1(t, "Worker_Hint"), "beta");
});

// v3.8：通用能力不在名册里，但点名 Worker 的通用任务照常执行，Runs.Worker 记它。
test("点名 Worker 的通用任务由该 Worker 执行", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, layered());
    await seedTask(mock, { Task_ID: "TASK-W-7", Skill_ID: "agent", Worker_Hint: "alpha" });
    await kernel.run({ once: true });
    const task = await taskOf(mock, "TASK-W-7");
    assert.equal(f1(task, "Status"), "completed");
    const run = (await mock.listRecords(TABLES.runs)).find((r) => f1(r, "Task_Ref") === "TASK-W-7");
    assert.equal(f1(run, "Worker"), "alpha");
  });
});

// 红线：装机把本机 Agent 登记成 Worker。旧的 <x>-agent 扁平条目被同名 Worker 取代，Cap_ID 不变。
test("setup：检测到的 Agent 写进 workers，并取代旧的扁平条目", () => {
  const entry = { command: "/bin/agy --print {prompt}", mode: "agent" };
  const out = buildAgentCommands(
    [{ worker: "agy", skill: "agy-agent", entry }],
    { "agy-agent": { command: "old", cap_id: "CAP-mini-agy-agent" }, briefing: { command: "node b.js", mode: "json" } },
  );
  assert.deepEqual(Object.keys(out).sort(), ["briefing", "workers"]);
  assert.deepEqual(out.workers, { agy: entry });
  assert.deepEqual([...capIdsOf(out, "mini")].sort(), ["CAP-mini-agy-agent", "CAP-mini-briefing"]);
});
