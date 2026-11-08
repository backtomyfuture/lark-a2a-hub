// carrier —— 特殊语境的代跑进程与客户端（设计 §9）。
//
// 为什么需要它：macOS 的本地网络隐私按「进程所属语境」授权。launchd 拉起的
// 守护进程树访问局域网会被系统拦截（No route to host），且裸 CLI 在隐私设置
// 里没有可授权的条目。同一个命令从用户自己的终端会话里跑则完全正常。
// carrier 就是常驻在用户终端里的同用户进程：守护进程经本地 unix socket
// 把命令发给它代跑，执行语义（shell、stdin、超时、输出捕获）与直跑一致。
//
// 铁律（§9）：carrier 只能由用户在终端里手动启动（hub-node host），
// 守护进程只连接、从不拉起它——被守护进程拉起的进程会回到受限语境，
// 那正是要避开的。carrier 不在线时对应能力标离线，绝不静默改走直跑。
//
// 协议：unix socket 上的 NDJSON，一行一个请求/响应。
//   请求 {"type":"ping"}
//   响应 {"type":"pong","pid":123}
//   请求 {"type":"exec","id":"...","command":"...","cwd":"...","input":"...","timeout_sec":600}
//   中间 {"id","status":"queued"|"running"}  排队阶段客户端不计执行超时
//   响应 {"id","status":"done","code":0,"signal":null,"stdout":"...","stderr":"..."}

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function carrierSocketPath(configDir, rawNodeJson) {
  const v = rawNodeJson?.carrierSocket;
  if (typeof v === "string" && v) return v.replace(/^~/, os.homedir());
  return path.join(configDir, "carrier.sock");
}

function readNodeJson(configDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
  } catch {
    return null;
  }
}

// 向 carrier 发一帧并等一帧响应。连不上/超时都返回 null（供探活使用）。
function carrierRoundTrip(socketPath, frame, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 已断开 */ }
      resolve(v);
    };
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    let buf = "";
    sock.on("error", () => { clearTimeout(timer); finish(null); });
    sock.on("connect", () => sock.write(JSON.stringify(frame) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try { finish(JSON.parse(buf.slice(0, nl))); } catch { finish(null); }
    });
    sock.on("close", () => { clearTimeout(timer); finish(null); });
  });
}

export async function pingCarrier(socketPath, timeoutMs = 800) {
  const r = await carrierRoundTrip(socketPath, { type: "ping" }, timeoutMs);
  return r?.type === "pong";
}

function coerceTimeoutSec(raw, fallback = 600) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 服务端串行队列：排队阶段不按本命令的执行超时掐断，从 running 起才计时。
// 否则排在长任务后面的短超时请求会在还没开跑时被客户端误判为超时。
function carrierExecRoundTrip(socketPath, frame, timeoutSec) {
  const execMs = (timeoutSec + 20) * 1000;
  const queueMs = 24 * 60 * 60 * 1000;
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    let timer = null;
    const sock = net.createConnection(socketPath);
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sock.destroy(); } catch { /* 已断开 */ }
      resolve(v);
    };
    const arm = (ms) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(null), ms);
      timer.unref?.();
    };
    const take = (msg) => {
      if (msg?.id && frame.id && msg.id !== frame.id) return;
      if (msg?.status === "queued") { arm(queueMs); return; }
      if (msg?.status === "running") { arm(execMs); return; }
      finish(msg);
    };
    arm(execMs);
    sock.on("error", () => finish(null));
    sock.on("connect", () => sock.write(JSON.stringify(frame) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while (!done && (nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try { take(JSON.parse(line)); } catch { finish(null); return; }
      }
    });
    sock.on("close", () => finish(null));
  });
}

// 经 carrier 执行命令，返回形状与内核 runShell 一致：{code, signal, stdout, stderr}。
export async function execViaCarrier(socketPath, { command, cwd, input, timeoutSec }) {
  const sec = coerceTimeoutSec(timeoutSec);
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const r = await carrierExecRoundTrip(
    socketPath,
    { type: "exec", id, command, cwd: cwd ?? "", input: input ?? null, timeout_sec: sec },
    sec,
  );
  if (!r) throw new Error("carrier 无响应（不在线或执行超时）");
  if (r.id !== id) throw new Error("carrier 响应 id 不匹配");
  if (r.error) throw new Error("carrier 执行错误：" + r.error);
  return { code: r.code, signal: r.signal ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// direct 在途账本的超时收口用同一个宽限，避免两处各写一个数。
export const KILL_GRACE_MS = 2500;
// 回执在输出尾部，启动报错在头部。中间的模型日志不留，避免无上限拼接撑满内存。
const OUTPUT_HEAD_BYTES = 64 * 1024;
const OUTPUT_TAIL_BYTES = 1024 * 1024;

export function createBoundedCapture(headLimit = OUTPUT_HEAD_BYTES, tailLimit = OUTPUT_TAIL_BYTES) {
  const head = [];
  let headLen = 0;
  const tail = [];
  let tailLen = 0;
  let omitted = 0;

  // 拷贝而不是 subarray：单块很大时，视图会把整块缓冲留在内存里。
  function pushTail(buf) {
    if (buf.length === 0) return;
    if (buf.length >= tailLimit) {
      omitted += tailLen + (buf.length - tailLimit);
      tail.length = 0;
      tail.push(Buffer.from(buf.subarray(buf.length - tailLimit)));
      tailLen = tailLimit;
      return;
    }
    tail.push(Buffer.from(buf));
    tailLen += buf.length;
    while (tailLen > tailLimit && tail.length) {
      const extra = tailLen - tailLimit;
      const first = tail[0];
      if (first.length <= extra) {
        tail.shift();
        tailLen -= first.length;
        omitted += first.length;
      } else {
        tail[0] = Buffer.from(first.subarray(extra));
        tailLen -= extra;
        omitted += extra;
      }
    }
  }

  return {
    push(chunk) {
      if (chunk == null) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      if (headLen < headLimit) {
        const take = Math.min(buf.length, headLimit - headLen);
        head.push(Buffer.from(buf.subarray(0, take)));
        headLen += take;
        offset = take;
      }
      if (offset < buf.length) pushTail(buf.subarray(offset));
    },
    text() {
      // 没丢字节时按整段解码，避免在 64KiB 边界把一个多字节字符拆成两段。
      if (omitted <= 0) return Buffer.concat([...head, ...tail]).toString("utf8");
      const h = Buffer.concat(head, headLen).toString("utf8");
      const t = Buffer.concat(tail, tailLen).toString("utf8");
      // 省略标记不含反引号。内核只把该行之后当作回执，头里的半截围栏不能吞掉尾部。
      return `${h}\n…[中间省略 ${omitted} 字节]…\n${t}`;
    },
  };
}

function killProcessGroup(child, sig) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, sig); }
  catch {
    try { child.kill(sig); } catch { /* 已退出 */ }
  }
}

// 独立进程组执行。超时先向整组发 SIGTERM，宽限后再 SIGKILL，并拆掉 stdio，
// 避免 shell 死后孙进程继续占着管道，使 close 永远不来。
export function runDetachedCommand(command, stdinText, timeoutSec, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const extra = ["/opt/homebrew/bin", path.join(os.homedir(), ".local/bin"), "/usr/local/bin"];
    env.PATH = [...extra, env.PATH ?? "/usr/bin:/bin"].join(":");
    const sec = Number(timeoutSec);
    const ms = Math.min(2_147_483_647, Math.max(0, Number.isFinite(sec) ? sec : 0) * 1000);
    let p;
    try {
      p = spawn(command, {
        shell: true,
        cwd: cwd || os.homedir(),
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      reject(e);
      return;
    }
    const outCap = createBoundedCapture();
    const errCap = createBoundedCapture();
    let settled = false;
    let timer = null;
    let killTimer = null;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      timer = null;
      killTimer = null;
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      fn(value);
    };
    const dropStdio = () => {
      for (const s of [p.stdin, p.stdout, p.stderr]) {
        try { s?.destroy(); } catch { /* 已关 */ }
      }
    };
    p.stdout?.on("data", (d) => { outCap.push(d); });
    p.stderr?.on("data", (d) => { errCap.push(d); });
    p.on("error", (e) => finish(reject, e));
    // EPIPE 表示对端已经退出，交给 close 收口，不能把守护进程打崩。
    p.stdin?.on("error", (e) => {
      if (e?.code === "EPIPE" || e?.code === "ERR_STREAM_DESTROYED") return;
      finish(reject, e);
    });
    p.on("close", (code, signal) => finish(resolve, { code, signal, stdout: outCap.text(), stderr: errCap.text() }));
    timer = setTimeout(() => {
      killProcessGroup(p, "SIGTERM");
      if (settled) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        killProcessGroup(p, "SIGKILL");
        dropStdio();
        if (settled) return;
        killTimer = setTimeout(() => {
          finish(resolve, { code: null, signal: "SIGKILL", stdout: outCap.text(), stderr: errCap.text() });
        }, 500);
      }, KILL_GRACE_MS);
    }, ms);
    try {
      if (stdinText != null) p.stdin.write(stdinText);
      p.stdin.end();
    } catch (e) {
      if (e?.code !== "EPIPE") finish(reject, e);
    }
  });
}

// 与内核 runShell 语义一致的本地执行（shell、PATH 前缀、超时、双流捕获）。
function runLocal(command, stdinText, timeoutSec, cwd) {
  return runDetachedCommand(command, stdinText, timeoutSec, cwd);
}

// hub-node host：carrier 进程本体。在用户终端里前台常驻。
export async function startCarrier(configDir) {
  const raw = readNodeJson(configDir);
  const node = String(raw?.node || "default");
  const socketPath = carrierSocketPath(configDir, raw);

  if (fs.existsSync(socketPath)) {
    if (await pingCarrier(socketPath)) {
      console.log(`carrier 已在运行（socket：${socketPath}），本进程退出。`);
      return 1;
    }
    fs.unlinkSync(socketPath); // 陈旧 socket 文件，清理后重建
  }

  // 执行串行化：一台节点同时只代跑一条命令，与守护进程的串行执行对齐。
  let chain = Promise.resolve();
  const enqueue = (fn) => (chain = chain.then(fn, fn));

  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === "ping") {
          sock.write(JSON.stringify({ type: "pong", pid: process.pid }) + "\n");
        } else if (frame.type === "exec") {
          try { sock.write(JSON.stringify({ id: frame.id, status: "queued" }) + "\n"); }
          catch { continue; }
          enqueue(async () => {
            const t0 = new Date().toISOString().slice(11, 19);
            console.log(`[${t0}] exec: ${String(frame.command).slice(0, 100)}`);
            const write = (obj) => {
              if (sock.destroyed) return;
              try { sock.write(JSON.stringify(obj) + "\n"); } catch { /* 客户端已走 */ }
            };
            try {
              write({ id: frame.id, status: "running" });
              const r = await runLocal(
                String(frame.command),
                frame.input ?? null,
                coerceTimeoutSec(frame.timeout_sec),
                frame.cwd || undefined,
              );
              console.log(`[${t0}] done: code=${r.code}`);
              write({ id: frame.id, status: "done", ...r });
            } catch (e) {
              write({ id: frame.id, status: "done", error: String(e?.message ?? e) });
            }
          });
        }
      }
    });
    sock.on("error", () => { /* 客户端断开，忽略 */ });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try { fs.chmodSync(socketPath, 0o600); } catch { /* 权限设置失败不阻塞 */ }

  console.log(`hub-node carrier 已启动（节点 ${node}，pid ${process.pid}）`);
  console.log(`  socket：${socketPath}`);
  console.log("  本终端保持开启即可；Ctrl-C 退出。守护进程只连接这里、不会自己拉起 carrier。");

  const shutdown = () => {
    server.close();
    try { fs.unlinkSync(socketPath); } catch { /* 已清理 */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return await new Promise(() => { /* 常驻 */ });
}
