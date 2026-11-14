// 长连接唤醒器（ws.mjs）的 SDK 参数、断连状态边界与 wait() 动态截断测试。
// 不发真实网络请求：通过注入假 WSClient 工厂与假 sleep 驱动完整生命周期。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  WS_HANDSHAKE_TIMEOUT_MS,
  WS_PING_TIMEOUT_SEC,
  buildWsClientOptions,
  createWsWaker,
} from "../src/transport/ws.mjs";
import { createWaker } from "../src/transport/index.mjs";
import { HubRuntime } from "../src/hub/index.mjs";
import { TABLES, withTemp } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

function fakeClientFactory(clients) {
  return (opts) => {
    const client = {
      opts,
      started: false,
      closed: [],
      start() {
        this.started = true;
        return Promise.resolve();
      },
      close(params) {
        this.closed.push(params ?? {});
      },
    };
    clients.push(client);
    return client;
  };
}

function fakeClock(onTick) {
  let ticks = 0;
  return {
    get ticks() { return ticks; },
    async sleep(ms) {
      assert.equal(ms, 1000);
      ticks += 1;
      await onTick?.(ticks);
    },
  };
}

test("buildWsClientOptions 携带官方 SDK 假死/握手/日志参数", () => {
  const feishu = buildWsClientOptions({ appId: "cli_1", appSecret: "sec" });
  assert.equal(feishu.domain, Lark.Domain.Feishu);
  assert.equal(feishu.loggerLevel, Lark.LoggerLevel.warn);
  assert.equal(feishu.loggerLevel, 2);
  assert.equal(feishu.handshakeTimeoutMs, WS_HANDSHAKE_TIMEOUT_MS);
  assert.deepEqual(feishu.wsConfig, { pingTimeout: WS_PING_TIMEOUT_SEC });

  const lark = buildWsClientOptions({ appId: "cli_1", appSecret: "sec", domain: "lark" });
  assert.equal(lark.domain, Lark.Domain.Lark);
});

test("onReconnecting 只降内部标志、不向调用方上抛 onStatus(false)；stop 拦住迟到回调", async () => {
  const clients = [];
  const statuses = [];
  const logs = [];
  const waker = createWaker(
    {
      role: "node",
      appId: "cli_test",
      appSecret: "sec",
      baseToken: "base",
      pollSec: 45,
      sweepSec: 900,
    },
    {
      onStatus: (up) => statuses.push(up),
      log: (msg) => logs.push(msg),
      createClient: fakeClientFactory(clients),
    },
  );

  waker.start(() => {});
  assert.equal(clients.length, 1);
  const { opts } = clients[0];

  opts.onReady();
  assert.equal(waker._wsUp, true);
  assert.deepEqual(statuses, [true]);

  // SDK 重连中：只把 waker._wsUp 降为 false，绝不上报 onStatus(false)。
  opts.onReconnecting();
  assert.equal(waker._wsUp, false);
  assert.deepEqual(statuses, [true]);
  assert.ok(logs.some((l) => l.includes("event receiver: reconnecting")));

  opts.onReconnected();
  assert.equal(waker._wsUp, true);
  assert.deepEqual(statuses, [true, true]);

  // SDK 终态放弃重连才上抛 onStatus(false)。
  opts.onError(new Error("exhausted"));
  assert.equal(waker._wsUp, false);
  assert.deepEqual(statuses, [true, true, false]);

  // stop() 之后迟到的在途握手回调不再翻回 true。
  waker.stop();
  opts.onReady();
  opts.onReconnected();
  assert.equal(waker._wsUp, false);
  assert.deepEqual(statuses, [true, true, false]);
});

test("WsWaker.wait：中途断连时本轮上限立即截断为 pollSec，且单轮只缩不涨", async () => {
  // 1) 运行至第 10 秒断连，未超过 45 秒时应等到第 45 秒结束这一轮。
  {
    const clients = [];
    let waker;
    const clock = fakeClock((tick) => {
      if (tick === 10) clients[0].opts.onReconnecting();
    });
    waker = createWsWaker(
      { role: "node", appId: "cli_1", appSecret: "sec", pollSec: 45, sweepSec: 900 },
      { sleep: clock.sleep, createClient: fakeClientFactory(clients) },
    );
    waker.start(() => {});
    clients[0].opts.onReady();
    await waker.wait(() => false);
    assert.equal(clock.ticks, 45);
    waker.stop();
  }

  // 2) 已睡到第 120 秒才断连（早已超过 45 秒），当轮在 1 秒内立即返回。
  {
    const clients = [];
    const clock = fakeClock((tick) => {
      if (tick === 120) clients[0].opts.onReconnecting();
    });
    const waker = createWsWaker(
      { role: "node", appId: "cli_1", appSecret: "sec", pollSec: 45, sweepSec: 900 },
      { sleep: clock.sleep, createClient: fakeClientFactory(clients) },
    );
    waker.start(() => {});
    clients[0].opts.onReady();
    await waker.wait(() => false);
    assert.equal(clock.ticks, 120);
    waker.stop();
  }

  // 3) 短暂断连并在同一秒内闪回重连：本轮仍以 pollSec 封顶对账，下一轮才恢复 sweepSec。
  {
    const clients = [];
    let round = 1;
    const clock = fakeClock((tick) => {
      if (round === 1 && tick === 10) {
        clients[0].opts.onReconnecting();
        clients[0].opts.onReconnected();
      }
    });
    const waker = createWsWaker(
      { role: "node", appId: "cli_1", appSecret: "sec", pollSec: 45, sweepSec: 900 },
      { sleep: clock.sleep, createClient: fakeClientFactory(clients) },
    );
    waker.start(() => {});
    clients[0].opts.onReady();
    await waker.wait(() => false);
    assert.equal(clock.ticks, 45);

    round = 2;
    const startTicks = clock.ticks;
    await waker.wait(() => false);
    assert.equal(clock.ticks - startTicks, 900);
    waker.stop();
  }

  // 4) 启动时以未就绪态进入 wait()，中途连上也不会在本轮把 45 秒拉长到 900 秒。
  {
    const clients = [];
    let round = 1;
    const clock = fakeClock((tick) => {
      if (round === 1 && tick === 3) clients[0].opts.onReady();
    });
    const waker = createWsWaker(
      { role: "node", appId: "cli_1", appSecret: "sec", pollSec: 45, sweepSec: 900 },
      { sleep: clock.sleep, createClient: fakeClientFactory(clients) },
    );
    waker.start(() => {});
    await waker.wait(() => false);
    assert.equal(clock.ticks, 45);

    round = 2;
    const startTicks = clock.ticks;
    await waker.wait(() => false);
    assert.equal(clock.ticks - startTicks, 900);
    waker.stop();
  }
});

test("WsWaker.wait：门铃文件存在时保持 sweepSec，文件变大或 stop() 立即唤醒", async () => {
  await withTemp(async (dir) => {
    const bellPath = path.join(dir, "doorbell.jsonl");
    fs.writeFileSync(bellPath, '{"init":1}\n');
    const clients = [];
    const wakes = [];
    const clock = fakeClock((tick) => {
      if (tick === 7) fs.appendFileSync(bellPath, '{"ev":2}\n');
    });
    const waker = createWsWaker(
      { role: "node", appId: "cli_1", appSecret: "sec", doorbellFile: bellPath, pollSec: 45, sweepSec: 900 },
      {
        onWake: (ev) => wakes.push(ev),
        sleep: clock.sleep,
        createClient: fakeClientFactory(clients),
      },
    );
    try {
      waker.start();
      // 门铃文件已存在时，即使长连接未就绪也按 sweepSec 等待，文件增长当拍唤醒。
      await waker.wait(() => false);
      assert.equal(clock.ticks, 7);
      assert.deepEqual(wakes, [{ source: "doorbell" }]);

      // 不变时直到 stop() 才立刻退出。
      const stopClock = fakeClock((tick) => {
        if (tick === 5) waker.stop();
      });
      waker._sleep = stopClock.sleep;
      await waker.wait(() => false);
      assert.equal(stopClock.ticks, 5);
    } finally {
      waker.stop();
    }
  });
});

test("HubRuntime：onReconnecting 不拆连接，只有终态 onError 才关闭并重建", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), "{}\n");
    const clients = [];
    const logs = [];
    const bus = new MockFeishuBus({ tables: TABLES });
    const hub = new HubRuntime({
      cfg: {
        node: "hub",
        role: "hub",
        kind: "host",
        zone: "test",
        capPrefix: "test",
        appId: "cli_hub",
        appSecret: "sec",
        baseToken: "base",
        pollSec: 45,
        sweepSec: 900,
        configDir: dir,
        carrierSocket: path.join(dir, "missing.sock"),
        bus,
      },
      retryMs: 20,
      log: (msg) => logs.push(msg),
      createWaker: (cfg, opts) => createWaker(cfg, { ...opts, createClient: fakeClientFactory(clients) }),
    });
    try {
      await hub.openConnection();
      assert.equal(clients.length, 1);
      const first = clients[0];

      first.opts.onReady();
      assert.equal(hub._wsUp, true);

      // 重连中：hub 保留原连接，不销毁也不重开第二条。
      first.opts.onReconnecting();
      assert.equal(clients.length, 1);
      assert.equal(first.closed.length, 0);

      first.opts.onReconnected();
      assert.equal(hub._wsUp, true);
      assert.equal(clients.length, 1);

      // SDK 彻底放弃（onError）：hub 才关旧连接并在退避后新建一条。
      first.opts.onError(new Error("fatal reconnect exhausted"));
      assert.equal(first.closed.length, 1);
      assert.deepEqual(first.closed[0], { force: true });
      assert.ok(logs.some((l) => l.includes("SDK 不再重连")));

      await new Promise((res) => setTimeout(res, 80));
      assert.equal(clients.length, 2);
      assert.equal(clients[1].started, true);
      clients[1].opts.onReady();
      assert.equal(hub._wsUp, true);
    } finally {
      hub.stop();
    }
  });
});
