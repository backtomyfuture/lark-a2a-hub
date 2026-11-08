// Windows 自启不在这台机器上调用 schtasks。这里锁住任务 XML、隐藏启动器和守护启动器的形状，
// 避免登录触发、免管理员、不限时长、日志重定向这些约束在改 service 时丢。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import {
  isLahDaemonCommandLine,
  renderWindowsLauncher,
  renderWindowsStarter,
  renderWindowsTaskXml,
  windowsLegacyTaskName,
  windowsServicePath,
  windowsTaskName,
  windowsTaskXmlBuffer,
} from "../src/service.mjs";
import { withTemp } from "./helpers.mjs";

test("结束残留守护进程时只认 lah daemon 的命令行", () => {
  assert.equal(isLahDaemonCommandLine("node.exe C:\\app\\bin\\lah.mjs daemon --config C:\\cfg --role hub"), true);
  assert.equal(isLahDaemonCommandLine("node.exe C:\\app\\bin\\lah.mjs doctor"), false);
  assert.equal(isLahDaemonCommandLine("node.exe C:\\daemon\\lah.mjs doctor"), false);
  assert.equal(isLahDaemonCommandLine("notepad.exe"), false);
});

test("Windows 任务名按角色分开，并保留旧名字供卸载", () => {
  assert.equal(windowsTaskName("hub", "desk"), "\\lah\\hub-node-hub.desk");
  assert.equal(windowsTaskName("node", "desk"), "\\lah\\hub-node-node.desk");
  assert.equal(windowsLegacyTaskName("desk"), "\\lah\\hub-node.desk");
});

test("Windows PATH 把 node 与配置目录 bin 放在前面且去重", () => {
  const got = windowsServicePath("C:\\Users\\a\\.hub-node", "C:\\Windows;C:\\node", "C:\\node\\node.exe");
  assert.equal(got, "C:\\node;C:\\Users\\a\\.hub-node\\bin;C:\\Windows");
});

test("Windows 任务 XML 是当前用户登录触发，不存密码，不因电池或 72 小时被杀掉", () => {
  const xml = renderWindowsTaskXml({
    starter: "C:\\Users\\a & b\\.hub-node\\service\\hub-node-node.desk.vbs",
    configDir: "C:\\Users\\a & b\\.hub-node",
    role: "node",
    node: "desk",
    userId: "DESKTOP\\a<b>",
    wscript: "C:\\Windows\\System32\\wscript.exe",
  });
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Interval>PT5S<\/Interval>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<UserId>DESKTOP\\a&lt;b&gt;<\/UserId>/);
  assert.match(xml, /a &amp; b/);
  assert.doesNotMatch(xml, /<Password/);
  assert.doesNotMatch(xml, /HighestAvailable/);
  assert.doesNotMatch(xml, /<Principal[^>]*>[\s\S]*<UserId>/);
  const buf = windowsTaskXmlBuffer(xml);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xfe);
  assert.match(buf.slice(2).toString("utf16le"), /LogonTrigger/);
});

test("Windows 启动器隐藏控制台，守护启动器把日志送进 daemon.log 且能被 node 解析", async () => {
  const starter = renderWindowsStarter({
    nodeExe: "C:\\Program Files\\nodejs\\node.exe",
    launcher: "C:\\Users\\张三\\.hub-node\\service\\hub-node-hub.desk.mjs",
  });
  assert.match(starter, /WScript\.Quit sh\.Run\(/);
  assert.match(starter, /, 0, True\)/);
  assert.match(starter, /张三/);

  const source = renderWindowsLauncher({
    node: "C:\\Program Files\\nodejs\\node.exe",
    appBin: "C:\\Users\\张三\\.hub-node\\app\\bin\\lah.mjs",
    configDir: "C:\\Users\\张三\\.hub-node",
    role: "hub",
    logPath: "C:\\Users\\张三\\.hub-node\\daemon.log",
    env: { PATH: "C:\\node;C:\\Users\\张三\\.hub-node\\bin", HTTPS_PROXY: "http://127.0.0.1:7890" },
  });
  assert.match(source, /windowsHide: true/);
  assert.match(source, /daemon", "--config"/);
  assert.match(source, /HTTPS_PROXY/);
  await withTemp(async (dir) => {
    const file = `${dir}/launcher.mjs`;
    fs.writeFileSync(file, source);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  });
});
