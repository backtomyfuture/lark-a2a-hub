// setup —— 一键配置向导：把「装节点」的门槛压到一条命令。
// 做完的事：确认 lark-cli 在位（不在则用 npm 装）；复用 lark-cli 已配置的
// 飞书应用（凭据只在本机流转：配置文件 / macOS 钥匙串 / 环境变量 /
// 已有 600 的 app.env -> 本机 app.env，绝不打印明文，也不接受命令行 Secret）；
// 向 Base 自动发现六张表的 ID 并写入 node.json；host 节点按本机已装 CLI Agent 生成能力（不预置任何占位能力）；
// 最后跑 doctor 自检，可选顺带注册开机自启。
// 已有 lark-cli 配置是主路径；没有时给出确切的下一步（lark-cli config init）。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync, execSync } from "node:child_process";
import { FeishuBus } from "./bus/feishu.mjs";
import { doctor, checkAppEventSubscribed } from "./doctor.mjs";
import { service } from "./service.mjs";

const REQUIRED_TABLES = ["Tasks", "Messages", "Parts", "Runs", "Artifacts", "AgentCards"];
const TABLE_KEYS = { Tasks: "tasks", Messages: "messages", Parts: "parts", Runs: "runs", Artifacts: "artifacts", AgentCards: "agentCards" };

export function parseFlags(argv) {
  const f = { yes: false, force: false, service: false, role: "node", kind: "", skipSkill: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--force") f.force = true;
    else if (a === "--service") f.service = true;
    else if (a === "--skip-skill") f.skipSkill = true;
    else if (a === "--help" || a === "-h") f.help = true;
    else if (a === "--wake") {
      f.wakeSeen = true;
      const next = argv[i + 1];
      if (next == null || next === "" || String(next).startsWith("--")) f.wakeMissing = true;
      else { f.wake = next; i++; }
    } else if (a.startsWith("--wake=")) {
      f.wakeSeen = true;
      f.wake = a.slice("--wake=".length);
      if (!String(f.wake ?? "").trim()) f.wakeMissing = true;
    }
    else if (a === "--role") f.role = argv[++i] || "node";
    else if (a.startsWith("--role=")) f.role = a.slice("--role=".length);
    else if (a === "--kind") f.kind = argv[++i] || "host";
    else if (a.startsWith("--kind=")) f.kind = a.slice("--kind=".length);
    else if (a === "--owner" || a === "--owner-open-id") f.ownerOpenId = argv[++i];
    else if (a.startsWith("--owner=")) f.ownerOpenId = a.slice("--owner=".length);
    else if (a.startsWith("--owner-open-id=")) f.ownerOpenId = a.slice("--owner-open-id=".length);
    else if (a === "--base") f.base = argv[++i];
    else if (a === "--node") f.node = argv[++i];
    else if (a === "--zone") f.zone = argv[++i];
    else if (a === "--prefix") f.prefix = argv[++i];
    else if (a === "--desc") f.desc = argv[++i];
    else if (a === "--app-id") f.appId = argv[++i];
    // 明文参数会留在 ps 和 shell 历史里，只拒绝、不保存值。
    else if (a === "--app-secret" || a.startsWith("--app-secret=")) {
      f.rejectAppSecret = true;
      if (a === "--app-secret") i++;
    }
  }
  return f;
}

function richPath() {
  const extra = [
    path.join(os.homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".npm-global/bin"),
    path.join(os.homedir(), ".bun/bin"),
    path.join(os.homedir(), ".cargo/bin"),
    path.join(os.homedir(), ".antigravity/antigravity/bin"),
    path.join(os.homedir(), ".amp/bin"),
    path.join(os.homedir(), ".grok/bin"),
  ];
  const cur = (process.env.PATH || "").split(path.delimiter);
  return [...new Set([...extra, ...cur])].join(path.delimiter);
}

function findExecutable(binName) {
  const dirs = richPath().split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const fullPath = path.join(dir, binName);
    try {
      if (fs.existsSync(fullPath)) {
        fs.accessSync(fullPath, fs.constants.X_OK);
        return fullPath;
      }
    } catch { /* 不可执行或不存在 */ }
  }
  return null;
}

function findLarkCliBin() {
  return findExecutable("lark-cli") || "lark-cli";
}

function run(cmd, args, opts = {}) {
  const resolvedCmd = cmd === "lark-cli" ? findLarkCliBin() : cmd;
  return execFileSync(resolvedCmd, args, { encoding: "utf8", env: { ...process.env, PATH: richPath() }, stdio: ["ignore", "pipe", "ignore"], ...opts });
}

function checkDriveSubscription(baseToken, appId) {
  try {
    const args = [
      "api", "GET", `/open-apis/drive/v1/files/${baseToken}/get_subscribe`,
      "--params", JSON.stringify({ file_type: "bitable" }),
      "--as", "user",
      "--json",
    ];
    const out = run("lark-cli", args);
    const parsed = JSON.parse(out);
    if (parsed?.data?.is_subscribe === true) return { subscribed: true };
    return { subscribed: false, error: parsed?.error?.message || parsed?.msg || (parsed?.data?.is_subscribe === false ? "未订阅" : out.trim()) };
  } catch (e) {
    return { subscribed: false, error: e.message };
  }
}

// 尝试以当前用户身份向 Base 注册云文档事件订阅（ws 秒级门铃所需）
function tryRegisterDriveSubscription(baseToken, appId) {
  const before = checkDriveSubscription(baseToken, appId);
  if (before.subscribed) return { success: true };

  try {
    const out = run("lark-cli", [
      "api", "POST", `/open-apis/drive/v1/files/${baseToken}/subscribe`,
      "--params", JSON.stringify({ file_type: "bitable" }),
      "--as", "user",
      "--json",
    ]);
    const parsed = JSON.parse(out);
    const after = checkDriveSubscription(baseToken, appId);
    if (after.subscribed) return { success: true };
    return { success: false, error: parsed?.error?.message || parsed?.msg || after.error || out.trim() };
  } catch (e) {
    const after = checkDriveSubscription(baseToken, appId);
    if (after.subscribed) return { success: true };
    return { success: false, error: e.message };
  }
}

function checkUserScopes(requiredScopes = ["docs:event:subscribe", "docs:permission.member:create"]) {
  try {
    const out = run("lark-cli", ["auth", "status", "--json"]);
    const d = JSON.parse(out);
    const user = d?.identities?.user;
    if (!user || user.available !== true) {
      return { ok: false, missing: requiredScopes };
    }
    const rawScope = user.scope || "";
    const scopes = new Set(typeof rawScope === "string" ? rawScope.split(/\s+/).filter(Boolean) : (Array.isArray(rawScope) ? rawScope : []));
    const missing = requiredScopes.filter((s) => !scopes.has(s));
    return { ok: missing.length === 0, missing };
  } catch (e) {
    return { ok: false, missing: requiredScopes, error: e.message };
  }
}

// 当机器人没有多维表格读写权限时，用当前已登录 User 身份自动把应用添加为该 Base 的协作者
function tryAddBotCollaborator(baseToken, appId) {
  if (!baseToken || !appId) return false;
  try {
    const out = run("lark-cli", [
      "drive", "+member-add",
      "--token", baseToken,
      "--type", "bitable",
      "--member-type", "appid",
      "--member-id", appId,
      "--perm", "full_access",
      "--as", "user",
      "--yes",
      "--json",
    ]);
    const parsed = JSON.parse(out);
    if (parsed && (parsed.code === 0 || parsed.member || parsed.data || parsed.member_id || !parsed.error)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function larkVersion() {
  try {
    return run("lark-cli", ["--version"]).trim();
  } catch {
    return null;
  }
}

function ensureLarkCli() {
  const v = larkVersion();
  if (v) {
    console.log(`  ✓ lark-cli 已安装（${v}）`);
    return true;
  }
  console.log("  · 未发现 lark-cli，正在通过 npm 安装 @larksuite/cli …");
  try {
    execSync("npm install -g @larksuite/cli", { stdio: "inherit", env: { ...process.env, PATH: richPath() } });
  } catch {
    console.error("  ✗ npm 安装 lark-cli 失败。请先确认 Node.js/npm 可用，再重跑 lah setup。");
    return false;
  }
  const v2 = larkVersion();
  if (!v2) {
    console.error("  ✗ lark-cli 安装后仍不可用（可能不在 PATH 中）。新开一个终端再试。");
    return false;
  }
  console.log(`  ✓ lark-cli 已安装（${v2}）`);
  return true;
}

function readLarkConfig() {
  const candidates = [
    path.join(os.homedir(), ".lark-cli", "config.json"),
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "lark-cli", "config.json") : null,
    path.join(os.homedir(), ".config", "lark-cli", "config.json"),
    path.join(os.homedir(), "Library", "Application Support", "lark-cli", "config.json"),
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "lark-cli", "config.json") : null,
    path.join(os.homedir(), ".local", "share", "lark-cli", "config.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(d.apps) && d.apps.length) return { path: p, apps: d.apps };
    } catch { /* 下一个候选 */ }
  }
  return null;
}

function parseMasterKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.startsWith("go-keyring-base64:")) {
    try {
      s = Buffer.from(s.slice("go-keyring-base64:".length), "base64").toString("utf8").trim();
    } catch {
      return null;
    }
  }
  try {
    const key = Buffer.from(s, "base64");
    if (key.length === 32) return key;
  } catch {
    return null;
  }
  return null;
}

function loadMasterKey() {
  const fileCandidates = [
    path.join(os.homedir(), "Library", "Application Support", "lark-cli", "master.key.file"),
    path.join(os.homedir(), "Library", "Application Support", "lark-cli", "master.key"),
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "lark-cli", "master.key.file") : null,
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "lark-cli", "master.key") : null,
    path.join(os.homedir(), ".local", "share", "lark-cli", "master.key.file"),
    path.join(os.homedir(), ".local", "share", "lark-cli", "master.key"),
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "lark-cli", "master.key.file") : null,
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "lark-cli", "master.key") : null,
    path.join(os.homedir(), ".config", "lark-cli", "master.key.file"),
    path.join(os.homedir(), ".config", "lark-cli", "master.key"),
    path.join(os.homedir(), ".lark-cli", "master.key.file"),
    path.join(os.homedir(), ".lark-cli", "master.key"),
  ].filter(Boolean);
  for (const fp of fileCandidates) {
    try {
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, "utf8").trim();
        const key = parseMasterKey(content);
        if (key) return key;
      }
    } catch { /* 下一个 */ }
  }

  if (process.platform === "darwin") {
    try {
      const out = run("security", ["find-generic-password", "-s", "lark-cli", "-a", "master.key", "-w"]).trim();
      const key = parseMasterKey(out);
      if (key) return key;
    } catch { /* 忽略 */ }
  }

  if (process.platform === "linux") {
    try {
      const out = run("secret-tool", ["lookup", "service", "lark-cli", "username", "master.key"]).trim();
      const key = parseMasterKey(out);
      if (key) return key;
    } catch { /* 忽略 */ }
  }

  return null;
}

function decryptLarkCliSecret(secretId) {
  if (!secretId || typeof secretId !== "string") return null;
  const key = loadMasterKey();
  if (!key) return null;

  const encFileName = secretId.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc";
  const dirCandidates = [
    path.join(os.homedir(), "Library", "Application Support", "lark-cli"),
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "lark-cli") : null,
    path.join(os.homedir(), ".local", "share", "lark-cli"),
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "lark-cli") : null,
    path.join(os.homedir(), ".config", "lark-cli"),
    path.join(os.homedir(), ".lark-cli"),
  ].filter(Boolean);

  for (const dir of dirCandidates) {
    const encPath = path.join(dir, encFileName);
    try {
      if (!fs.existsSync(encPath)) continue;
      const buf = fs.readFileSync(encPath);
      if (buf.length < 12 + 16) continue;
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(buf.length - 16);
      const ciphertext = buf.subarray(12, buf.length - 16);

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      if (decrypted) return decrypted;
    } catch { /* 下一个目录或失败 */ }
  }

  return null;
}

// 从 lark-cli 的应用条目里解析出 secret 明文；只在本机内存里流转，绝不打印。
// 形态：明文字符串 / 新版 lark-cli 安全存储（AES-256-GCM 文件） / 旧版 macOS 钥匙串引用。
function resolveSecret(app) {
  const s = app?.appSecret;
  if (typeof s === "string" && s) return { value: s, source: "lark-cli 配置（明文）" };
  if (s && typeof s === "object") {
    // 优先尝试新版 lark-cli 安全存储解密（AES-256-GCM）
    if (s.id) {
      const dec = decryptLarkCliSecret(s.id);
      if (dec) return { value: dec, source: "lark-cli 安全存储（自动解密）" };
    }
    // 旧版回退：直接通过 security 查明文
    if (s.source === "keychain" && s.id && process.platform === "darwin") {
      for (const args of [["find-generic-password", "-a", s.id, "-w"], ["find-generic-password", "-l", s.id, "-w"], ["find-generic-password", "-s", s.id, "-w"]]) {
        try {
          const out = run("security", args).replace(/\n$/, "");
          if (out) return { value: out, source: "macOS 钥匙串（经 lark-cli 引用）" };
        } catch { /* 换一种查法 */ }
      }
    }
  }
  return null;
}

function extractBaseToken(input) {
  if (!input) return null;
  const m = String(input).match(/\/base\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const t = String(input).trim();
  return /^[A-Za-z0-9_-]{16,}$/.test(t) ? t : null;
}

// 自动探测和发现多维表格 Base（通过 lark-cli / tempBus 搜索及本机已有配置，并验证标准表）
async function discoverCandidateBases(tempBus, appId) {
  const candidates = [];
  const seen = new Set();

  const add = (token, name, source) => {
    const t = extractBaseToken(token);
    if (!t || seen.has(t)) return;
    seen.add(t);
    candidates.push({ token: t, name: name || t, source });
  };

  const addEntity = (o, source) => {
    if (!o || typeof o !== "object") return;
    if (o.docs_type && o.docs_type !== "bitable") return;
    const tok = o.docs_token || o.token || o.file_token || o.doc_token;
    const name = o.title || o.name;
    add(tok, name, source);
  };

  // 1. 优先使用 tempBus 以 Bot 身份搜索（依次尝试关键词 ['Agent中台', 'Agent', '中台']，一旦找到候选即停）
  if (tempBus && typeof tempBus.api === "function") {
    for (const kw of ["Agent中台", "Agent", "中台"]) {
      try {
        const res = await tempBus.api("POST", "/suite/docs-api/search/object", {
          search_key: kw,
          count: 10,
          docs_types: ["bitable"],
        });
        const objs = res?.docs_entities ?? res?.data?.docs_entities ?? [];
        for (const o of objs) {
          addEntity(o, `tempBus (bot) 搜索 "${kw}"`);
        }
        if (candidates.length > 0) break;
      } catch { /* 忽略错误，继续下一个关键词或后续搜索方式 */ }
    }
  }

  // 2. 若 tempBus 未搜出，尝试 lark-cli 以 bot 身份搜索
  if (candidates.length === 0) {
    for (const kw of ["Agent中台", "Agent", "中台"]) {
      try {
        const out = run("lark-cli", [
          "api", "POST", "/open-apis/suite/docs-api/search/object",
          "--data", JSON.stringify({ search_key: kw, count: 10, docs_types: ["bitable"] }),
          "--as", "bot",
          "--json",
        ]);
        const parsed = JSON.parse(out);
        const objs = parsed?.data?.docs_entities ?? parsed?.docs_entities ?? [];
        for (const o of objs) {
          addEntity(o, `lark-cli bot 搜索 "${kw}"`);
        }
        if (candidates.length > 0) break;
      } catch { /* 忽略错误 */ }
    }
  }

  // 3. 尝试用 lark-cli 搜索 'Agent中台' 或 bitable 类型文件（user 身份）
  if (candidates.length === 0) {
    try {
      const out = run("lark-cli", [
        "drive", "+search",
        "--doc-types", "bitable",
        "--query", "Agent中台",
        "--as", "user",
        "--json",
      ]);
      const parsed = JSON.parse(out);
      const docs = parsed?.docs ?? parsed?.data?.docs ?? parsed?.items ?? [];
      for (const d of docs) {
        addEntity(d, "lark-cli 搜索");
      }
    } catch { /* 忽略错误 */ }
  }

  if (candidates.length === 0) {
    try {
      const out = run("lark-cli", [
        "drive", "+search",
        "--doc-types", "bitable",
        "--page-size", "10",
        "--as", "user",
        "--json",
      ]);
      const parsed = JSON.parse(out);
      const docs = parsed?.docs ?? parsed?.data?.docs ?? parsed?.items ?? [];
      for (const d of docs) {
        addEntity(d, "lark-cli 搜索");
      }
    } catch { /* 忽略错误 */ }
  }

  if (candidates.length === 0) {
    try {
      const out = run("lark-cli", [
        "api", "POST", "/open-apis/suite/docs-api/search/object",
        "--data", JSON.stringify({ search_key: "Agent中台", count: 10, docs_types: ["bitable"] }),
        "--as", "user",
        "--json",
      ]);
      const parsed = JSON.parse(out);
      const objs = parsed?.data?.docs_entities ?? parsed?.docs_entities ?? [];
      for (const o of objs) {
        addEntity(o, "docs-api 搜索");
      }
    } catch { /* 忽略错误 */ }
  }

  // 2. 检查本地已有配置
  const knownConfigPaths = [
    path.join(os.homedir(), ".hub-node", "node.json"),
    path.join(os.homedir(), ".hub-node-hub", "node.json"),
  ];
  for (const p of knownConfigPaths) {
    try {
      if (fs.existsSync(p)) {
        const d = JSON.parse(fs.readFileSync(p, "utf8"));
        const token = d.baseToken;
        if (token && !isPlaceholderToken(token)) {
          add(token, "已有配置", p);
        }
      }
    } catch { /* 忽略错误 */ }
  }

  // 3. 用 tempBus 校验哪些 Base 包含 6 张标准表，并补全名字
  const verified = [];
  for (const c of candidates) {
    try {
      let meta;
      try {
        meta = await tempBus.api("GET", `/bitable/v1/apps/${c.token}`);
      } catch {
        if (appId && tryAddBotCollaborator(c.token, appId)) {
          try {
            meta = await tempBus.api("GET", `/bitable/v1/apps/${c.token}`);
          } catch { /* 仍然失败 */ }
        }
      }
      if (meta?.app?.name) c.name = meta.app.name;
      let tablesRes;
      try {
        tablesRes = await tempBus.api("GET", `/bitable/v1/apps/${c.token}/tables?page_size=100`);
      } catch {
        if (appId && tryAddBotCollaborator(c.token, appId)) {
          try {
            tablesRes = await tempBus.api("GET", `/bitable/v1/apps/${c.token}/tables?page_size=100`);
          } catch { /* 仍然失败 */ }
        }
      }
      const names = new Set((tablesRes?.items ?? []).map((t) => t.name));
      const hasAll = REQUIRED_TABLES.every((n) => names.has(n));
      c.hasStandardTables = hasAll;
      if (hasAll) verified.push(c);
    } catch {
      // 无法访问该 Base（无权限或不存在），跳过
    }
  }

  return verified.length > 0 ? verified : candidates;
}

// install.sh 曾经把 example 直接种成 node.json。这些值仍是占位符时，
// 首装还没完成：--yes 应覆盖而不是退出 4，交互默认 Y。
// app_token 是旧示例字段（正式配置用 baseToken），出现 REPLACE 或 bascn 即占位。
// baseToken / 表 ID 认本仓库 example 的尖括号、<REPLACE>，以及 bascnxxxx 这种填充。
function isPlaceholderToken(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  if (s.startsWith("<") || s.includes("REPLACE")) return true;
  return s === "bascn" || /^bascn[xX._-]+$/.test(s);
}

function isUnfinishedExample(raw) {
  if (!raw || typeof raw !== "object") return false;
  const appToken = raw.app_token ?? raw.appToken;
  if (typeof appToken === "string" && (appToken.includes("REPLACE") || appToken.includes("bascn"))) return true;
  const fields = [raw.baseToken];
  if (raw.tables && typeof raw.tables === "object") fields.push(...Object.values(raw.tables));
  return fields.some(isPlaceholderToken);
}

// 只认安装脚本种下的那份示例：相对路径 echo 指错，lan-exec 又会让 doctor 因 carrier 离线失败。
// 用户事后自己写的能力表不在这里替换。
function isExampleCommands(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (Object.hasOwn(obj, "lan-exec")) return true;
  return Object.values(obj).some((e) => typeof e?.command === "string" && e.command.includes("../src/executors/echo.mjs"));
}

const KNOWN_AGENTS = [
  {
    bin: "claude",
    skill: "claude-agent",
    name: "Claude Code Agent",
    cmdTemplate: (b) => `${b} -p {prompt}`,
    desc: "以 Claude Code (claude) 为执行主体，带本机终端与文件工具面处理开发、排障与自动化任务",
  },
  {
    bin: "codex",
    skill: "codex-agent",
    name: "Codex Agent",
    cmdTemplate: (b) => `${b} exec {prompt}`,
    desc: "以 OpenAI Codex CLI (codex) 为执行主体，处理代码编写、终端排障与自动化任务",
  },
  {
    bin: "agy",
    skill: "agy-agent",
    name: "Antigravity Agent",
    cmdTemplate: (b) => `${b} --print {prompt}`,
    desc: "以 Antigravity (agy) 为执行主体，带本机终端与工具面处理开放式开发与运维任务",
  },
  {
    bin: "gemini",
    skill: "gemini-agent",
    name: "Gemini Agent",
    cmdTemplate: (b) => `${b} -p {prompt}`,
    desc: "以 Gemini CLI (gemini) 为执行主体，处理本地分析、脚本与开发任务",
  },
  {
    bin: "amp",
    skill: "amp-agent",
    name: "Amp Agent",
    cmdTemplate: (b) => `${b} -x {prompt}`,
    desc: "以 Sourcegraph Amp (amp) 为执行主体，处理代码分析、终端操作与工程任务",
  },
  {
    bin: "droid",
    skill: "droid-agent",
    name: "Factory Droid Agent",
    cmdTemplate: (b) => `${b} exec {prompt}`,
    desc: "以 Factory Droid (droid) 为执行主体，处理本地开发、重构与终端自动化任务",
  },
  {
    bin: "grok",
    skill: "grok-agent",
    name: "Grok CLI Agent",
    cmdTemplate: (b) => `${b} -p {prompt}`,
    desc: "以本机 Grok CLI (grok) 为执行主体，处理调研、分析与本地工具执行任务",
  },
  {
    bin: "hermes",
    skill: "hermes-agent",
    name: "Hermes Agent",
    cmdTemplate: (b) => `${b} -z {prompt}`,
    desc: "以 Hermes Agent (hermes) 为执行主体，带本机工具面处理自动化与创作任务",
  },
  {
    bin: "cursor-agent",
    skill: "cursor-agent",
    name: "Cursor Agent",
    cmdTemplate: (b) => `${b} -p {prompt}`,
    desc: "以 Cursor Agent (cursor-agent) 为执行主体，处理代码编辑与本机终端任务",
  },
  {
    bin: "opencode",
    skill: "opencode-agent",
    name: "OpenCode Agent",
    cmdTemplate: (b) => `${b} run {prompt}`,
    desc: "以 OpenCode (opencode) 为执行主体，处理本地编程与自动化任务",
  },
  {
    bin: "aider",
    skill: "aider-agent",
    name: "Aider Agent",
    cmdTemplate: (b) => `${b} --message {prompt} --yes`,
    desc: "以 Aider (aider) 为执行主体，处理本地代码修改任务",
  },
  {
    bin: "paseo",
    skill: "paseo-agent",
    name: "Paseo Agent",
    cmdTemplate: (b) => `${b} agent run {prompt}`,
    desc: "以 Paseo (paseo) 为执行主体，调度 Paseo 宿主或 Agent 执行复杂编排任务",
  },
  {
    bin: "orca",
    skill: "orca-agent",
    name: "Orca Agent",
    cmdTemplate: (b) => `${b} task run {prompt}`,
    desc: "以 Orca CLI (orca) 为执行主体，带多 Agent 与工作区环境执行终端与协同任务",
  },
];

export function discoverLocalAgents() {
  const discovered = [];
  for (const item of KNOWN_AGENTS) {
    const fullPath = findExecutable(item.bin);
    if (fullPath) {
      discovered.push({
        ...item,
        path: fullPath,
        entry: {
          command: item.cmdTemplate(fullPath),
          desc: item.desc,
          mode: "agent",
          name: item.name,
          side_effect: "write",
          approval_class: "auto",
          timeout_sec: 900,
        },
      });
    }
  }
  return discovered;
}

function buildAgentCommands(selectedAgents, existingCommands = {}) {
  const result = { ...existingCommands };
  for (const a of selectedAgents) {
    result[a.skill] = a.entry;
  }
  return result;
}

function envSecret() {
  const candidates = [
    { key: "HUB_APP_SECRET", val: process.env.HUB_APP_SECRET },
    { key: "APP_SECRET", val: process.env.APP_SECRET },
    { key: "FEISHU_APP_SECRET", val: process.env.FEISHU_APP_SECRET },
    { key: "LARK_APP_SECRET", val: process.env.LARK_APP_SECRET },
  ];
  for (const c of candidates) {
    const v = (c.val || "").trim();
    if (v) return { value: v, source: `环境变量 ${c.key}` };
  }
  return null;
}

function envAppId() {
  return (
    process.env.HUB_APP_ID ||
    process.env.APP_ID ||
    process.env.FEISHU_APP_ID ||
    process.env.LARK_APP_ID ||
    ""
  ).trim() || null;
}

// 只读权限刚好是 600 的普通文件。更松的权限或符号链接一律不读，避免把 Secret 从暴露的文件载入内存。
function readLockedAppEnv(configDir) {
  const p = path.join(configDir, "app.env");
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) return { insecure: true };
  const kv = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { appId: kv.APP_ID || "", secret: kv.APP_SECRET || "" };
}

// Node 26 的 promises readline 不再暴露 _writeToOutput，提问期间改写 stdout.write
// 把按键回显丢掉，只放行换行；finally 恢复，避免 Secret 留在屏幕或后续输出上。
async function askHidden(rl, prompt) {
  process.stdout.write(prompt.endsWith(" ") ? prompt : prompt + " ");
  const original = process.stdout.write;
  process.stdout.write = function (chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (/[\r\n]/.test(s)) return original.call(this, "\n", typeof cb === "function" ? cb : undefined);
    if (typeof cb === "function") cb();
    return true;
  };
  try {
    const raw = await rl.question("");
    const answer = String(raw || "").trim();
    try {
      if (Array.isArray(rl.history)) rl.history = rl.history.filter((h) => String(h).trim() !== answer);
      if ("historyIndex" in rl) rl.historyIndex = -1;
    } catch { /* 清不掉历史也不能把 Secret 打进日志 */ }
    return answer;
  } finally {
    process.stdout.write = original;
  }
}


export function setupHelpText() {
  return `用法：
  lah setup [--yes] [--config <dir>] [--role node|hub] [--kind host|agent]
            [--wake poll|event|sweep] [--skip-skill] [--force]
            [--node <名>] [--zone <区>] [--prefix <前缀>] [--desc <描述>]
            [--base <token>] [--app-id <id>] [--owner <open_id>]

  --wake    非交互时选择唤醒方式：event/ws、poll、sweep
            sweep 登记 poll，轮询间隔不超过对账周期 900 秒。
            automation 只属于手工登记的协议接入型节点，setup 不产出。
  --help    打印本帮助并退出，不进入向导，也不读取凭据`;
}

export function normalizeWake(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s === "1" || s === "ws" || s === "event") return "1";
  if (s === "2" || s === "poll") return "2";
  if (s === "3" || s === "sweep") return "3";
  if (s === "automation") {
    throw new Error("守护进程不能登记 automation。协议接入型节点的 Receive_Mode=automation 只能手工登记名片；--wake 请用 poll、event/ws 或 sweep");
  }
  throw new Error(`未知 --wake：${raw}（应为 poll、event/ws 或 sweep）`);
}

export async function runSetup(configDir, argv, appDir) {
  const flags = parseFlags(argv);
  if (flags.help) {
    console.log(setupHelpText());
    return 0;
  }
  if (flags.wakeMissing) {
    console.error("  ✗ --wake 缺少值（应为 poll、event/ws 或 sweep）。协议节点的 automation 只能手工登记名片。");
    return 2;
  }
  let wakeFlag = "";
  try {
    wakeFlag = flags.wake ? normalizeWake(flags.wake) : "";
  } catch (e) {
    console.error("  ✗ " + e.message);
    return 2;
  }
  const role = flags.role || "node";
  if (role !== "node" && role !== "hub") {
    console.error(`  ✗ --role 只能是 node 或 hub，收到：${role}`);
    return 2;
  }
  if (flags.rejectAppSecret) {
    console.error("  ✗ 已移除 --app-secret（会进入进程列表和 shell 历史）。请改用环境变量 APP_SECRET 或 HUB_APP_SECRET，或权限为 600 的 app.env。");
    return 2;
  }
  const interactive = !!process.stdin.isTTY && !flags.yes;
  let rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const runInteractive = (cmd) => {
    if (rl) {
      try { rl.close(); } catch {}
      rl = null;
    }
    try {
      execSync(cmd, { stdio: "inherit", env: { ...process.env, PATH: richPath() } });
    } finally {
      if (interactive) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      }
    }
  };
  const ask = async (q, def) => {
    if (!interactive) {
      if (def !== undefined) return def;
      throw new Error(`非交互模式缺少参数：${q}（请用命令行参数提供，或在终端里交互运行）`);
    }
    if (!rl) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    const a = (await rl.question(def !== undefined && def !== "" ? `${q} [${def}] ` : `${q} `)).trim();
    return a || def || "";
  };

  try {
    console.log(`lah setup —— 一键配置${role === "hub" ? "主枢纽（hub，干活＋审批呈递）" : "节点（node）"}`);
    console.log(`role: ${role}`);
    console.log(`config dir: ${configDir}`);

    // 1. 优先检测本机是否安装了 lark-cli：若已安装则复用已配置的飞书应用；
    //    未安装且无环境变量/app.env 凭据时，引导安装 lark-cli。
    const lv = larkVersion();
    let larkCfg = null;
    if (lv) {
      console.log(`  ✓ lark-cli 已安装（${lv}）`);
      larkCfg = readLarkConfig();
      if (larkCfg) console.log(`  ✓ 读到 lark-cli 配置：${larkCfg.path}（${larkCfg.apps.length} 个应用）`);
    }

    const fromEnv = envSecret();
    const fileCreds = readLockedAppEnv(configDir);
    let appId = flags.appId || envAppId() || null;
    let secret = fromEnv?.value || null;
    let secretSource = fromEnv?.source || null;
    if (!secret && fileCreds?.secret) { secret = fileCreds.secret; secretSource = "本机 app.env（600）"; }
    if (!appId && fileCreds?.appId) appId = fileCreds.appId;

    if (!(appId && secret)) {
      if (!lv) {
        if (!ensureLarkCli()) return 2;
        larkCfg = readLarkConfig();
        if (larkCfg) console.log(`  ✓ 读到 lark-cli 配置：${larkCfg.path}（${larkCfg.apps.length} 个应用）`);
      }
      if (!larkCfg && !appId) {
        if (interactive) {
          console.log("  · lark-cli 尚未配置应用，正在启动 lark-cli config init 引导配置…");
          try {
            runInteractive("lark-cli config init");
            larkCfg = readLarkConfig();
            if (larkCfg) console.log(`  ✓ 读到 lark-cli 配置：${larkCfg.path}（${larkCfg.apps.length} 个应用）`);
          } catch (e) {
            console.error("  ✗ lark-cli 配置引导未完成：" + e.message);
            return 2;
          }
        }
        if (!larkCfg && !appId) {
          console.error("  ✗ lark-cli 还没有配置任何飞书应用。");
          console.error("    先运行 `lark-cli config init` 按它的引导完成应用配置，再重跑 `lah setup`。");
          return 2;
        }
      }
    }

    // 2. 选定应用并解析凭据
    let appEntry = null;
    if (larkCfg) {
      if (appId) appEntry = larkCfg.apps.find((a) => a.appId === appId) || null;
      else if (larkCfg.apps.length === 1) appEntry = larkCfg.apps[0];
      else {
        larkCfg.apps.forEach((a, i) => console.log(`    ${i + 1}. ${a.appId}${a.users?.[0]?.userName ? `（${a.users[0].userName}）` : ""}`));
        const pick = await ask(`选择用作${role === "hub" ? "枢纽" : "节点"}身份的应用序号`, "1");
        appEntry = larkCfg.apps[Number(pick) - 1] || larkCfg.apps[0];
      }
      if (appEntry) appId = appEntry.appId;
    }
    if (!appId) throw new Error("未能确定应用：请用 --app-id 指定，或先完成 lark-cli 配置。");
    if (!secret && appEntry) {
      const r = resolveSecret(appEntry);
      if (r) { secret = r.value; secretSource = r.source; }
    }
    if (!secret && fileCreds?.insecure && !interactive) {
      console.error("  ✗ app.env 存在但权限不是 600（或是符号链接），已拒绝读取。请 chmod 600 后重跑，或改用环境变量 APP_SECRET / HUB_APP_SECRET。");
      return 2;
    }
    if (!secret) {
      if (!interactive) {
        console.error("  ✗ 非交互模式需要环境变量 APP_SECRET 或 HUB_APP_SECRET，或权限为 600 的 app.env。");
        return 2;
      }
      if (!rl) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      }
      secret = await askHidden(rl, `粘贴应用 ${appId} 的 App Secret（只写入本机 app.env，权限 600，输入不回显）`);
      secretSource = "手工粘贴";
      if (!secret) { console.error("  ✗ 没有 Secret 无法继续。"); return 2; }
    }
    console.log(`  ✓ 应用 ${appId}，凭据来源：${secretSource}`);

    if (interactive && larkCfg) {
      const userScopeCheck = checkUserScopes(["docs:event:subscribe", "docs:permission.member:create"]);
      if (!userScopeCheck.ok) {
        console.log("  · 正在通过 lark-cli 授权用户身份（用于自动搜索多维表格、自动添加机器人协作者权限及注册云文档事件订阅）…");
        try {
          runInteractive('lark-cli auth login --scope "docs:event:subscribe docs:permission.member:create"');
        } catch (e) {
          console.warn("  ! 用户身份授权未完成：" + e.message);
        }
      }
    }

    // 3. Base 与表发现
    let defaultBase = null;
    let defaultBaseLabel = "";
    if (!flags.base) {
      const tempBus = new FeishuBus({ appId, appSecret: secret, baseToken: "", tables: {} });
      const candidates = await discoverCandidateBases(tempBus, appId);
      if (candidates.length === 1) {
        defaultBase = candidates[0].token;
        defaultBaseLabel = candidates[0].name ? `${candidates[0].name}（${candidates[0].token}）` : candidates[0].token;
        console.log(`  ✓ 自动发现多维表格 Base：${defaultBaseLabel}`);
      } else if (candidates.length > 1) {
        console.log("  · 发现多个候选多维表格 Base：");
        candidates.forEach((c, idx) => {
          console.log(`    ${idx + 1}. ${c.name} (${c.token})${c.hasStandardTables ? " [含6张标准表]" : ""}`);
        });
        if (interactive) {
          const pick = await ask("选择要使用的 Base 序号或直接粘贴链接", "1");
          const num = Number(pick);
          if (Number.isInteger(num) && num >= 1 && num <= candidates.length) {
            defaultBase = candidates[num - 1].token;
            defaultBaseLabel = candidates[num - 1].name ? `${candidates[num - 1].name}（${candidates[num - 1].token}）` : candidates[num - 1].token;
          } else {
            defaultBase = extractBaseToken(pick) || pick;
          }
        } else {
          defaultBase = candidates[0].token;
        }
      }
    }

    const basePrompt = defaultBaseLabel
      ? "确认或修改多维表格 Base 链接/token"
      : "把多维表格 Base 的链接粘贴进来（打开 Base 页面复制网址即可，或直接给 token）";
    const baseInput = flags.base || (await ask(basePrompt, defaultBase || undefined));
    const baseToken = extractBaseToken(baseInput);
    if (!baseToken) { console.error("  ✗ 没能从输入里解析出 Base token。"); return 2; }
    const bus = new FeishuBus({ appId, appSecret: secret, baseToken, tables: {} });
    let tableItems;
    try {
      const items = [];
      let page = null;
      for (;;) {
        let d;
        try {
          d = await bus.api("GET", `/bitable/v1/apps/${baseToken}/tables?page_size=100` + (page ? `&page_token=${page}` : ""));
        } catch (firstErr) {
          if (!/tenant token failed/i.test(firstErr?.message || "") && tryAddBotCollaborator(baseToken, appId)) {
            console.log(`  ✓ 已自动将应用 ${appId} 添加为该多维表格的「可管理」协作者`);
            d = await bus.api("GET", `/bitable/v1/apps/${baseToken}/tables?page_size=100` + (page ? `&page_token=${page}` : ""));
          } else {
            throw firstErr;
          }
        }
        items.push(...(d.items ?? []));
        if (d.has_more) page = d.page_token; else break;
      }
      tableItems = items;
    } catch (e) {
      console.error(`  ✗ 读不到这个 Base 的表清单：${e.message}`);
      if (/tenant token failed/i.test(e.message)) {
        console.error("    凭据换不到 token：多半是 App Secret 不对，或应用未发布/未启用。核对开发者后台的应用凭据后重跑。");
      } else {
        console.error(`    若是无权限：请在该 Base 的分享设置里把应用 ${appId} 加为「可编辑」，再重跑 lah setup。`);
      }
      return 3;
    }
    const byName = new Map(tableItems.map((t) => [t.name, t.table_id]));
    const missing = REQUIRED_TABLES.filter((n) => !byName.has(n));
    if (missing.length) {
      console.error(`  ✗ Base 缺少标准表：${missing.join(", ")}（现有表：${[...byName.keys()].join(", ") || "无"}）。中台标准 Base 需含 Tasks/Messages/Parts/Runs/Artifacts/AgentCards 六表。`);
      return 3;
    }
    const tables = {};
    for (const n of REQUIRED_TABLES) tables[TABLE_KEYS[n]] = byName.get(n);
    // Rules 不是建单/执行路径的必需表，但 hub 的定时调度要读它：Base 里有就一并
    // 登记映射。缺了这条映射时调度会静默跳过（2026-11-08 实测踩过），所以发现
    // 阶段就把它补上，doctor 对 hub 角色另有缺失警告。
    if (byName.has("Rules")) tables.rules = byName.get("Rules");
    console.log(`  ✓ Base 表发现完成（${REQUIRED_TABLES.length} 张标准表齐全）`);

    // 4. 身份与参数配置
    let kind = flags.kind || "";
    if (!kind) {
      if (interactive) {
        const k = await ask("这台机器是：1=电脑（宿主：拉起本机已装的 CLI Agent 干活），2=独立 Agent（本身就是 Agent，如 Muse，接单后交给它自己处理）", "1");
        kind = (k === "2" || /agent/i.test(k)) ? "agent" : "host";
      } else {
        kind = "host";
      }
    } else {
      kind = /agent/i.test(kind) ? "agent" : "host";
    }

    let node, zone, prefix, nodeDesc, ownerOpenId;
    if (role === "hub") {
      node = flags.node || "hub";
      ownerOpenId = flags.ownerOpenId || (process.env.HUB_OWNER_OPEN_ID || "").trim();
      const defaultOwner = appEntry?.users?.[0]?.openId || "";
      if (!ownerOpenId) {
        if (interactive) {
          ownerOpenId = await ask(
            "输入机主 open_id（例如 ou_xxxx，审批卡只发给此人且回调只认此人）",
            defaultOwner || undefined
          );
        } else if (defaultOwner) {
          ownerOpenId = defaultOwner;
        } else {
          throw new Error("非交互模式配置 hub 角色缺少机主 open_id：请用 --owner 提供，或设置环境变量 HUB_OWNER_OPEN_ID");
        }
      }
      if (!ownerOpenId) {
        console.error("  ✗ hub 角色必须配置机主 open_id，未配置时审批回调一律拒绝。");
        return 2;
      }
      zone = flags.zone || "work";
      prefix = flags.prefix || (node === "hub" ? "hub" : (node.split("-").filter(Boolean).pop() || node));
      nodeDesc = flags.desc ?? "主枢纽节点（干活＋审批呈递）";
      if (interactive) {
        console.log(`  · 即将配置：主枢纽 ${node}（${kind === "agent" ? "独立 Agent" : "电脑宿主"}，机主 ${ownerOpenId.slice(0, 8)}…），能力前缀 CAP-${prefix}-，应用 ${appId}，Base ${baseToken.slice(0, 8)}…`);
        const go = await ask("开始配置？(Y/n)", "Y");
        if (!/^y/i.test(go)) { console.error("  已取消，未写任何文件。"); return 5; }
      }
    } else {
      const hostDefault = os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-") || "node";
      node = flags.node || (await ask("给这台机器起个节点名（中台按这个名字派活）", hostDefault));
      zone = flags.zone || null;
      if (!zone) {
        if (!interactive) zone = "home";
        else {
          const z = await ask("这台机器主要在哪用？输 1=家里，2=公司", "1");
          zone = (z === "2" || /work/i.test(z)) ? "work" : "home";
        }
      }
      prefix = flags.prefix || node.split("-").filter(Boolean).pop() || node;
      nodeDesc = flags.desc ?? (kind === "agent" ? `${node} 独立 Agent` : "");
      if (interactive) {
        console.log(`  · 即将配置：节点 ${node}（${kind === "agent" ? "独立 Agent" : "电脑宿主"}，${zone === "work" ? "公司" : "家里"}），能力前缀 CAP-${prefix}-，应用 ${appId}，Base ${baseToken.slice(0, 8)}…`);
        const go = await ask("开始配置？(Y/n)", "Y");
        if (!/^y/i.test(go)) { console.error("  已取消，未写任何文件。"); return 5; }
      }
    }

    // 5. 事件订阅检查与唤醒方式配置
    console.log("  · 正在检查事件订阅就绪状态…");
    const appEvRes = await checkAppEventSubscribed(bus, appId, "drive.file.bitable_record_changed_v1");
    if (appEvRes.status === "subscribed") {
      console.log(`  ✓ 应用已开启事件订阅：drive.file.bitable_record_changed_v1（线上版本 ${appEvRes.onlineVersionId}）`);
    } else if (appEvRes.status === "unknown") {
      console.log(`  · 跳过应用静态事件列表核对（${appEvRes.reason || "未开应用信息权限"}），以实际长连接状态为准`);
    } else {
      console.log(`  · 应用线上版本未订阅 drive.file.bitable_record_changed_v1 事件（${appEvRes.reason || "未包含该事件"}）`);
      console.log(`    若需开启，请在飞书开放平台「事件与回调」添加「多维表格记录变更」并发布版本：https://open.feishu.cn/app/${appId}/event`);
    }

    const subRes = tryRegisterDriveSubscription(baseToken, appId);
    if (subRes.success) {
      console.log("  ✓ 云文档事件订阅已生效（User 身份，is_subscribe=true）");
    } else {
      console.log(`  · 云文档事件订阅未生效（${subRes.error || "未订阅"}）`);
      console.log("    若需开启，请在本机终端执行：");
      console.log("    1. lark-cli auth login --scope docs:event:subscribe");
      console.log(`    2. lark-cli api POST /open-apis/drive/v1/files/${baseToken}/subscribe --params '{"file_type":"bitable"}' --as user`);
    }

    const allEventsReady = (appEvRes.status === "subscribed" || appEvRes.status === "unknown") && subRes.success;

    let events = false;
    let pollSec = 45;
    const sweepSec = 900;

    if (role === "hub") {
      events = true;
      if (!allEventsReady) {
        console.log("  · hub 角色强制使用长连接（用于审批卡回调）。未完成订阅时仍可通过长连接接收卡片回调与 15 分钟定时扫表。");
      }
    } else {
      const defaultWake = allEventsReady ? "1" : "2";
      let wakeChoice = defaultWake;
      if (interactive) {
        console.log("\n  选择节点的任务唤醒机制（标准 v3.1 §10.3）：");
        console.log(`    1. ws${allEventsReady ? "（推荐）" : "（两层事件订阅未全就绪，需补齐后方可秒级唤醒）"}：长连接秒级事件唤醒 ＋ 15分钟对账兜底`);
        console.log("    2. poll：45秒固定短轮询 ＋ 15分钟对账兜底（无需事件订阅）");
        console.log("    3. sweep：轮询间隔不超过对账周期（900秒），名片登记 poll");
        wakeChoice = await ask("选择唤醒方式序号", wakeFlag || defaultWake);
      } else {
        wakeChoice = wakeFlag || defaultWake;
      }

      if (wakeChoice === "1" || /ws/i.test(wakeChoice)) {
        events = true;
        pollSec = 45;
        console.log("  ✓ 唤醒方式：长连接（ws）秒级事件 ＋ 15分钟对账兜底");
      } else if (/automation/i.test(String(wakeChoice))) {
        console.error("  ✗ automation 不能由守护进程登记。协议接入型节点的 Receive_Mode=automation 只能手工登记名片。");
        return 2;
      } else if (wakeChoice === "3" || /^sweep$/i.test(String(wakeChoice).trim())) {
        events = false;
        // 标准 §10.3：poll 的间隔不得长于对账周期（900 秒）。
        pollSec = Math.min(sweepSec, 900);
        console.log("  ✓ 唤醒方式：poll，间隔不超过对账周期 900 秒（sweep）");
      } else {
        events = false;
        pollSec = 45;
        console.log("  ✓ 唤醒方式：45秒短轮询（poll）＋ 15分钟对账兜底");
      }
    }

    // 6. 写配置。真实 node.json 默认不覆盖；仍是示例占位符则视为首装未完成。
    fs.mkdirSync(configDir, { recursive: true });
    const nodeJsonPath = path.join(configDir, "node.json");
    const nodeExisted = fs.existsSync(nodeJsonPath);
    let placeholder = false;
    if (nodeExisted) {
      try { placeholder = isUnfinishedExample(JSON.parse(fs.readFileSync(nodeJsonPath, "utf8"))); }
      catch { /* 解析不了就按已有配置保护 */ }
    }
    if (nodeExisted && !flags.force) {
      if (placeholder) {
        if (interactive) {
          const ow = await ask("node.json 仍是示例占位符，覆盖并完成首装？(Y/n)", "Y");
          if (!/^y/i.test(ow)) { console.error("  ✗ 已保留现有 node.json，未做任何修改（--force 可强制覆盖）。"); return 4; }
        } else {
          console.log("  · 现有 node.json 仍是示例占位符，视为首装未完成，将覆盖");
        }
      } else {
        const ow = interactive ? await ask("node.json 已存在，覆盖？(y/N)", "N") : "N";
        if (!/^y/i.test(ow)) { console.error("  ✗ 已保留现有 node.json，未做任何修改（--force 可强制覆盖）。"); return 4; }
      }
    }
    const appEnvPath = path.join(configDir, "app.env");
    fs.writeFileSync(appEnvPath, `APP_ID=${appId}\nAPP_SECRET=${secret}\n`, { mode: 0o600 });
    fs.chmodSync(appEnvPath, 0o600);
    const nodeJson = {
      node,
      role,
      kind,
      ...(role === "hub" ? { ownerOpenId } : {}),
      zone: zone || "work",
      nodeDesc: nodeDesc || "",
      appEnv: appEnvPath,
      baseToken,
      pollSec, // sweep 也走这个变量：不超过对账周期，名片仍由 receiveModeOf 登记为 poll
      sweepSec: 900,
      events,
      doorbellFile: null,
      capPrefix: prefix,
      tables,
    };
    fs.writeFileSync(nodeJsonPath, JSON.stringify(nodeJson, null, 1) + "\n");

    const cmdPath = path.join(configDir, "commands.json");
    const cmdExisted = fs.existsSync(cmdPath);
    let existingCmds = {};
    let isExample = false;
    if (cmdExisted) {
      try {
        existingCmds = JSON.parse(fs.readFileSync(cmdPath, "utf8"));
        isExample = isExampleCommands(existingCmds);
      } catch { /* 留着，下面不覆盖 */ }
    }

    let finalCmds;
    if (kind === "agent") {
      console.log("  · 节点类型为独立 Agent (kind=agent)：跳过本机 CLI Agent 扫描，配置专属能力 agent (mode: inbox)");
      finalCmds = (!cmdExisted || isExample) ? {
        agent: {
          desc: "以本 Agent 为执行主体的专属任务接入通道",
          mode: "inbox",
          name: node,
          side_effect: "write",
          approval_class: "auto",
          inbox_timeout_sec: 86400,
        },
      } : existingCmds;
    } else {
      const discoveredAgents = discoverLocalAgents();
      let selectedAgents = [];
      if (discoveredAgents.length > 0) {
        console.log(`\n  · 扫描到本机已安装 ${discoveredAgents.length} 个终端 Agent：`);
        discoveredAgents.forEach((a, idx) => {
          console.log(`    ${idx + 1}. [${a.skill}] ${a.name} (${a.path})`);
        });

        let pick = "all";
        if (interactive) {
          pick = await ask("选择要添加到 commands.json 的本地 Agent（all=全部添加，none=都不添加，或填序号如 1,2,3）", "all");
        }
        const p = String(pick).trim().toLowerCase();
        if (p === "none" || p === "0") {
          selectedAgents = [];
        } else if (p === "all" || p === "" || p === "y" || p === "yes") {
          selectedAgents = discoveredAgents;
        } else {
          const indices = p.split(/[,，\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= discoveredAgents.length);
          selectedAgents = indices.map((i) => discoveredAgents[i - 1]);
        }
      } else {
        console.log("  · 未扫描到常见本机终端 Agent（本机暂无可接单能力，装好后重跑 lah setup 或手写 commands.json）");
      }

      const baseCmds = (!cmdExisted || isExample) ? {} : existingCmds;
      finalCmds = buildAgentCommands(selectedAgents, baseCmds);
    }

    fs.writeFileSync(cmdPath, JSON.stringify(finalCmds, null, 1) + "\n");
    const names = Object.keys(finalCmds);
    console.log(`  ✓ 已写入 app.env（600）、node.json、commands.json（共 ${names.length} 项能力：${names.join(", ")}）`);

    // 建立存量任务结果呈递水位线（baseline）：
    // 若本地 present_state.json 不存在，查询 Tasks 表将存量终态任务初始化记入，避免初启重放历史回执
    const presentStateFile = path.join(configDir, "present_state.json");
    if (!fs.existsSync(presentStateFile)) {
      try {
        const { f1 } = await import("./bus/feishu.mjs");
        const existingTasks = await bus.listRecords(tables.tasks);
        const baseKeys = [];
        for (const t of existingTasks) {
          const st = String(f1(t, "Status") ?? "");
          const tid = String(f1(t, "Task_ID") ?? "");
          if (!tid) continue;
          // Presented 列 v3.5 已废弃：水位线信号改看 Metadata.presented_keys 是否非空
          let hasPresentedKeys = false;
          try {
            const meta = JSON.parse(String(f1(t, "Metadata") ?? ""));
            hasPresentedKeys = Array.isArray(meta?.presented_keys) && meta.presented_keys.length > 0;
          } catch { /* Metadata 脏数据按未呈递处理 */ }
          const isTerm = ["completed", "failed", "rejected", "canceled"].includes(st);
          if (isTerm || hasPresentedKeys) {
            const smsg = String(f1(t, "Status_Msg") ?? "");
            const k = (["completed", "failed", "rejected"].includes(st)) ? `${tid}\t${st}\t${smsg}` : `${tid}\t${smsg}`;
            if (!baseKeys.includes(k)) baseKeys.push(k);
          }
        }
        fs.writeFileSync(presentStateFile, JSON.stringify({ keys: baseKeys }, null, 1), { mode: 0o600 });
        fs.chmodSync(presentStateFile, 0o600);
        if (baseKeys.length > 0) {
          console.log(`  ✓ 已建立存量任务结果呈递水位线（共 ${baseKeys.length} 项历史任务，避免首次启动重放）`);
        }
      } catch (e) {
        console.log("  · 存量任务水位线建立跳过：" + e.message);
      }
    }

    // 自动为本机 Agent 安装 lah 技能（支持 --skip-skill 或 LAH_SKIP_SKILL=1 跳过）
    const shouldSkipSkill = flags.skipSkill || ["1", "true"].includes(String(process.env.LAH_SKIP_SKILL || "").toLowerCase());
    if (!shouldSkipSkill) {
      try {
        const skillSrc = path.join(appDir, "skills", "lah", "SKILL.md");
        const skillDestDir = path.join(os.homedir(), ".agents", "skills", "lah");
        if (fs.existsSync(skillSrc)) {
          fs.mkdirSync(skillDestDir, { recursive: true });
          fs.copyFileSync(skillSrc, path.join(skillDestDir, "SKILL.md"));
          console.log(`  ✓ 已自动安装 lah Skill 至 ${path.join(skillDestDir, "SKILL.md")}`);
        }
      } catch {}
    } else {
      console.log("  · 跳过安装 lah Skill（--skip-skill）");
    }

    // 6. 自检
    let dc = await doctor(configDir, appDir, { role });
    if (role === "hub") {
      try {
        const { hubDoctor } = await import("./hub/index.mjs");
        const extra = await hubDoctor(configDir);
        if (extra) dc = 1;
      } catch (e) {
        console.error("  ✗ hub 自检模块加载失败：" + e.message);
        dc = 1;
      }
    }
    if (dc !== 0) {
      console.error(`  ✗ 自检未全过，按上面清单修完后运行 \`lah doctor${role === "hub" ? " --role hub" : ""}\` 复查。`);
      return dc;
    }

    // 7. 自启（可选）
    let wantService = flags.service;
    if (!wantService && interactive) wantService = /^y/i.test(await ask("现在注册开机自启并启动守护？(Y/n)", "Y"));
    if (wantService) {
      const sc = await service(configDir, { role }, appDir);
      if (sc !== 0) { console.error("  ✗ 自启注册失败，看上面输出。"); return sc; }
      console.log("  ✓ 自启已注册、守护已启动。");
    } else {
      console.log(`  · 未注册自启；手动运行守护：lah daemon${role === "hub" ? " --role hub" : ""} --config ${configDir}`);
    }
    if (role === "hub") {
      console.log(`setup 完成：主枢纽 ${node} 就绪（机主已绑定，带 ${names.length} 项本地能力），可通过 lah daemon --role hub 常驻。`);
    } else {
      console.log(`setup 完成：节点 ${node}（能力前缀 CAP-${prefix}-，带 ${names.length} 项本地能力），可通过 lah daemon 常驻。`);
    }
    return 0;
  } finally {
    if (rl) {
      try { rl.close(); } catch {}
      rl = null;
    }
  }
}
