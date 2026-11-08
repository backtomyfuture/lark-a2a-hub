// 本机 session.json。只给同一任务的问答续跑用，不进总线。
import fs from "node:fs";
import path from "node:path";
import { SESSION_ID } from "./receipt.mjs";

function sessionPath(configDir, taskId) {
  const id = String(taskId ?? "");
  if (!/^[\w-]+$/.test(id)) return "";
  return path.join(configDir, "runs", id, "session.json");
}

export function readSessionId(configDir, taskId) {
  const file = sessionPath(configDir, taskId);
  if (!file) return "";
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const id = data?.session;
    if (typeof id === "string" && SESSION_ID.test(id)) return id;
  } catch { /* 没有会话或文件坏了就当没有，续接退回原命令 */ }
  return "";
}

export function writeSessionId(configDir, taskId, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return;
  const dest = sessionPath(configDir, taskId);
  if (!dest) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(dest), 0o700); } catch { /* 目录权限失败不挡住会话文件 */ }
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ session: sessionId }), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
}

export function clearSessionId(configDir, taskId) {
  const dest = sessionPath(configDir, taskId);
  if (!dest) return;
  for (const file of [dest, dest + ".tmp"]) {
    try { fs.unlinkSync(file); } catch { /* 已经没了 */ }
  }
}
