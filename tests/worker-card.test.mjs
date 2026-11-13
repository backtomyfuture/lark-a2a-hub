// 守住 Worker 名片（标准 v3.8 要写明的口径，行为与现在的 v3.7 一致）。
// 这些用例钉的是当前正确行为：名片由 kernel.run 登记产生，不手造名册。
// 总线是 tests/mocks/mock-bus.mjs。不读 ~/.hub-node，不取凭据。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { f1 } from "../src/bus/feishu.mjs";
import { capIdOf, capIdsOf, capKey, loadConfig, normalizeCommands, resolveCapKey } from "../src/config.mjs";
import { createTask } from "../src/hub/create.mjs";
import { ScheduleService } from "../src/hub/schedule.mjs";
import { Kernel } from "../src/kernel.mjs";
import { LocalScheduleService } from "../src/local-schedule.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ECHO = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "src", "executors", "echo.mjs"))}`;
const LATER_NOW = Date.parse("2026-06-15T00:00:00.000Z");

// 两个 json 型 Worker，都用 echo 当启动模板。与 tests/worker-layer.test.mjs 的 layered() 同形。
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

function setup(dir, commands, extra = {}) {
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(commands), { mode: 0o600 });
  const mock = new MockFeishuBus({ tables: TABLES });
  const kernel = new Kernel({
    node: "node-a", role: "node", kind: extra.kind || "host", zone: "test", capPrefix: "test",
    events: false, configDir: dir, carrierSocket: path.join(dir, "missing.sock"), bus: mock,
    // 误配字段。现在的内核不应读取它。
    workerName: extra.workerName,
  });
  return { mock, kernel };
}

async function seedTask(mock, fields) {
  const taskId = fields.Task_ID;
  const msgId = `MSG-${taskId.replace("TASK-", "")}-01`;
  await mock.createRecord(TABLES.messages, {
    Msg_ID: msgId, Task_ID: taskId, Context_ID: fields.Context_ID || "CTX-W", From_Node: "hub", To_Node: "node-a",
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

function cardByCap(cards, capId) {
  return cards.find((row) => f1(row, "Cap_ID") === capId);
}

// 标准 v3.8 的四条判定，只看 Worker 与 Skill_ID（Node 用来核对「同节点」）。
function classify(row) {
  const skill = String(f1(row, "Skill_ID") ?? "");
  const worker = String(f1(row, "Worker") ?? "").trim();
  if (skill === "agent" && worker) return "worker-card";
  if (skill === "agent") return "self-worker-card";
  if (worker) return "specialty";
  return "self-skill";
}

test("R1：kind=agent 误配 workerName 时 Worker 列仍为空，能力键是 agent，任务能认领", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, { agent: { mode: "inbox" } }, { kind: "agent", workerName: "grok" });
    await seedTask(mock, { Task_ID: "TASK-R1", Skill_ID: "agent", Worker_Hint: "" });
    await kernel.run({ once: true });
    const cards = await mock.listRecords(TABLES.agentCards);
    const card = cardByCap(cards, "CAP-test-agent");
    assert.ok(card);
    assert.equal(f1(card, "Worker"), "");
    const caps = [...await kernel.myCapabilities()];
    assert.ok(caps.includes("agent"));
    assert.equal(caps.some((key) => key.includes("/")), false);
    assert.equal(f1(await taskOf(mock, "TASK-R1"), "Status"), "working");
  });
});

test("R1：loadConfig 不接纳 node.json 里的 workerName", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
      node: "node-a",
      kind: "agent",
      appId: "cli_placeholder",
      appSecret: "secret_placeholder",
      baseToken: "bascn_placeholder",
      tables: TABLES,
      workerName: "grok",
    }), { mode: 0o600 });
    const cfg = loadConfig(dir);
    assert.equal(Object.hasOwn(cfg, "workerName"), false);
  });
});

test("不变式：名册每一行都能按 Worker × Skill 回指本机能力表", async () => {
  async function assertAddressable(commands, extra) {
    await withTemp(async (dir) => {
      const { mock, kernel } = setup(dir, commands, extra);
      await kernel.run({ once: true });
      const caps = await kernel.myCapabilities();
      const cards = (await mock.listRecords(TABLES.agentCards)).filter((row) => f1(row, "Node") === "node-a");
      assert.ok(cards.length > 0);
      for (const row of cards) {
        const skill = String(f1(row, "Skill_ID") ?? "");
        const worker = String(f1(row, "Worker") ?? "").trim();
        const key = resolveCapKey(kernel.commands, skill, worker);
        assert.ok(key, `${f1(row, "Cap_ID")} 无法回指`);
        assert.ok(caps.has(capKey(worker, skill)), capKey(worker, skill));
        assert.equal(capIdOf(key, kernel.commands[key], kernel.cfg.capPrefix), f1(row, "Cap_ID"));
      }
    });
  }
  await assertAddressable(layered(), {});
  await assertAddressable({ agent: { mode: "inbox" } }, { kind: "agent" });
});

test("不变式：每个 Worker 恰好一张名片，专长技能都能找到同 Worker 的名片", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, layered());
    await kernel.run({ once: true });
    const cards = (await mock.listRecords(TABLES.agentCards)).filter((row) => f1(row, "Node") === "node-a");
    for (const name of ["alpha", "beta"]) {
      const rows = cards.filter((row) => f1(row, "Skill_ID") === "agent" && f1(row, "Worker") === name);
      assert.equal(rows.length, 1);
      assert.equal(classify(rows[0]), "worker-card");
    }
    const reviewRows = cards.filter((row) => f1(row, "Skill_ID") === "review");
    assert.equal(reviewRows.length, 2);
    for (const row of reviewRows) {
      assert.equal(classify(row), "specialty");
      const mate = cards.find((other) =>
        f1(other, "Node") === f1(row, "Node")
        && f1(other, "Worker") === f1(row, "Worker")
        && f1(other, "Skill_ID") === "agent");
      assert.ok(mate, f1(row, "Worker"));
    }
    const local = cards.find((row) => f1(row, "Skill_ID") === "local");
    assert.ok(local);
    assert.equal(classify(local), "self-skill");
  });
});

test("R2：本地计划引用 CAP-<前缀>-<Worker>-agent 能按期建单并由该 Worker 执行", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, {
      workers: {
        alpha: { command: ECHO, mode: "json", timeout_sec: 30 },
        beta: { command: ECHO, mode: "json", timeout_sec: 30 },
      },
    });
    await kernel.run({ once: true });
    // 不写内核默认识别的 schedules.json。建单用注入时钟，认领那一轮若再 tick 会按真实时钟多补一张。
    const schedulesPath = path.join(dir, "plan-r2.json");
    const statePath = path.join(dir, "plan-r2-state.json");
    fs.writeFileSync(schedulesPath, JSON.stringify({
      schedules: [{ id: "p1", enabled: true, cron: "* * * * *", cap: "CAP-test-beta-agent", text: "x" }],
    }, null, 1), { mode: 0o600 });
    const now = { value: Date.parse("2026-01-15T01:30:00.000Z") };
    const logs = [];
    const svc = new LocalScheduleService({
      bus: mock,
      node: "node-a",
      tz: "Asia/Shanghai",
      schedulesPath,
      statePath,
      now: () => now.value,
      log: (line) => logs.push(String(line)),
      createTask,
      commandsOf: () => capIdsOf(kernel.commands, kernel.cfg.capPrefix),
      notify: () => {},
    });
    await svc.tick();
    assert.equal((await mock.listRecords(TABLES.tasks)).length, 0, logs.join("\n"));
    now.value += 60_000;
    await svc.tick();
    const created = await mock.listRecords(TABLES.tasks);
    assert.equal(created.length, 1, logs.join("\n"));
    assert.equal(f1(created[0], "Skill_ID"), "agent");
    assert.equal(f1(created[0], "Worker_Hint"), "beta");
    assert.equal(f1(created[0], "Source"), "cron");
    await kernel.run({ once: true });
    const task = await taskOf(mock, f1(created[0], "Task_ID"));
    assert.equal(f1(task, "Claimed_By"), "node-a");
    const run = (await mock.listRecords(TABLES.runs)).find((row) => f1(row, "Task_Ref") === f1(created[0], "Task_ID"));
    assert.equal(f1(run, "Worker"), "beta");
  });
});

test("R3：Worker 通用任务到期的 LATER 复查单仍建得出来", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, {
      workers: {
        alpha: { command: ECHO, mode: "json", timeout_sec: 30 },
        beta: { command: ECHO, mode: "json", timeout_sec: 30 },
      },
    });
    await kernel.run({ once: true });
    await seedTask(mock, {
      Task_ID: "TASK-R3",
      Skill_ID: "agent",
      Worker_Hint: "beta",
      Status: "completed",
      Hop_Count: 2,
      Context_ID: "CTX-R3",
      Metadata: JSON.stringify({ later: { at: "2026-06-01T00:00:00Z", about: "看一眼" } }),
    });
    const svc = new ScheduleService({
      bus: mock,
      log: () => {},
      now: () => LATER_NOW,
      tz: "Asia/Shanghai",
      statePath: path.join(dir, "schedule_state.json"),
      role: "hub",
    });
    await svc.scan();
    const child = (await mock.listRecords(TABLES.tasks)).find((row) => f1(row, "Idempotency_Key") === "later:TASK-R3");
    assert.ok(child);
    assert.equal(f1(child, "Skill_ID"), "agent");
    assert.equal(f1(child, "Worker_Hint"), "beta");
    assert.equal(f1(child, "Hop_Count"), 3);
    const msg = (await mock.findRecords(TABLES.messages, "Task_ID", f1(child, "Task_ID")))
      .find((row) => f1(row, "Kind") === "instruction");
    assert.equal(f1(msg, "Ref_Task_IDs"), "TASK-R3");
    const marked = JSON.parse(f1(await taskOf(mock, "TASK-R3"), "Metadata"));
    assert.equal(marked.later_fired.task_id, f1(child, "Task_ID"));
  });
});

test("R4：createTask 只给 to 时落到通用执行 agent，认领回填第一个 Worker", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, {
      workers: {
        alpha: { command: ECHO, mode: "json", timeout_sec: 30 },
        beta: { command: ECHO, mode: "json", timeout_sec: 30 },
      },
      review: { workers: ["beta"] },
      local: { command: ECHO, mode: "json", timeout_sec: 30 },
    });
    await kernel.run({ once: true });
    const taskId = await createTask({ bus: mock, to: "node-a", text: "x" });
    const drafted = await taskOf(mock, taskId);
    assert.equal(f1(drafted, "Skill_ID"), "agent");
    assert.equal(f1(drafted, "Worker_Hint"), "");
    await kernel.run({ once: true });
    const claimed = await taskOf(mock, taskId);
    assert.equal(f1(claimed, "Worker_Hint"), "alpha");
    assert.equal(f1(claimed, "Claimed_By"), "node-a");
  });
});

test("R4 反例：自动挑选不会派给已停派的 Worker 名片", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, {
      workers: {
        alpha: { command: ECHO, mode: "json", timeout_sec: 30 },
      },
      review: { workers: ["alpha"] },
      local: { command: ECHO, mode: "json", timeout_sec: 30 },
    });
    await kernel.run({ once: true });
    const agentCard = cardByCap(await mock.listRecords(TABLES.agentCards), "CAP-test-alpha-agent");
    await mock.updateRecord(TABLES.agentCards, agentCard.record_id, { Dispatchable: "No" });
    // 锁现状：停派名片在打分前被丢掉。剩下的 review 与 local 同分，
    // 按登记顺序稳定排序，先登记的 review 胜出，不会改派到那张 Dispatchable=No 的名片。
    const taskId = await createTask({ bus: mock, to: "node-a", text: "x" });
    const task = await taskOf(mock, taskId);
    assert.equal(f1(task, "Skill_ID"), "review");
    assert.equal(f1(task, "Worker_Hint"), "");
    assert.notEqual(f1(task, "Skill_ID"), "agent");
  });
});

test("R5：只登记 workers 的节点仍有 Worker 名片，createTask 的 --to 校验通过", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, {
      workers: {
        alpha: { command: ECHO, mode: "json", timeout_sec: 30 },
      },
    });
    await kernel.run({ once: true });
    const cards = await mock.listRecords(TABLES.agentCards);
    assert.equal(cards.length, 1);
    assert.equal(f1(cards[0], "Cap_ID"), "CAP-test-alpha-agent");
    assert.equal(f1(cards[0], "Dispatchable"), "Yes");
    const plain = await createTask({ bus: mock, to: "node-a", text: "x" });
    const named = await createTask({ bus: mock, to: "node-a", worker: "alpha", text: "x" });
    assert.equal(f1(await taskOf(mock, plain), "Target_Node"), "node-a");
    assert.equal(f1(await taskOf(mock, named), "Target_Node"), "node-a");
    assert.equal(f1(await taskOf(mock, named), "Worker_Hint"), "alpha");
  });
});

test("迁移把旧的扁平 agy-agent 名片就地改写成 Worker 名片，旧技能名的在途任务被拒收", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, {
      "agy-agent": { command: ECHO, mode: "json", cap_id: "CAP-test-agy-agent", timeout_sec: 30 },
    });
    await kernel.run({ once: true });
    const before = (await mock.listRecords(TABLES.agentCards)).filter((row) => f1(row, "Cap_ID") === "CAP-test-agy-agent");
    assert.equal(before.length, 1);
    const recordId = before[0].record_id;
    await seedTask(mock, { Task_ID: "TASK-MIG", Skill_ID: "agy-agent", Worker_Hint: "" });
    const file = path.join(dir, "commands.json");
    // 热加载比较的是 mtime 和 size。拨一下 mtime，避免同一毫秒内写回被当成没变。
    fs.writeFileSync(file, JSON.stringify({
      workers: { agy: { command: ECHO, mode: "json", timeout_sec: 30 } },
    }) + "\n", { mode: 0o600 });
    const st = fs.statSync(file);
    fs.utimesSync(file, st.atime, new Date(st.mtimeMs + 5000));
    await kernel.run({ once: true });
    const after = (await mock.listRecords(TABLES.agentCards)).filter((row) => f1(row, "Cap_ID") === "CAP-test-agy-agent");
    assert.equal(after.length, 1);
    assert.equal(after[0].record_id, recordId);
    assert.equal(f1(after[0], "Worker"), "agy");
    assert.equal(f1(after[0], "Skill_ID"), "agent");
    assert.equal(f1(after[0], "Dispatchable"), "Yes");
    const mine = (await mock.listRecords(TABLES.agentCards)).filter((row) => f1(row, "Node") === "node-a");
    assert.equal(mine.some((row) => f1(row, "Dispatchable") === "No"), false);
    assert.equal(f1(await taskOf(mock, "TASK-MIG"), "Status"), "rejected");
    const notices = (await mock.findRecords(TABLES.messages, "Kind", "notice"))
      .filter((row) => f1(row, "Task_ID") === "TASK-MIG");
    assert.ok(notices.length >= 1);
  });
});

test("Worker 没写 name 时名片 Skill_Name 取 Worker 名", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, {
      workers: { paseo: { command: ECHO, mode: "json", timeout_sec: 30 } },
    });
    await kernel.run({ once: true });
    const card = cardByCap(await mock.listRecords(TABLES.agentCards), "CAP-test-paseo-agent");
    assert.equal(f1(card, "Skill_Name"), "paseo");
  });
});

test("显式 agent 条目只收紧审批时，Worker 的名称说明仍留在名片上", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, {
      workers: {
        alpha: { command: ECHO, mode: "json", name: "Alpha", desc: "甲", timeout_sec: 30 },
      },
      agent: { workers: ["alpha"], approval_class: "approve" },
    });
    await kernel.run({ once: true });
    const card = cardByCap(await mock.listRecords(TABLES.agentCards), "CAP-test-alpha-agent");
    assert.equal(f1(card, "Skill_Name"), "Alpha");
    assert.equal(f1(card, "Description"), "甲");
    assert.equal(kernel.commands["alpha/agent"].approval_class, "approve");
  });
});

test("专长技能没写 name 时 Skill_Name 是技能名，不借 Worker 的名字", async () => {
  await withTemp(async (dir) => {
    const { mock, kernel } = setup(dir, {
      workers: {
        alpha: { command: ECHO, mode: "json", name: "Alpha", desc: "甲", timeout_sec: 30 },
      },
      review: { workers: ["alpha"] },
    });
    await kernel.run({ once: true });
    const card = cardByCap(await mock.listRecords(TABLES.agentCards), "CAP-test-alpha-review");
    assert.equal(f1(card, "Skill_Name"), "review");
  });
});

test("新旧条目并存时两项 Cap_ID 相同", () => {
  const flat = normalizeCommands({
    workers: { agy: { command: "x" } },
    "agy-agent": { command: "x", cap_id: "CAP-mini-agy-agent" },
  });
  const workerCap = capIdOf("agy/agent", flat["agy/agent"], "mini");
  const legacyCap = capIdOf("agy-agent", flat["agy-agent"], "mini");
  assert.equal(workerCap, legacyCap);
  assert.equal(workerCap, "CAP-mini-agy-agent");
});
