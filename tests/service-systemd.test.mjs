// systemd 单元：重启守护进程不得连带杀掉它派生的长驻进程（herdr 服务、direct 在途命令）。

import assert from "node:assert/strict";
import test from "node:test";
import { renderSystemdUnit } from "../src/service.mjs";

test("systemd 单元用 KillMode=process，用户级与系统级都一样", () => {
  for (const isSystem of [false, true]) {
    const unit = renderSystemdUnit({
      role: "node", node: "n1", appBin: "/opt/lah/bin/lah.mjs", configDir: "/home/u/.hub-node",
      isSystem, user: isSystem ? "u" : "", home: isSystem ? "/home/u" : "",
    });
    const service = unit.split("[Service]")[1].split("[Install]")[0];
    assert.match(service, /^KillMode=process$/m);
    assert.match(service, /^Restart=on-failure$/m);
  }
});
