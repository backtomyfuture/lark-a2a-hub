// lah update —— 自更新程序本体。
// 等价于重跑 install.sh 的「更新已有安装」分支：git pull + 依赖重装 +
// 软链补齐 + Skill 重拷，但不碰配置目录里的任何文件。
// 只支持 git 检出（install.sh 装出来的就是）：tarball 装的没有 .git，
// 让用户重跑 install.sh，而不是在这里再实现一遍下载解包。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// git / npm 输出直接透传：npm ci 可能要几分钟，静默会像卡死。
function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function capture(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

function readAppVersion(appDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

// 软链只在缺失时补建、指向别处时警告：install.sh 的软链指向 $APP/bin/，
// git pull 后路径不变，本来就不用刷新；指向别处说明用户自管入口，不抢。
function ensureSymlink(target, link) {
  const name = path.basename(link);
  try {
    const cur = fs.readlinkSync(link);
    if (path.resolve(path.dirname(link), cur) === target) return "ok";
    return "other";
  } catch (e) {
    if (e.code === "ENOENT") return "missing";
    if (e.code === "EINVAL") return "other"; // 已存在但不是软链
    throw e;
  }
}

function ensureEntrySymlinks(appDir) {
  const binDir = path.join(os.homedir(), ".local", "bin");
  const entry = path.join(appDir, "bin", "lah.mjs");
  for (const name of ["lah", "hub-node"]) {
    const link = path.join(binDir, name);
    const state = ensureSymlink(entry, link);
    if (state === "missing") {
      fs.mkdirSync(binDir, { recursive: true });
      fs.symlinkSync(entry, link);
      console.log(`  ✓ 已补建软链 ${link}`);
    } else if (state === "other") {
      console.log(`  · ${link} 未指向本次安装，保持不动`);
    }
  }
}

function refreshSkill(appDir, skip) {
  if (skip) {
    console.log("  · 跳过 lah Skill 更新（--skip-skill）");
    return;
  }
  try {
    const src = path.join(appDir, "skills", "lah", "SKILL.md");
    if (!fs.existsSync(src)) return;
    const destDir = path.join(os.homedir(), ".agents", "skills", "lah");
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, "SKILL.md"));
    console.log(`  ✓ 已更新 lah Skill 至 ${path.join(destDir, "SKILL.md")}`);
  } catch (e) {
    console.log(`  · lah Skill 更新跳过：${e.message}`);
  }
}

// 守护进程还在跑时只提示、不强杀：进程退出是用户的决定，杀掉可能打断在途任务。
function daemonHint(configDir) {
  try {
    const pid = Number(fs.readFileSync(path.join(configDir, "daemon.lock"), "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      process.kill(pid, 0);
      console.log(`  · 守护进程仍在运行（pid ${pid}），新版本要等重启后才生效`);
    }
  } catch {
    /* 没在跑或读不到锁，都不用提示 */
  }
}

export async function update(appDir, { check = false, skipSkill = false, configDir = "" } = {}) {
  if (!fs.existsSync(path.join(appDir, ".git"))) {
    console.error(`当前程序不是 git 检出（${appDir}），无法自动更新；请重跑 install.sh。`);
    return 1;
  }

  const before = readAppVersion(appDir);

  // 跟当前分支走：install.sh 装的是 main，仓库检出可能停在别的分支，不写死。
  let branch;
  try {
    branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], appDir);
  } catch (e) {
    console.error("git 不可用或目录损坏：" + e.message);
    return 1;
  }
  if (!branch || branch === "HEAD") {
    console.error(`程序目录处于 detached HEAD，请先 git checkout 回分支再更新：${appDir}`);
    return 1;
  }

  try {
    run("git", ["fetch", "origin", branch], appDir);
  } catch (e) {
    console.error("git fetch 失败：" + e.message);
    return 1;
  }

  let behind = 0;
  try {
    behind = Number(capture("git", ["rev-list", "--count", "HEAD..FETCH_HEAD"], appDir)) || 0;
  } catch { /* 数不出来就按有更新处理，交给 pull 兜底 */ behind = 1; }

  if (check) {
    console.log(behind > 0
      ? `当前 v${before}，远端 ${branch} 有 ${behind} 个新提交。运行 lah update 升级。`
      : `已是最新（v${before}，分支 ${branch}）。`);
    return 0;
  }

  if (behind === 0) {
    console.log(`已是最新（v${before}，分支 ${branch}）。`);
    return 0;
  }

  console.log(`更新 ${branch}：${behind} 个新提交（v${before} → …）`);
  try {
    run("git", ["merge", "--ff-only", "FETCH_HEAD"], appDir);
  } catch (e) {
    console.error("git 合并失败（本地有改动时会拒绝快进）：" + e.message);
    return 1;
  }

  const after = readAppVersion(appDir);
  try {
    if (fs.existsSync(path.join(appDir, "package-lock.json"))) {
      run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], appDir);
    } else {
      run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], appDir);
    }
  } catch (e) {
    console.error("依赖安装失败：" + e.message);
    return 1;
  }

  try {
    for (const bin of ["lah.mjs", "hub-node.mjs"]) fs.chmodSync(path.join(appDir, "bin", bin), 0o755);
  } catch (e) {
    console.log("  · bin 可执行位跳过：" + e.message);
  }

  ensureEntrySymlinks(appDir);
  refreshSkill(appDir, skipSkill);
  if (configDir) daemonHint(configDir);
  console.log(`更新完成：v${before} → v${after}。重启 lah daemon / lah host 后生效。`);
  return 0;
}
