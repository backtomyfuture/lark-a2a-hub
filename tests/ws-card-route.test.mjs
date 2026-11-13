// hub 注册了卡片回调就不能挂 lark-cli 本地总线。那条路径回不了 toast。

import assert from "node:assert/strict";
import test from "node:test";
import { shouldAttachLocalBus } from "../src/transport/ws.mjs";

test("注册了 card.action.trigger 时不走本地总线", () => {
  const card = { "card.action.trigger": () => {} };
  assert.equal(shouldAttachLocalBus(card, true), false);
  assert.equal(shouldAttachLocalBus(card, false), false);
  assert.equal(shouldAttachLocalBus({}, true), true);
  assert.equal(shouldAttachLocalBus({ "card.action.trigger": "nope" }, true), true);
  assert.equal(shouldAttachLocalBus(undefined, true), true);
});
