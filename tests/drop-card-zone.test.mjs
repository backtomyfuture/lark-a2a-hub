// 守住名片 Zone 停写（AgentCards.Zone 与 Metadata.a2a.zone）：
// 1. kernel 登记/更新名片时不写 Zone 列，Metadata.a2a 不含 zone；
// 2. loadConfig 静默忽略旧 node.json 残留的 zone；
// 3. setup 帮助去掉 --zone，parseFlags 按未知参数忽略旧 --zone；
// 4. doctor 的 checkBusContract 在线上 Base 删掉 Zone 列前后都通过。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { f1 } from "../src/bus/feishu.mjs";
import { loadConfig } from "../src/config.mjs";
import { checkBusContract } from "../src/doctor.mjs";
import { Kernel } from "../src/kernel.mjs";
import { parseFlags, setupHelpText } from "../src/setup.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ECHO = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "src", "executors", "echo.mjs"))}`;

async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const value = await fn();
    return { value, text: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("kernel 登记的名片行不含 Zone 键且 Metadata.a2a 不含 zone", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify({
      workers: { alpha: { command: ECHO, mode: "json", name: "Alpha", desc: "甲" } },
      local: { command: ECHO, mode: "json" },
    }), { mode: 0o600 });
    const mock = new MockFeishuBus({ tables: TABLES });
    const kernel = new Kernel({
      node: "node-a",
      role: "node",
      kind: "host",
      zone: "test",
      capPrefix: "test",
      events: false,
      configDir: dir,
      bus: mock,
    });
    await kernel.run({ once: true });
    const cards = await mock.listRecords(TABLES.agentCards);
    assert.equal(cards.length, 2);
    for (const row of cards) {
      assert.equal(Object.hasOwn(row.fields, "Zone"), false, "AgentCards 行不应包含 Zone 键");
      const meta = JSON.parse(String(f1(row, "Metadata")));
      assert.equal(Object.hasOwn(meta.a2a, "zone"), false, "Metadata.a2a 不应包含 zone 键");
    }
  });
});

test("loadConfig 静默忽略旧 node.json 残留的 zone 键", async () => {
  await withTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
      node: "node-a",
      role: "node",
      zone: "home",
      appId: "cli_placeholder",
      appSecret: "secret_placeholder",
      baseToken: "bascn_placeholder",
      tables: TABLES,
    }), { mode: 0o600 });
    const { value: cfg, text } = await captureLogs(() => loadConfig(dir));
    assert.equal(Object.hasOwn(cfg, "zone"), false);
    assert.equal(text, "");
  });
});

test("setup 帮助去掉 --zone，旧 --zone 参数按未知参数忽略", () => {
  assert.equal(setupHelpText().includes("--zone"), false);
  const flags = parseFlags(["--yes", "--zone", "work", "--node", "mac-mini", "--prefix", "mini"]);
  assert.equal(flags.yes, true);
  assert.equal(flags.node, "mac-mini");
  assert.equal(flags.prefix, "mini");
  assert.equal(Object.hasOwn(flags, "zone"), false);
});

test("checkBusContract 在线上删掉 AgentCards.Zone 前后均通过", async () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "base-schema.json"), "utf8"));
  const makeBus = (dropZone) => ({
    baseToken: "bascn_test",
    tables: TABLES,
    async api(_method, apiPath) {
      const tableId = apiPath.match(/\/tables\/([^/]+)\/fields/)?.[1];
      const tableEntry = Object.entries(TABLES).find(([, id]) => id === tableId);
      const tableNameMap = {
        tasks: "Tasks",
        messages: "Messages",
        parts: "Parts",
        runs: "Runs",
        artifacts: "Artifacts",
        agentCards: "AgentCards",
      };
      const tableName = tableNameMap[tableEntry?.[0]];
      const schemaTable = schema.tables.find((t) => t.name === tableName);
      const items = schemaTable.fields
        .filter((f) => !(dropZone && tableName === "AgentCards" && f.name === "Zone"))
        .map((f) => ({
          field_name: f.name,
          property: f.options ? { options: f.options.map((name) => ({ name })) } : {},
        }));
      return { data: { items } };
    },
  });

  const before = await captureLogs(() => checkBusContract(makeBus(false), ROOT, "mac-mini"));
  assert.equal(before.value, 0, before.text);

  const after = await captureLogs(() => checkBusContract(makeBus(true), ROOT, "mac-mini"));
  assert.equal(after.value, 0, after.text);
  assert.equal(after.text.includes("AgentCards.Zone"), false);
});
