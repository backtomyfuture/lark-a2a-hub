// 节点本地定时调度（方案 §3.2）。计划在本机 schedules.json，不进总线。
// 到点只建一张 submitted 的普通任务，认领、心跳、审批都走现行链路。
// 基线还没有（新建、改了 cron、状态文件缺失或损坏）时只锚水位，不补历史期次。
import fs from "node:fs";
import path from "node:path";
import { f1 } from "./bus/feishu.mjs";
import { controlKeysIn } from "./config.mjs";
import { formatOccurrenceKey, latestOccurrence, parseCron, resolveScheduleTz } from "./schedule-cron.mjs";
import { ScheduleMirror } from "./schedule-mirror.mjs";

const APPROVALS = new Set(["auto", "notify", "approve"]);

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const src = parsed?.schedules;
    if (!src || typeof src !== "object" || Array.isArray(src)) {
      return { schedules: {}, broken: "schedule_local_state.json 结构无法识别" };
    }
    const schedules = {};
    for (const [id, value] of Object.entries(src)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (typeof value.cron !== "string") continue;
      schedules[id] = {
        cron: value.cron,
        last_fired: typeof value.last_fired === "string" ? value.last_fired : "",
        last_task: typeof value.last_task === "string" ? value.last_task : "",
      };
    }
    const res = { schedules };
    if (Array.isArray(parsed?.mirrored_ids)) {
      res.mirrored_ids = parsed.mirrored_ids.filter((x) => typeof x === "string" && x);
    }
    return res;
  } catch (e) {
    if (e.code === "ENOENT") return { schedules: {}, missing: true };
    return { schedules: {}, broken: e.message };
  }
}

function writeState(file, schedules) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const body = { schedules: {} };
  if (Array.isArray(existing?.mirrored_ids)) {
    body.mirrored_ids = existing.mirrored_ids;
  }
  for (const [id, value] of Object.entries(schedules)) {
    if (!value || typeof value.cron !== "string") continue;
    const entry = {
      cron: value.cron,
      last_fired: typeof value.last_fired === "string" ? value.last_fired : "",
    };
    if (value.last_task) entry.last_task = value.last_task;
    body.schedules[id] = entry;
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(body, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

async function defaultCreateTask(args) {
  const mod = await import("./hub/create.mjs");
  return mod.createTask(args);
}

export class LocalScheduleService {
  constructor({
    bus, node, tz, schedulesPath, statePath, now = () => Date.now(), log, createTask, commandsOf, notify,
  } = {}) {
    this.bus = bus;
    this.node = String(node ?? "");
    this.tz = tz;
    this.schedulesPath = schedulesPath;
    this.statePath = statePath;
    this.now = now;
    this.log = typeof log === "function" ? log : () => {};
    this.createTask = typeof createTask === "function" ? createTask : defaultCreateTask;
    this.commandsOf = typeof commandsOf === "function" ? commandsOf : () => new Set();
    this.notify = typeof notify === "function" ? notify : () => {};
    this._logged = new Set();
    this._seenPlans = false;
    this._view = null;
    this.mirror = new ScheduleMirror({ bus, node: this.node, now, log: this.log, statePath: this.statePath });
  }

  _once(key, line) {
    if (this._logged.has(key)) return;
    this._logged.add(key);
    this.log(line);
  }

  // 建单失败不推进水位，同一期次会每分钟再试。日志按计划 id + 期次只记一次。
  // 期次变了、建单成功或基线改写时丢掉旧 key，避免去重集合一直涨。
  _forgetCreateFail(id, keepOcc = null) {
    const prefix = `create-fail:${id}:`;
    const keep = keepOcc == null ? null : `${prefix}${keepOcc}`;
    for (const key of this._logged) {
      if (key.startsWith(prefix) && key !== keep) this._logged.delete(key);
    }
  }

  _forgetStaleCreateFail(entries) {
    const prefixes = entries.map((plan) => `create-fail:${plan.id}:`);
    for (const key of this._logged) {
      if (!key.startsWith("create-fail:")) continue;
      if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
      this._logged.delete(key);
    }
  }

  // 分钟定时器只靠这个判断要不要叫醒扫表。只读本地文件，不碰总线、不写状态。
  // 已有基线且水位不是最近期次，或还没有基线（tick 需要去锚），才返回 true。
  hasDue(nowMs) {
    try {
      return this._hasDue(nowMs);
    } catch (e) {
      this._once("has-due", "本地调度到期判断失败，本轮不唤醒：" + (e?.message ?? e));
      return false;
    }
  }

  _hasDue(nowMs) {
    const instant = Number(nowMs);
    if (!Number.isFinite(instant)) return false;
    let tz;
    try {
      tz = resolveScheduleTz(this.tz);
    } catch (e) {
      this._once("tz", "本地调度时区非法，整体停用（不回退宿主机时区）：" + (e?.message ?? e));
      return false;
    }
    const loaded = this._readFile();
    if (loaded.missing) return false;
    if (loaded.broken) {
      this._once("file", "schedules.json 损坏，本地调度整体停用：" + loaded.broken);
      return false;
    }
    if (!this.statePath) return false;
    let caps;
    try {
      const raw = this.commandsOf();
      caps = raw instanceof Set ? raw : new Set(raw || []);
    } catch (e) {
      this._once("caps", "读取本机能力失败，本轮不唤醒：" + (e?.message ?? e));
      return false;
    }
    const saved = readState(this.statePath);
    const nowDate = new Date(instant);
    for (const plan of this._accept(loaded.list, caps)) {
      if (!plan.enabled) continue;
      const occurrence = latestOccurrence(plan.parsed, nowDate, tz);
      if (!occurrence) continue;
      const occKey = formatOccurrenceKey(occurrence, tz);
      const prev = saved.schedules[plan.id];
      const known = !saved.missing && !saved.broken && prev && prev.cron === plan.cron && prev.last_fired;
      if (!known || prev.last_fired !== occKey) return true;
    }
    return false;
  }

  // 外层吞掉异常：调用方在扫表中途调用，这里失败不能打断认领。
  async tick() {
    try {
      await this._tick();
    } catch (e) {
      this.log("本地调度本轮失败：" + (e?.message ?? e));
    }
  }

  // tasks 用扫表已经拿到的那一份，这里不再 listRecords(tasks)。
  async observe(tasks) {
    if (!this._view) return;
    try {
      await this.mirror.sync({ ...this._view, tasks: Array.isArray(tasks) ? tasks : [] });
    } catch (e) {
      this.log("计划镜像失败（调度结果保留）：" + (e?.message ?? e));
    }
  }

  async _tick() {
    const loaded = this._readFile();
    if (loaded.missing && !this._seenPlans) return;
    let tz;
    try {
      tz = resolveScheduleTz(this.tz);
    } catch (e) {
      // 非法时区整轮停用。退回宿主机时区会把按北京时间写的表达式错位。
      this._once("tz", "本地调度时区非法，整体停用（不回退宿主机时区）：" + (e?.message ?? e));
      return;
    }
    if (loaded.missing) {
      this._view = { plans: [], state: {}, tz };
      await this._mirror();
      return;
    }
    if (loaded.broken) {
      this._once("file", "schedules.json 损坏，本地调度整体停用：" + loaded.broken);
      return;
    }
    if (!this.statePath) {
      this.log("本地调度没有状态文件路径，本轮跳过，避免无法记住基线仍建单");
      return;
    }
    const saved = readState(this.statePath);
    if (saved.broken) {
      this._once("state", "schedule_local_state.json 损坏，本轮只锚基线、不触发：" + saved.broken);
    } else {
      this._logged.delete("state");
    }
    let caps;
    try {
      const raw = this.commandsOf();
      caps = raw instanceof Set ? raw : new Set(raw || []);
    } catch (e) {
      this.log("读取本机能力失败，本轮不触发：" + (e?.message ?? e));
      return;
    }
    const entries = this._accept(loaded.list, caps);
    this._forgetStaleCreateFail(entries);
    for (const plan of entries) {
      if (!plan.enabled) this._forgetCreateFail(plan.id);
    }
    this._seenPlans = true;
    const nowDate = new Date(Number(this.now()));
    const baselines = saved.schedules;
    const next = { ...baselines };
    let dirty = false;
    const pending = [];
    const anchored = [];
    for (const plan of entries) {
      if (!plan.enabled) continue;
      const occurrence = latestOccurrence(plan.parsed, nowDate, tz);
      if (!occurrence) continue;
      const occKey = formatOccurrenceKey(occurrence, tz);
      const prev = baselines[plan.id];
      const known = !saved.missing && !saved.broken && prev && prev.cron === plan.cron && prev.last_fired;
      if (!known) {
        // 基线优先于补期：新建、改 cron、状态文件坏了，都先把水位锚在最近一期。
        next[plan.id] = {
          cron: plan.cron,
          last_fired: occKey,
          last_task: prev && prev.cron === plan.cron ? (prev.last_task || "") : "",
        };
        dirty = true;
        anchored.push(plan.id);
        this.log(`schedule baseline ${plan.id}（期次 ${occKey}，本次不建单）`);
        continue;
      }
      if (prev.last_fired === occKey) continue;
      pending.push({
        plan,
        occKey,
        idem: `sched:${this.node}:${plan.id}:${occKey}`,
      });
    }
    if (dirty) {
      try {
        writeState(this.statePath, next);
      } catch (e) {
        // 基线没落盘就建单的话，重启会把同一期再补一次。本轮宁可漏触发。
        this.log("schedule_local_state.json 写失败，本轮不建单：" + (e?.message ?? e));
        return;
      }
      for (const id of anchored) this._forgetCreateFail(id);
    }
    const stateNow = dirty ? next : baselines;
    let taskRows = null;
    let taskKeys = null;
    for (const item of pending) {
      // 同一轮多条计划共用这一次 Tasks 读取，后面只在内存里补键，避免并发写。
      if (taskRows == null) {
        taskRows = await this.bus.listRecords(this.bus.tables.tasks);
        taskKeys = new Set(taskRows.map((row) => String(f1(row, "Idempotency_Key") ?? "")).filter(Boolean));
      }
      if (taskKeys.has(item.idem)) {
        const existing = taskRows.find((row) => String(f1(row, "Idempotency_Key") ?? "") === item.idem);
        stateNow[item.plan.id] = {
          cron: item.plan.cron,
          last_fired: item.occKey,
          last_task: existing ? String(f1(existing, "Task_ID") ?? "") : (stateNow[item.plan.id]?.last_task || ""),
        };
        try {
          writeState(this.statePath, stateNow);
          this._forgetCreateFail(item.plan.id);
          this.log(`schedule watermark healed ${item.plan.id}（期次 ${item.occKey} 已建单）`);
        } catch (e) {
          this.log(`调度水位线回写失败 ${item.plan.id}：` + (e?.message ?? e));
        }
        continue;
      }
      let taskId;
      try {
        // 一律 submitted。createTask 先写 instruction，最后写 Tasks 行。
        taskId = await this.createTask({
          bus: this.bus,
          from: this.node,
          source: "cron",
          to: this.node,
          cap: item.plan.cap,
          text: item.plan.text,
          approval: item.plan.approval,
          idempotencyKey: item.idem,
          now: nowDate,
        });
      } catch (e) {
        // 名片暂不可派时不推进水位，下一轮重试，避免把这一期丢掉。
        // 同一期次只记一次，否则分钟唤醒会把同一句刷满日志。
        this._forgetCreateFail(item.plan.id, item.occKey);
        this._once(
          `create-fail:${item.plan.id}:${item.occKey}`,
          `调度建单失败 ${item.plan.id}（期次 ${item.occKey}，下一轮重试）：` + (e?.message ?? e),
        );
        continue;
      }
      this._forgetCreateFail(item.plan.id);
      taskKeys.add(item.idem);
      stateNow[item.plan.id] = { cron: item.plan.cron, last_fired: item.occKey, last_task: taskId };
      try {
        writeState(this.statePath, stateNow);
      } catch (e) {
        this.log(`调度水位线回写失败 ${item.plan.id}（下轮按幂等键自愈）：` + (e?.message ?? e));
      }
      try { this.notify(); }
      catch (e) { this.log("本地调度唤醒失败：" + (e?.message ?? e)); }
      this.log(`schedule fired ${item.plan.id} -> ${taskId}（期次 ${item.occKey}）`);
    }
    this._view = { plans: entries, state: stateNow, tz };
    await this._mirror();
  }

  async _mirror() {
    if (!this._view) return;
    try {
      await this.mirror.sync(this._view);
    } catch (e) {
      this.log("计划镜像失败（调度结果保留）：" + (e?.message ?? e));
    }
  }

  _readFile() {
    let raw;
    try {
      raw = fs.readFileSync(this.schedulesPath, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return { missing: true, list: [] };
      return { broken: e.message, list: [] };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { broken: e.message, list: [] };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.schedules)) {
      return { broken: "schedules.json 结构无法识别", list: [] };
    }
    this._logged.delete("file");
    return { list: parsed.schedules };
  }

  _accept(list, caps) {
    const seen = new Set();
    const entries = [];
    list.forEach((entry, index) => {
      const reason = this._rejectReason(entry, seen, caps);
      if (reason) {
        const id = entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim()
          ? entry.id.trim()
          : `#${index}`;
        this._once(`plan:${id}:${reason}`, `本地计划 ${id} 已停用：${reason}`);
        return;
      }
      const id = String(entry.id).trim();
      seen.add(id);
      const approval = String(entry.approval_class ?? "").trim();
      entries.push({
        id,
        enabled: entry.enabled === true,
        cron: String(entry.cron).trim(),
        parsed: parseCron(String(entry.cron).trim()),
        cap: String(entry.cap).trim(),
        text: String(entry.text),
        approval,
      });
    });
    return entries;
  }

  // approval_class 是这条计划要带上的审批级别，不是执行控制。
  // 其余控制键仍用 config.mjs 的清单，避免从计划里读出 command / cwd / context。
  _rejectReason(entry, seen, caps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "条目不是对象";
    const probe = { ...entry };
    delete probe.approval_class;
    const bad = controlKeysIn(probe);
    if (bad.length) return `含执行控制键 ${bad.join(", ")}`;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) return "缺少 id";
    if (seen.has(id)) return "id 重复";
    if (typeof entry.enabled !== "boolean") return "enabled 必须是布尔值";
    if (typeof entry.cron !== "string" || !entry.cron.trim()) return "缺少 cron";
    try {
      parseCron(entry.cron);
    } catch (e) {
      return "cron 无法解析：" + (e?.message ?? e);
    }
    const cap = typeof entry.cap === "string" ? entry.cap.trim() : "";
    if (!cap) return "缺少 cap";
    if (!caps.has(cap)) return "cap 不在本机 commands.json";
    if (typeof entry.text !== "string") return "缺少 text";
    if (entry.approval_class != null && entry.approval_class !== "") {
      const approval = String(entry.approval_class).trim();
      if (!APPROVALS.has(approval)) return "approval_class 只能是 auto、notify 或 approve";
    }
    return "";
  }
}
