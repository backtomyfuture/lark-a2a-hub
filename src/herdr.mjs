// herdr 执行语境：借本机的 herdr 服务，在一个只属于该任务的工作区里拉起交互式 Agent。
// 这里只有 herdr CLI 的薄客户端与配置校验，不含状态机；任务状态仍只由内核与 inbox 回执写。
// 守护进程只按需启停自己的专用会话（缺省 lah），从不碰用户的默认会话；
// 起不来就如实报出，不改走直跑（标准 §9 herdr 语境）。

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const HERDR_CONTEXT = "herdr";
// 只拦明显不是 kind 的值；kind 清单随 herdr 版本变，交给 herdr agent start 自己校验。
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
// herdr_autostart 缺省为 true 且没写 herdr_session 时，守护进程用这个专用会话，不去占用户的默认会话。
export const HERDR_AUTOSTART_SESSION = "lah";
const START_WAIT_MS = 10_000;
const START_POLL_MS = 500;

export function isHerdrEntry(entry) {
  return !!entry && typeof entry === "object" && entry.context === HERDR_CONTEXT;
}

// 返回一句人话，空串表示合法。config 归一、认领预检与 doctor 共用这一份口径。
export function herdrConfigProblem(entry) {
  if (!isHerdrEntry(entry)) return "";
  if (entry.mode != null && entry.mode !== "inbox") {
    return `context=herdr 只走 inbox 回执（mode 省略或写 inbox），当前 mode=${JSON.stringify(entry.mode)}`;
  }
  if (typeof entry.command === "string" && entry.command.trim()) {
    return "context=herdr 不用 command（Agent 由 herdr agent start 拉起），请删掉 command 并写 herdr_kind";
  }
  if (typeof entry.herdr_kind !== "string" || !KIND_RE.test(entry.herdr_kind)) {
    return "context=herdr 缺 herdr_kind 或取值非法（填 herdr agent start --kind 的取值，如 claude、codex、droid）";
  }
  if (entry.herdr_args != null && (!Array.isArray(entry.herdr_args) || entry.herdr_args.some((a) => typeof a !== "string"))) {
    return "herdr_args 必须是字符串数组";
  }
  if (entry.herdr_session != null && (typeof entry.herdr_session !== "string" || !SESSION_RE.test(entry.herdr_session))) {
    return "herdr_session 只能含字母、数字、. _ -（1–64 字符）";
  }
  if (entry.herdr_keep != null && typeof entry.herdr_keep !== "boolean") {
    return "herdr_keep 必须是 true 或 false";
  }
  if (entry.herdr_autostart != null && typeof entry.herdr_autostart !== "boolean") {
    return "herdr_autostart 必须是 true 或 false";
  }
  return "";
}

export function herdrAutostart(entry) {
  return entry?.herdr_autostart !== false;
}

// 实际使用的会话名。空串只出现在 herdr_autostart=false 且没写会话时，表示用户的默认会话。
// 内核、doctor 与收件箱里记录的 herdr.session 都走这一份，口径才一致。
export function herdrSessionOf(entry) {
  if (typeof entry?.herdr_session === "string" && entry.herdr_session) return entry.herdr_session;
  return herdrAutostart(entry) ? HERDR_AUTOSTART_SESSION : "";
}

// 守护进程负责启停的会话：会话非空，且用到它的条目没有一个写 herdr_autostart=false。
// 有人明确说了不要自动启停，就宁可不管；默认会话永远不在其中。
export function herdrManagedSessions(entries) {
  const seen = new Map();
  for (const e of entries) {
    if (!isHerdrEntry(e)) continue;
    const s = herdrSessionOf(e);
    if (!s) continue;
    seen.set(s, (seen.get(s) ?? true) && herdrAutostart(e));
  }
  return new Set([...seen].filter(([, managed]) => managed).map(([s]) => s));
}

// herdr 的 Agent 名要求 [a-z][a-z0-9_-]{0,31}，并且在一个服务里唯一。超长时截断加哈希，避免两个长任务号撞名。
export function herdrAgentName(taskId) {
  const slug = String(taskId ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `lah-${slug || "task"}`;
  if (name.length <= 32) return name;
  const h = createHash("sha1").update(String(taskId)).digest("hex").slice(0, 8);
  return `${name.slice(0, 23)}-${h}`;
}

export class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// herdr 成功时 stdout 是一个 JSON 对象，服务端错误是 stderr 上的 JSON 且退出码 1。
function parseResponse(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 可能夹着别的行，取最后一行 JSON */ }
  const lines = s.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* 继续往前找 */ }
  }
  return null;
}

export function createHerdrClient({
  bin = "herdr", execFileImpl = execFile, spawnImpl = spawn,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  startWaitMs = START_WAIT_MS,
} = {}) {
  const call = (session, args, timeoutMs) => new Promise((resolve) => {
    const argv = session ? ["--session", session, ...args] : args;
    execFileImpl(bin, argv, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

  const json = async (session, args, timeoutMs = 15_000) => {
    const { err, stdout, stderr } = await call(session, args, timeoutMs);
    const parsed = parseResponse(stdout) ?? parseResponse(stderr);
    if (parsed?.error) {
      throw new HerdrError(String(parsed.error.code || "herdr_error"), String(parsed.error.message || "herdr 报错").slice(0, 300));
    }
    if (err) {
      const code = err.code === "ENOENT" ? "herdr_missing" : (err.killed ? "timeout" : "herdr_failed");
      throw new HerdrError(code, String(stderr || err.message || "herdr 调用失败").trim().slice(0, 300));
    }
    if (!parsed || typeof parsed.result !== "object" || parsed.result === null) {
      throw new HerdrError("bad_response", "herdr 返回无法解析");
    }
    return parsed.result;
  };

  const serverRunning = async (session = "") => {
    const { err, stdout } = await call(session, ["status", "server"], 5_000);
    if (err) return false;
    return /^status:\s*running\s*$/m.test(stdout);
  };

  return {
    serverRunning,
    // 本机有没有 herdr 可执行文件。只有找不到文件才算没有，别的报错交给后续调用如实报。
    async installed() {
      const { err } = await call("", ["--version"], 5_000);
      return !(err && err.code === "ENOENT");
    },
    // 无头启动一个命名会话的服务。detached 让它自成进程组与会话，stdio 全部断开，再 unref：
    // launchd KeepAlive 重启或 lah update 收掉守护进程时，不会连带杀掉 herdr 和窗格里在跑的 Agent。
    async startServer(session) {
      if (!session) throw new HerdrError("default_session", "不启动 herdr 默认会话，只启动守护进程专用的命名会话");
      let spawnErr = null;
      let exited = null;
      let child;
      try {
        child = spawnImpl(bin, ["--session", session, "server"], { detached: true, stdio: "ignore" });
      } catch (e) {
        spawnErr = e;
      }
      child?.on?.("error", (e) => { spawnErr = e; });
      child?.on?.("exit", (code, signal) => { exited = { code, signal }; });
      child?.unref?.();
      const deadline = Date.now() + startWaitMs;
      for (;;) {
        if (spawnErr) {
          const missing = spawnErr.code === "ENOENT";
          throw new HerdrError(missing ? "herdr_missing" : "start_failed",
            missing ? `本机找不到 herdr 可执行文件（${bin}），请先安装 herdr` : String(spawnErr.message ?? spawnErr).slice(0, 300));
        }
        if (await serverRunning(session)) return true;
        // 服务进程非零退出却从没就绪，多半是配置出错或会话目录不可写，不必等满。
        // 正常退出（code 0）不算失败：万一某个版本自己再 fork 一次，还要等它就绪。
        if (exited && (exited.code !== 0 || exited.signal)) {
          throw new HerdrError("start_failed", `herdr --session ${session} server 启动后即退出（code=${exited.code ?? ""} signal=${exited.signal ?? ""}）`);
        }
        if (Date.now() >= deadline) {
          throw new HerdrError("start_timeout", `herdr --session ${session} server 启动后 ${Math.round(startWaitMs / 1000)} 秒内未就绪`);
        }
        await sleepImpl(START_POLL_MS);
      }
    },
    async stopServer(session) {
      if (!session) throw new HerdrError("default_session", "不停止 herdr 默认会话");
      const { err, stderr } = await call(session, ["server", "stop"], 15_000);
      if (!err) return true;
      if (/not running|cannot be reached/i.test(stderr)) return false;
      const code = err.code === "ENOENT" ? "herdr_missing" : "herdr_failed";
      throw new HerdrError(code, String(stderr || err.message || "herdr server stop 失败").trim().slice(0, 300));
    },
    async listWorkspaces(session) {
      const r = await json(session, ["workspace", "list"]);
      return Array.isArray(r.workspaces) ? r.workspaces : [];
    },
    async createWorkspace(session, { cwd, label }) {
      const r = await json(session, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
      const workspace = String(r.workspace?.workspace_id ?? "");
      const pane = String(r.root_pane?.pane_id ?? "");
      if (!workspace || !pane) throw new HerdrError("bad_response", "workspace create 未返回工作区或窗格 ID");
      return { workspace, pane };
    },
    async startAgent(session, { name, kind, pane, args = [], timeoutMs = 60_000 }) {
      const argv = ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", String(timeoutMs)];
      if (args.length) argv.push("--", ...args);
      const r = await json(session, argv, timeoutMs + 10_000);
      return r.agent ?? {};
    },
    // 只等到 working / blocked 出现就返回，不陪 Agent 跑完一整轮，免得堵住扫表。
    async prompt(session, name, text, { timeoutMs = 20_000 } = {}) {
      const r = await json(session, [
        "agent", "prompt", name, text, "--wait", "--until", "working", "--until", "blocked", "--timeout", String(timeoutMs),
      ], timeoutMs + 10_000);
      return r.agent ?? {};
    },
    async getAgent(session, name) {
      try {
        const r = await json(session, ["agent", "get", name]);
        return r.agent ?? null;
      } catch (e) {
        if (e?.code === "agent_not_found") return null;
        throw e;
      }
    },
    async closeWorkspace(session, id) {
      try {
        await json(session, ["workspace", "close", id]);
      } catch (e) {
        if (e?.code === "workspace_not_found") return;
        throw e;
      }
    },
  };
}
