// 节点配置、执行控制键拒收与超时夹紧。凭据只从本机 node.json / env 文件读取。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeishuBus } from "./bus/feishu.mjs";

// 任务参数里唯一允许影响执行的键是 timeout_sec。其余执行控制键一律拒收（标准 §9）：
// 命令、目录、语境、Agent、权限只来自本机 commands.json，不能从总线上改。
const EXEC_CONTROL_KEYS = new Set([
  "command", "cmd", "cwd", "context", "agent", "mode",
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

// 能力 Cap_ID 的唯一推导口径：条目显式 cap_id 优先，否则 CAP-<capPrefix>-<能力名>。
// 老配置没有 cap_id 字段，名片却一直按兜底值登记；内核登记、本地调度校验、doctor 必须共用这一份，
// 否则校验认不得线上已有的名片。
export function capIdOf(skill, entry, capPrefix) {
  const explicit = entry && typeof entry === "object" ? String(entry.cap_id ?? "").trim() : "";
  return explicit || `CAP-${capPrefix}-${skill}`;
}

export function capIdsOf(commands, capPrefix) {
  const caps = new Set();
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) return caps;
  for (const [skill, entry] of Object.entries(commands)) {
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
    // 只给节点本地定时调度读。缺省由 resolveScheduleTz 解释成 Asia/Shanghai，这里不套宿主机时区。
    tz: cfg.tz,
    // 缺省 undefined。hub 角色由传输层强制走长连接；不在这里把缺省改写成 node，避免和角色改造抢字段语义。
    bus: new FeishuBus({ appId, appSecret, baseToken: cfg.baseToken, tables: cfg.tables }),
    configDir,
  };
}


export function receiveModeOf(cfg) {
  // 标准 §6 / §10.3：守护进程只登记 event 或 poll。
  // automation 只给协议接入型节点，而且只能来自手工名片，不能由本函数产出。
  if (cfg?.events || cfg?.doorbellFile) return "event";
  return "poll";
}
