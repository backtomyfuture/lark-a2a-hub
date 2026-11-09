// CLI lah schedule 与 lah task begin 测试。
// 守住参数校验、控制键拒收、权限 600、幂等键格式、Rules 镜像保护与不重复建单。
// 内存 mock 总线，使用临时目录，不连真实 Base，不污染真实环境变量。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import {
  handleScheduleCli,
  handleTaskBegin,
  loadCommandsCaps,
  nextOccurrence,
  readSchedules,
  scheduleAdd,
  scheduleDisable,
  scheduleEnable,
  scheduleLs,
  scheduleRegister,
  scheduleRm,
  taskBegin,
} from "../src/schedule-cli.mjs";
import { parseCron } from "../src/schedule-cron.mjs";
import { ScheduleMirror } from "../src/schedule-mirror.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const TABLES_WITH_RULES = {
  ...TABLES,
  rules: "tbl_rules",
};

const NOW = Date.parse("2026-01-15T01:30:25.123Z"); // 09:30:25+0800

function setupDir(dir, { tz = "Asia/Shanghai", withRules = true, caps = { echo: "CAP-echo", agent: "agent" } } = {}) {
  const tables = withRules ? TABLES_WITH_RULES : { ...TABLES };
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
    node: "node-a",
    appId: "mock_id",
    appSecret: "mock_secret",
    baseToken: "mock_base",
    tz,
    tables,
  }, null, 2), { mode: 0o600 });

  const commands = {};
  for (const [skill, capId] of Object.entries(caps)) {
    commands[skill] = {
      command: "echo",
      mode: skill === "agent" ? "inbox" : "json",
      cap_id: capId,
    };
  }
  fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(commands, null, 2), { mode: 0o600 });
}

function mockBus(withRules = true) {
  const bus = new MockFeishuBus({ tables: withRules ? TABLES_WITH_RULES : TABLES });
  return bus;
}

async function addCards(bus) {
  await bus.createRecord(TABLES.agentCards, {
    Cap_ID: "agent",
    Skill_ID: "agent",
    Node: "node-a",
    Dispatchable: "Yes",
    Availability: "online",
  });
  await bus.createRecord(TABLES.agentCards, {
    Cap_ID: "CAP-echo",
    Skill_ID: "echo",
    Node: "node-a",
    Dispatchable: "Yes",
    Availability: "online",
  });
}

test("nextOccurrence 算得下一期期次且在整分", () => {
  const parsed = parseCron("0 9 * * *");
  const next = nextOccurrence(parsed, new Date("2026-01-15T09:00:00+0800"), "Asia/Shanghai");
  assert.ok(next);
  assert.equal(next.getTime(), Date.parse("2026-01-16T01:00:00.000Z"));
});

test("add 的各种校验失败不写文件", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    const schedulesPath = path.join(dir, "schedules.json");

    // 1. 坏 cron
    await assert.rejects(
      () => scheduleAdd({ configDir: dir, id: "T1", cron: "bad cron", cap: "CAP-echo", text: "t", bus }),
      /cron 表达式非法/
    );
    assert.equal(fs.existsSync(schedulesPath), false);

    // 2. cap 不存在
    await assert.rejects(
      () => scheduleAdd({ configDir: dir, id: "T2", cron: "0 9 * * *", cap: "CAP-missing", text: "t", bus }),
      /cap "CAP-missing" 不在本机 commands\.json/
    );
    assert.equal(fs.existsSync(schedulesPath), false);

    // 3. text 为空
    await assert.rejects(
      () => scheduleAdd({ configDir: dir, id: "T3", cron: "0 9 * * *", cap: "CAP-echo", text: "  ", bus }),
      /text 不能为空/
    );
    assert.equal(fs.existsSync(schedulesPath), false);

    // 4. id 非法字符或过长
    await assert.rejects(
      () => scheduleAdd({ configDir: dir, id: "bad id!", cron: "0 9 * * *", cap: "CAP-echo", text: "t", bus }),
      /计划 ID 非法/
    );
    await assert.rejects(
      () => scheduleAdd({ configDir: dir, id: "x".repeat(65), cron: "0 9 * * *", cap: "CAP-echo", text: "t", bus }),
      /计划 ID 非法/
    );
    assert.equal(fs.existsSync(schedulesPath), false);

    // 5. 控制键拒收
    await assert.rejects(
      () => scheduleAdd({ configDir: dir, id: "T5", cron: "0 9 * * *", cap: "CAP-echo", text: "t", rawExtra: { command: "rm -rf" }, bus }),
      /含执行控制键/
    );
    assert.equal(fs.existsSync(schedulesPath), false);

    // 6. 成功添加一条后，重复 id 报错且不破坏原文件
    await scheduleAdd({ configDir: dir, id: "DAILY", cron: "0 9 * * *", cap: "CAP-echo", text: "早报", bus });
    assert.equal(fs.existsSync(schedulesPath), true);
    assert.equal(readSchedules(dir).length, 1);

    await assert.rejects(
      () => scheduleAdd({ configDir: dir, id: "DAILY", cron: "0 10 * * *", cap: "CAP-echo", text: "早报2", bus }),
      /计划 ID 已存在：DAILY/
    );
    assert.equal(readSchedules(dir).length, 1);
    assert.equal(readSchedules(dir)[0].cron, "0 9 * * *");
  });
});

test("add/ls/rm/enable/disable 往返与文件权限 600", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    const schedulesPath = path.join(dir, "schedules.json");

    // add
    await scheduleAdd({
      configDir: dir,
      id: "DAILY",
      cron: "0 9 * * *",
      cap: "CAP-echo",
      text: "每日早报",
      approval: "notify",
      bus,
      now: NOW,
    });

    // 验证文件权限 600
    const stat = fs.statSync(schedulesPath);
    assert.equal(stat.mode & 0o777, 0o600);

    // ls
    const items = await scheduleLs({ configDir: dir, json: true, now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "DAILY");
    assert.equal(items[0].enabled, true);
    assert.equal(items[0].cap, "CAP-echo");
    assert.equal(items[0].cron, "0 9 * * *");
    assert.equal(items[0].anchored, false); // 尚未建立基线
    assert.match(items[0].next_period, /^2026-01-16T09:00:00\+0800$/);
    assert.equal(items[0].approval_class, "notify");

    // 模拟写入基线后 ls 显示已锚定
    fs.writeFileSync(path.join(dir, "schedule_local_state.json"), JSON.stringify({
      schedules: {
        DAILY: {
          cron: "0 9 * * *",
          last_fired: "2026-01-15T09:00:00+0800",
        },
      },
    }, null, 2), { mode: 0o600 });

    const itemsAnchored = await scheduleLs({ configDir: dir, json: true, now: NOW });
    assert.equal(itemsAnchored[0].anchored, true);

    // disable
    await scheduleDisable({ configDir: dir, id: "DAILY", bus, now: NOW });
    assert.equal(readSchedules(dir)[0].enabled, false);

    // enable
    await scheduleEnable({ configDir: dir, id: "DAILY", bus, now: NOW });
    assert.equal(readSchedules(dir)[0].enabled, true);

    // rm
    await scheduleRm({ configDir: dir, id: "DAILY", bus, now: NOW });
    assert.equal(readSchedules(dir).length, 0);

    // rm 之后镜像行被置为 Enabled=No
    const rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    const ruleRow = rules.find((r) => f1(r, "Rule_ID") === "node-a:DAILY");
    assert.ok(ruleRow);
    assert.equal(f1(ruleRow, "Enabled"), "No");
    assert.match(String(f1(ruleRow, "Note")), /计划已不在本机 schedules\.json/);
  });
});

test("register 幂等且不被镜像逻辑误置 No", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();

    // 首次 register
    await scheduleRegister({
      configDir: dir,
      id: "AGENT-1",
      cron: "0 8 * * *",
      cap: "agent",
      text: "Agent 定时",
      bus,
      now: NOW,
    });

    let rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    let row = rules.find((r) => f1(r, "Rule_ID") === "node-a:AGENT-1");
    assert.ok(row);
    assert.equal(f1(row, "Enabled"), "Yes");
    assert.equal(f1(row, "Skill_ID"), "agent");
    assert.equal(f1(row, "Schedule"), "0 8 * * *");
    assert.match(String(f1(row, "Note")), /由 Agent 自带定时器触发（register）/);

    // 同 Rule_ID 重复 register 为幂等更新，不新建行
    await scheduleRegister({
      configDir: dir,
      id: "AGENT-1",
      cron: "0 8 * * *",
      cap: "agent",
      text: "Agent 定时（更新）",
      bus,
      now: NOW,
    });
    rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    const matched = rules.filter((r) => f1(r, "Rule_ID") === "node-a:AGENT-1");
    assert.equal(matched.length, 1);
    assert.equal(f1(matched[0], "Text"), "Agent 定时（更新）");

    // ScheduleMirror.sync（批次 2 镜像同步）扫描时不误伤 register 行
    const mirror = new ScheduleMirror({ bus, node: "node-a", now: () => NOW });
    await mirror.sync({ plans: [], state: {}, tz: "Asia/Shanghai" });

    rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    row = rules.find((r) => f1(r, "Rule_ID") === "node-a:AGENT-1");
    assert.equal(f1(row, "Enabled"), "Yes");
    assert.match(String(f1(row, "Note")), /由 Agent 自带定时器触发（register）/);
    assert.doesNotMatch(String(f1(row, "Note")), /计划已不在本机 schedules\.json/);

    // node.json 缺少 tables.rules 时给出明确错误
    const badDir = path.join(dir, "no-rules");
    fs.mkdirSync(badDir);
    setupDir(badDir, { withRules: false });
    const busNoRules = mockBus(false);
    await assert.rejects(
      () => scheduleRegister({ configDir: badDir, id: "AGENT-2", cron: "0 8 * * *", cap: "agent", bus: busNoRules }),
      /node\.json 缺少 tables\.rules 表映射，无法登记 Rules 镜像/
    );
  });
});

test("task begin 默认字段与幂等键", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    await addCards(bus);

    // 先登记观察镜像行
    await scheduleRegister({
      configDir: dir,
      id: "AGENT-CRON",
      cron: "30 9 * * *",
      cap: "agent",
      text: "备忘",
      bus,
      now: NOW,
    });

    const res = await taskBegin({
      configDir: dir,
      schedule: "AGENT-CRON",
      bus,
      now: NOW, // 2026-01-15T09:30:25+0800
    });

    assert.ok(res.taskId);
    assert.equal(res.exists, false);

    const tasks = await bus.listRecords(TABLES.tasks);
    const task = tasks.find((t) => f1(t, "Task_ID") === res.taskId);
    assert.ok(task);
    assert.equal(f1(task, "Target_Node"), "node-a");
    assert.equal(f1(task, "Source"), "cron");
    assert.equal(f1(task, "Status"), "submitted"); // 严禁直接写 working
    assert.equal(f1(task, "Skill_ID"), "agent"); // 缺省 cap
    assert.equal(f1(task, "Title"), "定时任务 AGENT-CRON"); // 缺省 text
    // 默认期次键秒归零：09:30:00+0800
    assert.equal(f1(task, "Idempotency_Key"), "sched:node-a:AGENT-CRON:2026-01-15T09:30:00+0800");

    // instruction 消息上的 from/to 应为本节点
    const messages = await bus.listRecords(TABLES.messages);
    const msg = messages.find((m) => f1(m, "Task_ID") === res.taskId);
    assert.ok(msg);
    assert.equal(f1(msg, "From_Node"), "node-a");
    assert.equal(f1(msg, "To_Node"), "node-a");

    // Rules 镜像行的 Last_Fired 与 Note 应被更新
    const rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    const ruleRow = rules.find((r) => f1(r, "Rule_ID") === "node-a:AGENT-CRON");
    assert.ok(ruleRow);
    assert.equal(f1(ruleRow, "Last_Fired"), "2026-01-15T09:30:00+0800");
    assert.match(String(f1(ruleRow, "Note")), /上次运行/);
    assert.match(String(f1(ruleRow, "Note")), /submitted/);
    assert.match(String(f1(ruleRow, "Note")), /由 Agent 自带定时器触发（register）/);
  });
});

test("task begin 同键二次调用不重复建单且返回同一 Task_ID", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    await addCards(bus);

    let output1 = "";
    const res1 = await taskBegin({
      configDir: dir,
      schedule: "AGENT-CRON",
      period: "2026-01-15T09:30:00+0800",
      bus,
      now: NOW,
      stdout: (s) => { output1 += s; },
    });
    assert.equal(res1.exists, false);

    let output2 = "";
    const res2 = await taskBegin({
      configDir: dir,
      schedule: "AGENT-CRON",
      period: "2026-01-15T09:30:00+0800",
      bus,
      now: NOW + 1000,
      stdout: (s) => { output2 += s; },
    });
    assert.equal(res2.exists, true);
    assert.equal(res2.taskId, res1.taskId);
    assert.match(output2, /已存在/);

    const tasks = await bus.listRecords(TABLES.tasks);
    assert.equal(tasks.length, 1);
  });
});

test("task begin --period 非法格式报错", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    await addCards(bus);

    await assert.rejects(
      () => taskBegin({ configDir: dir, schedule: "T", period: "2026-01-15", bus }),
      /--period 格式非法，必须符合 YYYY-MM-DDThh:mm:ss±HHMM/
    );
    await assert.rejects(
      () => taskBegin({ configDir: dir, schedule: "T", period: "invalid-period", bus }),
      /--period 格式非法/
    );
  });
});

test("时区差异：Asia/Shanghai 与 UTC 下默认期次键偏移不同", async () => {
  await withTemp(async (dirShanghai) => {
    setupDir(dirShanghai, { tz: "Asia/Shanghai" });
    const busShanghai = mockBus();
    await addCards(busShanghai);

    const res1 = await taskBegin({
      configDir: dirShanghai,
      schedule: "TZ-TEST",
      bus: busShanghai,
      now: NOW,
    });
    const tasks1 = await busShanghai.listRecords(TABLES.tasks);
    const t1 = tasks1.find((t) => f1(t, "Task_ID") === res1.taskId);
    assert.match(String(f1(t1, "Idempotency_Key")), /\+0800$/);
  });

  await withTemp(async (dirUtc) => {
    setupDir(dirUtc, { tz: "UTC" });
    const busUtc = mockBus();
    await addCards(busUtc);

    const res2 = await taskBegin({
      configDir: dirUtc,
      schedule: "TZ-TEST",
      bus: busUtc,
      now: NOW,
    });
    const tasks2 = await busUtc.listRecords(TABLES.tasks);
    const t2 = tasks2.find((t) => f1(t, "Task_ID") === res2.taskId);
    assert.match(String(f1(t2, "Idempotency_Key")), /\+0000$/);
  });
});

test("handleScheduleCli 与 handleTaskBegin CLI 调度冒烟", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    await addCards(bus);

    let errOut = "";
    const stderr = (s) => { errOut += s; };

    // 校验失败返回 1
    const failCode = await handleScheduleCli(["add", "--id", "bad id", "--cron", "* * *", "--cap", "CAP-echo"], {
      configDir: dir, bus, stderr,
    });
    assert.equal(failCode, 1);
    assert.match(errOut, /计划 ID 非法/);

    // 成功添加返回 0
    let out = "";
    const stdout = (s) => { out += s; };
    const okCode = await handleScheduleCli(["add", "--id", "DAILY", "--cron", "0 9 * * *", "--cap", "CAP-echo", "--text", "早报"], {
      configDir: dir, bus, stdout, stderr,
    });
    assert.equal(okCode, 0);
    assert.match(out, /已添加计划 DAILY/);

    // ls 返回 0
    let lsOut = "";
    const lsCode = await handleScheduleCli(["ls", "--json"], {
      configDir: dir, bus, stdout: (s) => { lsOut += s; },
    });
    assert.equal(lsCode, 0);
    const parsed = JSON.parse(lsOut);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, "DAILY");

    // task begin 返回 0
    let beginOut = "";
    const beginCode = await handleTaskBegin(["--schedule", "DAILY"], {
      configDir: dir, bus, stdout: (s) => { beginOut += s; },
    });
    assert.equal(beginCode, 0);
    assert.match(beginOut, /^TASK-/);
  });
});

test("task begin 在 listRecords 抛错时非零退出且不建单", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    await addCards(bus);

    bus.listRecords = async (table) => {
      if (table === TABLES.tasks) throw new Error("总线网络超时");
      return [];
    };

    let errOut = "";
    const stderr = (s) => { errOut += s; };
    const code = await handleTaskBegin(["--schedule", "CRASH-TEST"], {
      configDir: dir,
      bus,
      stderr,
      now: NOW,
    });
    assert.equal(code, 1);
    assert.match(errOut, /总线网络超时/);
    assert.equal(bus.journal.filter((j) => j.table === TABLES.tasks && j.op === "create").length, 0);
  });
});

test("schedule add 对 command/cwd/context/agent/mode 每个控制键都拒收且不落盘", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    const schedulesPath = path.join(dir, "schedules.json");

    for (const key of ["command", "cwd", "context", "agent", "mode"]) {
      let errOut = "";
      const stderr = (s) => { errOut += s; };
      const code = await handleScheduleCli([
        "add", "--id", `BAD-${key}`, "--cron", "0 9 * * *", "--cap", "CAP-echo", "--text", "t", `--${key}`, "/danger",
      ], { configDir: dir, bus, stderr });

      assert.equal(code, 1);
      assert.match(errOut, /含执行控制键/);
      assert.equal(fs.existsSync(schedulesPath), false);
    }
  });
});

test("schedule add 非法 --approval 报错且不落盘", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    const schedulesPath = path.join(dir, "schedules.json");

    let errOut = "";
    const stderr = (s) => { errOut += s; };
    const code = await handleScheduleCli([
      "add", "--id", "BAD-APP", "--cron", "0 9 * * *", "--cap", "CAP-echo", "--text", "t", "--approval", "forbidden",
    ], { configDir: dir, bus, stderr });

    assert.equal(code, 1);
    assert.match(errOut, /--approval 只能是 auto、notify 或 approve/);
    assert.equal(fs.existsSync(schedulesPath), false);
  });
});

test("schedules.json 里 disable 后镜像行 Enabled=No", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();

    await scheduleAdd({
      configDir: dir,
      id: "DIS-TEST",
      cron: "0 9 * * *",
      cap: "CAP-echo",
      text: "测试",
      bus,
      now: NOW,
    });

    let rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    let row = rules.find((r) => f1(r, "Rule_ID") === "node-a:DIS-TEST");
    assert.ok(row);
    assert.equal(f1(row, "Enabled"), "Yes");

    await scheduleDisable({ configDir: dir, id: "DIS-TEST", bus, now: NOW });

    rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    row = rules.find((r) => f1(r, "Rule_ID") === "node-a:DIS-TEST");
    assert.equal(f1(row, "Enabled"), "No");
  });
});

test("schedule register 不写 schedules.json", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();
    const schedulesPath = path.join(dir, "schedules.json");

    await scheduleRegister({
      configDir: dir,
      id: "REG-ONLY",
      cron: "0 8 * * *",
      cap: "agent",
      text: "仅登记",
      bus,
      now: NOW,
    });

    assert.equal(fs.existsSync(schedulesPath), false);
  });
});

test("用户手改 register 行 Note 后，镜像刷新不会把该行置 No（验证 mirrored_ids 机制）", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();

    // 1. Agent 登记观察镜像
    await scheduleRegister({
      configDir: dir,
      id: "AGENT-HAND-EDIT",
      cron: "0 8 * * *",
      cap: "agent",
      bus,
      now: NOW,
    });

    let rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    let row = rules.find((r) => f1(r, "Rule_ID") === "node-a:AGENT-HAND-EDIT");
    assert.ok(row);
    assert.equal(f1(row, "Enabled"), "Yes");

    // 2. 模拟用户在多维表格界面手改 Note，删除了 "register" 等一切关键字
    await bus.updateRecord(TABLES_WITH_RULES.rules, row.record_id, {
      Note: "机主手写的备忘录：今天开会，不要删除我",
    });

    // 3. 本地调度刷新镜像（比如添加另一个任务并同步）
    await scheduleAdd({
      configDir: dir,
      id: "DAILY-LOCAL",
      cron: "0 9 * * *",
      cap: "CAP-echo",
      text: "本地计划",
      bus,
      now: NOW,
    });

    rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    row = rules.find((r) => f1(r, "Rule_ID") === "node-a:AGENT-HAND-EDIT");
    // 验证：手改 Note 后依然不受影响，保持 Enabled=Yes，Note 也未被篡改
    assert.equal(f1(row, "Enabled"), "Yes");
    assert.equal(f1(row, "Note"), "机主手写的备忘录：今天开会，不要删除我");
  });
});

test("旧状态文件无 mirrored_ids 时升级不误置 No", async () => {
  await withTemp(async (dir) => {
    setupDir(dir);
    const bus = mockBus();

    // 模拟旧版状态文件（只有 schedules，无 mirrored_ids 字段）
    const statePath = path.join(dir, "schedule_local_state.json");
    fs.writeFileSync(statePath, JSON.stringify({
      schedules: {
        OLD: { cron: "0 9 * * *", last_fired: "2026-01-15T09:00:00+0800" },
      },
    }, null, 2), { mode: 0o600 });

    // schedules.json 存在该计划
    fs.writeFileSync(path.join(dir, "schedules.json"), JSON.stringify({
      schedules: [
        { id: "OLD", enabled: true, cron: "0 9 * * *", cap: "CAP-echo", text: "旧计划" },
      ],
    }, null, 2), { mode: 0o600 });

    // Rules 表已有两行：一个是旧计划镜像，另一个是未知的 Agent 外部行（无 register 字样）
    await bus.createRecord(TABLES_WITH_RULES.rules, {
      Rule_ID: "node-a:OLD",
      Target_Node: "node-a",
      Skill_ID: "CAP-echo",
      Schedule: "0 9 * * *",
      Text: "旧计划",
      Enabled: "Yes",
      Last_Fired: "2026-01-15T09:00:00+0800",
      Note: "同步于 2026-01-15T09:00:00+0800",
    });
    await bus.createRecord(TABLES_WITH_RULES.rules, {
      Rule_ID: "node-a:EXTERNAL-AGENT",
      Target_Node: "node-a",
      Skill_ID: "agent",
      Schedule: "0 8 * * *",
      Text: "外部计划",
      Enabled: "Yes",
      Last_Fired: "",
      Note: "外部 Agent 自建行",
    });

    // 运行 mirror 同步
    const mirror = new ScheduleMirror({ bus, node: "node-a", now: () => NOW, statePath });
    await mirror.sync({
      plans: [{ id: "OLD", enabled: true, cron: "0 9 * * *", cap: "CAP-echo", text: "旧计划" }],
      tz: "Asia/Shanghai",
      statePath,
    });

    const rules = await bus.listRecords(TABLES_WITH_RULES.rules);
    const oldRow = rules.find((r) => f1(r, "Rule_ID") === "node-a:OLD");
    const extRow = rules.find((r) => f1(r, "Rule_ID") === "node-a:EXTERNAL-AGENT");

    assert.equal(f1(oldRow, "Enabled"), "Yes");
    // 外部行未被误伤置 No
    assert.equal(f1(extRow, "Enabled"), "Yes");
    assert.equal(f1(extRow, "Note"), "外部 Agent 自建行");

    // 验证状态文件已自动补齐 mirrored_ids
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(saved.mirrored_ids, ["OLD"]);
  });
});
