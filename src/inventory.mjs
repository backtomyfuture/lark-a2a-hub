// inventory —— 只读盘点本节点名片与任务。不创建、不更新、不删除任何行。

import { loadConfig, receiveModeOf } from "./kernel.mjs";
import { f1 } from "./bus/feishu.mjs";

const ok = (msg) => console.log("  ✓ " + msg);
const warn = (msg) => console.log("  ! " + msg);
const info = (msg) => console.log("  · " + msg);

export async function inventory(configDir) {
  const cfg = loadConfig(configDir);
  const expectedMode = receiveModeOf(cfg);
  console.log(`inventory: 节点 ${cfg.node}（只读，不写入）`);
  info(`本地配置 Receive_Mode 期望 ${expectedMode}（events=${cfg.events ? "true" : "false"} pollSec=${cfg.pollSec} sweepSec=${cfg.sweepSec}）`);
  if (cfg.nodeDesc) info(`本地 nodeDesc：${cfg.nodeDesc}`);

  const cards = await cfg.bus.listRecords(cfg.bus.tables.agentCards);
  const mine = cards.filter((row) => f1(row, "Node") === cfg.node);
  if (!mine.length) warn("本节点没有名片行");
  let drifts = 0;
  for (const row of mine) {
    const capId = f1(row, "Cap_ID") || "(无 Cap_ID)";
    const mode = f1(row, "Receive_Mode") || "(空)";
    const avail = f1(row, "Availability") || "(空)";
    const dispatch = f1(row, "Dispatchable") || "(空)";
    const desc = f1(row, "Node_Desc") || "";
    info(`名片 ${capId}  Worker=${f1(row, "Worker") || "(节点本尊)"}  Skill=${f1(row, "Skill_ID") || ""}  Receive_Mode=${mode}  Availability=${avail}  Dispatchable=${dispatch}`);
    if (mode !== expectedMode) {
      warn(`${capId} Receive_Mode=${mode}，与本地配置期望 ${expectedMode} 不一致`);
      drifts++;
    }
    if (cfg.nodeDesc && desc && desc !== cfg.nodeDesc) {
      warn(`${capId} Node_Desc 与本地 nodeDesc 不一致`);
      drifts++;
    }
  }

  const tasks = await cfg.bus.listRecords(cfg.bus.tables.tasks);
  const mineTasks = tasks.filter((row) => f1(row, "Target_Node") === cfg.node);
  const byStatus = new Map();
  for (const row of mineTasks) {
    const st = f1(row, "Status") || "(空)";
    byStatus.set(st, (byStatus.get(st) || 0) + 1);
  }
  if (!mineTasks.length) info("没有 Target_Node 指向本节点的任务");
  else {
    const summary = [...byStatus.entries()].map(([k, n]) => `${k}=${n}`).join("，");
    info(`本节点任务 ${mineTasks.length} 条：${summary}`);
    for (const row of mineTasks) {
      const st = f1(row, "Status") || "(空)";
      if (st === "submitted" || st === "working" || st === "auth-required" || st === "input-required") {
        info(`  ${f1(row, "Task_ID") || "(无 Task_ID)"}  ${st}  ${f1(row, "Title") || ""}`);
      }
    }
  }

  if (drifts) warn(`发现 ${drifts} 处名片与本地配置偏离`);
  else ok("名片与本地配置无偏离");
  return 0;
}
