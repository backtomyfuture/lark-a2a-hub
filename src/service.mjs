// service —— 把守护进程注册为开机自启（M3）。
//   macOS：写 LaunchAgent 并 launchctl bootstrap（用户级，无需 sudo）
//   Linux：写 systemd 用户单元并 enable --now（用户级，无需 sudo）
//   Windows：写当前用户的任务计划程序任务（登录触发，无需管理员）
// --remove 反向卸载。carrier 语境进程是另一个概念（设计 §9），不在此命令内。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function nodeNameOf(configDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
    return String(raw.node || "default").replace(/[^A-Za-z0-9_.-]/g, "-");
  } catch {
    return "default";
  }
}

function roleOf(configDir, opts = {}) {
  if (opts?.role === "node" || opts?.role === "hub") return opts.role;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--role") {
      const v = process.argv[i + 1];
      if (v === "node" || v === "hub") return v;
    } else if (a.startsWith("--role=")) {
      const v = a.slice("--role=".length);
      if (v === "node" || v === "hub") return v;
    }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, "node.json"), "utf8"));
    if (raw.role === "hub" || raw.role === "node") return raw.role;
  } catch {}
  return "node";
}

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

function xmlEscape(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// systemd 按空白切 ExecStart。配置目录含空格时若不引用，--role 会被吃进路径，
// 守护进程看不到角色参数，退回默认 node，等于把 hub 覆盖成 node。
function systemdArg(value) {
  return '"' + String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

function run(cmd, args, { ignore = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (ignore) return "";
    throw new Error(`${cmd} ${args.join(" ")} 失败：${(e.stderr || e.message || "").toString().slice(0, 300)}`);
  }
}

async function checkSystemdActive(unit, isUser = true) {
  await new Promise((res) => setTimeout(res, 800));
  const args = isUser ? ["--user", "is-active", unit] : ["is-active", unit];
  try {
    const out = execFileSync("systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (out === "active" || out === "activating") {
      return { ok: true, status: out };
    }
    return { ok: false, status: out };
  } catch (e) {
    const statusOut = (e.stdout || e.stderr || "").toString().trim();
    let detail = "";
    try {
      const statusArgs = isUser ? ["--user", "status", unit, "-n", "10", "--no-pager"] : ["status", unit, "-n", "10", "--no-pager"];
      detail = execFileSync("systemctl", statusArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (err) {
      detail = (err.stdout || err.stderr || err.message || "").toString().trim();
    }
    return { ok: false, status: statusOut || "failed", detail };
  }
}

export function renderPlist({ label, appBin, configDir, role, logPath }) {
  const envEntries = [];
  const defaultPath = `${path.dirname(process.execPath)}:${path.join(os.homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const pathVal = process.env.PATH ? `${process.env.PATH}:${defaultPath}` : defaultPath;
  const uniquePath = [...new Set(pathVal.split(":").filter(Boolean))].join(":");
  envEntries.push(`<key>PATH</key><string>${xmlEscape(uniquePath)}</string>`);

  for (const k of PROXY_ENV_KEYS) {
    if (process.env[k]) {
      envEntries.push(`<key>${xmlEscape(k)}</key><string>${xmlEscape(process.env[k])}</string>`);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlEscape(label)}</string>
<key>ProgramArguments</key><array>
<string>${xmlEscape(process.execPath)}</string>
<string>${xmlEscape(appBin)}</string>
<string>daemon</string>
<string>--config</string>
<string>${xmlEscape(configDir)}</string>
<string>--role</string>
<string>${xmlEscape(role)}</string>
</array>
<key>WorkingDirectory</key><string>${xmlEscape(configDir)}</string>
<key>EnvironmentVariables</key><dict>
${envEntries.join("\n")}
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
<key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict></plist>
`;
}

export function renderSystemdUnit({ role, node, appBin, configDir, isSystem = false, user = "", home = "" }) {
  const serviceLines = [
    `ExecStart=${systemdArg(process.execPath)} ${systemdArg(appBin)} daemon --config ${systemdArg(configDir)} --role ${systemdArg(role)}`,
    `WorkingDirectory=${configDir}`,
    `Restart=on-failure`,
    `RestartSec=5`,
  ];
  if (isSystem && user) {
    serviceLines.unshift(`User=${user}`);
  }

  const envLines = [];
  if (isSystem && home) {
    envLines.push(`Environment=${systemdArg(`HOME=${home}`)}`);
  }
  if (process.env.PATH) {
    envLines.push(`Environment=${systemdArg(`PATH=${process.env.PATH}`)}`);
  }
  for (const k of PROXY_ENV_KEYS) {
    if (process.env[k]) {
      envLines.push(`Environment=${systemdArg(`${k}=${process.env[k]}`)}`);
    }
  }

  if (envLines.length) {
    serviceLines.splice(isSystem && user ? 1 : 0, 0, ...envLines);
  }

  return `[Unit]
Description=hub-node daemon (${role}: ${node})
After=network-online.target

[Service]
${serviceLines.join("\n")}

[Install]
WantedBy=${isSystem ? "multi-user.target" : "default.target"}
`;
}

// 任务名跟 LaunchAgent 标签对齐：同一配置目录可以各挂一个 node 与 hub。
export function windowsTaskName(role, node) {
  return `\\lah\\hub-node-${role}.${node}`;
}

export function windowsLegacyTaskName(node) {
  return `\\lah\\hub-node.${node}`;
}

// 登记当时的 PATH 写进启动器。登录后的计划任务拿不到「当时这个终端」的 PATH，
// 不写进去，node 和 lah 这类用户目录里的命令会找不到。
export function windowsServicePath(configDir, currentPath, execPath) {
  // 用 win32 规则切路径：这个函数的入参是 Windows 路径，测试和 CI 跑在 macOS / Linux 上。
  const extra = [path.win32.dirname(execPath), path.win32.join(configDir, "bin")];
  const cur = String(currentPath || "").split(";").filter(Boolean);
  return [...new Set([...extra, ...cur])].join(";");
}

export function windowsLauncherPath(configDir, role, node) {
  return path.join(configDir, "service", `hub-node-${role}.${node}.mjs`);
}

export function windowsStarterPath(configDir, role, node) {
  return path.join(configDir, "service", `hub-node-${role}.${node}.vbs`);
}

// 计划任务直接跑 node.exe 会弹出控制台。wscript 是窗口程序，用窗口样式 0 把 node 藏起来，
// 并等它退出，好把退出码交回任务计划程序（非 0 才按 RestartOnFailure 拉起）。
export function renderWindowsStarter({ nodeExe, launcher }) {
  const command = `"${nodeExe}" "${launcher}"`.replaceAll('"', '""');
  return `Set sh = CreateObject("Wscript.Shell")\r\nWScript.Quit sh.Run("${command}", 0, True)\r\n`;
}

// 启动器停在前台：自己负责环境变量和 daemon.log。计划任务结束时，作业对象会连带结束子进程。
export function renderWindowsLauncher(spec) {
  const payload = JSON.stringify(spec);
  return `// 由 lah service 生成。任务计划程序经 vbs 拉起本文件，本文件再拉起守护进程。
import { spawn } from "node:child_process";
import fs from "node:fs";
const spec = ${payload};
const outFd = fs.openSync(spec.logPath, "a");
const errFd = fs.openSync(spec.logPath, "a");
const child = spawn(spec.node, [spec.appBin, "daemon", "--config", spec.configDir, "--role", spec.role], {
  cwd: spec.configDir,
  env: { ...process.env, ...spec.env },
  stdio: ["ignore", outFd, errFd],
  windowsHide: true,
});
const stop = () => { try { child.kill(); } catch { /* 子进程已退出 */ } };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("error", (err) => {
  try { fs.writeSync(errFd, String(err && err.message || err) + "\\n"); } catch { /* 日志写不了也要退出，好让计划任务重拉 */ }
  process.exit(1);
});
child.on("exit", (code) => { process.exit(code == null ? 1 : code); });
`;
}

export function renderWindowsTaskXml({ starter, configDir, role, node, userId, wscript }) {
  const userLine = userId ? `\n      <UserId>${xmlEscape(userId)}</UserId>` : "";
  const args = `//B //Nologo "${starter}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`hub-node daemon (${role}: ${node})`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${userLine}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT5S</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wscript)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(configDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// schtasks /XML 认 UTF-16 LE。带 BOM，避免它把声明当成别的编码。
export function windowsTaskXmlBuffer(xml) {
  return Buffer.from(`\ufeff${xml}`, "utf16le");
}

function windowsUserId() {
  try {
    return execFileSync("whoami", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function nodeBinary() {
  try { return fs.realpathSync(process.execPath); }
  catch { return process.execPath; }
}

// 只认本仓库守护进程的命令行，避免锁文件里的 pid 被系统复用后误杀别的进程。
export function isLahDaemonCommandLine(text) {
  // 子命令必须紧跟 lah.mjs。路径里碰巧有 daemon 字样不能算。
  return /lah\.mjs["']?\s+daemon\b/.test(String(text ?? ""));
}

// 计划任务结束时，子进程有时不会跟着退出。锁里若仍是本次 lah daemon，就结束它，
// 否则重新注册会因为「daemon 已在运行」起不来。
function stopLockedDaemon(configDir) {
  let pid;
  try {
    pid = Number(fs.readFileSync(path.join(configDir, "daemon.lock"), "utf8").trim());
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let commandLine = "";
  try {
    commandLine = execFileSync(ps, [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return;
  }
  if (!isLahDaemonCommandLine(commandLine)) return;
  run("taskkill", ["/PID", String(pid), "/F"], { ignore: true });
}

// 先停用再结束再删除：进程自己退出（非 0）会触发重启，卸载时不能让它马上被拉起来。
async function stopWindowsTask(taskName) {
  run("schtasks", ["/Change", "/TN", taskName, "/DISABLE"], { ignore: true });
  const ended = run("schtasks", ["/End", "/TN", taskName], { ignore: true });
  run("schtasks", ["/Delete", "/F", "/TN", taskName], { ignore: true });
  if (ended.trim()) await new Promise((resolve) => setTimeout(resolve, 400));
}

function removeFile(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

async function registerWindowsService({ configDir, role, node, appBin, logPath, remove }) {
  const taskName = windowsTaskName(role, node);
  const legacyName = windowsLegacyTaskName(node);
  const launcher = windowsLauncherPath(configDir, role, node);
  const starter = windowsStarterPath(configDir, role, node);
  const legacyLauncher = path.join(configDir, "service", `hub-node.${node}.mjs`);
  const legacyStarter = path.join(configDir, "service", `hub-node.${node}.vbs`);

  if (remove) {
    await stopWindowsTask(taskName);
    if (legacyName !== taskName) await stopWindowsTask(legacyName);
    stopLockedDaemon(configDir);
    for (const file of [launcher, starter, legacyLauncher, legacyStarter]) removeFile(file);
    console.log(`已卸载自启：${taskName}`);
    return 0;
  }

  await stopWindowsTask(taskName);
  if (legacyName !== taskName) await stopWindowsTask(legacyName);
  stopLockedDaemon(configDir);
  removeFile(legacyLauncher);
  removeFile(legacyStarter);

  const nodeExe = nodeBinary();
  const env = { PATH: windowsServicePath(configDir, process.env.PATH, nodeExe) };
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, renderWindowsLauncher({
    node: nodeExe,
    appBin,
    configDir,
    role,
    logPath,
    env,
  }));
  fs.writeFileSync(starter, Buffer.from(`\ufeff${renderWindowsStarter({ nodeExe, launcher })}`, "utf16le"));

  const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const xml = renderWindowsTaskXml({
    starter,
    configDir,
    role,
    node,
    userId: windowsUserId(),
    wscript,
  });
  const xmlPath = path.join(os.tmpdir(), `lah-task-${process.pid}-${role}-${node}.xml`);
  try {
    fs.writeFileSync(xmlPath, windowsTaskXmlBuffer(xml));
    run("schtasks", ["/Create", "/F", "/TN", taskName, "/XML", xmlPath]);
  } finally {
    try { fs.unlinkSync(xmlPath); } catch { /* 临时 XML 删不掉不影响任务 */ }
  }
  run("schtasks", ["/Run", "/TN", taskName]);
  console.log(`自启已安装并启动：${taskName}（role: ${role}）`);
  console.log(`  任务：任务计划程序库 ${taskName}`);
  console.log(`  启动器：${launcher}`);
  console.log(`  日志：${logPath}`);
  console.log(`  卸载：lah service --remove --role ${role} --config ${configDir}`);
  return 0;
}

export async function service(configDir, { remove = false, role: explicitRole } = {}, appDir) {
  const role = roleOf(configDir, { role: explicitRole });
  const node = nodeNameOf(configDir);
  const appBin = path.join(appDir, "bin", "lah.mjs");
  const logPath = path.join(configDir, "daemon.log");

  if (process.platform === "darwin") {
    const label = `hub-node-${role}.${node}`;
    const legacyLabel = `hub-node.${node}`;
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const legacyPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${legacyLabel}.plist`);
    const uid = String(process.getuid());
    if (remove) {
      run("launchctl", ["bootout", `gui/${uid}/${label}`], { ignore: true });
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
      if (legacyPlistPath !== plistPath && fs.existsSync(legacyPlistPath)) {
        run("launchctl", ["bootout", `gui/${uid}/${legacyLabel}`], { ignore: true });
        fs.unlinkSync(legacyPlistPath);
      }
      console.log(`已卸载自启：${label}`);
      return 0;
    }
    const plist = renderPlist({ label, appBin, configDir, role, logPath });
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    run("launchctl", ["bootout", `gui/${uid}/${label}`], { ignore: true });
    run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    console.log(`自启已安装并启动：${label}（role: ${role}）`);
    console.log(`  plist：${plistPath}`);
    console.log(`  日志：${logPath}`);
    console.log(`  卸载：lah service --remove --role ${role} --config ${configDir}`);
    return 0;
  }

  if (process.platform === "linux") {
    const unit = `hub-node-${role}-${node}.service`;
    const legacyUnit = `hub-node-${node}.service`;
    const unitPath = path.join(os.homedir(), ".config", "systemd", "user", unit);
    const legacyUnitPath = path.join(os.homedir(), ".config", "systemd", "user", legacyUnit);
    const sysUnitPath = `/etc/systemd/system/${unit}`;
    const legacySysUnitPath = `/etc/systemd/system/${legacyUnit}`;
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    let hasSudo = false;
    if (!isRoot) {
      try {
        execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
        hasSudo = true;
      } catch {}
    }

    if (remove) {
      run("systemctl", ["--user", "disable", "--now", unit], { ignore: true });
      if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
      if (legacyUnitPath !== unitPath && fs.existsSync(legacyUnitPath)) {
        run("systemctl", ["--user", "disable", "--now", legacyUnit], { ignore: true });
        fs.unlinkSync(legacyUnitPath);
      }
      run("systemctl", ["--user", "daemon-reload"], { ignore: true });

      // 系统级卸载尝试
      if (isRoot) {
        run("systemctl", ["disable", "--now", unit], { ignore: true });
        if (fs.existsSync(sysUnitPath)) fs.unlinkSync(sysUnitPath);
        if (fs.existsSync(legacySysUnitPath)) fs.unlinkSync(legacySysUnitPath);
        run("systemctl", ["daemon-reload"], { ignore: true });
      } else if (hasSudo) {
        try {
          execFileSync("sudo", ["systemctl", "disable", "--now", unit], { stdio: "ignore" });
          execFileSync("sudo", ["rm", "-f", sysUnitPath, legacySysUnitPath], { stdio: "ignore" });
          execFileSync("sudo", ["systemctl", "daemon-reload"], { stdio: "ignore" });
        } catch {}
      }

      console.log(`已卸载自启：${unit}`);
      return 0;
    }

    // 检查 systemctl --user 是否真正可用
    let hasUserSession = false;
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      hasUserSession = true;
    } catch {
      hasUserSession = false;
    }

    if (hasUserSession) {
      try {
        const text = renderSystemdUnit({ role, node, appBin, configDir });
        fs.mkdirSync(path.dirname(unitPath), { recursive: true });
        fs.writeFileSync(unitPath, text);
        run("systemctl", ["--user", "daemon-reload"]);
        run("systemctl", ["--user", "enable", "--now", unit]);

        const activeCheck = await checkSystemdActive(unit, true);
        if (!activeCheck.ok) {
          console.warn(`  ! systemd 用户服务 ${unit} 启动后未能处于 active 状态（状态：${activeCheck.status}）`);
          if (activeCheck.detail) {
            console.warn(`    ${activeCheck.detail.split("\n").slice(-6).join("\n    ")}`);
          }
          run("systemctl", ["--user", "disable", "--now", unit], { ignore: true });
          hasUserSession = false;
        } else {
          console.log(`自启已安装并启动：${unit}（role: ${role}）`);
          console.log(`  单元：${unitPath}`);
          console.log(`  日志：journalctl --user -u ${unit}`);
          console.log(`  卸载：lah service --remove --role ${role} --config ${configDir}`);
          return 0;
        }
      } catch (e) {
        hasUserSession = false;
      }
    }

    // 回退路径 1：若具有 root 或免密 sudo 权限，写入系统级 systemd
    const curUser = os.userInfo().username;
    const curHome = os.homedir();
    if (isRoot || hasSudo) {
      try {
        const text = renderSystemdUnit({ role, node, appBin, configDir, isSystem: true, user: curUser, home: curHome });
        if (isRoot) {
          fs.writeFileSync(sysUnitPath, text);
          run("systemctl", ["daemon-reload"]);
          run("systemctl", ["enable", "--now", unit]);
        } else {
          const tmpUnit = path.join(os.tmpdir(), unit);
          fs.writeFileSync(tmpUnit, text);
          execFileSync("sudo", ["cp", tmpUnit, sysUnitPath]);
          fs.unlinkSync(tmpUnit);
          execFileSync("sudo", ["systemctl", "daemon-reload"]);
          execFileSync("sudo", ["systemctl", "enable", "--now", unit]);
        }

        const activeCheck = await checkSystemdActive(unit, false);
        if (!activeCheck.ok) {
          console.warn(`  ! systemd 系统服务 ${unit} 启动后未能处于 active 状态（状态：${activeCheck.status}）`);
          if (activeCheck.detail) {
            console.warn(`    ${activeCheck.detail.split("\n").slice(-6).join("\n    ")}`);
          }
          if (isRoot) {
            run("systemctl", ["disable", "--now", unit], { ignore: true });
          } else {
            try { execFileSync("sudo", ["systemctl", "disable", "--now", unit], { stdio: "ignore" }); } catch {}
          }
        } else {
          console.log(`自启已作为系统服务安装并启动：${unit}（role: ${role}）`);
          console.log(`  单元：${sysUnitPath}`);
          console.log(`  日志：journalctl -u ${unit}`);
          console.log(`  卸载：sudo systemctl disable --now ${unit} && sudo rm -f ${sysUnitPath}`);
          return 0;
        }
      } catch {}
    }

    // 回退路径 2：无 systemd user session 且无系统级权限时，以后台进程方式拉起守护，不抛错阻断 setup
    try {
      const { spawn } = await import("node:child_process");
      fs.mkdirSync(configDir, { recursive: true });
      const outFd = fs.openSync(logPath, "a");
      const child = spawn(process.execPath, [appBin, "daemon", "--config", configDir, "--role", role], {
        detached: true,
        stdio: ["ignore", outFd, outFd],
        cwd: configDir,
      });
      child.unref();
      console.log(`· 当前环境未提供 systemd user session，已后台拉起守护进程（PID: ${child.pid}）`);
      console.log(`  日志：${logPath}`);
      console.log(`  提示：若需开机自启，请由管理员以 root 权限写入 /etc/systemd/system/：`);
      console.log(`        sudo tee ${sysUnitPath} << 'EOF'`);
      console.log(renderSystemdUnit({ role, node, appBin, configDir, isSystem: true, user: curUser, home: curHome }));
      console.log(`EOF`);
      console.log(`        sudo systemctl daemon-reload && sudo systemctl enable --now ${unit}`);
      return 0;
    } catch (e) {
      console.error(`  ✗ 后台拉起守护进程失败：${e.message}`);
      return 1;
    }
  }

  if (process.platform === "win32") {
    return registerWindowsService({ configDir, role, node, appBin, logPath, remove });
  }

  console.log(`暂不支持在 ${process.platform} 上自动注册自启；请用任务计划程序手动安排：`);
  console.log(`  ${process.execPath} ${appBin} daemon --config ${configDir} --role ${role}`);
  return 1;
}
