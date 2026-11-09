// hub 的 scan() 不再按 Rules 建单。这是防双跑的回归：节点把计划镜像写进 Rules 之后，
// 旧 hub 若仍扫 Enabled=Yes 且 Schedule 非空的行，会和节点本地时钟各建一张。
// 总线是内存 mock。不读 ~/.hub-node，不连飞书。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { f1 } from "../src/bus/feishu.mjs";
import { ScheduleService } from "../src/hub/schedule.mjs";
import { withTemp, TABLES } from "./helpers.mjs";
import { MockFeishuBus } from "./mocks/mock-bus.mjs";

const tables = { ...TABLES, rules: "tbl_rules" };

test("Rules 里有启用的计划行时 hub scan 不建任务、不写 Last_Fired", async () => {
  await withTemp(async (dir) => {
    const mock = new MockFeishuBus({ tables });
    await mock.createRecord(tables.rules, {
      Rule_ID: "hub:DAILY",
      Skill_ID: "echo",
      Target_Node: "hub",
      Enabled: "Yes",
      Schedule: "0 9 * * *",
      Text: "到点跑一下",
      Last_Fired: "",
    });
    await mock.createRecord(tables.rules, {
      Rule_ID: "hub:OFF",
      Skill_ID: "echo",
      Target_Node: "hub",
      Enabled: "No",
      Schedule: "0 9 * * *",
      Text: "不该跑",
      Last_Fired: "",
    });
    await mock.createRecord(tables.agentCards, {
      Cap_ID: "CAP-hub-echo",
      Node: "hub",
      Skill_ID: "echo",
      Dispatchable: "Yes",
      Availability: "online",
    });
    const svc = new ScheduleService({
      bus: mock,
      log: () => {},
      now: () => Date.parse("2026-01-15T01:30:00.000Z"),
      tz: "Asia/Shanghai",
      statePath: path.join(dir, "schedule_state.json"),
    });

    assert.equal(await svc.scan(), 0);
    assert.equal(await svc.scan(), 0);
    assert.equal((await mock.listRecords(tables.tasks)).length, 0);
    assert.equal((await mock.listRecords(tables.messages)).length, 0);
    const rows = await mock.listRecords(tables.rules);
    for (const row of rows) assert.equal(f1(row, "Last_Fired"), "");
    assert.equal(fs.existsSync(path.join(dir, "schedule_state.json")), false);
  });
});
