// doctor —— 节点自检：把「装完之后为什么跑不起来」变成一张清单。
// 检查 Node 版本、配置文件、凭据可达性、总线连通、能力登记与自启状态。
// 只读操作；凭据只校验存在与可用，绝不打印明文。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, DAEMON_VERSION } from "./kernel.mjs";
import { f1 } from "./bus/feishu.mjs";
import { execViaCarrier, pingCarrier } from "./carrier.mjs";

const ok = (msg) => console.log("  ✓ " + msg);
const bad = (msg) => console.log("  ✗ " + msg);
const info = (msg) => console.log("  · " + msg);

// ping 只证明本机 unix socket 上有 carrier 在听。DESIGN §9 注记④：长驻进程的
// 局域网裸 TCP 仍可能失败，所以默认报告必须把「socket 在线」和「目标可达」拆开。
const SOCKET_ONLINE = "carrier socket 在线（局域网目标可达性未验证，可加 --probe <host:port> 探测）";

function parseProbeTarget(raw) {
  const s = String(raw ?? "").trim();
  let host, portText;
  const bracket = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracket) {
    host = bracket[1];
    portText = bracket[2];
  } else {
    const i = s.lastIndexOf(":");
    if (i <= 0 || i === s.length - 1) return null;
    host = s.slice(0, i);
    portText = s.slice(i + 1);
  }
  if (!host || host.length > 253 || host.startsWith("-")) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) return null;
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

// 经 carrier 做一次只读 TCP 握手。目标只作为已校验的 argv 传入，不进 shell 元字符。
async function probeLan(socketPath, host, port) {
  const script = 'const n=require("net");const h=process.argv[1];const p=Number(process.argv[2]);const s=n.createConnection({host:h,port:p});s.setTimeout(5000,()=>{s.destroy();process.exit(2)});s.on("error",()=>process.exit(1));s.on("connect",()=>{s.end();process.exit(0)})';
  const command = `node -e '${script}' -- ${host} ${port}`;
  try {
    const r = await execViaCarrier(socketPath, { command, timeoutSec: 8 });
    if (r.code === 0) return { ok: true, detail: "" };
    const extra = (r.stderr || r.stdout || "").trim().replace(/\s+/g, " ").slice(0, 160);
    return { ok: false, detail: `退出码 ${r.code ?? "null"}${extra ? " " + extra : ""}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

function richPath() {
  // 优先尊重外部传入的 PATH（允许测试通过 PATH 模拟缺少 lark-cli）；若未设置则兜底常用路径
  if (process.env.PATH != null) return process.env.PATH;
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin"), "/usr/bin", "/bin"];
  return extra.join(path.delimiter);
}

function getLarkVersion() {
  try {
    return execFileSync("lark-cli", ["--version"], { encoding: "utf8", env: { ...process.env, PATH: richPath() } }).trim();
  } catch {
    return null;
  }
}

export async function checkAppEventSubscribed(bus, appId, eventType = "drive.file.bitable_record_changed_v1") {
  try {
    const appRes = await bus.api("GET", `/application/v6/applications/${appId}?lang=zh_cn`);
    const appData = appRes?.app ?? appRes?.data?.app;
    const onlineVersionId = appData?.online_version_id;
    if (!onlineVersionId) {
      return { ok: false, status: "unknown", reason: "未获取到线上发布版本 ID" };
    }
    const verRes = await bus.api("GET", `/application/v6/applications/${appId}/app_versions/${onlineVersionId}?lang=zh_cn`);
    const verData = verRes?.app_version ?? verRes?.data?.app_version;
    const eventInfos = verData?.event_infos;
    if (!Array.isArray(eventInfos)) {
      return { ok: false, status: "unknown", onlineVersionId, reason: "应用版本数据不含事件订阅列表" };
    }
    const subscribed = eventInfos.some((e) => e.event_type === eventType);
    if (subscribed) {
      return {
        ok: true,
        status: "subscribed",
        onlineVersionId,
        subscribed: true,
        eventInfos,
      };
    }
    return {
      ok: false,
      status: "unsubscribed",
      onlineVersionId,
      subscribed: false,
      eventInfos,
      reason: "线上版本已发布但未订阅该事件",
    };
  } catch (e) {
    const msg = e?.message || "";
    return {
      ok: false,
      status: "unknown",
      reason: `未开通应用版本查询权限或接口不可达（${msg.slice(0, 100)}）`,
    };
  }
}

// 总线契约检查：代码与标准写到的字段、选项值，必须在线上 Base 真实存在。
// 2026-11-07 两次装机瘫痪都是「代码写了 Base 没有的列」（AgentCards.Metadata、
// Runs.Status/Ended_At），运行时才爆 1254045；这里把这一类问题提前到自检阶段。
// 期望侧来自随仓库发布的 schema/base-schema.json（由 generate_schema 生成），
// 事实侧来自线上字段 API；标准声明的字段同样在 schema 里，一并覆盖。
const CONTRACT_TABLES = {
  tasks: "Tasks",
  messages: "Messages",
  parts: "Parts",
  runs: "Runs",
  artifacts: "Artifacts",
  agentCards: "AgentCards",
};
// 代码实际会写入的单选值（取自各写点的字面量）；缺登记会报 OptionNotFound 或被迫污染选项集。
const REQUIRED_OPTION_VALUES = {
  Tasks: {
    Status: ["submitted", "working", "input-required", "auth-required", "completed", "failed", "canceled", "rejected"],
    Approval_Class: ["auto", "notify", "approve"],
    Presented: ["Yes", "No"],
  },
  Messages: {
    Kind: ["instruction", "question", "answer", "auth_request", "auth_decision", "progress", "result", "notice"],
    Role: ["user", "agent"],
  },
  Parts: {
    Kind: ["text", "file", "data"],
    Parent_Type: ["message", "artifact"],
  },
  Runs: {
    Outcome: ["succeeded", "failed", "paused"],
  },
  AgentCards: {
    Availability: ["online", "offline"],
    Dispatchable: ["Yes", "No"],
    Receive_Mode: ["event", "poll", "automation"],
  },
};
// 已废弃但可能残留在选项集里的值：出现只警告，不算失败。
const DEPRECATED_OPTION_VALUES = {
  AgentCards: { Receive_Mode: ["webhook"] },
  Tasks: { Presented: ["no"] },
};

async function checkBusContract(bus, appDir, nodeName) {
  let problems = 0;
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(path.join(appDir, "schema", "base-schema.json"), "utf8"));
  } catch (e) {
    info(`契约检查跳过：读不到 schema/base-schema.json（${e.message}）`);
    return 0;
  }
  const schemaTables = new Map((schema.tables || []).map((t) => [t.name, t]));
  for (const [key, tableName] of Object.entries(CONTRACT_TABLES)) {
    const tableId = bus.tables?.[key];
    const schemaTable = schemaTables.get(tableName);
    if (!tableId || !schemaTable) continue;
    let liveFields;
    try {
      const res = await bus.api("GET", `/bitable/v1/apps/${bus.baseToken}/tables/${tableId}/fields?page_size=100`);
      liveFields = res?.data?.items || res?.items || [];
    } catch (e) {
      info(`契约检查跳过 ${tableName}：字段列表读失败（${(e?.message || "").slice(0, 80)}）`);
      continue;
    }
    const liveByName = new Map(liveFields.map((f) => [f.field_name, f]));
    const schemaNames = new Set((schemaTable.fields || []).map((f) => f.name));
    for (const name of schemaNames) {
      if (!liveByName.has(name)) {
        bad(`契约：${tableName}.${name} 在 schema 里有、线上 Base 没有（写它会报 1254045）`);
        problems++;
      }
    }
    for (const name of liveByName.keys()) {
      if (!schemaNames.has(name)) {
        info(`契约：${tableName}.${name} 线上有、schema 未登记（手工加列或 schema 过期，改表后请重跑 generate_schema）`);
      }
    }
    const required = REQUIRED_OPTION_VALUES[tableName] || {};
    for (const [field, values] of Object.entries(required)) {
      const live = liveByName.get(field);
      if (!live) continue; // 缺列已在上面报过
      const opts = new Set((live.property?.options || []).map((o) => o.name));
      if (!opts.size) continue; // 非单选或选项读不到，不下结论
      for (const v of values) {
        if (!opts.has(v)) {
          bad(`契约：${tableName}.${field} 缺选项值 ${v}（代码会写，缺登记会报 OptionNotFound）`);
          problems++;
        }
      }
    }
    // 本节点名必须在寻址类单选的选项里（历史上 Target_Node 选项缺现行节点名，靠自动新增污染选项集）
    for (const field of tableName === "Tasks" ? ["Target_Node"] : tableName === "AgentCards" ? ["Node"] : []) {
      const live = liveByName.get(field);
      const opts = new Set((live?.property?.options || []).map((o) => o.name));
      if (live && opts.size && nodeName && !opts.has(nodeName)) {
        bad(`契约：${tableName}.${field} 选项里没有本节点名 ${nodeName}`);
        problems++;
      }
    }
    const deprecated = DEPRECATED_OPTION_VALUES[tableName] || {};
    for (const [field, values] of Object.entries(deprecated)) {
      const opts = new Set((liveByName.get(field)?.property?.options || []).map((o) => o.name));
      for (const v of values) {
        if (opts.has(v)) info(`契约：${tableName}.${field} 残留已废弃选项 ${v}（建议清洗）`);
      }
    }
    for (const f of liveFields) {
      const dv = f.property?.default_value;
      if (dv !== null && dv !== undefined && dv !== "") {
        info(`契约：${tableName}.${f.field_name} 设了字段默认值（项目口径为一律不设，请核对）`);
      }
    }
  }
  if (!problems) ok("总线契约检查通过（字段存在性与代码写入的选项值均已登记）");
  return problems;
}

function roleFrom(argv, opts, raw) {
  if (opts?.role === "node" || opts?.role === "hub") return opts.role;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") {
      const v = argv[i + 1];
      if (v === "node" || v === "hub") return v;
    } else if (a.startsWith("--role=")) {
      const v = a.slice("--role=".length);
      if (v === "node" || v === "hub") return v;
    }
  }
  if (raw?.role === "hub" || raw?.role === "node") return raw.role;
  return "node";
}

export async function doctor(configDir, appDir, opts = {}) {
  let problems = 0;
  const probeProvided = opts.probe != null;
  const probe = probeProvided ? parseProbeTarget(opts.probe) : null;

  // 读取配置以辅助判断角色（若 CLI 或 opts 未显式给出）
  const nodeJsonPath = path.join(configDir, "node.json");
  let raw = null;
  let rawError = null;
  try {
    raw = JSON.parse(fs.readFileSync(nodeJsonPath, "utf8"));
  } catch (e) {
    rawError = e;
  }

  const role = roleFrom(process.argv, opts, raw);
  const kind = raw?.kind || "host";

  console.log(`lah doctor ${DAEMON_VERSION}`);
  console.log(`role: ${role}`);
  console.log(`kind: ${kind}`);
  console.log(`config dir: ${configDir}`);
  if (probeProvided && !probe) {
    bad(`--probe 需要 <host:port>（例如 192.168.1.10:22），收到：${opts.probe === "" ? "(空)" : opts.probe}`);
    problems++;
  }

  // 1. Node 版本（package.json engines: >=20）
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`node ${process.versions.node} (>= 20)`);
  else { bad(`node ${process.versions.node} 过低，需要 >= 20`); problems++; }

  // 2. 配置文件
  if (raw) {
    ok("node.json 可解析");
    const placeholder = (v) => typeof v === "string" && v.startsWith("<");
    if (!raw.node || placeholder(raw.node)) { bad("node.json 的 node 未填"); problems++; }
    if (!raw.baseToken || placeholder(raw.baseToken)) { bad("node.json 的 baseToken 未填（还是示例占位符）"); problems++; }
    for (const k of ["tasks", "messages", "parts", "runs", "artifacts", "agentCards"]) {
      if (!raw.tables?.[k] || placeholder(raw.tables[k])) { bad(`node.json 的 tables.${k} 未填`); problems++; }
    }
  } else {
    bad(`node.json 读不了：${rawError?.message ?? "文件不存在"}`);
    problems++;
  }

  try {
    const cmdsPath = path.join(configDir, "commands.json");
    if (fs.existsSync(cmdsPath)) {
      const cmds = JSON.parse(fs.readFileSync(cmdsPath, "utf8"));
      const names = Object.keys(cmds);
      if (names.length) ok(`commands.json：${names.length} 项能力（${names.join(", ")}）`);
      else info("commands.json 为空：本节点不登记任何能力，不会认领任务");
      for (const [name, entry] of Object.entries(cmds)) {
        if (!entry.command && entry.mode !== "inbox") { bad(`能力 ${name} 缺 command 模板`); problems++; }
      }
    } else if (role === "hub") {
      info("未配置 commands.json（hub 仍可承担审批/呈递，但不会认领干活任务）");
    } else {
      bad("commands.json 不存在");
      problems++;
    }
  } catch (e) {
    bad(`commands.json 读不了：${e.message}`);
    problems++;
  }

  // 3. 依赖（事件订阅用的飞书 SDK 与 CLI）
  const sdkDir = path.join(appDir, "node_modules", "@larksuiteoapi", "node-sdk");
  if (fs.existsSync(sdkDir)) ok("依赖已安装（@larksuiteoapi/node-sdk）");
  else { bad("依赖未安装：在 app 目录跑 npm install"); problems++; }

  const larkVer = getLarkVersion();
  // hub 角色强制长连接；node 角色仅在开启事件订阅（默认或显式 events: true）时才需要 lark-cli
  // 做云文档事件订阅检查与注册；纯 REST / 轮询 / 协议节点（events: false）降级为 info 提示。
  const needsLarkCli = role === "hub" || raw?.events !== false;
  if (larkVer) ok(`lark-cli 已安装（${larkVer}）`);
  else if (!needsLarkCli) {
    info("未发现 lark-cli（当前为轮询/协议节点，无需此依赖；若需长连接 ws 门铃可运行 npm install -g @larksuite/cli 安装）");
  } else {
    bad("未发现 lark-cli：请运行 npm install -g @larksuite/cli 安装");
    problems++;
  }

  // 4-6. 凭据与总线（loadConfig 成功 = 凭据齐备；再实测 token 与读表）
  let cfg = null;
  try {
    cfg = loadConfig(configDir);
    cfg.role = role;
    ok(`凭据可读（${role === "hub" ? "枢纽" : "节点"} ${cfg.node}，app_id 已配置）`);
  } catch (e) {
    bad(`凭据不可用：${e.message}`);
    problems++;
  }
  if (cfg) {
    const baseToken = cfg.bus.baseToken;
    try {
      await cfg.bus.tenantToken();
      ok("飞书 tenant token 获取成功");
    } catch (e) {
      bad(`tenant token 失败：${e.message}`);
      problems++;
    }
    try {
      const appMeta = await cfg.bus.api("GET", `/bitable/v1/apps/${baseToken}`);
      const baseName = appMeta?.app?.name || baseToken;
      ok(`Base 元数据可访问：${baseName}`);
    } catch (e) {
      const msg = e?.message || "";
      if (/403|91403|1254302|forbidden|permission/i.test(msg)) {
        bad("多维表格读写权限不足：请打开该 Base 文档右上角「分享/协作」，将应用机器人添加为「可编辑」协作者");
      } else {
        bad(`Base 元数据访问失败：${msg}`);
      }
      problems++;
    }
    try {
      const cards = await cfg.bus.listRecords(cfg.bus.tables.agentCards);
      const mine = cards.filter((r) => f1(r, "Node") === cfg.node);
      if (role === "hub") {
        ok(`AgentCards 可读：本节点已登记 ${mine.length} 项能力，总线共 ${cards.length} 项在册`);
      } else {
        ok(`AgentCards 可读：本节点已登记 ${mine.length} 项能力`);
      }
      const tasks = await cfg.bus.listRecords(cfg.bus.tables.tasks);
      ok(`Tasks 可读：共 ${tasks.length} 条`);
      problems += await checkBusContract(cfg.bus, appDir, cfg.node);
    } catch (e) {
      const msg = e?.message || "";
      if (/403|91403|1254302|forbidden|permission/i.test(msg)) {
        bad("多维表格读写权限不足：请打开该 Base 文档右上角「分享/协作」，将应用机器人添加为「可编辑」协作者");
      } else {
        bad(`读表失败：${e.message}`);
      }
      problems++;
    }
    if (role === "hub" || cfg.events === true) {
      const appEvCheck = await checkAppEventSubscribed(cfg.bus, cfg.bus.appId, "drive.file.bitable_record_changed_v1");
      if (appEvCheck.status === "subscribed") {
        ok(`应用已开启事件订阅：drive.file.bitable_record_changed_v1（线上版本 ${appEvCheck.onlineVersionId}）`);
      } else if (appEvCheck.status === "unknown") {
        info(`跳过应用静态事件列表核对（${appEvCheck.reason || "未开应用信息权限"}），以实际长连接状态为准`);
      } else {
        bad(`应用线上已发布版本未订阅事件 drive.file.bitable_record_changed_v1（${appEvCheck.reason || "未包含该事件"}）`);
        info(`请打开 https://open.feishu.cn/app/${cfg.bus.appId}/event 添加「多维表格记录变更」并发布版本，或降级为 45s 轮询模式。`);
        problems++;
      }

      let isSubscribed = false;
      let checkErr = null;
      if (!larkVer) {
        checkErr = "未发现 lark-cli";
      } else {
        try {
          const out = execFileSync("lark-cli", [
            "api", "GET", `/open-apis/drive/v1/files/${baseToken}/get_subscribe`,
            "--params", JSON.stringify({ file_type: "bitable" }),
            "--as", "user",
            "--json",
          ], { encoding: "utf8", env: { ...process.env, PATH: richPath() } });
          const parsed = JSON.parse(out);
          if (parsed?.data?.is_subscribe === true) {
            isSubscribed = true;
          } else {
            checkErr = parsed?.error?.message || parsed?.msg || (parsed?.data?.is_subscribe === false ? "is_subscribe=false" : out.trim());
          }
        } catch (e) {
          checkErr = e.message;
        }
      }

      if (isSubscribed) {
        ok("云文档事件订阅已生效（User 身份，is_subscribe=true）");
      } else {
        bad(`云文档事件订阅未生效${checkErr ? `（${checkErr}）` : ""}`);
        info(`修复命令：lark-cli api POST /open-apis/drive/v1/files/${baseToken}/subscribe --params '{"file_type":"bitable"}' --as user`);
        problems++;
      }
    } else {
      const appEvCheck = await checkAppEventSubscribed(cfg.bus, cfg.bus.appId, "drive.file.bitable_record_changed_v1");
      if (appEvCheck.status === "subscribed") {
        ok(`应用已开启事件订阅：drive.file.bitable_record_changed_v1（线上版本 ${appEvCheck.onlineVersionId}）`);
      } else if (appEvCheck.status === "unknown") {
        info(`跳过应用静态事件列表核对（${appEvCheck.reason || "未开应用信息权限"}）`);
      } else {
        info(`应用线上版本未订阅 drive.file.bitable_record_changed_v1（当前为轮询模式已忽略）`);
      }
    }
    const busSockPath = cfg.bus?.appId
      ? path.join(os.homedir(), ".lark-cli", "events", cfg.bus.appId, "bus.sock")
      : null;
    if (busSockPath && fs.existsSync(busSockPath)) {
      let busAlive = false;
      try {
        const { createConnection } = await import("node:net");
        await new Promise((resolve) => {
          const s = createConnection(busSockPath, () => {
            busAlive = true;
            s.end();
            resolve();
          });
          s.setTimeout(1500, () => { s.destroy(); resolve(); });
          s.on("error", () => resolve());
        });
      } catch { /* 忽略探测异常 */ }

      if (busAlive) {
        ok(`发现本机 lark-cli Local Event Bus 在线（${busSockPath}，事件将无缝复用该 Bus）`);
      } else {
        info(`本机 lark-cli Local Event Bus socket 存在但无法连接（${busSockPath}，事件将直连飞书 WSClient）`);
      }
    } else {
      info(`未发现本机 lark-cli Local Event Bus（${busSockPath || "~/.lark-cli/events/<appId>/bus.sock"}，事件将通过 WSClient 直连飞书）`);
    }
    if (role === "hub") {
      info(`唤醒方式：长连接（ws，表变更门铃 + card.action.trigger）＋ ${cfg.sweepSec}s 对账扫表（hub 角色强制长连接）`);
    } else if (cfg.events) {
      info(`唤醒方式：事件订阅（长连接 ws）＋ ${cfg.sweepSec}s 对账兜底`);
    } else if (cfg.pollSec >= cfg.sweepSec) {
      info(`唤醒方式：仅对账间隔 ${cfg.sweepSec}s（事件订阅已关）`);
    } else {
      info(`唤醒方式：轮询（poll）${cfg.pollSec}s（事件订阅已关）`);
    }
    // carrier 语境（设计 §9）：有 context=carrier 的能力，或显式 --probe 时才检查。
    // socket 探活成功只说明本机 carrier 在听，不宣称局域网可达。
    if (role !== "hub") {
      try {
        const cmds = JSON.parse(fs.readFileSync(path.join(configDir, "commands.json"), "utf8"));
        const carrierCaps = Object.entries(cmds).filter(([, e]) => e.context === "carrier").map(([k]) => k);
        if (carrierCaps.length || probe) {
          const online = await pingCarrier(cfg.carrierSocket);
          if (!online) {
            const caps = carrierCaps.length ? `能力 ${carrierCaps.join(", ")} 将标离线；` : "";
            const via = probe ? `无法探测 ${probe.host}:${probe.port}；` : "";
            bad(`carrier 离线：${caps}${via}请在终端里跑 lah host`);
            problems++;
          } else if (!probe) {
            ok(SOCKET_ONLINE);
            if (carrierCaps.length) info(`carrier 能力：${carrierCaps.join(", ")}`);
          } else {
            ok("carrier socket 在线，经其执行只读 TCP 探测");
            if (carrierCaps.length) info(`carrier 能力：${carrierCaps.join(", ")}`);
            const reached = await probeLan(cfg.carrierSocket, probe.host, probe.port);
            const target = `${probe.host}:${probe.port}`;
            if (reached.ok) ok(`局域网目标 ${target} 可达（经 carrier 只读 TCP 探测）`);
            else {
              bad(`局域网目标 ${target} 不可达（经 carrier 只读 TCP 探测）${reached.detail ? "：" + reached.detail : ""}`);
              problems++;
            }
          }
        }
      } catch { /* commands.json 已在前面报过 */ }
    } else if (probe) {
      const online = await pingCarrier(cfg.carrierSocket);
      if (!online) {
        bad(`carrier 离线：无法探测 ${probe.host}:${probe.port}；请在终端里跑 lah host`);
        problems++;
      } else {
        ok("carrier socket 在线，经其执行只读 TCP 探测");
        const reached = await probeLan(cfg.carrierSocket, probe.host, probe.port);
        const target = `${probe.host}:${probe.port}`;
        if (reached.ok) ok(`局域网目标 ${target} 可达（经 carrier 只读 TCP 探测）`);
        else {
          bad(`局域网目标 ${target} 不可达（经 carrier 只读 TCP 探测）${reached.detail ? "：" + reached.detail : ""}`);
          problems++;
        }
      }
    }
  }
  if (probe && !cfg) {
    bad(`无法探测 ${probe.host}:${probe.port}：配置未加载，不知道 carrier socket 路径`);
    problems++;
  }

  // 7. 自启状态（只报告，不动手）
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("launchctl", ["list"], { encoding: "utf8" });
      const mine = out.split("\n").filter((l) => l.includes("hub-node") || l.includes("agenthub"));
      if (mine.length) ok(`launchd 自启在册：${mine.map((l) => l.trim().split(/\s+/).pop()).join(", ")}`);
      else info("未发现 launchd 自启（可用 lah service 安装）");
    } else if (process.platform === "linux") {
      const units = fs.existsSync(path.join(os.homedir(), ".config/systemd/user"))
        ? fs.readdirSync(path.join(os.homedir(), ".config/systemd/user")).filter((f) => f.startsWith("hub-node"))
        : [];
      if (units.length) ok(`systemd 用户单元在册：${units.join(", ")}`);
      else info("未发现 systemd 用户单元（可用 lah service 安装）");
    }
  } catch { /* 自启状态查不到不算失败 */ }

  console.log(problems ? `doctor: ${problems} 个问题` : "doctor: 全部通过");
  return problems ? 1 : 0;
}
