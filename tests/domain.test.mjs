// 守住域名选择：国内飞书与国际版 Lark 是两套域名。写错直接报错，不悄悄回退到飞书。
// 不发真实请求：替换全局 fetch，用例结束还原。

import assert from "node:assert/strict";
import test from "node:test";
import { FeishuBus, openHost } from "../src/bus/feishu.mjs";

test("openHost：缺省飞书，lark 走 larksuite，非法值报错", () => {
  assert.equal(openHost(undefined), "open.feishu.cn");
  assert.equal(openHost("feishu"), "open.feishu.cn");
  assert.equal(openHost("lark"), "open.larksuite.com");
  assert.throws(() => openHost("larksuite"), /domain 只能是 feishu 或 lark/);
  assert.throws(() => new FeishuBus({ appId: "a", appSecret: "b", baseToken: "c", tables: {}, domain: "x" }), /domain/);
});

test("FeishuBus 的令牌与读表请求都发往所选域名", async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const body = String(url).includes("/auth/")
      ? { code: 0, tenant_access_token: "t", expire: 7200 }
      : { code: 0, data: { items: [], has_more: false } };
    return { status: 200, json: async () => body };
  };
  try {
    const bus = new FeishuBus({ appId: "a", appSecret: "b", baseToken: "base", tables: {}, domain: "lark" });
    await bus.listRecords("tbl");
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seen.length, 2);
  for (const url of seen) assert.ok(url.startsWith("https://open.larksuite.com/open-apis/"), url);
});
