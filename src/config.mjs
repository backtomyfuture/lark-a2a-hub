// 节点配置、执行控制键拒收与超时夹紧。凭据只从本机 node.json / env 文件读取。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeishuBus } from "./bus/feishu.mjs";

// 任务参数里唯一允许影响执行的键是 timeout_sec。其余执行控制键一律拒收（标准 §9）：
// 命令、目录、语境、Agent、权限只来自本机 commands.json，不能从总线上改。
const EXEC_CONTROL_KEYS = new Set([
  "command", "cmd", "cwd", "context", "agent", "worker", "mode",
  "side_effect", "approval_class", "permissions", "permission",
  "shell", "env", "executable", "argv", "bin", "max_timeout_sec",
]);

export function controlKeysIn(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return [];
  const bad = [];
  for (const k of Object.keys(params)) {
    const lk = String(k).trim().toLowerCase();
    if (lk === "timeout_sec") continue;
    if (EXEC_CONTROL_KEYS.has(lk)) bad.push(k);
  }
  return bad;
}

// 先要求有限正数，否则回退条目默认；再收紧到 [1, max]，避免 NaN 或超长超时占住主循环。
export function clampTimeoutSec(raw, entry) {
  const fallbackNum = Number(entry?.timeout_sec);
  const fallback = Number.isFinite(fallbackNum) && fallbackNum > 0 ? fallbackNum : 600;
  const capNum = Number(entry?.max_timeout_sec ?? entry?.timeout_sec ?? 600);
  const cap = Number.isFinite(capNum) && capNum >= 1 ? capNum : Math.max(1, fallback);
  const n = Number(raw);
  const chosen = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(cap, Math.max(1, chosen));
}

// ---------- 能力表归一（标准 v3.7 §9：Node / Worker / Skill） ----------
//
// commands.json 根上的保留键 workers 定义本机的 Worker（Agent CLI 的启动模板），其余键是 Skill。
// 归一后得到一张平表：键是「能力键」，节点本尊的能力就是技能名，Worker 的能力是 <worker>/<skill>，
// 条目上带 worker 与 skill 两个字段。没有 workers 键的旧配置原样通过，含义不变。

const WORKER_NAME = /^[A-Za-z0-9._-]+$/;
// 启动方式只归 Worker 管，技能条目不能改写。
const LAUNCH_KEYS = new Set(["command", "resume_command", "mode", "context", "cwd", "workers", "cap_id", "worker", "skill"]);
const APPROVAL_RANK = { "": 0, auto: 0, notify: 1, auto_notify: 1, approve: 2 };

function isEntry(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function capKey(worker, skill) {
  return worker ? `${worker}/${skill}` : String(skill);
}

// 本地审批下限取 Worker 与 Skill 中更严者：Worker 的无头权限不能被技能条目放松。
function stricterApproval(a, b) {
  const rank = (v) => APPROVAL_RANK[String(v ?? "").trim()] ?? 2;
  if (a == null && b == null) return undefined;
  return rank(a) >= rank(b) ? (a ?? b) : b;
}

function workerSkillEntry(workerEntry, skillEntry, worker, skill) {
  const merged = { ...workerEntry };
  // 名称与说明是技能的属性。专长技能没写就留空，不借 Worker 的名字冒充。
  if (skillEntry) {
    delete merged.name;
    delete merged.desc;
    for (const [k, v] of Object.entries(skillEntry)) {
      if (!LAUNCH_KEYS.has(k) && k !== "approval_class") merged[k] = v;
    }
    const approval = stricterApproval(workerEntry.approval_class, skillEntry.approval_class);
    if (approval !== undefined) merged.approval_class = approval;
  }
  merged.worker = worker;
  merged.skill = skill;
  return merged;
}

// onProblem 收到一句人话。出问题的那一项能力不进平表，其余照常（失败要响，但不连坐）。
export function normalizeCommands(raw, onProblem = () => {}) {
  if (!isEntry(raw)) return {};
  const workers = {};
  if (raw.workers !== undefined) {
    if (!isEntry(raw.workers)) {
      onProblem("workers 是保留键，必须是对象（Worker 名 -> 启动模板）");
    } else {
      for (const [name, w] of Object.entries(raw.workers)) {
        if (!WORKER_NAME.test(name)) {
          onProblem(`Worker ${name}：名字只能含字母、数字、. _ -`);
        } else if (!isEntry(w) || typeof w.command !== "string" || !w.command.trim()) {
          onProblem(`Worker ${name} 缺 command 模板`);
        } else if (w.mode != null && w.mode !== "agent" && w.mode !== "json") {
          onProblem(`Worker ${name}：mode=${JSON.stringify(w.mode)} 非法（Worker 只认 agent / json）`);
        } else {
          workers[name] = w;
        }
      }
    }
  }
  const out = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (key === "workers") continue;
    if (!isEntry(entry) || !Array.isArray(entry.workers)) {
      // 节点本尊的能力（或坏条目）：原样留给既有校验。
      out[key] = entry;
      continue;
    }
    if (typeof entry.command === "string" && entry.command.trim()) {
      onProblem(`能力 ${key}：不能同时写 command 与 workers`);
      continue;
    }
    for (const item of entry.workers) {
      const name = String(item ?? "").trim();
      if (!workers[name]) {
        onProblem(`能力 ${key}：引用了未定义的 Worker ${name || "(空)"}`);
        continue;
      }
      out[capKey(name, key)] = workerSkillEntry(workers[name], entry, name, key);
    }
  }
  // 每个 Worker 固有通用能力 agent（标准 v3.8：是属性不是技能）。
  // 它只在本机归一表里 materialize，供认领解析与执行使用；名片登记会跳过它
  // （见 isGenericCap），名册里不再为每个 Worker 堆一行同名卡。
  // 条目里显式列过的不重复生成，顺序以显式的为先。
  for (const [name, w] of Object.entries(workers)) {
    const key = capKey(name, "agent");
    if (!out[key]) out[key] = workerSkillEntry(w, null, name, "agent");
  }
  return out;
}

// Worker 的通用能力（标准 v3.8）：带 Worker 的 agent 条目都是它——自动生成的，
// 或显式写了 agent 条目给它取名/写说明的。它可寻址、可执行，但不登记名片。
export function isGenericCap(entry) {
  return !!(entry && typeof entry === "object" && entry.worker && entry.skill === "agent");
}

// 任务行的 Worker × Skill 在归一后的能力表里对应哪一项；空串表示本机没有这项能力。
// 指定了 Worker 就是硬约束，不换别的 Worker 代跑。没指定时节点本尊优先，否则取第一个登记了该技能的 Worker。
export function resolveCapKey(commands, skill, worker = "") {
  const s = String(skill ?? "").trim();
  const w = String(worker ?? "").trim();
  if (!s || !isEntry(commands)) return "";
  if (w) {
    const key = capKey(w, s);
    return isEntry(commands[key]) && commands[key].worker === w ? key : "";
  }
  if (isEntry(commands[s]) && !commands[s].worker) return s;
  for (const [key, entry] of Object.entries(commands)) {
    if (isEntry(entry) && entry.worker && entry.skill === s) return key;
  }
  return "";
}

// 能力 Cap_ID 的唯一推导口径（标准 §6）。节点本尊：条目显式 cap_id 优先，否则 CAP-<capPrefix>-<能力名>；
// Worker 的能力固定 CAP-<capPrefix>-<worker>-<skill>。
// 老配置没有 cap_id 字段，名片却一直按兜底值登记；内核登记、本地调度校验、doctor 必须共用这一份，
// 否则校验认不得线上已有的名片。
export function capIdOf(skill, entry, capPrefix) {
  if (isEntry(entry) && entry.worker) return `CAP-${capPrefix}-${entry.worker}-${entry.skill}`;
  const explicit = entry && typeof entry === "object" ? String(entry.cap_id ?? "").trim() : "";
  return explicit || `CAP-${capPrefix}-${skill}`;
}

export function capIdsOf(commands, capPrefix) {
  const caps = new Set();
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) return caps;
  for (const [skill, entry] of Object.entries(normalizeCommands(commands))) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    caps.add(capIdOf(skill, entry, capPrefix));
  }
  return caps;
}

// 不走 loadConfig（它要凭据），只取推导 Cap_ID 需要的前缀，与 loadConfig 的 capPrefix 缺省同口径。
export function capPrefixFromNodeJson(configDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
    return raw?.capPrefix ?? raw?.node ?? "";
  } catch {
    return "";
  }
}

function readEnvFile(p) {
  const kv = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

export function loadConfig(configDir) {
  const cfgPath = path.join(configDir, "node.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  let { appId, appSecret } = cfg;
  if ((!appId || !appSecret) && cfg.appEnv) {
    const kv = readEnvFile(cfg.appEnv.replace(/^~/, os.homedir()));
    appId = appId || kv.APP_ID;
    appSecret = appSecret || kv.APP_SECRET;
  }
  if (!appId || !appSecret) throw new Error("no app credentials: set appId/appSecret or appEnv in node.json");
  if (!cfg.node) throw new Error("node.json missing 'node'");
  if (!cfg.baseToken || !cfg.tables) throw new Error("node.json missing baseToken/tables");
  return {
    node: cfg.node,
    role: cfg.role,
    kind: cfg.kind || "host",
    zone: cfg.zone ?? "",
    nodeDesc: cfg.nodeDesc ?? "",
    pollSec: cfg.pollSec ?? 45,
    sweepSec: cfg.sweepSec ?? 900,
    events: cfg.events !== false,
    doorbellFile: cfg.doorbellFile ? cfg.doorbellFile.replace(/^~/, os.homedir()) : null,
    carrierSocket: cfg.carrierSocket ? cfg.carrierSocket.replace(/^~/, os.homedir()) : path.join(configDir, "carrier.sock"),
    capPrefix: cfg.capPrefix ?? cfg.node,
    // 仅 kind=agent 节点用：本尊的名字，登记名片时写进 Worker 列（标准 v3.8 §6）。
    workerName: cfg.workerName ?? "",
    // hub 的审批签名公钥（base64）。配了就只认签名对得上的 auth_decision（标准 §8.3 第 5 条）。
    hubPublicKey: cfg.hubPublicKey,
    // 只给节点本地定时调度读。缺省由 resolveScheduleTz 解释成 Asia/Shanghai，这里不套宿主机时区。
    tz: cfg.tz,
    // 缺省 undefined。hub 角色由传输层强制走长连接；不在这里把缺省改写成 node，避免和角色改造抢字段语义。
    bus: new FeishuBus({ appId, appSecret, baseToken: cfg.baseToken, tables: cfg.tables, domain: cfg.domain }),
    configDir,
  };
}


export function receiveModeOf(cfg) {
  // 标准 §6 / §10.3：守护进程只登记 event 或 poll。
  // automation 只给协议接入型节点，而且只能来自手工名片，不能由本函数产出。
  if (cfg?.events || cfg?.doorbellFile) return "event";
  return "poll";
}
