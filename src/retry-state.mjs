// retry_state.json 退避水位。缺失或损坏都当成没有水位，调用方决定是否记日志。
import fs from "node:fs";
import path from "node:path";

// 失败立刻回到 submitted 会在下一轮扫表连打。次数仍是 MAX_RETRIES，这里只把间隔拉开。
const RETRY_BACKOFF_BASE_MS = 60_000;
const RETRY_BACKOFF_CAP_MS = 10 * 60_000;

// nextRetryCount 是即将写入的 Retry_Count（第一次失败为 1）。60s 起翻倍，封顶 10 分钟。
export function retryBackoffMs(nextRetryCount) {
  const n = Math.floor(Number(nextRetryCount));
  const step = Number.isFinite(n) && n >= 1 ? n : 1;
  const exp = Math.min(step - 1, 16);
  return Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * (2 ** exp));
}

export function retryHoldUntil(state, taskId, now = Date.now()) {
  const row = state?.[taskId];
  const nb = Number(row?.not_before);
  if (!Number.isFinite(nb) || now >= nb) return 0;
  return nb;
}

function retryStatePath(configDir) {
  return path.join(configDir, "retry_state.json");
}

// 缺失或损坏都当成没有水位。调用方决定是否把「缺失」只记一次，避免每轮刷屏。
export function loadRetryWatermark(configDir, logFn = () => {}) {
  const file = retryStatePath(configDir);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") {
      logFn("retry_state.json 缺失，按无水位处理");
      return {};
    }
    logFn("retry_state.json 读失败，按无水位处理：" + (e?.message ?? e));
    return {};
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      logFn("retry_state.json 损坏，按无水位处理");
      return {};
    }
    const state = {};
    for (const [id, row] of Object.entries(data)) {
      if (!id || id === "__proto__" || id === "constructor" || id === "prototype") continue;
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const nb = Number(row.not_before);
      if (!Number.isFinite(nb)) continue;
      state[id] = { not_before: nb };
    }
    return state;
  } catch (e) {
    logFn("retry_state.json 损坏，按无水位处理：" + (e?.message ?? e));
    return {};
  }
}

// 先写同目录 tmp 再 rename，避免读到半截 JSON。权限 0600：水位只属于本节点。
export function saveRetryWatermark(configDir, state) {
  const file = retryStatePath(configDir);
  const tmp = file + ".tmp";
  const clean = {};
  for (const [id, row] of Object.entries(state ?? {})) {
    if (!id || id === "__proto__" || id === "constructor" || id === "prototype") continue;
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const nb = Number(row.not_before);
    if (!Number.isFinite(nb)) continue;
    clean[id] = { not_before: nb };
  }
  fs.writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
