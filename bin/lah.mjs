#!/usr/bin/env node
// lah —— lark-a2a-hub 命令行入口。
// 子命令：
//   setup    一键配置向导：装/复用 lark-cli、发现 Base 表、写配置、自检、自启
//   daemon   常驻守护进程。--role node 认领执行；--role hub 既认领执行，又做全网审批、呈递、陈旧告警。
//            省略 --role 时读 node.json 的 role，再缺省 node。
//   task     task create：hub 角色建单。先写 instruction 与 Parts，最后写 Tasks 行。
//            task cancel：发起方撤自己的单，或 hub 角色撤任意单。先写 notice，最后改 Tasks。
//   doctor   本机自检：配置、凭据、总线连通、能力登记、自启状态（M3）
//   inventory 只读盘点本节点名片与任务，不写入
//   reconcile 单次回表认领/对账后退出（webhook 或 15 分钟兜底；不停派手工名片）
//            --probe <host:port> 经在线 carrier 做一次只读 TCP 探测
//   service  注册/卸载开机自启：macOS launchd / Linux systemd / Windows 任务计划程序（均用户级，无需管理员）
//   update   自更新程序本体：git pull + 依赖重装 + 软链/Skill 补齐；--check 只看有没有新版本
//   host     carrier 语境进程：在用户终端里常驻，替守护进程代跑需要
//            特殊语境（如 macOS 局域网权限）的命令（设计 §9，M4）
// 配置目录：--config <dir>，或环境变量 HUB_NODE_HOME，默认 ~/.hub-node。
// 配置目录内含 node.json（节点身份与总线参数）与 commands.json（能力 -> 命令模板）。

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Kernel, loadConfig, DAEMON_VERSION } from "../src/kernel.mjs";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function configDirFrom(argv) {
  const i = argv.indexOf("--config");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.HUB_NODE_HOME) return process.env.HUB_NODE_HOME;
  return path.join(os.homedir(), ".hub-node");
}

// 命令行写了 --role 就取出；没写返回 undefined。非法值抛错，不静默当成 node。
function specifiedRole(argv) {
  let value;
  let seen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--role") {
      seen = true;
      value = argv[i + 1] ?? "";
      i++;
    } else if (arg.startsWith("--role=")) {
      seen = true;
      value = arg.slice("--role=".length);
    }
  }
  if (!seen) return undefined;
  if (value !== "node" && value !== "hub") {
    throw new Error(`--role 只能是 node 或 hub，收到：${value || "(空)"}`);
  }
  return value;
}

// daemon / doctor / service 共用：命令行 --role 优先。
// 省略时读 node.json 的 role，没有该字段或读不到配置再缺省 node。
function roleForTool(argv) {
  const specified = specifiedRole(argv);
  if (specified) return specified;
  try {
    const file = path.join(configDirFrom(argv), "node.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw.role === "hub" || raw.role === "node") return raw.role;
  } catch { /* 读不到配置就按 node，doctor 会再报配置失败 */ }
  return "node";
}

function probeTargetFrom(argv) {
  const i = argv.indexOf("--probe");
  if (i < 0) return undefined;
  return argv[i + 1] ?? "";
}

// launchd KeepAlive 会在进程一退出就拉起。配置错误若立刻退出，会毫秒级刷屏。
function configErrorBackoffMs() {
  const raw = process.env.HUB_CONFIG_ERROR_BACKOFF_MS;
  if (raw == null || String(raw).trim() === "") return 5000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5000;
  return Math.floor(n);
}

function readableConfigError(e, configDir) {
  const file = path.join(configDir, "node.json");
  if (e instanceof SyntaxError || e?.name === "SyntaxError") {
    const at = String(e.message).match(/position \d+ \(line \d+ column \d+\)/);
    return `${file} JSON 语法损坏${at ? "，" + at[0] : ""}`;
  }
  if (e?.code === "ENOENT") return `配置文件不可读：${e.message}`;
  return e?.message ? String(e.message) : String(e);
}

function acquireDaemonLock(configDir) {
  const lockPath = path.join(configDir, "daemon.lock");
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stat, pid;
      try {
        stat = fs.statSync(lockPath);
        pid = Number(fs.readFileSync(lockPath, "utf8").trim());
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      // 空文件可能是另一进程刚抢到锁、尚未写完；宁可拒绝启动，不误删活锁。
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`daemon 锁无有效 pid，请确认无守护进程后清理：${lockPath}`);
      }
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code !== "ESRCH") throw new Error(`daemon 锁 pid ${pid} 无法确认已退出：${e.code}`);
        try {
          if (sameFile(stat, fs.statSync(lockPath))) fs.unlinkSync(lockPath);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        continue;
      }
      throw new Error(`daemon 已在运行（pid ${pid}，锁：${lockPath}）`);
    }
    try {
      fs.writeFileSync(fd, String(process.pid) + "\n");
      const stat = fs.fstatSync(fd);
      return () => {
        try {
          if (sameFile(stat, fs.statSync(lockPath))) fs.unlinkSync(lockPath);
        } catch (e) {
          if (e.code !== "ENOENT") console.error("daemon 锁清理失败：" + e.message);
        }
      };
    } catch (e) {
      fs.unlinkSync(lockPath);
      throw e;
    } finally {
      fs.closeSync(fd);
    }
  }
  throw new Error(`daemon 锁竞争未完成，请稍后重试：${lockPath}`);
}

process.on("unhandledRejection", (e) => {
  console.error(new Date().toISOString().slice(0, 19), "unhandledRejection:", e?.message ?? e);
});

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "setup") {
  const { runSetup } = await import("../src/setup.mjs");
  process.exitCode = await runSetup(configDirFrom(rest), rest, APP_DIR);
} else if (cmd === "reconcile") {
  let role;
  try {
    role = roleForTool(rest);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  if (role === "hub") {
    console.error("lah reconcile 只支持节点一次对账；hub 请继续用 lah daemon --role hub");
    process.exitCode = 2;
  } else if (role) try {
    const cfg = loadConfig(path.resolve(configDirFrom(rest)));
    await new Kernel(cfg).run({ once: true });
  } catch (e) {
    console.error("reconcile 失败：" + e.message);
    process.exitCode = 1;
  }
} else if (cmd === "inventory") {
  try {
    const { inventory } = await import("../src/inventory.mjs");
    process.exitCode = await inventory(configDirFrom(rest));
  } catch (e) {
    console.error("inventory 失败：" + e.message);
    process.exitCode = 1;
  }
} else if (cmd === "daemon") {
  let role;
  try {
    role = roleForTool(rest);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  let release;
  let kernel = null;
  let hubRuntime = null;
  let signalCode;
  const onSignal = (signal) => {
    const code = signal === "SIGINT" ? 130 : 143;
    const ts = new Date().toISOString().slice(0, 19);
    if (signalCode != null) {
      console.error(`${ts} 再次收到 ${signal}，直接退出`);
      process.exit(code);
    }
    signalCode = code;
    if (kernel) {
      console.error(`${ts} 收到 ${signal}，正在停止并标记 offline`);
      kernel.requestStop();
      return;
    }
    if (hubRuntime) {
      console.error(`${ts} 收到 ${signal}，hub 关闭长连接并退出`);
      try { hubRuntime.stop(); }
      catch (e) { console.error(`${ts} hub 停止失败：` + (e?.message ?? e)); }
      return;
    }
    // hub 路径在 lah 里不持有 Kernel；运行时还没建好时也要能退出。
    console.error(`${ts} 收到 ${signal}，守护进程退出`);
    process.exit(code);
  };
  if (role) try {
    const configDir = path.resolve(configDirFrom(rest));
    release = acquireDaemonLock(configDir);
    process.once("exit", release);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let cfg = null;
    try {
      cfg = loadConfig(configDir);
    } catch (e) {
      const backoffMs = configErrorBackoffMs();
      const ts = new Date().toISOString().slice(0, 19);
      console.error(`${ts} 配置加载失败：${readableConfigError(e, configDir)}`);
      console.error(`守护进程将退避 ${backoffMs}ms 后以非零状态退出，避免 launchd KeepAlive 毫秒级重启刷屏。请修正配置后再启动。`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      process.exitCode = 1;
    }
    if (cfg && role === "hub") {
      const { runHub } = await import("../src/hub/index.mjs");
      await runHub(cfg, undefined, { onRuntime(rt) { hubRuntime = rt; } });
      if (signalCode != null) process.exitCode = signalCode;
    } else if (cfg) {
      kernel = new Kernel(cfg);
      await kernel.run();
      if (signalCode != null) process.exitCode = signalCode;
    }
  } catch (e) {
    console.error("daemon 启动失败：" + e.message);
    process.exitCode = 1;
  } finally {
    if (release) {
      release();
      process.removeListener("exit", release);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
} else if (cmd === "doctor") {
  let role;
  try {
    role = roleForTool(rest);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  if (role) {
    const { doctor } = await import("../src/doctor.mjs");
    let code = await doctor(configDirFrom(rest), APP_DIR, { probe: probeTargetFrom(rest), role });
    if (role === "hub") {
      const { hubDoctor } = await import("../src/hub/index.mjs");
      const extra = await hubDoctor(configDirFrom(rest));
      if (extra) code = 1;
    }
    process.exitCode = code;
  }
} else if (cmd === "host") {
  const { startCarrier } = await import("../src/carrier.mjs");
  process.exitCode = await startCarrier(configDirFrom(rest));
} else if (cmd === "service") {
  let role;
  try {
    role = roleForTool(rest);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  if (role) {
    const { service } = await import("../src/service.mjs");
    process.exitCode = await service(configDirFrom(rest), { remove: rest.includes("--remove"), role }, APP_DIR);
  }
} else if (cmd === "task") {
  const sub = rest[0];
  if (sub === "create") {
    try {
      const { parseCreateArgv, parseParams, createTask } = await import("../src/hub/create.mjs");
      const args = parseCreateArgv(rest.slice(1));
      parseParams(args.paramsRaw);
      const cfg = loadConfig(args.configDir || configDirFrom(rest));
      const taskId = await createTask({
        bus: cfg.bus,
        from: args.from || cfg.node,
        source: args.source || args.from || cfg.node,
        to: args.to,
        cap: args.cap,
        worker: args.worker,
        text: args.text,
        params: args.paramsRaw,
        context: args.context,
        ref: args.ref,
        approval: args.approval,
        idempotencyKey: args.idempotencyKey,
        validateTarget: true,
      });
      console.log(taskId);
    } catch (e) {
      console.error(e?.message ?? e);
      process.exitCode = 1;
    }
  } else if (sub === "reply") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let configDir = "";
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--config") configDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：lah task reply --task <Task_ID> --text <答复内容>");
      process.exitCode = 1;
    } else if (!text) {
      console.error("lah task reply 需要 --text <答复内容>");
      process.exitCode = 1;
    } else {
      try {
        const { f1 } = await import("../src/bus/feishu.mjs");
        const cfg = loadConfig(configDir || configDirFrom(rest));
        const tasks = await cfg.bus.listRecords(cfg.bus.tables.tasks);
        const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
        if (!task) throw new Error(`任务不存在：${taskId}`);
        const status = f1(task, "Status");
        if (status !== "input-required") {
          throw new Error(`任务当前状态为 ${status}，不是 input-required，无法答复。`);
        }
        const statusMsg = String(f1(task, "Status_Msg") ?? "").trim();
        const messages = (await cfg.bus.listRecords(cfg.bus.tables.messages))
          .filter((m) => f1(m, "Task_ID") === taskId);
        let max = 0;
        for (const m of messages) {
          const id = String(f1(m, "Msg_ID") ?? "");
          const matched = id.match(/-(\d+)$/);
          if (matched) {
            const n = Number(matched[1]);
            if (n > max) max = n;
          }
        }
        const seq = max + 1;
        const msgId = `MSG-${taskId.replace("TASK-", "")}-${String(seq).padStart(2, "0")}`;
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const nowMinute = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

        await cfg.bus.createRecord(cfg.bus.tables.messages, {
          Msg_ID: msgId,
          Task_ID: taskId,
          Context_ID: f1(task, "Context_ID"),
          From_Node: cfg.node,
          To_Node: f1(task, "Target_Node"),
          Role: "user",
          Kind: "answer",
          In_Reply_To: statusMsg,
          Created_At: nowMinute,
        });
        await cfg.bus.createRecord(cfg.bus.tables.parts, {
          Part_ID: `${msgId}-P1`,
          Parent_ID: msgId,
          Parent_Type: "message",
          Seq: 1,
          Kind: "text",
          Text: text.slice(0, 4000),
        });
        console.log(`已答复：${msgId}`);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "show") {
    const argv = rest.slice(1);
    let taskId = "";
    let configDir = "";
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--config") configDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：lah task show <Task_ID> [--config <dir>]");
      process.exitCode = 1;
    } else {
      try {
        const { f1 } = await import("../src/bus/feishu.mjs");
        const { messageText } = await import("../src/hub/cards.mjs");
        const cfg = loadConfig(configDir || configDirFrom(rest));
        const tasks = await cfg.bus.listRecords(cfg.bus.tables.tasks);
        const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
        if (!task) throw new Error(`任务不存在：${taskId}`);
        const messages = (await cfg.bus.listRecords(cfg.bus.tables.messages))
          .filter((m) => f1(m, "Task_ID") === taskId);
        const parts = await cfg.bus.listRecords(cfg.bus.tables.parts);
        const artifacts = cfg.bus.tables.artifacts
          ? (await cfg.bus.listRecords(cfg.bus.tables.artifacts)).filter((a) => f1(a, "Task_ID") === taskId)
          : [];

        const lastMsg = messages.length ? messages[messages.length - 1] : null;
        const lastMsgText = lastMsg ? messageText(parts, f1(lastMsg, "Msg_ID")) : "";

        const out = {
          task_id: taskId,
          title: f1(task, "Title"),
          status: f1(task, "Status"),
          skill_id: f1(task, "Skill_ID"),
          target_node: f1(task, "Target_Node"),
          source: f1(task, "Source"),
          status_msg: f1(task, "Status_Msg"),
          retry_count: f1(task, "Retry_Count"),
          claimed_by: f1(task, "Claimed_By"),
          last_message: lastMsg ? {
            msg_id: f1(lastMsg, "Msg_ID"),
            kind: f1(lastMsg, "Kind"),
            from: f1(lastMsg, "From_Node"),
            to: f1(lastMsg, "To_Node"),
            role: f1(lastMsg, "Role"),
            text: lastMsgText,
          } : null,
          artifacts: artifacts.map((a) => ({
            artifact_id: f1(a, "Artifact_ID"),
            name: f1(a, "Name"),
            description: f1(a, "Description"),
          })),
        };
        console.log(JSON.stringify(out, null, 2));
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "why") {
    const argv = rest.slice(1);
    let taskId = "";
    let configDir = "";
    let isJson = false;
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--config") configDir = argv[++i] ?? "";
      else if (flag === "--json") isJson = true;
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：lah task why <Task_ID> [--config <dir>] [--json]");
      process.exitCode = 1;
    } else {
      try {
        const { getTaskWhy, formatWhyText } = await import("../src/why.mjs");
        const effectiveConfigDir = configDir || configDirFrom(rest);
        const cfg = loadConfig(effectiveConfigDir);
        const data = await getTaskWhy({ bus: cfg.bus, configDir: effectiveConfigDir, taskId });
        if (isJson) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(formatWhyText(data));
        }
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "cancel") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let configDir = "";
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--config") configDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：lah task cancel --task <Task_ID> [--text <说明>] [--config <dir>]");
      process.exitCode = 1;
    } else {
      try {
        const { cancelTask } = await import("../src/hub/cancel.mjs");
        const cfg = loadConfig(configDir || configDirFrom(rest));
        // 角色只认 node.json。命令行 --role 不能把 node 提升成可撤任意单的 hub。
        const result = await cancelTask({
          bus: cfg.bus,
          node: cfg.node,
          role: cfg.role === "hub" ? "hub" : "node",
          taskId,
          text,
        });
        console.log(`已取消：${result.taskId}`);
        if (result.workingHint) console.log(result.workingHint);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "begin") {
    const { handleTaskBegin } = await import("../src/schedule-cli.mjs");
    process.exitCode = await handleTaskBegin(rest.slice(1), { configDir: configDirFrom(rest) });
  } else {
    console.error("用法：lah task create | reply | show | why | cancel | begin");
    process.exitCode = 1;
  }
} else if (cmd === "inbox") {
  const sub = rest[0];
  const configDir = configDirFrom(rest);
  if (sub === "done") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let artifact = "";
    let cfgDir = "";
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--artifact") artifact = argv[++i] ?? "";
      else if (flag === "--config") cfgDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：lah inbox done --task <Task_ID> --text <处理结果> [--artifact <路径>]");
      process.exitCode = 1;
    } else {
      try {
        const { handleInboxDone } = await import("../src/inbox.mjs");
        const cfg = loadConfig(cfgDir || configDir);
        await handleInboxDone({ configDir: cfgDir || configDir, bus: cfg.bus, node: cfg.node, taskId, text, artifact });
        console.log(`✓ 任务 ${taskId} 已完成并上报总线`);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "ask") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let cfgDir = "";
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--config") cfgDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId || !text) {
      console.error("用法：lah inbox ask --task <Task_ID> --text <需要用户/发起方补充的信息>");
      process.exitCode = 1;
    } else {
      try {
        const { handleInboxAsk } = await import("../src/inbox.mjs");
        const cfg = loadConfig(cfgDir || configDir);
        await handleInboxAsk({ configDir: cfgDir || configDir, bus: cfg.bus, node: cfg.node, taskId, text });
        console.log(`✓ 任务 ${taskId} 已转入 input-required 并向发起方提问`);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "auth") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let cfgDir = "";
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--config") cfgDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId || !text.trim()) {
      console.error("用法：lah inbox auth --task <Task_ID> --text <具体动作、对象与风险>");
      process.exitCode = 1;
    } else {
      try {
        const { handleInboxAuth } = await import("../src/inbox.mjs");
        const cfg = loadConfig(cfgDir || configDir);
        await handleInboxAuth({ configDir: cfgDir || configDir, bus: cfg.bus, node: cfg.node, taskId, text });
        console.log(`✓ 任务 ${taskId} 已请求机主批准`);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else if (sub === "fail") {
    const argv = rest.slice(1);
    let taskId = "";
    let text = "";
    let cfgDir = "";
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--task") taskId = argv[++i] ?? "";
      else if (flag === "--text") text = argv[++i] ?? "";
      else if (flag === "--config") cfgDir = argv[++i] ?? "";
      else if (!flag.startsWith("--") && !taskId) taskId = flag;
    }
    if (!taskId) {
      console.error("用法：lah inbox fail --task <Task_ID> --text <失败原因>");
      process.exitCode = 1;
    } else {
      try {
        const { handleInboxFail } = await import("../src/inbox.mjs");
        const cfg = loadConfig(cfgDir || configDir);
        await handleInboxFail({ configDir: cfgDir || configDir, bus: cfg.bus, node: cfg.node, taskId, text: text || "执行失败" });
        console.log(`✓ 任务 ${taskId} 已置 failed 并上报原因`);
      } catch (e) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    }
  } else {
    // lah inbox [--pop] [--json]
    const isPop = rest.includes("--pop");
    const isJson = rest.includes("--json");
    try {
      const { popPendingInbox, readInbox } = await import("../src/inbox.mjs");
      const items = isPop ? popPendingInbox(configDir, { pop: true }) : readInbox(configDir);
      if (isJson) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        for (const item of items) {
          console.log(JSON.stringify(item));
        }
      }
    } catch (e) {
      console.error("读取 agent_inbox.jsonl 失败：" + (e?.message ?? e));
      process.exitCode = 1;
    }
  }
} else if (cmd === "present") {
  const { handlePresentCli } = await import("../src/present-queue.mjs");
  process.exitCode = await handlePresentCli(rest, { configDir: configDirFrom(rest) });
} else if (cmd === "schedule") {
  const { handleScheduleCli } = await import("../src/schedule-cli.mjs");
  process.exitCode = await handleScheduleCli(rest, { configDir: configDirFrom(rest) });
} else if (cmd === "update") {
  const { update } = await import("../src/update.mjs");
  process.exitCode = await update(APP_DIR, {
    check: rest.includes("--check"),
    skipSkill: rest.includes("--skip-skill"),
    configDir: path.resolve(configDirFrom(rest)),
  });
} else if (cmd === "--version" || cmd === "-v") {
  console.log(DAEMON_VERSION);
} else {
  console.log(`lah ${DAEMON_VERSION}
用法：
  lah setup   [--config <dir>] [--role node|hub] [--kind host|agent] [--wake poll|event|sweep] [--skip-skill]  一键配置向导（sweep 登记 poll，间隔不超过 900 秒）
  lah daemon  [--config <dir>] [--role node|hub]  常驻守护进程（省略 --role 时读 node.json，缺省 node）
  lah reconcile [--config <dir>]  单次回表认领/对账后退出（不长驻；不停派、不改写命令表外的手工名片）
  lah inventory [--config <dir>]  只读盘点本节点名片与任务，不写入
  lah doctor  [--config <dir>] [--role node|hub] [--probe <host:port>]  本机自检
  lah service [--config <dir>] [--role node|hub]  注册开机自启（--remove 卸载）
  lah update  [--check] [--skip-skill] [--config <dir>]  自更新程序本体（git pull + 依赖重装 + 软链/Skill 补齐）
  lah host    [--config <dir>]    carrier 语境进程（在终端里常驻代跑）
  lah inbox   [--pop] [--json]    读取专属 Agent 收件箱（--pop 提取并标为 acked）
  lah inbox done --task <Task_ID> --text <处理结果> [--artifact <路径>]
  lah inbox ask  --task <Task_ID> --text <补充提问>
  lah inbox fail --task <Task_ID> --text <失败原因>
  lah inbox auth --task <Task_ID> --text <具体动作、对象与风险>
  lah task create --to <node> [--cap/--skill <cap_id>] [--text <指令>] [--from <node>] [--params <json 或 @文件>] [--idempotency-key <键>]
  lah task reply  --task <Task_ID> --text <答复内容>
  lah task show   <Task_ID>
  lah task why    <Task_ID> [--config <dir>] [--json]
  lah task cancel --task <Task_ID> [--text <说明>] [--config <dir>]
  lah task begin  --schedule <id> [--period <期次键>] [--cap <cap_id>] [--text <指令>]  Agent 定时触发（同一期次不要并发调用；建 submitted 任务由本节点守护进程认领；Agent 完成后用 lah inbox done|ask|fail 登记结果）
  lah schedule ls [--config <dir>] [--json]  列出本机定时调度计划
  lah schedule add --id <id> --cron "<五段>" --cap <cap_id> --text <指令> [--approval auto|notify|approve] [--disabled]  添加本机定时计划
  lah schedule rm <id> [--config <dir>]  删除本机计划
  lah schedule enable <id> [--config <dir>]  启用本机计划
  lah schedule disable <id> [--config <dir>]  停用本机计划
  lah schedule register --id <id> --cron "<五段>" --cap <cap_id> [--text <指令>]  登记 Agent 观察镜像（不写本机计划）
  lah present [--pop] [--task <Task_ID>] [--wait <秒>]  读取本机结果呈递队列；--wait 阻塞到出现匹配回执（超时退出码 2）；--pop 只移除本次输出的条目`);
}
