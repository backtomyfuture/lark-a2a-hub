// 本机结果队列的追加、取走与等待。只碰队列文件和它旁边的锁，不访问总线。
// 追加方（守护进程）与 lah present --pop 必须共用这把锁：只做 rename 快照仍会丢，
// 因为追加方可能已经打开旧文件，rename 之后才写入被摘走的 inode。

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 3000;
const DEFAULT_STALE_MS = 10_000;
const DEFAULT_POLL_MS = 500;
const WAIT_MAX_SEC = 86400;

const USAGE = "用法：lah present [--pop] [--task <Task_ID>] [--wait <秒>]  读取本机结果呈递队列；--wait 阻塞到出现匹配回执（超时退出码 2）；--pop 只移除本次输出的条目";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPathOf(queuePath) {
  return `${queuePath}.lock`;
}

// 超过 10 秒的锁视为持有者已崩溃。两个进程可能在同一微秒里都判定过期并删除，
// 然后各自创建；这个窗口只在崩溃之后出现，接受它，避免陈旧锁把守护进程或 CLI 永久卡住。
function reclaimStaleLock(lockPath, staleMs, nowMs) {
  let st;
  try {
    st = fs.statSync(lockPath);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  if (nowMs - st.mtimeMs <= staleMs) return false;
  try {
    fs.unlinkSync(lockPath);
  } catch (e) {
    if (e.code !== "ENOENT") return false;
  }
  return true;
}

// Windows 上杀毒软件会让刚创建的文件偶发 EPERM/EBUSY。只对这两种重试，最多 3 次。
async function retryBusy(fn, sleepFn) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      if ((e.code === "EPERM" || e.code === "EBUSY") && i < 2) {
        await sleepFn(LOCK_RETRY_MS);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

function readLockToken(lockPath) {
  try {
    return fs.readFileSync(lockPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// 写回前再看一眼。过期被接管之后，按读到的旧内容整文件盖回去会丢掉接管者刚追加的行。
function assertLockOwner(hold) {
  const current = readLockToken(hold.lockPath);
  if (current == null) throw new Error("present 队列锁已不在，放弃写回");
  if (current !== hold.token) throw new Error("present 队列锁已被接管，放弃写回");
}

async function releaseLock(lockPath, token, sleepFn) {
  try {
    await retryBusy(() => {
      // 只删令牌仍是自己的那把。接管者已经换过锁时，删的会是别人的。
      if (readLockToken(lockPath) !== token) return;
      try {
        fs.unlinkSync(lockPath);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }, sleepFn);
  } catch {
    // 调用方已经完成队列写入时，释放失败不能再抛：否则它会重试，队列里出现重复行。
    // 残留锁留给上面的过期删除。写入尚未完成时同样吞掉，好让原始错误露出来。
  }
}

export async function withQueueLock(queuePath, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const sleepFn = opts.sleep ?? defaultSleep;
  const nowFn = opts.now ?? Date.now;
  const lockPath = lockPathOf(queuePath);
  let waited = 0;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (reclaimStaleLock(lockPath, staleMs, nowFn())) continue;
      // 拿不到锁就停，不能无限等：扫表主循环会卡在呈递上。
      if (waited >= timeoutMs) throw new Error("拿不到 present 队列锁");
      await sleepFn(LOCK_RETRY_MS);
      waited += LOCK_RETRY_MS;
      continue;
    }
    const token = randomBytes(16).toString("hex");
    try {
      fs.writeSync(fd, token);
    } finally {
      fs.closeSync(fd);
    }
    try {
      return await fn({ token, lockPath });
    } finally {
      await releaseLock(lockPath, token, sleepFn);
    }
  }
}

function completeLines(raw) {
  if (!raw) return { lines: [], partial: "" };
  if (raw.endsWith("\n")) {
    const lines = raw.slice(0, -1).split("\n");
    return { lines, partial: "" };
  }
  const idx = raw.lastIndexOf("\n");
  if (idx < 0) return { lines: [], partial: raw };
  return { lines: raw.slice(0, idx).split("\n"), partial: raw.slice(idx + 1) };
}

function lineMatches(line, taskId) {
  if (taskId == null) return true;
  try {
    return JSON.parse(line).task_id === taskId;
  } catch {
    return false;
  }
}

function splitQueue(raw, taskId) {
  const { lines, partial } = completeLines(raw);
  const matched = [];
  const kept = [];
  for (const line of lines) {
    if (lineMatches(line, taskId)) matched.push(line);
    else kept.push(line);
  }
  let rest = kept.length ? `${kept.join("\n")}\n` : "";
  rest += partial;
  return { matched, rest };
}

async function replaceQueue(queuePath, content, sleepFn) {
  const tmp = `${queuePath}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    await retryBusy(() => fs.renameSync(tmp, queuePath), sleepFn);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 留下临时文件也比盖掉队列更糟 */ }
    throw e;
  }
}

export async function appendQueueItem(queuePath, item, opts = {}) {
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  const line = `${JSON.stringify(item)}\n`;
  // 锁里只有一次 O_APPEND。读完之后被挂起、锁被接管、再恢复，也只是往末尾追加，
  // 不会截断接管者已经写入的内容，所以写之前不再对令牌。释放时仍只删自己的锁。
  await withQueueLock(queuePath, () => {
    fs.appendFileSync(queuePath, line, { mode: 0o600 });
  }, opts);
}

export async function popQueue(queuePath, options = {}) {
  const { taskId, onBeforeRewrite, ...lockOpts } = options;
  // 只有显式传入 taskId 才过滤。不传则取走全部完整行，其余为空，文件留下且长度为 0。
  const taskFilter = Object.hasOwn(options, "taskId") ? taskId : undefined;
  return withQueueLock(queuePath, async (hold) => {
    let raw = "";
    try {
      raw = fs.readFileSync(queuePath, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const { matched, rest } = splitQueue(raw, taskFilter);
    // onBeforeRewrite 只给测试把「接管」插在读完和写回之间，不给命令行用。
    if (onBeforeRewrite) await onBeforeRewrite();
    assertLockOwner(hold);
    await replaceQueue(queuePath, rest, lockOpts.sleep ?? defaultSleep);
    return matched;
  }, lockOpts);
}

export function readQueueLines(queuePath) {
  try {
    return completeLines(fs.readFileSync(queuePath, "utf8")).lines;
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

// 与 bin/lah.mjs 的 acquireDaemonLock 同一口径：EPERM 说明 pid 还在，只是信号被拒绝。
export function daemonAlive(configDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(configDir, "daemon.lock"), "utf8");
  } catch {
    return false;
  }
  const pid = Number(String(text).trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function queueSignature(queuePath) {
  try {
    const st = fs.statSync(queuePath);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    if (e.code === "ENOENT") return "enoent";
    throw e;
  }
}

function writeLines(out, lines) {
  for (const line of lines) out(`${line}\n`);
}

function failUsage(err, message) {
  err(`${message}\n${USAGE}\n`);
  return 1;
}

function parsePresentArgs(args) {
  let pop = false;
  let taskId;
  let waitSec;
  let sawWait = false;
  let sawTask = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pop") {
      pop = true;
      continue;
    }
    if (arg === "--config") {
      i += 1;
      continue;
    }
    if (arg === "--task") {
      const value = args[i + 1];
      if (value == null || value.startsWith("--")) return { error: "缺少 --task 的值" };
      sawTask = true;
      taskId = value;
      i += 1;
      continue;
    }
    if (arg === "--wait") {
      const value = args[i + 1];
      if (value == null || value.startsWith("--")) return { error: "缺少 --wait 的值" };
      if (!/^\d+$/.test(value)) return { error: "--wait 必须是 0 到 86400 的整数" };
      const n = Number(value);
      if (n > WAIT_MAX_SEC) return { error: "--wait 上限是 86400 秒" };
      sawWait = true;
      waitSec = n;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) return { error: `未知参数：${arg}` };
    return { error: `未知参数：${arg}` };
  }
  return { pop, taskId: sawTask ? taskId : undefined, waitSec: sawWait ? waitSec : undefined };
}

function timeoutMessage(waitSec, taskId, configDir, alive) {
  const who = taskId == null ? "任何回执" : `任务 ${taskId} 的回执`;
  let text = `未收到${who}（已等待 ${waitSec} 秒）。\n`;
  if (!alive) {
    text += `未检测到守护进程在运行（${path.join(configDir, "daemon.lock")}）。可用 lah doctor 排查。\n`;
  }
  return text;
}

function waitingHint(configDir) {
  return `未检测到守护进程在运行（${path.join(configDir, "daemon.lock")}）。回执要等守护进程写入队列；可用 lah doctor 排查。继续等待。\n`;
}

export async function handlePresentCli(args, {
  configDir,
  out = (chunk) => process.stdout.write(chunk),
  err = (chunk) => process.stderr.write(chunk),
  clock,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const parsed = parsePresentArgs(args ?? []);
  if (parsed.error) return failUsage(err, parsed.error);
  if (!configDir) return failUsage(err, "缺少配置目录");
  const queuePath = path.join(configDir, "present_queue.jsonl");
  const clockImpl = clock ?? { now: () => Date.now(), sleep: defaultSleep };
  const lockOpts = { sleep: clockImpl.sleep, now: clockImpl.now };
  const taskArg = parsed.taskId === undefined ? {} : { taskId: parsed.taskId };
  try {
    if (parsed.waitSec == null) {
      const lines = parsed.pop
        ? await popQueue(queuePath, { ...taskArg, ...lockOpts })
        : readQueueLines(queuePath).filter((line) => lineMatches(line, parsed.taskId));
      writeLines(out, lines);
      return 0;
    }
    const deadline = clockImpl.now() + parsed.waitSec * 1000;
    let prevSig;
    let warned = false;
    for (;;) {
      // 签名必须早于读。读的过程中又写入的变化会落在下一次签名上，不会被这轮漏掉。
      const sig = queueSignature(queuePath);
      if (sig !== prevSig) {
        prevSig = sig;
        const lines = readQueueLines(queuePath).filter((line) => lineMatches(line, parsed.taskId));
        if (lines.length) {
          if (!parsed.pop) {
            writeLines(out, lines);
            return 0;
          }
          const taken = await popQueue(queuePath, { ...taskArg, ...lockOpts });
          // 读到和取走之间可能被另一次 --pop 拿走。空结果不能当成等到了。
          if (taken.length) {
            writeLines(out, taken);
            return 0;
          }
          prevSig = undefined;
        }
      }
      if (!warned) {
        warned = true;
        if (!daemonAlive(configDir)) err(waitingHint(configDir));
      }
      if (clockImpl.now() >= deadline) {
        err(timeoutMessage(parsed.waitSec, parsed.taskId, configDir, daemonAlive(configDir)));
        return 2;
      }
      const slice = Math.min(pollMs, deadline - clockImpl.now());
      await clockImpl.sleep(slice);
    }
  } catch (e) {
    err(`读取 present_queue.jsonl 失败：${e?.message ?? e}\n`);
    return 1;
  }
}
