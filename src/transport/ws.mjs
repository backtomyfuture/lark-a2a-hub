// ws 唤醒器：飞书 SDK 长连接订阅多维表格记录变更，只当门铃，不解析事件内容。
// 丢事件由调用方的低频对账兜底（默认 15 分钟）。门铃文件（doorbellFile）的
// 追加与「文件变大就叫醒」都在本文件，不在内核里。
//
// extraHandlers 契约（稳定，hub 依赖它收审批卡）：
//   形状是 { [事件类型]: async (data) => {} }。
//   与 bitable 变更事件一起注册进同一个 SDK EventDispatcher，从而共用一条长连接。
//   hub 角色用键 "card.action.trigger" 注册卡片回调；审批回调只能从这条长连接进来，
//   本进程不开回调地址。注册了这个键就始终走 SDK 的 WSClient，不走 lark-cli 的 bus.sock：
//   本地总线的上游收到事件就回空 200，协议里没有回复帧，卡片 toast 回不出去。
//   card.action.trigger 在总线上又是单消费者，被拒后再 fallback 自建第二条 WS，
//   会和已有连接抢投递（同一应用只随机交给一条）。
//   - 这些处理函数原样注册，本模块不包一层、也不替它们调用 onWake。
//     卡片回调要不要接着扫表，由处理函数自己决定。
//   - "drive.file.bitable_record_changed_v1" 由本模块占用为门铃。
//     extraHandlers 里若带了同名键，门铃处理完后再调用它，不会被覆盖掉。
//   - 非函数的值会跳过并记一条日志，避免一个坏配置弄断整条连接。

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";

const EVENT_TYPE = "drive.file.bitable_record_changed_v1";
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// 服务端 PingInterval 当前为 90 秒；pingTimeout 必须严格小于它，否则半开连接上每次重发 ping
// 都会重置看门狗。设为 30 秒可在最多约 120 秒（90+30）内掐断假死套接字并交给 SDK 重连。
export const WS_PING_TIMEOUT_SEC = 30;
// 与 SDK pullConnectConfig 的 15 秒 HTTP 超时对齐，防止 DNS/TLS 握手黑洞把 isConnecting 永久卡死。
export const WS_HANDSHAKE_TIMEOUT_MS = 15_000;

export function buildWsClientOptions({
  appId,
  appSecret,
  domain,
  onReady,
  onError,
  onReconnecting,
  onReconnected,
} = {}) {
  return {
    appId,
    appSecret,
    // 国际版 Lark 的长连接网关在另一套域名上，必须和读写表的域名一致。
    domain: domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
    // SDK LoggerLevel 枚举键是小写 warn=2；写成大写 WARN 会得 undefined 并回退到 info。
    loggerLevel: Lark.LoggerLevel.warn,
    handshakeTimeoutMs: WS_HANDSHAKE_TIMEOUT_MS,
    wsConfig: { pingTimeout: WS_PING_TIMEOUT_SEC },
    onReady,
    onError,
    onReconnecting,
    onReconnected,
  };
}

// 卡片回调必须能把 toast 和卡片交回飞书。本地总线做不到，所以只要注册了处理函数就不挂总线。
export function shouldAttachLocalBus(extraHandlers, sockExists) {
  if (!sockExists) return false;
  return typeof extraHandlers?.["card.action.trigger"] !== "function";
}

export function normalizeBusEvent(msg) {
  if (!msg || typeof msg !== "object") return { _source: "bus" };
  const rawPayload = msg.payload ?? msg.event ?? msg.data ?? msg;
  const payload = (rawPayload && typeof rawPayload === "object") ? rawPayload : {};
  const rawInner = payload.event ?? payload.data?.event ?? payload;
  const innerEvent = (rawInner && typeof rawInner === "object") ? { ...rawInner } : {};
  const header = payload.header ?? msg.header ?? innerEvent.header ?? {};

  const operator = innerEvent.operator ?? payload.operator ?? msg.operator;
  if (operator && !innerEvent.operator) innerEvent.operator = operator;
  const action = innerEvent.action ?? payload.action ?? msg.action;
  if (action && !innerEvent.action) innerEvent.action = action;

  return {
    ...msg,
    ...payload,
    event: innerEvent,
    header,
    _source: "bus",
  };
}

export class FeishuEventReceiver {
  constructor({
    appId,
    appSecret,
    baseToken,
    domain,
    doorbellFile,
    onEvent,
    onStatus,
    onReconnecting,
    log,
    extraHandlers,
    createClient,
  }) {
    this.domain = domain;
    this.baseToken = baseToken;
    this.doorbellFile = doorbellFile;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onReconnecting = onReconnecting;
    this.log = log ?? (() => {});
    this.appId = appId;
    this.appSecret = appSecret;
    this.extraHandlers = extraHandlers ?? {};
    this._createClient = createClient ?? ((opts) => new Lark.WSClient(opts));
    this._stopped = false;
    this.ws = null;
    this.busSockets = [];
    this.busLogTimer = null;
    this.usingLocalBus = false;
    this.busConnected = false;
  }

  handle(data) {
    if (this._stopped) return;
    const ev = data?.event ?? data?.payload ?? data ?? {};
    const fileToken = ev.file_token ?? ev.fileToken;
    if (fileToken && this.baseToken && fileToken !== this.baseToken) return;
    if (this.doorbellFile) {
      try {
        const rec = { ts: new Date().toISOString(), type: EVENT_TYPE, event: ev };
        fs.appendFileSync(this.doorbellFile, JSON.stringify(rec) + "\n");
      } catch (e) {
        this.log("doorbell append failed: " + e.message);
      }
    }
    this.onEvent?.();
  }

  _cleanupBusSockets() {
    if (this.busLogTimer) {
      clearInterval(this.busLogTimer);
      this.busLogTimer = null;
    }
    for (const sock of this.busSockets) {
      try {
        sock.removeAllListeners();
        sock.destroy();
      } catch { /* 忽略 */ }
    }
    this.busSockets = [];
  }

  _subscribedKeys() {
    const keys = [EVENT_TYPE];
    for (const [key, fn] of Object.entries(this.extraHandlers)) {
      if (typeof fn === "function" && !keys.includes(key)) {
        keys.push(key);
      }
    }
    return keys;
  }

  _dispatchBusEvent(key) {
    if (this._stopped || key !== EVENT_TYPE) return;
    this.handle({ type: EVENT_TYPE, event: { file_token: this.baseToken }, _source: "bus_log" });
    if (typeof this.extraHandlers[EVENT_TYPE] === "function") {
      Promise.resolve(this.extraHandlers[EVENT_TYPE]({ type: EVENT_TYPE, _source: "bus_log" })).catch((e) => {
        this.log(`event receiver: extraHandler ${EVENT_TYPE} error: ${e?.message ?? e}`);
      });
    }
  }

  _startBusLogMonitor(busSockPath) {
    if (this.busLogTimer) {
      clearInterval(this.busLogTimer);
      this.busLogTimer = null;
    }
    const logPath = path.join(path.dirname(busSockPath), "bus.log");
    let offset = 0;
    try {
      if (fs.existsSync(logPath)) {
        offset = fs.statSync(logPath).size;
      }
    } catch { /* 忽略 */ }

    const seenMsgIds = new Set();
    let lastThrottledTime = 0;

    this.busLogTimer = setInterval(() => {
      if (this._stopped || !this.usingLocalBus) return;
      try {
        if (!fs.existsSync(logPath)) return;
        const st = fs.statSync(logPath);
        if (st.size < offset) {
          offset = st.size;
          return;
        }
        if (st.size === offset) return;

        const readLen = st.size - offset;
        const buf = Buffer.alloc(readLen);
        const fd = fs.openSync(logPath, "r");
        try {
          fs.readSync(fd, buf, 0, readLen, offset);
        } finally {
          fs.closeSync(fd);
        }
        offset = st.size;

        const chunk = buf.toString("utf8");
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (!line) continue;
          if (line.includes(EVENT_TYPE)) {
            const m = line.match(/message_id:\s*([0-9a-zA-Z-]+)/);
            if (m) {
              const msgId = m[1];
              if (seenMsgIds.has(msgId)) {
                continue;
              }
              seenMsgIds.add(msgId);
              if (seenMsgIds.size > 2000) {
                const arr = [...seenMsgIds].slice(-1000);
                seenMsgIds.clear();
                for (const id of arr) seenMsgIds.add(id);
              }
              this.log(`event receiver [bus.log]: detected ${EVENT_TYPE} (msg_id: ${msgId})`);
              this._dispatchBusEvent(EVENT_TYPE);
            } else {
              const now = Date.now();
              if (now - lastThrottledTime >= 3000) {
                lastThrottledTime = now;
                this.log(`event receiver [bus.log]: detected ${EVENT_TYPE} (throttled)`);
                this._dispatchBusEvent(EVENT_TYPE);
              }
            }
          }
        }
      } catch {
        // 忽略单次读取异常
      }
    }, 1000);
  }

  _connectLocalBus(busSockPath) {
    this.usingLocalBus = true;
    this.busSockets = [];
    let hasReportedReady = false;
    let fallbackTriggered = false;

    const triggerFallback = (reason) => {
      if (this._stopped || fallbackTriggered) return;
      fallbackTriggered = true;
      const wasConnected = this.busConnected;
      this.usingLocalBus = false;
      this.busConnected = false;
      if (wasConnected) {
        this.onStatus?.(false);
      }
      this.log(`event receiver: local bus unavailable (${reason}), falling back to direct ws`);
      this._cleanupBusSockets();
      this._startWsClient();
    };

    this._startBusLogMonitor(busSockPath);

    const keys = this._subscribedKeys();
    for (const key of keys) {
      if (this._stopped || fallbackTriggered) break;
      let buf = "";
      let sock;
      try {
        sock = net.createConnection(busSockPath);
      } catch (e) {
        triggerFallback(`createConnection error: ${e.message}`);
        break;
      }
      this.busSockets.push(sock);

      sock.setTimeout(5000);
      sock.on("timeout", () => {
        sock.destroy();
        triggerFallback(`connection timeout for ${key}`);
      });

      sock.on("connect", () => {
        sock.setTimeout(0);
        const handshake = JSON.stringify({
          type: "hello",
          pid: process.pid,
          event_key: key,
          subscription_id: key,
          event_types: [key],
        }) + "\n";
        sock.write(handshake);
      });

      sock.on("data", (chunk) => {
        if (this._stopped) return;
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "hello_ack") {
              if (key === "card.action.trigger") {
                this.log("event receiver: card.action.trigger 出现在本地总线上，返回值到不了飞书。hub 不应走这条路径");
              }
              if (!hasReportedReady) {
                hasReportedReady = true;
                this.busConnected = true;
                this.log("event receiver: attached to local lark-cli event bus");
                this.onStatus?.(true);
              }
            } else if (msg.type === "event") {
              const payload = normalizeBusEvent(msg);
              if (key === EVENT_TYPE) {
                this.handle(payload);
                if (typeof this.extraHandlers[EVENT_TYPE] === "function") {
                  // 本地总线没有「把处理结果回给飞书」的帧，返回值只能丢掉。
                  Promise.resolve(this.extraHandlers[EVENT_TYPE](payload)).catch((e) => {
                    this.log(`event receiver: extraHandler ${EVENT_TYPE} error: ${e?.message ?? e}`);
                  });
                }
              } else if (typeof this.extraHandlers[key] === "function") {
                // card.action.trigger 同样回不出去。hub 已改为不走总线，这里只是兜底。
                Promise.resolve(this.extraHandlers[key](payload)).catch((e) => {
                  this.log(`event receiver: extraHandler ${key} error: ${e?.message ?? e}`);
                });
              }
            }
          } catch (e) {
            this.log(`event receiver: parse frame error: ${e.message}`);
          }
        }
      });

      sock.on("error", (err) => {
        if (this._stopped) return;
        triggerFallback(`socket error on ${key}: ${err.message}`);
      });

      sock.on("close", () => {
        if (this._stopped) return;
        triggerFallback(`socket closed for ${key}`);
      });
    }
  }

  _startWsClient() {
    this._cleanupBusSockets();
    this.usingLocalBus = false;
    if (this._stopped || this.ws) return;
    const handles = {};
    for (const [key, fn] of Object.entries(this.extraHandlers)) {
      if (typeof fn === "function") {
        handles[key] = (data) => {
          const wrapped = (data && typeof data === "object") ? { ...data, _source: "ws" } : data;
          return fn(wrapped);
        };
      } else {
        this.log(`event receiver: ignore extra handler ${key} (not a function)`);
      }
    }
    // 门铃后写。同名键先留给上面的用户函数，再包一层，避免 register 的覆盖警告把门铃弄丢。
    const userBitable = handles[EVENT_TYPE];
    handles[EVENT_TYPE] = async (data) => {
      const wrapped = (data && typeof data === "object") ? { ...data, _source: "ws" } : data;
      this.handle(wrapped);
      if (typeof userBitable === "function") await userBitable(wrapped);
    };
    const dispatcher = new Lark.EventDispatcher({}).register(handles);
    let ws = null;
    const isAlive = () => !this._stopped && (this.ws === null || this.ws === ws);
    ws = this._createClient(buildWsClientOptions({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      onReady: () => {
        if (!isAlive()) return;
        this.log("event receiver: ws connected");
        this.onStatus?.(true);
      },
      onError: (err) => {
        if (!isAlive()) return;
        this.log("event receiver: ws error " + (err?.message ?? err));
        this.onStatus?.(false);
      },
      onReconnecting: () => {
        if (!isAlive()) return;
        this.log("event receiver: reconnecting");
        this.onReconnecting?.();
      },
      onReconnected: () => {
        if (!isAlive()) return;
        this.log("event receiver: reconnected");
        this.onStatus?.(true);
      },
    }));
    this.ws = ws;
    // SDK 1.76.0 的 start() 同步调起 reConnect(true) 后就会 resolve，不会等连接关闭。
    Promise.resolve(ws.start({ eventDispatcher: dispatcher })).catch((e) => {
      if (!isAlive()) return;
      this.log("event receiver: start failed " + e.message);
      this.onStatus?.(false);
    });
  }

  start() {
    this._stopped = false;
    this.usingLocalBus = false;
    this.busConnected = false;

    const busSockPath = this.appId
      ? path.join(os.homedir(), ".lark-cli", "events", this.appId, "bus.sock")
      : null;

    const sockExists = !!(busSockPath && fs.existsSync(busSockPath));
    if (shouldAttachLocalBus(this.extraHandlers, sockExists)) {
      this._connectLocalBus(busSockPath);
    } else {
      if (sockExists) {
        this.log("event receiver: 已注册 card.action.trigger，不走本地总线，改走 WSClient。同一 appId 不要再被 lark-cli event consume 或其他进程占用长连接。");
      }
      this._startWsClient();
    }
  }

  stop() {
    this._stopped = true;
    this.usingLocalBus = false;
    this.busConnected = false;
    this._cleanupBusSockets();
    const ws = this.ws;
    this.ws = null;
    if (!ws?.close) return;
    try {
      // force 走 terminate，避免半开握手的 error 事件把进程打崩，也避免 ping 定时器挂住事件循环。
      ws.close({ force: true });
    } catch (e) {
      this.log("event receiver: stop failed " + e.message);
    }
  }
}

export function createWsWaker(cfg, opts = {}) {
  return new WsWaker(cfg, opts);
}

class WsWaker {
  constructor(cfg, { onWake, extraHandlers, log, onStatus, sleep: sleepFn, createClient } = {}) {
    this.mode = "ws";
    this.cfg = cfg ?? {};
    this.onWake = onWake;
    this.extraHandlers = extraHandlers ?? {};
    this.log = log ?? (() => {});
    this.onStatus = onStatus;
    this._sleep = sleepFn ?? sleep;
    this._createClient = createClient;
    this._wsUp = false;
    this._disconnectEpoch = 0;
    this._stopped = false;
    this._started = false;
    this.receiver = null;
  }

  start(onWake) {
    if (typeof onWake === "function") this.onWake = onWake;
    if (this._started) return;
    this._started = true;
    this._stopped = false;
    // hub 必须连着；node 在 events 不为 false 时才连。纯门铃（events 关、但有门铃文件）只盯文件。
    const connect = this.cfg.role === "hub" || this.cfg.events !== false;
    if (!connect) return;
    // 凭据挂在总线上（loadConfig 的回传对象不另抄一份）。直接构造时也可放在 cfg 上。
    const bus = this.cfg.bus ?? {};
    this.receiver = new FeishuEventReceiver({
      appId: this.cfg.appId ?? bus.appId,
      appSecret: this.cfg.appSecret ?? bus.appSecret,
      baseToken: this.cfg.baseToken ?? bus.baseToken,
      domain: this.cfg.domain ?? bus.domain,
      doorbellFile: this.cfg.doorbellFile,
      extraHandlers: this.extraHandlers,
      createClient: this._createClient,
      onEvent: () => {
        if (this._stopped) return;
        this.onWake?.({ source: "event" });
      },
      onStatus: (up) => {
        if (this._stopped) return;
        if (!up && this._wsUp) this._disconnectEpoch += 1;
        this._wsUp = up;
        this.onStatus?.(up);
      },
      onReconnecting: () => {
        if (this._stopped) return;
        // 重连中只降本地等待上限，不向调用方上报 onStatus(false)，
        // 避免 hub 误判为「SDK 已放弃重连」而强拆正在自愈的实例。
        this._disconnectEpoch += 1;
        this._wsUp = false;
      },
      log: this.log,
    });
    this.receiver.start();
  }

  stop() {
    this._stopped = true;
    this._started = false;
    if (this._wsUp) {
      this._wsUp = false;
      this.onStatus?.(false);
    }
    this.receiver?.stop();
    this.receiver = null;
  }

  _doorbellSize() {
    if (!this.cfg.doorbellFile) return -1;
    try { return fs.statSync(this.cfg.doorbellFile).size; } catch { return -1; }
  }

  _waitCapMs(doorbellStart, disconnectEpoch) {
    // 只要本轮等待中发生过断连，即使 1 秒内秒级重连成功也不把上限拉回 sweepSec，
    // 避免断线窗口内漏掉的非补发事件被迫等到下一轮 900 秒对账。
    const healthyWs = this._wsUp && this._disconnectEpoch === disconnectEpoch;
    const eventDriven = healthyWs || doorbellStart >= 0;
    return (eventDriven ? this.cfg.sweepSec : this.cfg.pollSec) * 1000;
  }

  // 与原 waitWake 同一节奏：先睡 1 秒再看标志；每轮重新评估长连接状态，且上限只缩不涨。
  // 不在这里清标志。门铃变大时补一次 onWake，让不走 wait() 的调用方也能收到。
  async wait(isAwake) {
    const start = this._doorbellSize();
    const disconnectEpoch = this._disconnectEpoch;
    let maxWait = this._waitCapMs(start, disconnectEpoch);
    let waited = 0;
    while (waited < maxWait) {
      if (this._stopped) return;
      await this._sleep(1000);
      waited += 1000;
      maxWait = Math.min(maxWait, this._waitCapMs(start, disconnectEpoch));
      if (this._stopped) return;
      if (isAwake?.()) {
        this.log("event: waking");
        return;
      }
      if (this.cfg.doorbellFile && this._doorbellSize() !== start) {
        this.onWake?.({ source: "doorbell" });
        this.log("doorbell: event arrived, waking");
        return;
      }
    }
  }
}
