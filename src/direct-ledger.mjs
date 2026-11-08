// direct 语境的在途账本。只服务 kernel 的 json/agent 直跑，carrier 与 inbox 不走这里。
//
// 为什么先落盘再 spawn：守护进程在命令执行中崩溃时，detached 子进程还活着，
// 但没有 pid 与退出码的话，重启后的心跳回收会把任务送回 submitted 再跑一遍。
// 账本放在配置目录，不进总线。输出走文件而不是管道，是为了守护进程消失后
// 子进程不会因为管道断裂收到 SIGPIPE。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KILL_GRACE_MS } from "./carrier.mjs";

export { KILL_GRACE_MS };

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;
// lstart 只有秒级，再留一点余量给 ps 与本地时钟的错位。窗口再大就会把复用后的新进程认成旧的。
const PROC_START_TOLERANCE_MS = 5000;

export function safeTaskId(taskId) {
  const id = String(taskId ?? "");
  if (!/^[\w-]+$/.test(id)) throw new Error("非法 Task_ID，拒绝写入运行账本");
  return id;
}

export function runDir(configDir, taskId) {
  return path.join(configDir, "runs", safeTaskId(taskId));
}

function entryFile(configDir, taskId) {
  return path.join(runDir(configDir, taskId), "entry.json");
}

export function readEntry(configDir, taskId) {
  let file;
  try {
    file = entryFile(configDir, taskId);
  } catch {
    return { broken: true };
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    return { broken: true };
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { broken: true };
    return data;
  } catch {
    return { broken: true };
  }
}

export function saveEntry(configDir, entry) {
  const dest = entryFile(configDir, entry.task_id);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(dest), 0o700); } catch { /* 目录权限失败不挡住账本 */ }
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

// 与 carrier 的 PATH 前缀一致，避免直跑和代跑找到的可执行文件不一样。
export function commandEnv(extra) {
  const env = { ...process.env, ...extra };
  const prefix = ["/opt/homebrew/bin", path.join(os.homedir(), ".local/bin"), "/usr/local/bin"];
  env.PATH = [...prefix, env.PATH ?? "/usr/bin:/bin"].join(":");
  return env;
}

// spawn 之前调用。此时还没有 pid；进程若没起来，重启后能看出「没启动」而不是「丢了账本」。
export function beginLaunchEntry({
  configDir, taskId, attempt, startedAt, startedMs, timeoutSec, mode, runId, stdinText,
}) {
  const dir = runDir(configDir, taskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* 同上 */ }
  const stdinPath = path.join(dir, "stdin.txt");
  const stdoutPath = path.join(dir, "stdout.txt");
  const stderrPath = path.join(dir, "stderr.txt");
  const exitPath = path.join(dir, "exit");
  const wrapPath = path.join(dir, "wrap.sh");
  // 上一轮的退出码文件还在的话，扫表会以为这次命令已经结束。新的一次开始前先清掉。
  for (const stale of [stdoutPath, stderrPath, exitPath, `${exitPath}.tmp`]) {
    try { fs.unlinkSync(stale); } catch { /* 第一次没有这些文件 */ }
  }
  fs.writeFileSync(stdinPath, stdinText ?? "", { mode: 0o600 });
  fs.chmodSync(stdinPath, 0o600);
  // 退出码先写临时文件再改名，扫表不会读到半截数字。最后的 `:` 保证包装自己退出，
  // 而不是被前面的 mv 替换掉、来不及把退出码留下。
  const script = [
    "umask 077",
    '/bin/sh -c "$LAH_CMD" <"$LAH_STDIN" >"$LAH_OUT" 2>"$LAH_ERR"',
    "code=$?",
    'echo "$code" >"$LAH_EXIT.tmp"',
    'mv "$LAH_EXIT.tmp" "$LAH_EXIT"',
    ":",
    "",
  ].join("\n");
  fs.writeFileSync(wrapPath, script, { mode: 0o700 });
  fs.chmodSync(wrapPath, 0o700);
  const entry = {
    task_id: safeTaskId(taskId),
    attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : 0,
    state: "launching",
    pid: null,
    pgid: null,
    started_at: startedAt,
    started_ms: startedMs,
    timeout_sec: timeoutSec,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    exit_path: exitPath,
    stdin_path: stdinPath,
    wrap_path: wrapPath,
    proc_start_ms: null,
    run_id: runId || "",
    mode: mode || "agent",
    stop_at_ms: null,
    disposition: null,
    fail_error: null,
  };
  saveEntry(configDir, entry);
  return entry;
}

export function spawnWrapped(entry, command, cwd) {
  return spawn("/bin/sh", [entry.wrap_path], {
    cwd: cwd || os.homedir(),
    env: commandEnv({
      LAH_CMD: command,
      LAH_STDIN: entry.stdin_path,
      LAH_OUT: entry.stdout_path,
      LAH_ERR: entry.stderr_path,
      LAH_EXIT: entry.exit_path,
    }),
    detached: true,
    stdio: "ignore",
  });
}

export function readProcStartMs(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;
  let out;
  try {
    out = spawnSync("ps", ["-p", String(id), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch {
    return null;
  }
  if (out.error || out.status !== 0) return null;
  const text = String(out.stdout ?? "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function positivePid(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

// ps 失败与「进程不在」不是一回事。调用方看到 unknown 时不得当成已死。
export function findWrapProcess(wrapPath) {
  if (!wrapPath) return { status: "absent" };
  let out;
  try {
    out = spawnSync("ps", ["-ax", "-o", "pid=", "-o", "pgid=", "-o", "command="], { encoding: "utf8" });
  } catch {
    return { status: "unknown" };
  }
  if (out.error || out.status !== 0 || out.stdout == null) return { status: "unknown" };
  for (const line of String(out.stdout).split("\n")) {
    if (!line.includes(wrapPath)) continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s/);
    if (!match) continue;
    return { status: "found", pid: Number(match[1]), pgid: Number(match[2]) };
  }
  return { status: "absent" };
}

function probeGroup(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    if (e?.code === "ESRCH") return false;
    return null;
  }
}

// true 还在，false 确认没有活进程，null 是 ps 与 kill 探测都失败。
export function groupAlive(pgid) {
  const id = positivePid(pgid);
  if (!id) return false;
  let out;
  try {
    out = spawnSync("ps", ["-ax", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" });
  } catch {
    return probeGroup(id);
  }
  if (out.error || out.status !== 0 || out.stdout == null) return probeGroup(id);
  let alive = false;
  for (const line of String(out.stdout).split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    if (Number(parts[0]) !== id) continue;
    if (String(parts[1]).startsWith("Z")) continue;
    alive = true;
  }
  return alive;
}

export function signalGroup(pgid, sig) {
  const id = positivePid(pgid);
  if (!id) return false;
  try {
    process.kill(-id, sig);
    return true;
  } catch (e) {
    if (e?.code === "ESRCH") return false;
    try {
      process.kill(id, sig);
      return true;
    } catch (err) {
      if (err?.code === "ESRCH") return false;
      return null;
    }
  }
}

function identityOf(entry) {
  const pid = positivePid(entry?.pid);
  if (!pid) return "nopid";
  if (entry.proc_start_ms == null) return "unknown";
  const live = readProcStartMs(pid);
  if (live == null) return "unknown";
  if (Math.abs(live - Number(entry.proc_start_ms)) <= PROC_START_TOLERANCE_MS) return "match";
  return "mismatch";
}

function rebound(found) {
  return {
    kind: "alive",
    pid: found.pid,
    pgid: found.pgid,
    procStartMs: readProcStartMs(found.pid),
    rebound: true,
  };
}

// 退出码文件优先：包装用改名发布它，出现就表示命令本身已经结束。
// pid 对不上时先按包装脚本路径再找一次，避免把复用后的无关进程当成我们的，或把还在跑的包装漏掉。
export function classifyEntry(entry) {
  if (!entry || entry.broken) return { kind: "uncertain" };
  if (entry.disposition === "fail") return { kind: "fail" };
  if (entry.exit_path && fs.existsSync(entry.exit_path)) return { kind: "exited" };
  const ident = identityOf(entry);
  if (ident === "nopid" || ident === "mismatch") {
    const found = findWrapProcess(entry.wrap_path);
    if (found.status === "unknown") return { kind: "uncertain" };
    if (found.status === "found") return rebound(found);
    return { kind: "dead" };
  }
  const group = groupAlive(entry.pgid || entry.pid);
  if (group === true && ident === "match") return { kind: "alive" };
  if (group === true && ident === "unknown") return { kind: "uncertain" };
  if (group === false) {
    const found = findWrapProcess(entry.wrap_path);
    if (found.status === "found") return rebound(found);
    if (found.status === "unknown") return { kind: "uncertain" };
    return { kind: "dead" };
  }
  return { kind: "uncertain" };
}

export function readExitCode(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

// 没超过头尾预算时整段解码，避免在 64KiB 边界拆开一个多字节字符。
// 超过时沿用 carrier 的省略标记，回执解析只看标记之后。
export function readBoundedFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if (e?.code === "ENOENT") return "";
    throw e;
  }
  if (!st.size) return "";
  const fd = fs.openSync(file, "r");
  try {
    if (st.size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(st.size);
      fs.readSync(fd, buf, 0, st.size, 0);
      return buf.toString("utf8");
    }
    const head = Buffer.alloc(HEAD_BYTES);
    const tail = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    fs.readSync(fd, tail, 0, TAIL_BYTES, st.size - TAIL_BYTES);
    const omitted = st.size - HEAD_BYTES - TAIL_BYTES;
    return `${head.toString("utf8")}\n…[中间省略 ${omitted} 字节]…\n${tail.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

// 成功落总线后清输出。input.json 是 §9 的运行输入，不在这里删。
export function cleanupRunFiles(configDir, entry) {
  if (!entry?.task_id) return;
  let dir;
  try {
    dir = runDir(configDir, entry.task_id);
  } catch {
    return;
  }
  const keep = path.join(dir, "input.json");
  const paths = [
    entry.stdout_path,
    entry.stderr_path,
    entry.exit_path,
    entry.stdin_path,
    entry.wrap_path,
    entry.exit_path ? `${entry.exit_path}.tmp` : "",
    path.join(dir, "entry.json"),
    path.join(dir, "entry.json.tmp"),
  ];
  for (const file of paths) {
    if (!file || file === keep) continue;
    try { fs.unlinkSync(file); } catch { /* 已经没了 */ }
  }
}
