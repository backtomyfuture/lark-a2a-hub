// lah present 的等待、按任务过滤，以及队列锁。状态只写临时目录。
// 等待用注入的时钟，不睡真实的秒；并发用例只看结果对不对。

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  appendQueueItem,
  handlePresentCli,
  popQueue,
  withQueueLock,
} from "../src/present-queue.mjs";
import { withTemp } from "./helpers.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lahBin = path.join(root, "bin", "lah.mjs");

function queueFile(dir) {
  return path.join(dir, "present_queue.jsonl");
}

function makeClock(start = 1_000_000) {
  let now = start;
  const clock = {
    sleeps: [],
    now() { return now; },
    async sleep(ms) {
      clock.sleeps.push(ms);
      now += ms;
      if (clock.onSleep) await clock.onSleep(clock.sleeps.length);
    },
  };
  return clock;
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    writeOut: (chunk) => { out.push(chunk); },
    writeErr: (chunk) => { err.push(chunk); },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function present(dir, args, extra = {}) {
  const io = capture();
  const code = await handlePresentCli(args, {
    configDir: dir,
    out: io.writeOut,
    err: io.writeErr,
    ...extra,
  });
  return { code, ...io };
}

test("无文件与已有队列的读取、--pop 后文件还在且为空", async () => {
  await withTemp(async (dir) => {
    const missing = await present(dir, []);
    assert.equal(missing.code, 0);
    assert.equal(missing.stdout(), "");
    assert.equal(fs.existsSync(queueFile(dir)), false);

    const lines = [
      JSON.stringify({ task_id: "T", n: 1 }),
      JSON.stringify({ task_id: "T", n: 2 }),
      JSON.stringify({ task_id: "T", n: 3 }),
    ];
    const raw = `${lines.join("\n")}\n`;
    fs.writeFileSync(queueFile(dir), raw);
    const read = await present(dir, []);
    assert.equal(read.code, 0);
    assert.equal(read.stdout(), raw);
    assert.equal(fs.readFileSync(queueFile(dir), "utf8"), raw);

    const popped = await present(dir, ["--pop"]);
    assert.equal(popped.code, 0);
    assert.equal(popped.stdout(), raw);
    assert.equal(fs.existsSync(queueFile(dir)), true);
    assert.equal(fs.statSync(queueFile(dir)).size, 0);
  });
});

test("--task 只输出匹配行，--pop 只移除这些行且其余字节不变", async () => {
  await withTemp(async (dir) => {
    const x1 = '{"task_id":"X","k":1}';
    const y1 = '{"task_id":"Y","k":2}';
    const x2 = '{"task_id":"X","k":3}';
    const y2 = '{"task_id":"Y","k":4}';
    const raw = `${x1}\n${y1}\n${x2}\n${y2}\n`;
    fs.writeFileSync(queueFile(dir), raw);
    const read = await present(dir, ["--task", "X"]);
    assert.equal(read.code, 0);
    assert.equal(read.stdout(), `${x1}\n${x2}\n`);
    assert.equal(fs.readFileSync(queueFile(dir), "utf8"), raw);

    const popped = await present(dir, ["--pop", "--task", "X"]);
    assert.equal(popped.code, 0);
    assert.equal(popped.stdout(), `${x1}\n${x2}\n`);
    assert.equal(fs.readFileSync(queueFile(dir), "utf8"), `${y1}\n${y2}\n`);
  });
});

test("等待开始前已有匹配条目则立即返回", async () => {
  await withTemp(async (dir) => {
    const line = JSON.stringify({ task_id: "X", status: "completed" });
    fs.writeFileSync(queueFile(dir), `${line}\n`);
    const clock = makeClock();
    const result = await present(dir, ["--wait", "30", "--task", "X"], { clock, pollMs: 500 });
    assert.equal(result.code, 0);
    assert.equal(result.stdout(), `${line}\n`);
    assert.equal(clock.sleeps.length, 0);
  });
});

test("等待中后到的匹配回执才返回，--pop 留下其他任务", async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const clock = makeClock();
    const y = { task_id: "Y", status: "completed" };
    const x = { task_id: "X", status: "completed" };
    clock.onSleep = async (n) => {
      if (n === 2) await appendQueueItem(q, y);
      if (n === 4) await appendQueueItem(q, x);
    };
    const result = await present(dir, ["--wait", "30", "--task", "X", "--pop"], { clock, pollMs: 500 });
    assert.equal(result.code, 0);
    assert.equal(clock.sleeps.length, 4);
    assert.equal(result.stdout(), `${JSON.stringify(x)}\n`);
    assert.equal(fs.readFileSync(q, "utf8"), `${JSON.stringify(y)}\n`);
  });
});

test("超时退出码 2 且 stdout 为空，--wait 0 立即超时", async () => {
  await withTemp(async (dir) => {
    const clock = makeClock();
    const start = clock.now();
    const result = await present(dir, ["--wait", "2", "--task", "X"], { clock, pollMs: 500 });
    assert.equal(result.code, 2);
    assert.equal(result.stdout(), "");
    assert.match(result.stderr(), /未收到/);
    assert.equal(clock.now() - start, 2000);

    const zero = makeClock();
    const zeroStart = zero.now();
    const immediate = await present(dir, ["--wait", "0", "--task", "X"], { clock: zero, pollMs: 500 });
    assert.equal(immediate.code, 2);
    assert.equal(immediate.stdout(), "");
    assert.match(immediate.stderr(), /未收到/);
    assert.equal(zero.now(), zeroStart);
    assert.equal(zero.sleeps.length, 0);
  });
});

test("question 先返回，pop 后再等终态；同时在队列里则一次返回两条", async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const question = { task_id: "X", status: "input-required" };
    fs.writeFileSync(q, `${JSON.stringify(question)}\n`);
    const first = await present(dir, ["--wait", "10", "--task", "X", "--pop"], { clock: makeClock(), pollMs: 500 });
    assert.equal(first.code, 0);
    assert.equal(JSON.parse(first.stdout()).status, "input-required");
    assert.equal(fs.readFileSync(q, "utf8"), "");

    const clock = makeClock();
    const done = { task_id: "X", status: "completed" };
    clock.onSleep = async (n) => {
      if (n === 1) await appendQueueItem(q, done);
    };
    const second = await present(dir, ["--wait", "10", "--task", "X", "--pop"], { clock, pollMs: 500 });
    assert.equal(second.code, 0);
    assert.equal(JSON.parse(second.stdout()).status, "completed");
  });

  await withTemp(async (dir) => {
    const question = JSON.stringify({ task_id: "X", status: "input-required" });
    const done = JSON.stringify({ task_id: "X", status: "completed" });
    fs.writeFileSync(queueFile(dir), `${question}\n${done}\n`);
    const both = await present(dir, ["--wait", "10", "--task", "X", "--pop"], { clock: makeClock(), pollMs: 500 });
    assert.equal(both.code, 0);
    assert.equal(both.stdout(), `${question}\n${done}\n`);
    assert.equal(makeClock().sleeps.length, 0);
  });
});

test("队列文件起初不存在，等待中被创建后返回", async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const clock = makeClock();
    const item = { task_id: "X", status: "completed" };
    clock.onSleep = async (n) => {
      if (n === 1) await appendQueueItem(q, item);
    };
    const result = await present(dir, ["--wait", "10", "--task", "X"], { clock, pollMs: 500 });
    assert.equal(result.code, 0);
    assert.equal(result.stdout(), `${JSON.stringify(item)}\n`);
    assert.equal(fs.existsSync(q), true);
  });
});

test("守护进程未运行时提示一次并继续等；锁里的 pid 仍在则不提示", async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const clock = makeClock();
    const item = { task_id: "X", status: "completed" };
    clock.onSleep = async (n) => {
      if (n === 1) await appendQueueItem(q, item);
    };
    const result = await present(dir, ["--wait", "30", "--task", "X", "--pop"], { clock, pollMs: 500 });
    assert.equal(result.code, 0);
    assert.ok(clock.sleeps.length >= 1);
    assert.equal(result.stderr().split("未检测到").length - 1, 1);
  });

  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "daemon.lock"), `${process.pid}\n`);
    const q = queueFile(dir);
    const clock = makeClock();
    const item = { task_id: "X", status: "completed" };
    clock.onSleep = async (n) => {
      if (n === 1) await appendQueueItem(q, item);
    };
    const result = await present(dir, ["--wait", "30", "--task", "X"], { clock, pollMs: 500 });
    assert.equal(result.code, 0);
    assert.equal(result.stderr().includes("未检测到"), false);
    assert.ok(clock.sleeps.length >= 1);
  });
});

test("非法参数退出码 1、stderr 含用法，且不改队列", async () => {
  await withTemp(async (dir) => {
    const raw = `${JSON.stringify({ task_id: "X" })}\n`;
    fs.writeFileSync(queueFile(dir), raw);
    const cases = [
      ["--wait", "abc"],
      ["--wait", "-1"],
      ["--wait"],
      ["--wait", "86401"],
      ["--task"],
      ["--wiat", "60"],
      ["leftover"],
    ];
    for (const args of cases) {
      const result = await present(dir, args);
      assert.equal(result.code, 1, args.join(" "));
      assert.match(result.stderr(), /用法/);
      assert.equal(fs.readFileSync(queueFile(dir), "utf8"), raw);
    }
  });
});

test("末尾没有换行的半行要等补全后的下一轮才返回", async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const head = '{"task_id":"X","status":"completed"';
    fs.writeFileSync(q, head);
    const clock = makeClock();
    clock.onSleep = async (n) => {
      if (n === 1) fs.appendFileSync(q, "}\n");
    };
    const result = await present(dir, ["--wait", "10", "--task", "X"], { clock, pollMs: 500 });
    assert.equal(result.code, 0);
    assert.equal(clock.sleeps.length, 1);
    assert.equal(JSON.parse(result.stdout()).task_id, "X");
  });
});

test("读完队列后锁被接管，原持锁者放弃写回且不输出", async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    fs.writeFileSync(q, `${JSON.stringify({ task_id: "OLD", n: 1 })}\n`);
    const out = [];
    await assert.rejects(async () => {
      const lines = await popQueue(q, {
        staleMs: 1,
        sleep: async () => {},
        onBeforeRewrite: async () => {
          const lock = `${q}.lock`;
          const past = new Date(Date.now() - 5_000);
          fs.utimesSync(lock, past, past);
          await appendQueueItem(q, { task_id: "NEW", n: 2 }, { staleMs: 1, sleep: async () => {} });
        },
      });
      for (const line of lines) out.push(line);
    }, /放弃写回/);
    assert.deepEqual(out, []);
    const text = fs.readFileSync(q, "utf8");
    assert.equal(text.includes('"task_id":"OLD"'), true);
    assert.equal(text.includes('"task_id":"NEW"'), true);
  });
});

test("读完队列后锁还在但令牌是别人的，原持锁者放弃写回且不删这把锁", async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const lock = `${q}.lock`;
    const oldLine = `${JSON.stringify({ task_id: "OLD", n: 1 })}\n`;
    const newLine = `${JSON.stringify({ task_id: "NEW", n: 2 })}\n`;
    fs.writeFileSync(q, oldLine);
    const out = [];
    await assert.rejects(async () => {
      const lines = await popQueue(q, {
        sleep: async () => {},
        onBeforeRewrite: async () => {
          // 接管者仍持锁：文件还在，内容换成别人的令牌，队列是接管者写完后的样子。
          fs.writeFileSync(lock, "successor-token");
          fs.appendFileSync(q, newLine);
        },
      });
      for (const line of lines) out.push(line);
    }, /已被接管/);
    assert.deepEqual(out, []);
    assert.equal(fs.readFileSync(q, "utf8"), oldLine + newLine);
    assert.equal(fs.readFileSync(lock, "utf8"), "successor-token");
  });
});

test("释放锁时若已被接管，不删除接管者的锁", async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const lock = `${q}.lock`;
    await withQueueLock(q, () => {
      fs.writeFileSync(lock, "successor-token");
    }, { sleep: async () => {} });
    assert.equal(fs.readFileSync(lock, "utf8"), "successor-token");
  });
});

test("并发追加与 pop 不丢不重", { timeout: 120_000 }, async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const href = pathToFileURL(path.join(root, "src", "present-queue.mjs")).href;
    const script = `
      import { appendQueueItem } from ${JSON.stringify(href)};
      const q = ${JSON.stringify(q)};
      for (let i = 0; i < 3000; i++) await appendQueueItem(q, { n: i });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errText = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { errText += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`child ${code}: ${errText}`));
      });
    });
    const seen = [];
    try {
      while (child.exitCode == null) {
        const lines = await popQueue(q);
        for (const line of lines) seen.push(JSON.parse(line).n);
        if (lines.length === 0 && child.exitCode == null) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      }
      await exited;
      const tail = await popQueue(q);
      for (const line of tail) seen.push(JSON.parse(line).n);
      seen.sort((a, b) => a - b);
      assert.deepEqual(seen, Array.from({ length: 3000 }, (_, i) => i));
    } finally {
      if (child.exitCode == null) child.kill("SIGKILL");
    }
  });
});

test("新鲜锁会等，超时失败且队列不变，过期锁可以被清掉；写完后释放失败不抛", async () => {
  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const lock = `${q}.lock`;
    fs.writeFileSync(q, "");
    fs.writeFileSync(lock, "held");
    let n = 0;
    const sleep = async () => {
      n += 1;
      if (n === 3) fs.unlinkSync(lock);
    };
    await appendQueueItem(q, { n: 1 }, { sleep });
    assert.equal(n, 3);
    assert.equal(fs.readFileSync(q, "utf8"), `${JSON.stringify({ n: 1 })}\n`);
  });

  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const lock = `${q}.lock`;
    const raw = `${JSON.stringify({ task_id: "T", n: 1 })}\n`;
    fs.writeFileSync(q, raw);
    fs.writeFileSync(lock, "held");
    const sleep = async () => {};
    await assert.rejects(() => appendQueueItem(q, { n: 2 }, { sleep, timeoutMs: 40 }));
    assert.equal(fs.readFileSync(q, "utf8"), raw);
    const result = await present(dir, ["--pop"], {
      clock: { now: () => 0, sleep },
    });
    assert.equal(result.code, 1);
    assert.equal(fs.readFileSync(q, "utf8"), raw);
  });

  await withTemp(async (dir) => {
    const q = queueFile(dir);
    const lock = `${q}.lock`;
    fs.writeFileSync(lock, "stale");
    const past = new Date(Date.now() - 20_000);
    fs.utimesSync(lock, past, past);
    await appendQueueItem(q, { n: 3 }, { sleep: async () => {} });
    assert.equal(JSON.parse(fs.readFileSync(q, "utf8")).n, 3);
    assert.equal(fs.existsSync(lock), false);
  });

  await withTemp(async (dir) => {
    const q = queueFile(dir);
    await withQueueLock(q, () => {
      fs.appendFileSync(q, `${JSON.stringify({ n: 9 })}\n`, { mode: 0o600 });
      const lock = `${q}.lock`;
      fs.unlinkSync(lock);
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "keep"), "x");
    }, { sleep: async () => {} });
    assert.equal(fs.readFileSync(q, "utf8"), `${JSON.stringify({ n: 9 })}\n`);
    assert.equal(fs.statSync(`${q}.lock`).isDirectory(), true);
  });
});

test("真实 CLI：--wait 0 退出码 2，无文件的 --pop 退出码 0", async () => {
  await withTemp(async (dir) => {
    const waited = spawnSync(process.execPath, [
      lahBin, "present", "--config", dir, "--wait", "0", "--task", "NOPE",
    ], { encoding: "utf8" });
    assert.equal(waited.status, 2);
    assert.equal(waited.stdout, "");
    assert.match(waited.stderr, /未收到/);

    const popped = spawnSync(process.execPath, [
      lahBin, "present", "--config", dir, "--pop",
    ], { encoding: "utf8" });
    assert.equal(popped.status, 0);
    assert.equal(popped.stdout, "");
  });
});
