// 守住命令输出只留头尾，以及超时必须杀掉整个进程组，不能留下孙进程。

import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedCapture, runDetachedCommand } from "../src/carrier.mjs";

// 红线：中间日志不留。省略标记本身不含反引号，内核才能从这一行之后认回执。
test("createBoundedCapture 超限时插入省略标记", () => {
  const cap = createBoundedCapture(8, 8);
  cap.push(Buffer.from("HEADMARK-MIDDLE-TAILMARK"));
  const text = cap.text();
  assert.match(text, /^HEADMARK/);
  assert.match(text, /TAILMARK$/);
  assert.match(text, /…\[中间省略 \d+ 字节\]…/);
  assert.equal(text.includes("```"), false);
});

// 红线：真实执行路径也走头尾截断，回执在尾部、启动报错在头部。
test("runDetachedCommand 保留头尾并标出省略字节数", async () => {
  const headLimit = 64 * 1024;
  const tailLimit = 1024 * 1024;
  const extra = 123;
  const total = headLimit + tailLimit + extra;
  const script = [
    "const total = " + total + ";",
    "const body = 'HEADMARK' + 'm'.repeat(total - 16) + 'TAILMARK';",
    "process.stdout.write(body);",
  ].join("");
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const result = await runDetachedCommand(command, null, 30, process.cwd());
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^HEADMARK/);
  assert.match(result.stdout, /TAILMARK$/);
  assert.match(result.stdout, /…\[中间省略 123 字节\]…/);
});

// 红线：超时先向进程组发 SIGTERM，宽限后再 SIGKILL。被测命令必须是 node -e，测完不能留子进程。
test("runDetachedCommand 超时后结束 node -e 进程组", { timeout: 15_000 }, async () => {
  const script = "setInterval(() => {}, 1000)";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const started = Date.now();
  const result = await runDetachedCommand(command, null, 1, process.cwd());
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 12_000, `超时杀进程用了 ${elapsed}ms`);
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL" || result.code !== 0);
  assert.equal(result.code === 0 && result.signal == null, false);
});
