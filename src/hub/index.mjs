// hub 角色主循环：node 能力的超集（单进程承载能力登记与执行、审批发卡、结果呈递、陈旧告警）。
// 长连接走 src/transport/index.mjs 的 createWaker。调用前把 cfg.role 设为 hub，
// 工厂才会强制 ws（events:false 也不改发 poll）。本角色不接受纯轮询退路。
// SDK 只在放弃重连时才让 onStatus(false) 上来；那时停掉当前这条，退避后
// 再 connect 一次。同一时刻只留一条连接。对账间隔固定 sweepSec，不用
// waker.wait()——那条等待在长连接未就绪时会缩短成 pollSec。

import fs from "node:fs";
import path from "node:path";
import { Kernel } from "../kernel.mjs";
import { ApprovalService } from "./approval.mjs";
import { PresentService } from "./present.mjs";
import { StaleService } from "./stale.mjs";
import { ScheduleService } from "./schedule.mjs";
import { readOwnerFromConfigDir } from "./owner.mjs";

function logLine(msg) {
  console.log(new Date().toISOString().slice(0, 19), msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importWakerModule() {
  const base = new URL("../transport/index.mjs", import.meta.url);
  try {
    return await import(base.href);
  } catch (first) {
    // 失败的 import 会被 Node 缓存。文件稍后写好时，用新的 URL 再试一次。
    const bust = new URL("../transport/index.mjs", import.meta.url);
    bust.searchParams.set("hubRetry", String(Date.now()));
    try {
      return await import(bust.href);
    } catch {
      throw first;
    }
  }
}

export async function hubDoctor(configDir) {
  let problems = 0;
  const ok = (msg) => console.log("  ✓ " + msg);
  const bad = (msg) => console.log("  ✗ " + msg);
  const info = (msg) => console.log("  · " + msg);
  console.log("hub 角色检查（必须长连接，不允许纯轮询）");
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
  } catch (e) {
    bad("hub 读 node.json 失败：" + e.message);
    problems++;
  }
  let owner = "";
  try {
    owner = readOwnerFromConfigDir(configDir);
  } catch (e) {
    bad("hub 读取机主配置失败：" + e.message);
    problems++;
  }
  if (!owner) {
    bad("未配置机主 open_id（node.json 的 ownerOpenId，或环境变量 HUB_OWNER_OPEN_ID）。未配置时不发卡，审批回调一律拒绝。");
    problems++;
  } else {
    ok("机主 open_id 已配置（不显示明文）");
  }
  if (raw?.events === false) {
    bad("node.json 写了 events=false。hub 角色忽略该项：审批卡回调只能经长连接送达，不会改为纯轮询。");
    problems++;
  }
  const sweep = Number(raw?.sweepSec);
  const sweepSec = Number.isFinite(sweep) && sweep > 0 ? sweep : 900;
  info(`唤醒：长连接（表变更门铃 + card.action.trigger）＋ ${sweepSec}s 对账扫表。poll 不是 hub 的退路。`);
  try {
    const mod = await importWakerModule();
    if (typeof mod.createWaker !== "function") {
      bad("src/transport/index.mjs 未导出 createWaker。hub 收不到审批卡回调，且不会退化为纯轮询。");
      problems++;
    } else {
      ok("长连接模块 createWaker 可加载。首启失败或 SDK 放弃重连时会退避重试，同一时刻只保持一条连接");
    }
  } catch (e) {
    bad("长连接模块不可用（" + e.message + "）。hub 角色不会退化为纯轮询。");
    problems++;
  }
  try {
    const present = await import("./present.mjs");
    const stale = await import("./stale.mjs");
    const schedule = await import("./schedule.mjs");
    if (typeof present.PresentService !== "function" || typeof present.presentKey !== "function") {
      bad("结果呈递模块不可用");
      problems++;
    } else {
      ok("结果呈递：归属于本节点或主节点的任务回执（completed / failed / rejected / input-required）写入 present_queue.jsonl 原路唤醒 Agent，去重键记在 present_state.json 与线上 Metadata");
    }
    if (typeof stale.StaleService !== "function") {
      bad("陈旧告警模块不可用");
      problems++;
    } else {
      ok("陈旧告警与回收：working 心跳超过 20 分钟或为空先告警，告警后宽限 30 分钟无心跳恢复则由 hub 置 failed 回收（心跳恢复自动撤销告警）；submitted 超过 20 分钟无人认领只告警。状态在 stale_state.json");
    }
    if (typeof schedule.ScheduleService !== "function" || typeof schedule.parseCron !== "function") {
      bad("定时调度模块不可用");
      problems++;
    } else {
      ok("定时调度：全网唯一的时钟在 hub；Rules 中 Enabled=Yes 且 Schedule 非空的行即计划行，到期建 Source=cron 的任务，只补最近一期，水位线 Last_Fired 与幂等键防重复");
    }
    if (!raw?.tables?.rules) {
      info("定时调度将跳过：本配置 node.json 缺 tables.rules 映射（重跑 setup 或手动补上 Rules 表 id 后生效）");
    }
  } catch (e) {
    bad("呈递或告警模块加载失败：" + e.message);
    problems++;
  }
  try {
    fs.accessSync(configDir, fs.constants.W_OK);
    ok("配置目录可写，呈递与告警状态可以落盘");
  } catch {
    bad("配置目录不可写，呈递去重和陈旧告警无法记住已发送项");
    problems++;
  }
  info("建单：lah task create --to <node> --cap <cap_id>。先写 instruction 与 Parts，最后写 Tasks 行。doctor 不写表。");
  return problems;
}

export async function runHub(cfg, log = logLine, hooks = {}) {
  // 工厂只在 role===hub 时强制长连接。loadConfig 不带这个字段。
  cfg.role = "hub";
  let ownerOpenId = "";
  try {
    ownerOpenId = readOwnerFromConfigDir(cfg.configDir);
  } catch (e) {
    log("读取机主配置失败（进程不退出）：" + (e?.message ?? e));
  }
  if (!ownerOpenId) {
    log("hub 未配置机主 open_id。不发卡；审批回调一律拒绝。不会因此退出。");
  }
  if (cfg.events === false) {
    log("hub 角色忽略 events=false：审批卡回调只能经长连接送达，禁止退化为纯轮询。");
  }
  const approval = new ApprovalService({
    bus: cfg.bus,
    ownerOpenId,
    statePath: path.join(cfg.configDir, "approval_state.json"),
    log,
  });
  const present = new PresentService({
    bus: cfg.bus,
    ownerOpenId,
    nodeName: cfg.node,
    role: "hub",
    statePath: path.join(cfg.configDir, "present_state.json"),
    queuePath: path.join(cfg.configDir, "present_queue.jsonl"),
    log,
  });
  const stale = new StaleService({
    bus: cfg.bus,
    ownerOpenId,
    statePath: path.join(cfg.configDir, "stale_state.json"),
    log,
  });
  const schedule = new ScheduleService({ bus: cfg.bus, log });
  const runtime = new HubRuntime({ cfg, approval, present, stale, schedule, log });
  if (typeof hooks.onRuntime === "function") hooks.onRuntime(runtime);
  runtime.startWsLoop();
  await runtime.run();
}

export class HubRuntime {
  constructor({ cfg, approval, present, stale, schedule, log, createWaker, retryMs }) {
    this.cfg = cfg;
    this.approval = approval;
    this.present = present;
    this.stale = stale;
    this.schedule = schedule;
    this.log = log;
    this.createWaker = createWaker ?? null;
    this.kernel = new Kernel(this.cfg);
    const retry = Number(retryMs);
    this._retryBase = Number.isFinite(retry) && retry >= 0 ? retry : 5000;
    this._delay = this._retryBase;
    this._wakeFlag = false;
    this._wsUp = false;
    this._stopped = false;
    this._waker = null;
    this._kickTimer = null;
  }

  sweepSec() {
    const n = Number(this.cfg.sweepSec);
    return Number.isFinite(n) && n > 0 ? n : 900;
  }

  refreshOwner() {
    let owner = "";
    try {
      owner = readOwnerFromConfigDir(this.cfg.configDir);
    } catch (e) {
      this.log("读取机主配置失败：" + (e?.message ?? e));
    }
    if (this.approval) this.approval.ownerOpenId = owner;
    if (this.present) this.present.ownerOpenId = owner;
    if (this.stale) this.stale.ownerOpenId = owner;
  }

  startWsLoop() {
    this.kick(0);
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._kickTimer);
    this._kickTimer = null;
    this.closeConnection();
  }

  kick(delayMs) {
    if (this._stopped) return;
    clearTimeout(this._kickTimer);
    this._kickTimer = setTimeout(() => {
      this._kickTimer = null;
      if (this._stopped) return;
      this.openConnection().catch((e) => {
        if (this._stopped) return;
        this._wsUp = false;
        this.log("hub 长连接失败，不允许退化为纯轮询，将重试：" + (e?.message ?? e));
        const wait = this._delay;
        this._delay = Math.min(this._delay * 2, 60_000);
        this.kick(wait);
      });
    }, delayMs);
  }

  closeConnection() {
    const waker = this._waker;
    // 先摘掉引用，stop() 里若再回调 onStatus(false) 不会再开一条。
    this._waker = null;
    this._wsUp = false;
    if (this.kernel) this.kernel._wsUp = false;
    if (!waker) return;
    try { waker.stop?.(); } catch (e) {
      this.log("hub 长连接关闭失败：" + (e?.message ?? e));
    }
  }

  scheduleRetry() {
    const wait = this._delay;
    this._delay = Math.min(this._delay * 2, 60_000);
    this.kick(wait);
  }

  // 运输层把 SDK 的 onError 转成 onStatus(false)。SDK 只在不再重连时才走 onError
  // （首次连接不可恢复，或重试次数用尽）。start() 自己抛错也算没连上。
  // 这两种都不能干等，也不能再开第二条：先停掉当前实例，退避后再建一条。
  async openConnection() {
    if (this._stopped) return;
    this.closeConnection();
    this.cfg.role = "hub";
    const factory = this.createWaker ?? (await importWakerModule()).createWaker;
    if (this._stopped) return;
    if (typeof factory !== "function") throw new Error("src/transport/index.mjs 未导出 createWaker");
    let mine = null;
    const waker = await factory(this.cfg, {
      onWake: () => { this._wakeFlag = true; },
      extraHandlers: {
        "card.action.trigger": (data) => this.approval.handleCardAction(data),
      },
      onStatus: (up) => {
        if (this._stopped || !mine || this._waker !== mine) return;
        this._wsUp = !!up;
        if (this.kernel) this.kernel._wsUp = !!up;
        if (up) {
          this._delay = this._retryBase;
          this.log("hub 长连接已就绪");
          return;
        }
        this.log("hub 长连接未就绪且 SDK 不再重连。将退避后重建一条连接，不会改为纯轮询。");
        this.closeConnection();
        this.scheduleRetry();
      },
      log: (msg) => this.log(String(msg ?? "")),
    });
    if (this._stopped) {
      try { waker?.stop?.(); } catch { /* 退出时拆掉刚建的实例 */ }
      return;
    }
    if (waker?.mode !== "ws" || typeof waker.start !== "function") {
      try { waker?.stop?.(); } catch { /* 退路实例不要留着 */ }
      throw new Error(`hub 角色需要 ws 唤醒器，实际是 ${waker?.mode ?? "未知"}。拒绝改用轮询。`);
    }
    mine = waker;
    this._waker = waker;
    try {
      waker.start();
    } catch (e) {
      if (this._waker === waker) this.closeConnection();
      throw e;
    }
    if (this._waker === waker) {
      this.log(`hub 长连接已发起，card.action.trigger 已注册。对账间隔 ${this.sweepSec()}s。SDK 若放弃重连，将退避后只重建一条，不使用 pollSec。`);
    }
  }

  async waitWake() {
    // 不清 _wakeFlag。清零在扫表之前：扫表期间到达的事件要留到下一轮立刻再扫。
    // stop() 之后最多再睡 1 秒就返回，避免对账间隔（默认 15 分钟）把退出拖住。
    const maxWait = this.sweepSec() * 1000;
    let waited = 0;
    while (waited < maxWait) {
      if (this._stopped) return;
      await sleep(1000);
      waited += 1000;
      if (this._stopped) return;
      if (this._wakeFlag) {
        this.log("event: waking");
        return;
      }
    }
  }

  async run() {
    this.log(`hub daemon starting on ${this.cfg.node}（对账 ${this.sweepSec()}s，长连接必需，不使用 poll 退路；含能力登记与接单、审批、呈递、陈旧告警、定时调度）`);
    try {
      await this.cfg.bus.tenantToken();
    } catch (e) {
      this.log("initial token failed (will retry in loop): " + (e?.message ?? e));
    }
    for (;;) {
      if (this._stopped) return;
      this._wakeFlag = false;
      this.refreshOwner();
      if (!this._wsUp) {
        this.log("hub 长连接未就绪：本轮只做对账。正在按退避重建一条长连接，不会改为纯轮询，也不会同时保持两条。");
      }
      try {
        await this.kernel.sweepOnce();
      } catch (e) {
        this.log("kernel sweep error: " + (e?.message ?? e));
      }
      for (const [name, job] of [
        ["approval", () => this.approval?.scan()],
        ["present", () => this.present?.scan()],
        ["stale", () => this.stale?.scan()],
        ["schedule", () => this.schedule?.scan()],
      ]) {
        try {
          await job();
        } catch (e) {
          this.log(name + " scan failed: " + (e?.message ?? e));
        }
      }
      if (this._wakeFlag) continue;
      await this.waitWake();
    }
  }
}
