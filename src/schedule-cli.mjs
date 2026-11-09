// CLI 调度子命令实现：lah schedule (ls|add|rm|enable|disable|register) 与 lah task begin。
// 调度计划保存在本机 schedules.json，由 LocalScheduleService 读取触发；
// register 与 begin 供 Agent 类自带时钟终端使用，通过 Rules 镜像和总线收件箱协作。

import fs from "node:fs";
import path from "node:path";
import { f1 } from "./bus/feishu.mjs";
import { capIdsOf, capPrefixFromNodeJson, controlKeysIn, loadConfig } from "./config.mjs";
import { createTask } from "./hub/create.mjs";
import { formatOccurrenceKey, latestOccurrence, parseCron, resolveScheduleTz, wallClock, DEFAULT_SCHEDULE_TZ } from "./schedule-cron.mjs";
import { ScheduleMirror } from "./schedule-mirror.mjs";

const APPROVALS = new Set(["auto", "notify", "approve"]);
const PERIOD_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/;

function cronMatches(parsed, wall) {
  if (!parsed.minute.has(wall.minute)) return false;
  if (!parsed.hour.has(wall.hour)) return false;
  if (!parsed.month.has(wall.month)) return false;
  const domHit = parsed.dom.has(wall.day);
  const dowHit = parsed.dow.has(wall.weekday);
  if (parsed.domAny && parsed.dowAny) return true;
  if (parsed.domAny) return dowHit;
  if (parsed.dowAny) return domHit;
  return domHit || dowHit;
}

export function loadCommandsCaps(configDir) {
  const file = path.join(configDir, "commands.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return capIdsOf(raw, capPrefixFromNodeJson(configDir));
  } catch {
    return new Set();
  }
}

export function readSchedules(configDir) {
  const file = path.join(configDir, "schedules.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.schedules)) {
      throw new Error("schedules.json 格式非法：根对象缺少 schedules 数组");
    }
    return parsed.schedules;
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export function writeSchedules(configDir, schedules) {
  const file = path.join(configDir, "schedules.json");
  const tmp = path.join(configDir, `schedules.json.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ schedules }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function readLocalState(configDir) {
  const file = path.join(configDir, "schedule_local_state.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw?.schedules && typeof raw.schedules === "object" ? raw.schedules : {};
  } catch {
    return {};
  }
}

function resolveTzFromConfig(configDir) {
  try {
    const file = path.join(configDir, "node.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return resolveScheduleTz(raw?.tz);
  } catch {
    return DEFAULT_SCHEDULE_TZ;
  }
}

export function nextOccurrence(parsed, now, timeZone = DEFAULT_SCHEDULE_TZ) {
  const tz = resolveScheduleTz(timeZone);
  const instant = now instanceof Date ? now : new Date(now);
  const start = Math.floor(instant.getTime() / 60000) * 60000;
  const searchMinutes = 8 * 24 * 60;
  for (let i = 1; i <= searchMinutes; i++) {
    const t = new Date(start + i * 60_000);
    if (cronMatches(parsed, wallClock(t, tz))) {
      return t;
    }
  }
  return null;
}

export async function refreshMirror({ configDir, bus, now = () => Date.now(), log = () => {} } = {}) {
  let cfg;
  try {
    cfg = loadConfig(configDir);
  } catch {
    return;
  }
  const busInstance = bus || cfg.bus;
  if (!busInstance?.tables?.rules) return;
  let plans = [];
  try {
    plans = readSchedules(configDir);
  } catch {}
  const state = readLocalState(configDir);
  const statePath = path.join(configDir, "schedule_local_state.json");
  const nowFn = typeof now === "function" ? now : () => now;
  const mirror = new ScheduleMirror({ bus: busInstance, node: cfg.node, now: nowFn, log, statePath });
  await mirror.sync({ plans, state, tz: cfg.tz, statePath });
}

// lah schedule ls [--config <dir>] [--json]
export async function scheduleLs({ configDir, json = false, now = () => Date.now(), stdout = (s) => process.stdout.write(s) } = {}) {
  const schedules = readSchedules(configDir);
  const state = readLocalState(configDir);
  const tz = resolveTzFromConfig(configDir);
  const nowDate = new Date(typeof now === "function" ? now() : now);

  const items = schedules.map((plan) => {
    let nextPeriod = "-";
    try {
      const parsed = parseCron(plan.cron);
      const nextDate = nextOccurrence(parsed, nowDate, tz);
      if (nextDate) nextPeriod = formatOccurrenceKey(nextDate, tz);
    } catch {}

    const saved = state[plan.id];
    const anchored = Boolean(saved && saved.cron === plan.cron && saved.last_fired);

    return {
      id: plan.id,
      enabled: plan.enabled === true,
      cron: plan.cron,
      cap: plan.cap,
      text: plan.text,
      next_period: nextPeriod,
      anchored,
      ...(plan.approval_class ? { approval_class: plan.approval_class } : {}),
    };
  });

  if (json) {
    stdout(JSON.stringify(items, null, 2) + "\n");
    return items;
  }

  if (!items.length) {
    stdout("（当前无本地计划）\n");
    return items;
  }

  const p = (str, len) => String(str).padEnd(len, " ");
  const lines = [
    `${p("ID", 20)} ${p("Enabled", 9)} ${p("Cron", 16)} ${p("Cap", 16)} ${p("下一期期次键", 28)} ${p("基线", 8)}`,
    "-".repeat(105),
  ];
  for (const item of items) {
    lines.push(
      `${p(item.id, 20)} ${p(item.enabled ? "Yes" : "No", 9)} ${p(item.cron, 16)} ${p(item.cap, 16)} ${p(item.next_period, 28)} ${p(item.anchored ? "已锚定" : "未锚定", 8)}`
    );
  }
  stdout(lines.join("\n") + "\n");
  return items;
}

// lah schedule add --id <id> --cron "<五段>" --cap <cap_id> --text <指令> [--approval auto|notify|approve] [--disabled]
export async function scheduleAdd({
  configDir, id, cron, cap, text, approval, disabled = false, rawExtra = {},
  bus, now = () => Date.now(), stdout = (s) => process.stdout.write(s), log = () => {},
} = {}) {
  const normId = String(id ?? "").trim();
  if (!normId || !/^[a-zA-Z0-9_-]{1,64}$/.test(normId)) {
    throw new Error(`计划 ID 非法（必须由字母、数字、短横线或下划线组成，且长度不超过 64 个字符）：${id ?? "(空)"}`);
  }

  const badControls = controlKeysIn(rawExtra);
  if (badControls.length) {
    throw new Error(`拒绝添加计划：参数含执行控制键（${badControls.join(", ")}）。要执行的命令、目录、语境只来自本机 commands.json。`);
  }

  const normCron = String(cron ?? "").trim();
  if (!normCron) throw new Error("缺少 --cron 表达式");
  try {
    parseCron(normCron);
  } catch (e) {
    throw new Error(`cron 表达式非法：${e?.message ?? e}`);
  }

  const normCap = String(cap ?? "").trim();
  if (!normCap) throw new Error("缺少 --cap");
  const caps = loadCommandsCaps(configDir);
  if (!caps.has(normCap)) {
    throw new Error(`cap "${normCap}" 不在本机 commands.json 中已登记的能力（当前已登记：${[...caps].join(", ") || "无"}）`);
  }

  const normText = String(text ?? "").trim();
  if (!normText) throw new Error("text 不能为空");
  if (normText.length > 4000) throw new Error("text 长度不能超过 4000 个字符");

  let normApproval = "";
  if (approval != null && String(approval).trim() !== "") {
    normApproval = String(approval).trim();
    if (!APPROVALS.has(normApproval)) {
      throw new Error(`--approval 只能是 auto、notify 或 approve，收到：${normApproval}`);
    }
  }

  const schedules = readSchedules(configDir);
  if (schedules.some((p) => p.id === normId)) {
    throw new Error(`计划 ID 已存在：${normId}`);
  }

  const newPlan = {
    id: normId,
    enabled: !disabled,
    cron: normCron,
    cap: normCap,
    text: normText,
  };
  if (normApproval) newPlan.approval_class = normApproval;

  // 写入前再次校验控制键安全红线
  const probe = { ...newPlan };
  delete probe.approval_class;
  const probeBad = controlKeysIn(probe);
  if (probeBad.length) {
    throw new Error(`计划结构含执行控制键（${probeBad.join(", ")}）`);
  }

  schedules.push(newPlan);
  writeSchedules(configDir, schedules);
  stdout(`✓ 已添加计划 ${normId}（新计划首轮只锚基线，从下一期起触发）\n`);

  try {
    await refreshMirror({ configDir, bus, now, log });
  } catch (e) {
    stdout(`刷新 Rules 镜像失败（计划已保存）：${e?.message ?? e}\n`);
  }
}

// lah schedule rm <id>
export async function scheduleRm({
  configDir, id, bus, now = () => Date.now(), stdout = (s) => process.stdout.write(s), log = () => {},
} = {}) {
  const normId = String(id ?? "").trim();
  if (!normId) throw new Error("lah schedule rm 需要指定 <id>");

  const schedules = readSchedules(configDir);
  const idx = schedules.findIndex((p) => p.id === normId);
  if (idx < 0) throw new Error(`计划不存在：${normId}`);

  schedules.splice(idx, 1);
  writeSchedules(configDir, schedules);
  stdout(`✓ 已删除计划 ${normId}\n`);

  try {
    await refreshMirror({ configDir, bus, now, log });
  } catch (e) {
    stdout(`刷新 Rules 镜像失败（计划已删除）：${e?.message ?? e}\n`);
  }
}

// lah schedule enable <id>
export async function scheduleEnable({
  configDir, id, bus, now = () => Date.now(), stdout = (s) => process.stdout.write(s), log = () => {},
} = {}) {
  const normId = String(id ?? "").trim();
  if (!normId) throw new Error("lah schedule enable 需要指定 <id>");

  const schedules = readSchedules(configDir);
  const plan = schedules.find((p) => p.id === normId);
  if (!plan) throw new Error(`计划不存在：${normId}`);

  plan.enabled = true;
  writeSchedules(configDir, schedules);
  stdout(`✓ 已启用计划 ${normId}\n`);

  try {
    await refreshMirror({ configDir, bus, now, log });
  } catch (e) {
    stdout(`刷新 Rules 镜像失败（状态已修改）：${e?.message ?? e}\n`);
  }
}

// lah schedule disable <id>
export async function scheduleDisable({
  configDir, id, bus, now = () => Date.now(), stdout = (s) => process.stdout.write(s), log = () => {},
} = {}) {
  const normId = String(id ?? "").trim();
  if (!normId) throw new Error("lah schedule disable 需要指定 <id>");

  const schedules = readSchedules(configDir);
  const plan = schedules.find((p) => p.id === normId);
  if (!plan) throw new Error(`计划不存在：${normId}`);

  plan.enabled = false;
  writeSchedules(configDir, schedules);
  stdout(`✓ 已停用计划 ${normId}\n`);

  try {
    await refreshMirror({ configDir, bus, now, log });
  } catch (e) {
    stdout(`刷新 Rules 镜像失败（状态已修改）：${e?.message ?? e}\n`);
  }
}

// lah schedule register --id <id> --cron "<五段>" --cap <cap_id> [--text <指令>]
export async function scheduleRegister({
  configDir, id, cron, cap, text = "", bus, now = () => Date.now(), stdout = (s) => process.stdout.write(s),
} = {}) {
  const normId = String(id ?? "").trim();
  if (!normId || !/^[a-zA-Z0-9_-]{1,64}$/.test(normId)) {
    throw new Error(`计划 ID 非法（必须由字母、数字、短横线或下划线组成，且长度不超过 64 个字符）：${id ?? "(空)"}`);
  }

  const normCron = String(cron ?? "").trim();
  if (!normCron) throw new Error("缺少 --cron 表达式");
  try {
    parseCron(normCron);
  } catch (e) {
    throw new Error(`cron 表达式非法：${e?.message ?? e}`);
  }

  const normCap = String(cap ?? "").trim();
  if (!normCap) throw new Error("缺少 --cap");

  let cfg;
  try {
    cfg = loadConfig(configDir);
  } catch (e) {
    throw new Error(`读取配置目录失败：${e?.message ?? e}`);
  }

  const busInstance = bus || cfg.bus;
  if (!busInstance?.tables?.rules) {
    throw new Error("node.json 缺少 tables.rules 表映射，无法登记 Rules 镜像");
  }

  const node = cfg.node;
  const tz = cfg.tz;
  const ruleId = `${node}:${normId}`;
  const nowMs = typeof now === "function" ? now() : now;
  const stamp = formatOccurrenceKey(new Date(nowMs), tz);

  const rows = await busInstance.listRecords(busInstance.tables.rules);
  const existing = rows.find((r) => String(f1(r, "Rule_ID") ?? "") === ruleId);

  const fields = {
    Rule_ID: ruleId,
    Target_Node: node,
    Skill_ID: normCap,
    Schedule: normCron,
    Text: String(text ?? ""),
    Enabled: "Yes",
    Last_Fired: existing ? String(f1(existing, "Last_Fired") ?? "") : "",
    Note: `由 Agent 自带定时器触发（register）；同步于 ${stamp}`,
  };

  if (existing) {
    await busInstance.updateRecord(busInstance.tables.rules, existing.record_id, fields);
    stdout(`✓ 已更新 Agent 观察镜像 ${ruleId}\n`);
  } else {
    await busInstance.createRecord(busInstance.tables.rules, fields);
    stdout(`✓ 已登记 Agent 观察镜像 ${ruleId}\n`);
  }
}

// lah task begin --schedule <id> [--period <期次键>] [--cap <cap_id>] [--text <指令>] [--config <dir>]
export async function taskBegin({
  configDir, schedule, period, cap = "agent", text, bus, now = () => Date.now(), stdout = (s) => process.stdout.write(s),
} = {}) {
  const schedId = String(schedule ?? "").trim();
  if (!schedId) {
    throw new Error("lah task begin 需要 --schedule <id>");
  }

  let cfg;
  try {
    cfg = loadConfig(configDir);
  } catch (e) {
    throw new Error(`读取配置目录失败：${e?.message ?? e}`);
  }

  const node = cfg.node;
  const tz = cfg.tz;
  const busInstance = bus || cfg.bus;
  const nowMs = typeof now === "function" ? now() : now;
  const nowDate = new Date(nowMs);

  let periodKey;
  if (period != null && String(period).trim() !== "") {
    const rawPeriod = String(period).trim();
    if (!PERIOD_REGEX.test(rawPeriod)) {
      throw new Error(`--period 格式非法，必须符合 YYYY-MM-DDThh:mm:ss±HHMM（收到：${rawPeriod}）`);
    }
    periodKey = rawPeriod;
  } else {
    // 缺省取当前时刻在 node.json 的 tz 下的分钟级期次键（秒归零）
    const zeroedMs = Math.floor(nowDate.getTime() / 60000) * 60000;
    periodKey = formatOccurrenceKey(new Date(zeroedMs), tz);
  }

  const idem = `sched:${node}:${schedId}:${periodKey}`;
  const targetCap = String(cap ?? "").trim() || "agent";
  const targetText = text != null && String(text).trim() !== "" ? String(text) : `定时任务 ${schedId}`;

  // 先按幂等键查 Tasks
  const tasks = await busInstance.listRecords(busInstance.tables.tasks);
  const existing = tasks.find((t) => String(f1(t, "Idempotency_Key") ?? "") === idem);
  if (existing) {
    const existingTaskId = String(f1(existing, "Task_ID") ?? "");
    stdout(`${existingTaskId}（已存在）\n`);
    return { taskId: existingTaskId, exists: true, exitCode: 0 };
  }

  // 走 createTask，Status 一律 submitted（严禁写 working）
  const taskId = await createTask({
    bus: busInstance,
    from: node,
    source: "cron",
    to: node,
    cap: targetCap,
    text: targetText,
    idempotencyKey: idem,
    now: nowDate,
  });
  stdout(`${taskId}\n`);

  // 建单后尽力更新对应 Rules 镜像行的 Last_Fired 与 Note（若该行存在；不存在就跳过，失败只提示）
  if (busInstance.tables?.rules) {
    try {
      const rules = await busInstance.listRecords(busInstance.tables.rules);
      const ruleId = `${node}:${schedId}`;
      const ruleRow = rules.find((r) => String(f1(r, "Rule_ID") ?? "") === ruleId);
      if (ruleRow) {
        const stamp = formatOccurrenceKey(nowDate, tz);
        const prevNote = String(f1(ruleRow, "Note") ?? "");
        const isReg = prevNote.includes("register") || prevNote.includes("由 Agent 自带定时器触发");
        const noteSuffix = isReg ? "；由 Agent 自带定时器触发（register）" : "";
        const updatedNote = `上次运行 ${taskId} submitted${noteSuffix}；同步于 ${stamp}`;
        await busInstance.updateRecord(busInstance.tables.rules, ruleRow.record_id, {
          Last_Fired: periodKey,
          Note: updatedNote,
        });
      }
    } catch (e) {
      stdout(`更新 Rules 镜像行失败（不影响建单）：${e?.message ?? e}\n`);
    }
  }

  return { taskId, exists: false, exitCode: 0 };
}

// lah schedule CLI 入口分发
export async function handleScheduleCli(argv, options = {}) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const stdout = options.stdout || ((s) => process.stdout.write(s));
  const stderr = options.stderr || ((s) => process.stderr.write(s));
  const configDir = options.configDir;

  try {
    if (sub === "ls") {
      let cfgDir = configDir;
      let json = false;
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === "--config") cfgDir = rest[++i];
        else if (flag === "--json") json = true;
      }
      await scheduleLs({ configDir: cfgDir, json, now: options.now, stdout });
      return 0;
    }

    if (sub === "add") {
      let cfgDir = configDir;
      let id = "";
      let cron = "";
      let cap = "";
      let text = "";
      let approval = "";
      let disabled = false;
      const rawExtra = {};

      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === "--config") cfgDir = rest[++i];
        else if (flag === "--id") id = rest[++i];
        else if (flag === "--cron") cron = rest[++i];
        else if (flag === "--cap" || flag === "--skill") cap = rest[++i];
        else if (flag === "--text") text = rest[++i];
        else if (flag === "--approval") approval = rest[++i];
        else if (flag === "--disabled") disabled = true;
        else if (flag.startsWith("--")) {
          const key = flag.slice(2);
          const val = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
          rawExtra[key] = val;
        }
      }

      await scheduleAdd({
        configDir: cfgDir, id, cron, cap, text, approval, disabled, rawExtra,
        bus: options.bus, now: options.now, stdout, log: options.log,
      });
      return 0;
    }

    if (sub === "rm") {
      let cfgDir = configDir;
      let id = "";
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === "--config") cfgDir = rest[++i];
        else if (flag === "--id") id = rest[++i];
        else if (!flag.startsWith("--") && !id) id = flag;
      }
      await scheduleRm({ configDir: cfgDir, id, bus: options.bus, now: options.now, stdout, log: options.log });
      return 0;
    }

    if (sub === "enable") {
      let cfgDir = configDir;
      let id = "";
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === "--config") cfgDir = rest[++i];
        else if (flag === "--id") id = rest[++i];
        else if (!flag.startsWith("--") && !id) id = flag;
      }
      await scheduleEnable({ configDir: cfgDir, id, bus: options.bus, now: options.now, stdout, log: options.log });
      return 0;
    }

    if (sub === "disable") {
      let cfgDir = configDir;
      let id = "";
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === "--config") cfgDir = rest[++i];
        else if (flag === "--id") id = rest[++i];
        else if (!flag.startsWith("--") && !id) id = flag;
      }
      await scheduleDisable({ configDir: cfgDir, id, bus: options.bus, now: options.now, stdout, log: options.log });
      return 0;
    }

    if (sub === "register") {
      let cfgDir = configDir;
      let id = "";
      let cron = "";
      let cap = "";
      let text = "";
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (flag === "--config") cfgDir = rest[++i];
        else if (flag === "--id") id = rest[++i];
        else if (flag === "--cron") cron = rest[++i];
        else if (flag === "--cap" || flag === "--skill") cap = rest[++i];
        else if (flag === "--text") text = rest[++i];
      }
      await scheduleRegister({ configDir: cfgDir, id, cron, cap, text, bus: options.bus, now: options.now, stdout });
      return 0;
    }

    stderr("用法：lah schedule ls|add|rm|enable|disable|register\n");
    return 1;
  } catch (e) {
    stderr((e?.message ?? String(e)) + "\n");
    return 1;
  }
}

// lah task begin CLI 入口分发
export async function handleTaskBegin(argv, options = {}) {
  const stdout = options.stdout || ((s) => process.stdout.write(s));
  const stderr = options.stderr || ((s) => process.stderr.write(s));
  let configDir = options.configDir;
  let schedule = "";
  let period = "";
  let cap = "agent";
  let text = "";

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--config") configDir = argv[++i];
    else if (flag === "--schedule") schedule = argv[++i];
    else if (flag === "--period") period = argv[++i];
    else if (flag === "--cap" || flag === "--skill") cap = argv[++i];
    else if (flag === "--text") text = argv[++i];
  }

  try {
    const res = await taskBegin({
      configDir, schedule, period, cap, text,
      bus: options.bus, now: options.now, stdout,
    });
    return res.exitCode ?? 0;
  } catch (e) {
    stderr((e?.message ?? String(e)) + "\n");
    return 1;
  }
}
