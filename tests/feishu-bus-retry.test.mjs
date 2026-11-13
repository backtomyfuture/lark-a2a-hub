// FeishuBus 的退避与计数。替换全局 fetch，不发真实请求。
// 同一文件串行：fetch 是进程全局的，并行会互相盖掉。

import assert from "node:assert/strict";
import test from "node:test";
import { FeishuBus } from "../src/bus/feishu.mjs";
import { formatStats } from "../src/kernel-util.mjs";

const DELAYS = [0, 0, 0, 0];

function jsonRes(status, body) {
  return { status, json: async () => body };
}

function okData(data) {
  return jsonRes(200, { code: 0, data });
}

function installFetch(steps) {
  const real = globalThis.fetch;
  const calls = [];
  let apiN = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/auth/")) {
      return jsonRes(200, { code: 0, tenant_access_token: "tok", expire: 7200 });
    }
    const step = steps[apiN];
    apiN += 1;
    if (step === undefined) throw new Error(`unexpected api fetch #${apiN}`);
    if (typeof step === "function") return step(u);
    return step;
  };
  return {
    calls,
    apiCount() { return calls.filter((u) => !u.includes("/auth/")).length; },
    restore() { globalThis.fetch = real; },
  };
}

function makeBus(log, extra = {}) {
  return new FeishuBus({
    appId: "app",
    appSecret: extra.appSecret ?? "secret",
    baseToken: extra.baseToken ?? "base",
    tables: { tasks: extra.table ?? "tbl" },
    log,
    delaysMs: DELAYS,
  });
}

test.describe("飞书退避与计数", { concurrency: false }, () => {
  test("429 一次后成功：记一行退避，list=2 backoff=1", async () => {
    const logs = [];
    const fetchMock = installFetch([
      jsonRes(429, { code: 99991400 }),
      okData({ items: [{ record_id: "rec_ok" }], has_more: false }),
    ]);
    try {
      const bus = makeBus((line) => logs.push(line));
      const rows = await bus.listRecords("tbl");
      assert.deepEqual(rows, [{ record_id: "rec_ok" }]);
      const backoff = logs.filter((line) => line.includes("api backoff reason=http-429 kind=list retry=1/3"));
      assert.equal(backoff.length, 1);
      assert.deepEqual(bus.takeStats(), { list: 2, get: 0, write: 0, other: 0, backoff: 1 });
    } finally {
      fetchMock.restore();
    }
  });

  test("HTTP 200 的 1254290 会重试，不按 api code 抛出", async () => {
    const logs = [];
    const fetchMock = installFetch([
      jsonRes(200, { code: 1254290, msg: "too many" }),
      okData({ items: [], has_more: false }),
    ]);
    try {
      const bus = makeBus((line) => logs.push(line));
      const rows = await bus.listRecords("tbl");
      assert.deepEqual(rows, []);
      assert.equal(logs.filter((line) => line.includes("reason=code-1254290")).length, 1);
      assert.equal(logs.some((line) => line.includes("api code 1254290")), false);
    } finally {
      fetchMock.restore();
    }
  });

  test("1254291 写冲突按 write 退避", async () => {
    const logs = [];
    const fetchMock = installFetch([
      jsonRes(200, { code: 1254291, msg: "conflict" }),
      okData({ record: { record_id: "rec_w" } }),
    ]);
    try {
      const bus = makeBus((line) => logs.push(line));
      const res = await bus.updateRecord("tbl", "rec_w", { Status: "working" });
      assert.equal(res.record.record_id, "rec_w");
      assert.equal(logs.filter((line) => line.includes("api backoff reason=code-1254291 kind=write retry=1/3")).length, 1);
    } finally {
      fetchMock.restore();
    }
  });

  test("429 且响应体 99991403 不重试，并报月度配额", async () => {
    const logs = [];
    const fetchMock = installFetch([
      jsonRes(429, { code: 99991403, msg: "quota" }),
    ]);
    try {
      const bus = makeBus((line) => logs.push(line));
      await assert.rejects(
        () => bus.listRecords("tbl"),
        (err) => /99991403/.test(err.message) && /monthly quota exceeded/.test(err.message),
      );
      assert.equal(fetchMock.apiCount(), 1);
      assert.equal(logs.some((line) => line.includes("api backoff")), false);
    } finally {
      fetchMock.restore();
    }
  });

  test("429 的响应体不是 JSON 时仍按 http-429 重试", async () => {
    const logs = [];
    const fetchMock = installFetch([
      { status: 429, json: async () => { throw new Error("not json"); } },
      okData({ items: [{ record_id: "rec_nj" }], has_more: false }),
    ]);
    try {
      const bus = makeBus((line) => logs.push(line));
      const rows = await bus.listRecords("tbl");
      assert.deepEqual(rows, [{ record_id: "rec_nj" }]);
      assert.equal(logs.filter((line) => line.includes("reason=http-429")).length, 1);
    } finally {
      fetchMock.restore();
    }
  });

  test("502 连续四次：三次退避后抛 api retry exhausted", async () => {
    const logs = [];
    const fetchMock = installFetch([
      jsonRes(502, {}),
      jsonRes(502, {}),
      jsonRes(502, {}),
      jsonRes(502, {}),
    ]);
    try {
      const bus = makeBus((line) => logs.push(line));
      await assert.rejects(() => bus.listRecords("tbl"), /api retry exhausted/);
      const backoff = logs.filter((line) => line.includes("api backoff"));
      assert.deepEqual(backoff.map((line) => line.match(/retry=\d\/\d/)[0]), ["retry=1/3", "retry=2/3", "retry=3/3"]);
      assert.equal(fetchMock.apiCount(), 4);
    } finally {
      fetchMock.restore();
    }
  });

  test("其他业务码不重试", async () => {
    const logs = [];
    const fetchMock = installFetch([
      jsonRes(200, { code: 1254045, msg: "missing" }),
    ]);
    try {
      const bus = makeBus((line) => logs.push(line));
      await assert.rejects(() => bus.getRecord("tbl", "rec_missing"), /api code 1254045/);
      assert.equal(fetchMock.apiCount(), 1);
      assert.equal(logs.some((line) => line.includes("api backoff")), false);
    } finally {
      fetchMock.restore();
    }
  });

  test("list/get/write/other 分开计数，取走后归零", async () => {
    const logs = [];
    const fetchMock = installFetch([
      okData({ items: [{ record_id: "a" }], has_more: true, page_token: "p2" }),
      okData({ items: [{ record_id: "b" }], has_more: false }),
      okData({ record: { record_id: "rec_g" } }),
      okData({ record: { record_id: "rec_c" } }),
      okData({ record: { record_id: "rec_c" } }),
      okData({ message_id: "om_1" }),
    ]);
    try {
      const bus = makeBus((line) => logs.push(line));
      const rows = await bus.listRecords("tbl");
      assert.deepEqual(rows.map((row) => row.record_id), ["a", "b"]);
      const got = await bus.getRecord("tbl", "rec_g");
      assert.equal(got.record_id, "rec_g");
      const created = await bus.createRecord("tbl", { Task_ID: "TASK-1" });
      assert.equal(created.record.record_id, "rec_c");
      await bus.updateRecord("tbl", "rec_c", { Status: "working" });
      await bus.sendMessage("ou_x", "text", "hi");
      assert.deepEqual(bus.takeStats(), { list: 2, get: 1, write: 2, other: 1, backoff: 0 });
      assert.deepEqual(bus.takeStats(), { list: 0, get: 0, write: 0, other: 0, backoff: 0 });
      assert.equal(logs.length, 0);
    } finally {
      fetchMock.restore();
    }
  });

  test("退避日志和统计行不含凭据、token、table_id、record_id", async () => {
    const SENTINEL_BASE = "SENTINEL_BASE_9f3a";
    const SENTINEL_TABLE = "SENTINEL_TABLE_9f3a";
    const SENTINEL_SECRET = "SENTINEL_SECRET_9f3a";
    const SENTINEL_REC = "SENTINEL_REC_9f3a";
    const logs = [];
    const statsLines = [];
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${SENTINEL_BASE}/tables/${SENTINEL_TABLE}/records/${SENTINEL_REC}`;
    const fetchMock = installFetch([
      jsonRes(429, { code: 99991400 }),
      okData({ items: [], has_more: false }),
      jsonRes(429, { code: 99991403, msg: "quota" }),
      jsonRes(502, {}),
      jsonRes(502, {}),
      jsonRes(502, {}),
      jsonRes(502, {}),
      () => {
        const err = new Error("fetch failed " + url);
        err.cause = { code: "ENOTFOUND" };
        throw err;
      },
      () => {
        const err = new Error("fetch failed " + url);
        err.cause = { code: "ENOTFOUND" };
        throw err;
      },
      () => {
        const err = new Error("fetch failed " + url);
        err.cause = { code: "ENOTFOUND" };
        throw err;
      },
      () => {
        const err = new Error("fetch failed " + url);
        err.cause = { code: "ENOTFOUND" };
        throw err;
      },
    ]);
    try {
      const bus = makeBus((line) => logs.push(line), {
        appSecret: SENTINEL_SECRET,
        baseToken: SENTINEL_BASE,
        table: SENTINEL_TABLE,
      });
      await bus.listRecords(SENTINEL_TABLE);
      statsLines.push(formatStats("sweep end", 3, true, bus.takeStats()));
      await assert.rejects(() => bus.getRecord(SENTINEL_TABLE, SENTINEL_REC), /99991403/);
      statsLines.push(formatStats("sweep end", 4, false, bus.takeStats()));
      await assert.rejects(() => bus.updateRecord(SENTINEL_TABLE, SENTINEL_REC, { Status: "working" }), /api retry exhausted/);
      statsLines.push(formatStats("sweep end", 5, false, bus.takeStats()));
      await assert.rejects(() => bus.listRecords(SENTINEL_TABLE), /api retry exhausted/);
      statsLines.push(formatStats("sweep end", 6, false, bus.takeStats()));
      const text = logs.join("\n");
      assert.match(text, /reason=http-429/);
      assert.match(text, /reason=net-ENOTFOUND/);
      assert.equal(logs.filter((line) => line.includes("api backoff") && line.includes("reason=net-ENOTFOUND")).length, 3);
      for (const secret of [SENTINEL_BASE, SENTINEL_TABLE, SENTINEL_SECRET, SENTINEL_REC]) {
        assert.equal(text.includes(secret), false, secret);
        for (const line of statsLines) assert.equal(line.includes(secret), false, line);
      }
    } finally {
      fetchMock.restore();
    }
  });

  test("重试耗尽只抛归一原因，不带底层异常里的 URL", async () => {
    const SENTINEL = "SENTINEL_URL_9f3a";
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${SENTINEL}/tables/tbl/records/rec`;
    const boom = () => {
      const err = new Error("fetch failed " + url);
      err.cause = { code: "ENOTFOUND" };
      throw err;
    };
    const logs = [];
    const fetchMock = installFetch([boom, boom, boom, boom]);
    try {
      const bus = makeBus((line) => logs.push(line));
      await assert.rejects(
        () => bus.listRecords("tbl"),
        (err) => {
          assert.equal(err.message, "api retry exhausted: net-ENOTFOUND");
          assert.equal(err.message.includes(SENTINEL), false);
          assert.equal(String(err).includes(SENTINEL), false);
          return true;
        },
      );
      const text = logs.join("\n");
      assert.equal(text.includes(SENTINEL), false);
      assert.match(text, /reason=net-ENOTFOUND/);
    } finally {
      fetchMock.restore();
    }
  });
});
