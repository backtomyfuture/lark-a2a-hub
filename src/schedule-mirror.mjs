// 本节点计划的 Rules 观察镜像（方案 §3.4）。
// 只把自己的计划摘要写进 Rules，供总览页查看。不读这些行来触发，
// 也不改别人的行：触发只认本机 schedules.json。
import fs from "node:fs";
import path from "node:path";
import { f1 } from "./bus/feishu.mjs";
import { formatOccurrenceKey } from "./schedule-cron.mjs";

const REFRESH_MS = 15 * 60 * 1000;
const FIELDS = ["Rule_ID", "Target_Node", "Skill_ID", "Schedule", "Text", "Enabled", "Last_Fired", "Note"];

function text(row, name) {
  // 不 trim。Text 尾部空格若被裁掉，下一轮比对会认为变了，从而每轮重写。
  return String(f1(row, name) ?? "");
}

function noteBody(note) {
  return String(note ?? "").replace(/同步于 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}/, "同步于").trim();
}

// 同步于的时间要能和 now 比 15 分钟。期次键的偏移不带冒号，这里补上再交给 Date.parse。
function noteStamp(note) {
  const matched = /同步于 (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{4})/.exec(String(note ?? ""));
  if (!matched) return null;
  const off = matched[2];
  const iso = `${matched[1]}${off.slice(0, 3)}:${off.slice(3)}`;
  const stamp = Date.parse(iso);
  return Number.isFinite(stamp) ? stamp : null;
}

export class ScheduleMirror {
  constructor({ bus, node, now = () => Date.now(), log, statePath } = {}) {
    this.bus = bus;
    this.node = String(node ?? "");
    this.now = now;
    this.log = typeof log === "function" ? log : () => {};
    this.statePath = statePath || null;
    this._logged = new Set();
    this._syncedOnce = false;
    this._mirroredIds = null;
    // 没有任务列表的那次同步不能把已经看见的终态写回 submitted。
    this._status = new Map();
  }

  _once(key, line) {
    if (this._logged.has(key)) return;
    this._logged.add(key);
    this.log(line);
  }

  async sync({ plans = [], state = {}, tasks = null, tz, statePath } = {}) {
    if (statePath) this.statePath = statePath;
    const table = this.bus?.tables?.rules;
    if (!table) {
      this._once("rules-missing", "node.json 缺少 tables.rules，跳过计划镜像");
      return;
    }
    let rows;
    try {
      rows = await this.bus.listRecords(table);
    } catch (e) {
      this.log("读取 Rules 镜像失败，本轮跳过：" + (e?.message ?? e));
      return;
    }
    const nowMs = Number(this.now());
    const clock = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
    let stamp;
    try {
      stamp = formatOccurrenceKey(clock, tz);
    } catch (e) {
      this.log("计划镜像时区无法格式化，本轮跳过：" + (e?.message ?? e));
      return;
    }

    let fileMirrored = null;
    let fileHasField = false;
    if (this.statePath) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        if (Array.isArray(raw?.mirrored_ids)) {
          fileMirrored = raw.mirrored_ids.filter((x) => typeof x === "string" && x);
          fileHasField = true;
        }
      } catch {}
    } else if (Array.isArray(state?.mirrored_ids)) {
      fileMirrored = state.mirrored_ids.filter((x) => typeof x === "string" && x);
      fileHasField = true;
    }

    if (this._mirroredIds == null) {
      if (fileHasField) {
        this._mirroredIds = new Set(fileMirrored || []);
      } else {
        // 升级兼容：状态文件没有该字段时，把当前 schedules.json 里存在的 id 视为初值，避免把旧镜像行误当孤儿置 No
        this._mirroredIds = new Set(plans.map((p) => p && p.id).filter(Boolean));
      }
    } else if (fileMirrored != null) {
      for (const id of fileMirrored) this._mirroredIds.add(id);
    }

    // 启动后的第一次即使字段没变也刷新「同步于」，总览页能看出这个进程还活着。
    const force = !this._syncedOnce;
    this._syncedOnce = true;
    const prefix = `${this.node}:`;
    const live = new Set();
    for (const plan of plans) {
      const id = String(plan?.id ?? "");
      if (!id) continue;
      live.add(id);
      this._mirroredIds.add(id);
      const ruleId = `${prefix}${id}`;
      const saved = state?.[id] && typeof state[id] === "object" ? state[id] : {};
      const desired = this._desired(plan, saved, tasks, stamp, ruleId);
      const existing = rows.find((row) => text(row, "Rule_ID") === ruleId);
      await this._upsert(table, existing, desired, force, nowMs);
    }
    for (const row of rows) {
      const ruleId = text(row, "Rule_ID");
      if (!ruleId.startsWith(prefix) || text(row, "Target_Node") !== this.node) continue;
      const id = ruleId.slice(prefix.length);
      // 只对本节点 local-schedule 镜像过、且已不在 schedules.json 的 id 置 Enabled=No；不在集合内（含 register 行）一律不动
      if (!id || live.has(id) || !this._mirroredIds.has(id)) continue;
      const desired = {
        Rule_ID: ruleId,
        Target_Node: this.node,
        Skill_ID: text(row, "Skill_ID"),
        Schedule: text(row, "Schedule"),
        Text: text(row, "Text"),
        Enabled: "No",
        Last_Fired: text(row, "Last_Fired"),
        Note: `计划已不在本机 schedules.json；同步于 ${stamp}`,
      };
      // 下线行只在首次置 No 时写一次。之后不再按 15 分钟刷新「同步于」。
      await this._upsert(table, row, desired, force, nowMs, false);
    }

    if (this.statePath) {
      try {
        let existing = {};
        try {
          existing = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        } catch {}
        const nextList = Array.from(this._mirroredIds).sort();
        const prevList = Array.isArray(existing?.mirrored_ids) ? existing.mirrored_ids : [];
        if (JSON.stringify(nextList) !== JSON.stringify(prevList)) {
          existing.mirrored_ids = nextList;
          const dir = path.dirname(this.statePath);
          fs.mkdirSync(dir, { recursive: true });
          const tmp = this.statePath + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify(existing, null, 1), { mode: 0o600 });
          fs.renameSync(tmp, this.statePath);
          fs.chmodSync(this.statePath, 0o600);
        }
      } catch (e) {
        this.log("schedule_local_state.json 记录 mirrored_ids 失败：" + (e?.message ?? e));
      }
    }
  }

  _desired(plan, saved, tasks, stamp, ruleId) {
    const lastFired = typeof saved.last_fired === "string" ? saved.last_fired : "";
    const idem = `sched:${this.node}:${plan.id}:${lastFired}`;
    let taskId = typeof saved.last_task === "string" ? saved.last_task : "";
    let status = taskId ? (this._status.get(plan.id) || "submitted") : "";
    if (Array.isArray(tasks) && lastFired) {
      const hit = tasks.find((row) => text(row, "Idempotency_Key") === idem);
      if (hit) {
        taskId = text(hit, "Task_ID") || taskId;
        status = text(hit, "Status") || status || "submitted";
        this._status.set(plan.id, status);
      }
    }
    const note = taskId
      ? `上次运行 ${taskId} ${status || "submitted"}；同步于 ${stamp}`
      : `尚未运行；同步于 ${stamp}`;
    return {
      Rule_ID: ruleId,
      Target_Node: this.node,
      Skill_ID: String(plan.cap ?? ""),
      Schedule: String(plan.cron ?? ""),
      Text: String(plan.text ?? ""),
      Enabled: plan.enabled ? "Yes" : "No",
      Last_Fired: lastFired,
      Note: note,
    };
  }

  _sameBody(row, desired) {
    for (const key of FIELDS) {
      if (key === "Note") continue;
      if (text(row, key) !== desired[key]) return false;
    }
    return noteBody(text(row, "Note")) === noteBody(desired.Note);
  }

  _unchanged(row, desired, nowMs) {
    if (!this._sameBody(row, desired)) return false;
    const stamp = noteStamp(text(row, "Note"));
    if (stamp == null) return false;
    return nowMs - stamp < REFRESH_MS;
  }

  async _upsert(table, existing, desired, force, nowMs, refreshStamp = true) {
    try {
      if (!existing) {
        await this.bus.createRecord(table, desired);
        return;
      }
      // 已下线的行正文没变就停。force 和 15 分钟刷新都不改写「同步于」。
      if (!refreshStamp && this._sameBody(existing, desired)) return;
      if (!force && this._unchanged(existing, desired, nowMs)) return;
      const patch = {};
      for (const key of FIELDS) {
        if (key === "Rule_ID") continue;
        if (text(existing, key) !== desired[key]) patch[key] = desired[key];
      }
      if (!Object.keys(patch).length) return;
      await this.bus.updateRecord(table, existing.record_id, patch);
    } catch (e) {
      this.log(`计划镜像写入失败 ${desired.Rule_ID}：` + (e?.message ?? e));
    }
  }
}
