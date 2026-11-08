// 测试只许把状态放进系统临时目录。调用方要在用例结束时删掉，避免留下配置或子进程。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lah-test-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const TABLES = {
  tasks: "tbl_tasks",
  messages: "tbl_messages",
  parts: "tbl_parts",
  runs: "tbl_runs",
  artifacts: "tbl_artifacts",
  agentCards: "tbl_cards",
};
