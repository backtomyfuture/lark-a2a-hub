// 通用进程工具：独立进程组执行、输出头尾截断捕获。kernel 的直跑路径与 direct 在途账本共用。

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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
