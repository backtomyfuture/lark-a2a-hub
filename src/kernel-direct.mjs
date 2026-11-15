// direct 在途命令编排。方法挂到 Kernel.prototype，this 仍是内核实例。
// MAX_RETRIES 与 kernel.mjs 同值。不从 kernel.mjs 导入，避免循环依赖。
import fs from "node:fs";
import {
  VERIFY_MAX_LAUNCHES,
  buildAcceptance,
  clampVerifyTimeout,
  judgeChecks,
  verifyEvidenceTail,
  verifyVerdict,
} from "./acceptance.mjs";
import { f1 } from "./bus/feishu.mjs";
import { KILL_GRACE_MS } from "./proc.mjs";
import {
  beginLaunchEntry,
  beginVerifyLaunch,
  classifyEntry,
  cleanupRunFiles,
  readBoundedFile,
  readEntry,
  readExitCode,
  readProcStartMs,
  saveEntry,
  signalGroup,
  spawnVerifyWrapped,
  spawnWrapped,
} from "./direct-ledger.mjs";
import { log, nowStr } from "./kernel-util.mjs";
import { InvalidReceipt, NeedAuth, NeedInput } from "./receipt.mjs";

const MAX_RETRIES = 2;

export const directMethods = {

  // 未写 context 时直跑就是 direct。inbox 不进账本，避免改变它们的同步语义。
  usesDirectLedger(entry) {
    const ctx = entry?.context ?? "direct";
    const mode = entry?.mode ?? "agent";
    return ctx === "direct" && (mode === "json" || mode === "agent");
  },

  // 子进程结束或超时到点时只抬唤醒标志。写总线留在扫表里，避免和心跳、hub 扫描并发。
  nudge() {
    this._wakeFlag = true;
    try { this._notifyWake?.(); } catch (e) { log("wake notify failed: " + (e?.message ?? e)); }
    const waiter = this._directFlight?.waiter;
    if (waiter) {
      this._directFlight.waiter = null;
      waiter();
    }
  },

  waitInFlight() {
    const flight = this._directFlight;
    if (!flight) return Promise.resolve();
    if (flight.localExited || this._wakeFlag) return Promise.resolve();
    if (flight.exitPath && fs.existsSync(flight.exitPath)) return Promise.resolve();
    return new Promise((resolve) => {
      if (flight.localExited || this._wakeFlag) {
        resolve();
        return;
      }
      flight.waiter = resolve;
    });
  },

  // 模拟进程崩溃：丢掉本进程里的定时器和句柄，不杀子进程，也不删账本。
  abandonLocalFlight() {
    const flight = this._directFlight;
    if (!flight) return;
    flight.finishing = true;
    if (flight.hbTimer) clearInterval(flight.hbTimer);
    if (flight.timeoutTimer) clearTimeout(flight.timeoutTimer);
    flight.hbTimer = null;
    flight.timeoutTimer = null;
    if (flight.child) {
      flight.child.removeAllListeners("exit");
      flight.child.removeAllListeners("error");
      try { flight.child.unref(); } catch { /* 已经松开 */ }
      flight.child = null;
    }
    flight.waiter = null;
    this._directFlight = null;
  },

  _ledgerHolds(taskId) {
    if (this._directFlight && this._directFlight.taskId === taskId) return true;
    let entry;
    try {
      entry = readEntry(this.cfg.configDir, taskId);
    } catch (e) {
      log(`ledger read failed ${taskId}: ${e?.message ?? e}`);
      return true;
    }
    return !!entry;
  },

  flightFrom(task, entry) {
    const verifying = entry.state === "verifying" && !!entry.verify && typeof entry.verify === "object";
    const v = verifying ? entry.verify : null;
    return {
      taskId: f1(task, "Task_ID"),
      recordId: task.record_id,
      verifying,
      timedOut: verifying ? Boolean(v.timed_out) : false,
      started: entry.started_at || nowStr(),
      startedMs: Number(verifying ? v.started_ms : entry.started_ms) || Date.now(),
      timeoutSec: Number(verifying ? v.timeout_sec : entry.timeout_sec) || 0,
      runId: entry.run_id || "",
      mode: entry.mode || "agent",
      exitPath: (verifying ? v.exit_path : entry.exit_path) || "",
      stdoutPath: (verifying ? v.stdout_path : entry.stdout_path) || "",
      stderrPath: (verifying ? v.stderr_path : entry.stderr_path) || "",
      pid: (verifying ? v.pid : entry.pid) ?? null,
      pgid: (verifying ? (v.pgid ?? v.pid) : (entry.pgid ?? entry.pid)) ?? null,
      stopAt: Number(verifying ? v.stop_at_ms : entry.stop_at_ms) || 0,
      uncertain: false,
      broken: false,
      localExited: false,
      child: null,
      hbTimer: null,
      timeoutTimer: null,
      heartbeat: null,
      finishing: false,
      waiter: null,
    };
  },

  rememberEntry(entry) {
    try {
      saveEntry(this.cfg.configDir, entry);
    } catch (e) {
      log("entry.json 写失败：" + (e?.message ?? e));
    }
  },

  loadFlightEntry(flight) {
    const entry = readEntry(this.cfg.configDir, flight.taskId);
    if (!entry || entry.broken) return null;
    return entry;
  },

  startFlightHeartbeat(flight) {
    if (flight.hbTimer) clearInterval(flight.hbTimer);
    flight.finishing = false;
    // 60 秒一次，和原来 execute 里的间隔相同。必须 ≤ HEARTBEAT_MIN_SEC，见 kernel.mjs。
    // 扫表写总线时先等它结束，见 stopFlightHeartbeat。
    flight.hbTimer = setInterval(() => {
      if (flight.finishing || flight.heartbeat || this._sweepBusy) return;
      flight.heartbeat = (async () => {
        if (flight.finishing || this._sweepBusy) return;
        const row = await this.bus.getRecord(this.T.tasks, flight.recordId);
        if (!row || f1(row, "Status") !== "working" || f1(row, "Claimed_By") !== this.cfg.node) {
          flight.finishing = true;
          if (flight.hbTimer) clearInterval(flight.hbTimer);
          flight.hbTimer = null;
          return;
        }
        if (flight.finishing || this._sweepBusy) return;
        await this.bus.updateRecord(this.T.tasks, flight.recordId, { Heartbeat_At: nowStr() });
      })().catch((e) => log("heartbeat failed: " + (e?.message ?? e)))
        .finally(() => { flight.heartbeat = null; });
    }, 60_000);
    flight.hbTimer.unref?.();
  },

  async stopFlightHeartbeat(flight) {
    if (!flight) return;
    flight.finishing = true;
    if (flight.hbTimer) clearInterval(flight.hbTimer);
    flight.hbTimer = null;
    await flight.heartbeat;
  },

  armFlightTimer(flight) {
    if (flight.timeoutTimer) clearTimeout(flight.timeoutTimer);
    const timeoutMs = (Number(flight.timeoutSec) || 0) * 1000;
    const due = (Number(flight.startedMs) || Date.now()) + timeoutMs;
    const graceDue = flight.stopAt ? flight.stopAt + KILL_GRACE_MS : 0;
    const target = graceDue && graceDue < due ? graceDue : due;
    const wait = Math.max(0, Math.min(target - Date.now(), 2_147_483_647));
    flight.timeoutTimer = setTimeout(() => this.nudge(), wait);
    flight.timeoutTimer.unref?.();
  },

  timeoutDue(flight) {
    const timeoutMs = (Number(flight.timeoutSec) || 0) * 1000;
    if (!timeoutMs) return false;
    return Date.now() >= (Number(flight.startedMs) || 0) + timeoutMs;
  },

  async touchHeartbeat(task) {
    // pokeFlight、多余账本和接管都从这里过。间隔内不写，打断「写 → 事件 → 扫表 → 再写」。
    if (!this.heartbeatDue(task)) return;
    try {
      await this.bus.updateRecord(this.T.tasks, task.record_id, { Heartbeat_At: nowStr() });
    } catch (e) {
      log("heartbeat refresh failed: " + (e?.message ?? e));
    }
  },

  clearFlight(flight) {
    if (!flight) return;
    if (flight.timeoutTimer) clearTimeout(flight.timeoutTimer);
    flight.timeoutTimer = null;
    if (this._directFlight === flight) this._directFlight = null;
  },

  applyClass(flight, entry, cls) {
    if (!cls?.rebound) return entry;
    const target = entry.state === "verifying" && entry.verify ? entry.verify : entry;
    target.pid = cls.pid;
    target.pgid = cls.pgid;
    target.proc_start_ms = cls.procStartMs ?? null;
    if (entry.state !== "verifying") entry.state = "running";
    this.rememberEntry(entry);
    flight.pid = target.pid;
    flight.pgid = target.pgid;
    return entry;
  },

  async failExecution(task, flight, err) {
    await this.stopFlightHeartbeat(flight);
    const taskId = flight.taskId || f1(task, "Task_ID");
    if (this.readOutbox(taskId)) {
      this.clearFlight(flight);
      return;
    }
    const entry = this.loadFlightEntry(flight);
    if (entry && !entry.broken) {
      // 先记下「这轮已经失败」，进程在写总线途中崩溃时也不会再 spawn。
      entry.state = "exited";
      entry.disposition = "fail";
      entry.fail_error = String(err?.message ?? err).slice(0, 800);
      this.rememberEntry(entry);
    }
    const current = await this.taskForWrite(task, ["working"], true);
    if (!current) {
      this.clearFlight(flight);
      return;
    }
    const retries = Number(f1(current, "Retry_Count")) || 0;
    const rid = await this.writeRun(current, "failed", flight.started || nowStr(), String(err?.message ?? err).slice(0, 800));
    let ok = false;
    if (retries < MAX_RETRIES) {
      const next = retries + 1;
      const until = this.armRetry(taskId, next);
      ok = await this.updateTaskState(current, {
        Status: "submitted", Latest_Run: rid, Claimed_By: "", Heartbeat_At: "",
        Retry_Count: next,
      }, ["working"], true);
      if (ok) log(`failed, will retry ${taskId} after ${new Date(until).toISOString()}: ${String(err?.message ?? err).slice(0, 200)}`);
    } else {
      await this.writeMessage(current, "notice", "执行失败且已达重试上限：" + String(err?.message ?? err).slice(0, 500));
      ok = await this.updateTaskState(current, {
        Status: "failed", Latest_Run: rid, Heartbeat_At: "",
      }, ["working"], true);
      if (ok) {
        this.clearRetry(taskId);
        log(`failed permanently ${taskId}: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
    if (ok) {
      await this.applyUsage(current, null);
      if (entry && !entry.broken) cleanupRunFiles(this.cfg.configDir, entry);
      if (retries >= MAX_RETRIES) this.dropSession(taskId);
      this.clearFlight(flight);
    }
  },

  // 无法确认进程还在不在时不能重跑。超时信号也确认不了的，直接终止，避免占住唯一的执行槽。
  async terminateUncertain(task, flight) {
    await this.stopFlightHeartbeat(flight);
    const taskId = flight.taskId;
    const current = await this.taskForWrite(task, ["working"], true);
    if (!current) {
      this.clearFlight(flight);
      return;
    }
    const message = "无法确认在途进程组是否已结束。为避免副作用被执行第二次，任务终止且不回到 submitted。";
    const rid = await this.writeRun(current, "failed", flight.started || nowStr(), message);
    await this.writeMessage(current, "notice", message);
    const ok = await this.updateTaskState(current, {
      Status: "failed", Latest_Run: rid, Heartbeat_At: "",
    }, ["working"], true);
    if (ok) {
      this.clearRetry(taskId);
      await this.applyUsage(current, null);
      this.dropSession(taskId);
      log("uncertain flight terminated " + taskId);
      this.clearFlight(flight);
    }
  },

  async settleVerify(task, flight, entry, { verdict, exit_code = null, duration_ms = 0, stdout = "", stderr = "" }) {
    await this.stopFlightHeartbeat(flight);
    const taskId = flight?.taskId || f1(task, "Task_ID");
    if (this.readOutbox(taskId)) {
      this.clearFlight(flight);
      return;
    }
    const current = await this.taskForWrite(task, ["working"], true);
    if (!current) {
      this.clearFlight(flight);
      return;
    }
    const res = entry?.receipt ?? { summary: "", artifact: "" };
    const { criteria, criteriaRef } = await this.getAcceptanceCriteria(current);
    const checks = judgeChecks(criteria, res.checks);
    const acceptance = buildAcceptance({
      verify: { verdict, exit_code, duration_ms, evidence: "captured" },
      criteriaRef,
      checks,
    });
    const outcome = verdict === "pass" ? "succeeded" : "verify_failed";
    const verifyEvidence = verdict === "pass" ? "" : verifyEvidenceTail(stdout, stderr);
    const box = this.beginOutbox(current, {
      outcome,
      res,
      started: flight?.started || entry?.started_at || nowStr(),
      runId: flight?.runId || entry?.run_id || "",
      usage: res.usage ?? null,
      acceptance,
      verifyEvidence,
    });
    try { await this.submitOutbox(current, box); }
    catch (err) { log(`verify submit failed, will reconcile ${taskId}: ${err.message}`); }
    if (!this.readOutbox(taskId)) {
      const latest = entry || (flight ? this.loadFlightEntry(flight) : null);
      if (latest && !latest.broken) cleanupRunFiles(this.cfg.configDir, latest);
    }
    this.clearFlight(flight);
  },

  async launchVerify(task, entry, { flight = this._directFlight, capEntry = null, verifyCmd = "" } = {}) {
    const taskId = f1(task, "Task_ID") || entry.task_id;
    const skill = this.capKeyOf(task);
    const resolvedCap = capEntry ?? (skill ? (this.commands[skill] ?? {}) : {});
    const cmd = verifyCmd || (typeof resolvedCap.verify === "string" && resolvedCap.verify.trim() ? resolvedCap.verify : "");
    const prevLaunches = Number(entry.verify?.launches) || 0;
    if (prevLaunches >= VERIFY_MAX_LAUNCHES) {
      await this.settleVerify(task, flight, entry, {
        verdict: "error", exit_code: null, duration_ms: 0, stdout: "",
        stderr: `verify 超过最大拉起次数（${VERIFY_MAX_LAUNCHES}）`,
      });
      return;
    }
    if (!cmd) {
      await this.settleVerify(task, flight, entry, {
        verdict: "error", exit_code: null, duration_ms: 0, stdout: "",
        stderr: "verify 命令未配置或不可用",
      });
      return;
    }
    const timeoutSec = clampVerifyTimeout(resolvedCap.verify_timeout_sec);
    beginVerifyLaunch({
      configDir: this.cfg.configDir,
      entry,
      receipt: entry.receipt ?? { summary: "", artifact: "" },
      timeoutSec,
    });
    const cwd = resolvedCap.cwd || this.cfg.configDir;
    let child;
    try {
      child = spawnVerifyWrapped(this.cfg.configDir, entry, cmd, cwd);
    } catch (e) {
      await this.settleVerify(task, flight, entry, {
        verdict: "error", exit_code: null, duration_ms: 0, stdout: "",
        stderr: String(e?.message ?? e),
      });
      return;
    }
    if (!child?.pid) {
      await this.settleVerify(task, flight, entry, {
        verdict: "error", exit_code: null, duration_ms: 0, stdout: "",
        stderr: "verify spawn 没有返回 pid",
      });
      return;
    }
    entry.verify.pid = child.pid;
    entry.verify.pgid = child.pid;
    entry.verify.proc_start_ms = readProcStartMs(child.pid);
    this.rememberEntry(entry);
    if (flight) {
      await this.stopFlightHeartbeat(flight);
      if (flight.timeoutTimer) clearTimeout(flight.timeoutTimer);
      flight.timeoutTimer = null;
    }
    const nextFlight = this.flightFrom(task, entry);
    nextFlight.child = child;
    this._directFlight = nextFlight;
    child.on("error", (err) => {
      nextFlight.localExited = true;
      nextFlight.localError = err;
      log(`verify child error ${taskId}: ${err?.message ?? err}`);
      this.nudge();
    });
    child.on("exit", () => {
      nextFlight.localExited = true;
      this.nudge();
    });
    child.unref();
    this.startFlightHeartbeat(nextFlight);
    this.armFlightTimer(nextFlight);
    log(`verify started ${taskId} pid=${child.pid} launch=${entry.verify.launches}`);
  },

  async finishVerifyFromOutput(task, flight, entry = null) {
    const loaded = entry || this.loadFlightEntry(flight);
    const code = readExitCode(flight.exitPath);
    const stdout = readBoundedFile(flight.stdoutPath);
    const stderr = readBoundedFile(flight.stderrPath);
    const timedOut = Boolean(loaded?.verify?.timed_out || flight.timedOut);
    const verdict = verifyVerdict({ code, timedOut, error: !timedOut && code == null });
    const durationMs = Math.max(0, Date.now() - (Number(loaded?.verify?.started_ms) || flight.startedMs || Date.now()));
    await this.settleVerify(task, flight, loaded, {
      verdict,
      exit_code: code,
      duration_ms: durationMs,
      stdout,
      stderr,
    });
  },

  async relaunchOrFailVerify(task, flight, entry) {
    const current = await this.taskForWrite(task, ["working"], true);
    if (!current) {
      await this.stopFlightHeartbeat(flight);
      this.clearFlight(flight);
      return;
    }
    if (entry?.verify?.timed_out || flight?.timedOut) {
      const durationMs = Math.max(0, Date.now() - (Number(entry?.verify?.started_ms) || flight?.startedMs || Date.now()));
      await this.settleVerify(current, flight, entry, {
        verdict: "timeout",
        exit_code: null,
        duration_ms: durationMs,
        stdout: readBoundedFile(flight?.stdoutPath || entry?.verify?.stdout_path || ""),
        stderr: readBoundedFile(flight?.stderrPath || entry?.verify?.stderr_path || ""),
      });
      return;
    }
    if (!entry?.verify || typeof entry.verify !== "object") {
      await this.settleVerify(current, flight, entry, {
        verdict: "error", exit_code: null, duration_ms: 0, stdout: "",
        stderr: "verify 账本状态缺失",
      });
      return;
    }
    log(`relaunch verify ${f1(current, "Task_ID")} (prev launches=${entry.verify.launches || 0})`);
    await this.launchVerify(current, entry, { flight });
  },

  async finishFlightFromOutput(task, flight) {
    await this.stopFlightHeartbeat(flight);
    const taskId = flight.taskId;
    if (this.readOutbox(taskId)) {
      this.clearFlight(flight);
      return;
    }
    const current = await this.taskForWrite(task, ["working"], true);
    if (!current) {
      this.clearFlight(flight);
      return;
    }
    const code = readExitCode(flight.exitPath);
    const stdout = readBoundedFile(flight.stdoutPath);
    const stderr = readBoundedFile(flight.stderrPath);
    if (code == null) {
      await this.failExecution(current, flight, new Error("在途进程已结束但退出码文件不可读，按执行失败处理"));
      return;
    }
    try {
      const res = this.interpretCommandResult(flight.mode, { code, stdout, stderr });
      this.persistSession(taskId, res.session);
      const skill = this.capKeyOf(current);
      const capEntry = this.commands[skill] ?? {};
      const verifyCmd = typeof capEntry.verify === "string" && capEntry.verify.trim() ? capEntry.verify : "";
      if (verifyCmd) {
        const ledger = this.loadFlightEntry(flight) || {
          task_id: taskId,
          attempt: Number(f1(current, "Retry_Count")) || 0,
          started_at: flight.started,
          started_ms: flight.startedMs,
          timeout_sec: flight.timeoutSec,
          stdout_path: flight.stdoutPath,
          stderr_path: flight.stderrPath,
          exit_path: flight.exitPath,
          run_id: flight.runId,
          mode: flight.mode,
        };
        ledger.receipt = res;
        await this.launchVerify(current, ledger, { flight, capEntry, verifyCmd });
        return;
      }
      const { criteria, criteriaRef } = await this.getAcceptanceCriteria(current);
      const checks = judgeChecks(criteria, res.checks);
      const acceptance = buildAcceptance({ verify: null, criteriaRef, checks });
      const box = this.beginOutbox(current, {
        outcome: "succeeded", res, started: flight.started, runId: flight.runId,
        usage: res.usage ?? null, acceptance,
      });
      try { await this.submitOutbox(current, box); }
      catch (err) { log(`submit failed, will reconcile ${taskId}: ${err.message}`); }
      if (!this.readOutbox(taskId)) {
        const entry = this.loadFlightEntry(flight);
        if (entry && !entry.broken) cleanupRunFiles(this.cfg.configDir, entry);
      }
      this.clearFlight(flight);
    } catch (e) {
      if (e instanceof InvalidReceipt) {
        this.persistSession(taskId, e.session);
        const box = this.beginOutbox(current, {
          outcome: "invalid", started: flight.started, runId: flight.runId,
          error: String(e.message).slice(0, 300),
          raw: String(e.raw ?? "").slice(0, 500),
          usage: e.usage ?? null,
        });
        try { await this.submitOutbox(current, box); }
        catch (err) { log(`invalid receipt submit failed, will reconcile ${taskId}: ${err.message}`); }
        if (!this.readOutbox(taskId)) {
          const entry = this.loadFlightEntry(flight);
          if (entry && !entry.broken) cleanupRunFiles(this.cfg.configDir, entry);
        }
        this.clearFlight(flight);
        return;
      }
      if (e instanceof NeedInput) {
        this.persistSession(taskId, e.session);
        const rid = await this.writeRun(current, "paused", flight.started, "input-required: " + String(e.message).slice(0, 400));
        const mid = await this.writeMessage(current, "question", String(e.message));
        const ok = await this.updateTaskState(current, {
          Status: "input-required", Latest_Run: rid, Status_Msg: mid, Heartbeat_At: "",
        }, ["working"], true);
        if (ok) {
          await this.applyUsage(current, e.usage ?? null);
          this.clearRetry(taskId);
          const entry = this.loadFlightEntry(flight);
          if (entry && !entry.broken) cleanupRunFiles(this.cfg.configDir, entry);
          this.clearFlight(flight);
          log(`input-required ${taskId}: ${String(e.message).slice(0, 120)}`);
        }
        return;
      }
      if (e instanceof NeedAuth) {
        this.persistSession(taskId, e.session);
        // token 用账本里的 runId。writeRun 在已 paused 时会新建下一行，拿它的返回值会发出第二张卡。
        if (!String(flight.runId ?? "").trim()) {
          await this.failExecution(current, flight, new Error("动态审批缺少稳定 runId"));
          return;
        }
        try {
          const rid = await this.writeRun(current, "paused", flight.started, "auth-required: " + String(e.message).slice(0, 400));
          const mid = await this.writeDynamicAuthRequest(current, String(e.message), flight.runId);
          const ok = await this.updateTaskState(current, {
            Status: "auth-required", Latest_Run: rid, Status_Msg: mid, Heartbeat_At: "",
          }, ["working"], true);
          if (ok) {
            await this.applyUsage(current, e.usage ?? null);
            this.clearRetry(taskId);
            const entry = this.loadFlightEntry(flight);
            if (entry && !entry.broken) cleanupRunFiles(this.cfg.configDir, entry);
            this.clearFlight(flight);
            log(`auth-required ${taskId}: ${String(e.message).slice(0, 120)}`);
          }
        } catch (err) {
          log(`auth-required write failed ${taskId}: ${err?.message ?? err}`);
        }
        return;
      }
      await this.failExecution(current, flight, e);
    }
  },

  async enforceTimeout(task, flight) {
    const entry = this.loadFlightEntry(flight);
    if (!entry || entry.broken) {
      await this.terminateUncertain(task, flight);
      return;
    }
    const verifying = entry.state === "verifying" && !!entry.verify && typeof entry.verify === "object";
    const target = verifying ? entry.verify : entry;
    const cls = classifyEntry(entry);
    this.applyClass(flight, entry, cls);
    if (cls.kind === "dead" || cls.kind === "fail") return;
    if (cls.kind === "exited") return;
    // 启动时间戳对不上时 classify 会改去找包装进程。仍不确定就不发信号，免得打死复用了 pid 的无关进程。
    if (cls.kind === "uncertain" && target.proc_start_ms != null && cls.rebound !== true) {
      const identLive = readProcStartMs(target.pid);
      if (identLive != null && Math.abs(identLive - Number(target.proc_start_ms)) > 5000) {
        target.disposition = "fail";
        target.fail_error = "pid 已复用，原进程不在，且没有退出码文件";
        this.rememberEntry(entry);
        return;
      }
    }
    // 守护重启后接管的进程组，pid 可能已被系统复用给无关进程。没有本进程的 child 句柄、
    // 启动时间戳又对不上（或根本没记）时一律不发信号，宁可让超时收口去失败，也不误杀别人的进程。
    let canSignal = !!flight.child || cls.rebound === true;
    if (!canSignal && target.proc_start_ms != null) {
      const liveStart = readProcStartMs(target.pid);
      canSignal = liveStart != null && Math.abs(liveStart - Number(target.proc_start_ms)) <= 5000;
    }
    if (!canSignal) {
      if (!flight.signalSkipLogged) {
        flight.signalSkipLogged = true;
        log(`${verifying ? "verify" : "direct"} timeout ${flight.taskId}: 无法确认进程身份，不向进程组发信号`);
      }
    }
    const now = Date.now();
    if (!flight.stopAt) {
      const signaled = canSignal ? signalGroup(flight.pgid || flight.pid, "SIGTERM") : false;
      flight.stopAt = now;
      target.stop_at_ms = now;
      if (verifying) {
        target.timed_out = true;
        flight.timedOut = true;
      } else {
        entry.state = "running";
      }
      this.rememberEntry(entry);
      this.armFlightTimer(flight);
      log(`${verifying ? "verify" : "direct"} timeout SIGTERM ${flight.taskId} signaled=${signaled}`);
      return;
    }
    if (now - flight.stopAt >= KILL_GRACE_MS) {
      if (canSignal) signalGroup(flight.pgid || flight.pid, "SIGKILL");
      log(`${verifying ? "verify" : "direct"} timeout SIGKILL ` + flight.taskId + (canSignal ? "" : "（未发信号）"));
    }
  },

  async pokeFlight(flight) {
    const task = await this.bus.getRecord(this.T.tasks, flight.recordId);
    if (!task || f1(task, "Status") !== "working" || f1(task, "Claimed_By") !== this.cfg.node) {
      await this.stopFlightHeartbeat(flight);
      this.clearFlight(flight);
      return;
    }
    if (flight.broken) {
      if (this.timeoutDue(flight)) await this.terminateUncertain(task, flight);
      else await this.touchHeartbeat(task);
      return;
    }
    const entry = this.loadFlightEntry(flight);
    if (!entry || entry.broken) {
      flight.broken = true;
      flight.uncertain = true;
      if (this.timeoutDue(flight)) await this.terminateUncertain(task, flight);
      else await this.touchHeartbeat(task);
      return;
    }
    const verifying = entry.state === "verifying";
    const cls = classifyEntry(entry);
    this.applyClass(flight, entry, cls);
    if (cls.kind === "exited") {
      if (verifying) await this.finishVerifyFromOutput(task, flight, entry);
      else await this.finishFlightFromOutput(task, flight);
      return;
    }
    if (cls.kind === "dead" || cls.kind === "fail") {
      if (verifying) {
        await this.relaunchOrFailVerify(task, flight, entry);
        return;
      }
      const message = entry.fail_error || "在途进程已结束且没有退出码文件，按执行失败处理";
      await this.failExecution(task, flight, new Error(message));
      return;
    }
    flight.uncertain = cls.kind === "uncertain";
    if (this.timeoutDue(flight)) {
      await this.enforceTimeout(task, flight);
      const again = this.loadFlightEntry(flight);
      const after = again && !again.broken ? classifyEntry(again) : { kind: "uncertain" };
      if (again && !again.broken) this.applyClass(flight, again, after);
      if (after.kind === "exited") {
        if (verifying) await this.finishVerifyFromOutput(task, flight, again);
        else await this.finishFlightFromOutput(task, flight);
        return;
      }
      if (after.kind === "dead" || after.kind === "fail") {
        if (verifying) {
          await this.relaunchOrFailVerify(task, flight, again);
          return;
        }
        await this.failExecution(task, flight, new Error(again?.fail_error || "在途命令超时后进程已结束且没有退出码文件，按执行失败处理"));
        return;
      }
      if (flight.stopAt && Date.now() - flight.stopAt >= KILL_GRACE_MS && after.kind === "uncertain") {
        if (verifying) {
          const durationMs = Math.max(0, Date.now() - (Number(again?.verify?.started_ms) || flight.startedMs || Date.now()));
          await this.settleVerify(task, flight, again, {
            verdict: (again?.verify?.timed_out || flight.timedOut) ? "timeout" : "error",
            exit_code: null,
            duration_ms: durationMs,
            stdout: readBoundedFile(flight.stdoutPath),
            stderr: readBoundedFile(flight.stderrPath),
          });
          return;
        }
        await this.terminateUncertain(task, flight);
      }
      return;
    }
    await this.touchHeartbeat(task);
  },

  async adoptLedger(task, entry) {
    const taskId = f1(task, "Task_ID");
    if (this.readOutbox(taskId)) return;
    if (entry.broken) {
      const flight = {
        taskId,
        recordId: task.record_id,
        started: nowStr(),
        startedMs: Date.now(),
        timeoutSec: 600,
        runId: "",
        mode: "agent",
        exitPath: "",
        stdoutPath: "",
        stderrPath: "",
        broken: true,
        uncertain: true,
        localExited: false,
        stopAt: 0,
        child: null,
        hbTimer: null,
        timeoutTimer: null,
        heartbeat: null,
        finishing: false,
        waiter: null,
      };
      this._directFlight = flight;
      await this.touchHeartbeat(task);
      this.startFlightHeartbeat(flight);
      this.armFlightTimer(flight);
      log("ledger broken, hold without rerun " + taskId);
      return;
    }
    const verifying = entry.state === "verifying";
    const flight = this.flightFrom(task, entry);
    const cls = classifyEntry(entry);
    this.applyClass(flight, entry, cls);
    this._directFlight = flight;
    if (cls.kind === "exited") {
      log(`adopt exited ${verifying ? "verify " : ""}ledger ` + taskId);
      if (verifying) await this.finishVerifyFromOutput(task, flight, entry);
      else await this.finishFlightFromOutput(task, flight);
      return;
    }
    if (cls.kind === "dead" || cls.kind === "fail") {
      if (verifying) {
        log("adopt dead verify ledger " + taskId);
        await this.relaunchOrFailVerify(task, flight, entry);
        return;
      }
      log("adopt dead ledger " + taskId);
      await this.failExecution(task, flight, new Error(entry.fail_error || "在途进程已结束且没有退出码文件，按执行失败处理"));
      return;
    }
    flight.uncertain = cls.kind === "uncertain";
    await this.touchHeartbeat(task);
    this.startFlightHeartbeat(flight);
    this.armFlightTimer(flight);
    log(`adopt live ${verifying ? "verify " : ""}ledger ${taskId} pid=${flight.pid || "none"} uncertain=${flight.uncertain}`);
    if (this.timeoutDue(flight)) await this.pokeFlight(flight);
  },

  async serviceDirectFlight() {
    if (this._directFlight) {
      await this.pokeFlight(this._directFlight);
      return;
    }
    let tasks;
    try {
      tasks = await this.bus.listRecords(this.T.tasks);
    } catch (e) {
      log("ledger scan failed: " + (e?.message ?? e));
      return;
    }
    const held = [];
    for (const task of tasks) {
      if (f1(task, "Status") !== "working" || f1(task, "Claimed_By") !== this.cfg.node) continue;
      const taskId = f1(task, "Task_ID");
      if (!taskId || this.readOutbox(taskId)) continue;
      const entry = readEntry(this.cfg.configDir, taskId);
      if (!entry) continue;
      held.push({ task, entry });
    }
    if (!held.length) return;
    await this.adoptLedger(held[0].task, held[0].entry);
    for (const extra of held.slice(1)) {
      // 容量是 1。多出来的账本本轮只续心跳，下一轮再收口，避免两条命令同时写总线。
      await this.touchHeartbeat(extra.task);
      log("extra ledger held " + f1(extra.task, "Task_ID"));
    }
  },

  async launchDirect(task, extraAnswers, started, startedMs, runId, resume = false) {
    const taskId = f1(task, "Task_ID");
    const skill = this.capKeyOf(task);
    if (this._directFlight) throw new Error("direct slot busy");
    const params = await this.getParams(task);
    if (extraAnswers) params._answers = extraAnswers;
    const prep = await this.prepareCommand(skill, task, params, extraAnswers, resume);
    const attempt = Number(f1(task, "Retry_Count")) || 0;
    const entry = beginLaunchEntry({
      configDir: this.cfg.configDir,
      taskId,
      attempt,
      startedAt: started,
      startedMs,
      timeoutSec: prep.timeout,
      mode: prep.mode,
      runId,
      stdinText: prep.stdinText,
    });
    let child;
    try {
      child = spawnWrapped(entry, prep.command, prep.cwd);
    } catch (e) {
      const flight = this.flightFrom(task, entry);
      this._directFlight = flight;
      await this.failExecution(task, flight, e);
      return;
    }
    if (!child?.pid) {
      const flight = this.flightFrom(task, entry);
      this._directFlight = flight;
      await this.failExecution(task, flight, new Error("spawn 没有返回 pid"));
      return;
    }
    entry.pid = child.pid;
    entry.pgid = child.pid;
    entry.proc_start_ms = readProcStartMs(child.pid);
    entry.state = "running";
    this.rememberEntry(entry);
    const flight = this.flightFrom(task, entry);
    flight.child = child;
    this._directFlight = flight;
    child.on("error", (err) => {
      flight.localExited = true;
      flight.localError = err;
      log(`direct child error ${taskId}: ${err?.message ?? err}`);
      this.nudge();
    });
    child.on("exit", () => {
      flight.localExited = true;
      this.nudge();
    });
    child.unref();
    this.startFlightHeartbeat(flight);
    this.armFlightTimer(flight);
    log(`direct started ${taskId} pid=${child.pid}`);
  },

  async executeDirect(task, extraAnswers, resume = false) {
    const taskId = f1(task, "Task_ID");
    const started = nowStr();
    const startedMs = Date.now();
    let runId = "";
    try {
      runId = await this.openRun(task, started);
      await this.launchDirect(task, extraAnswers, started, startedMs, runId, resume);
    } catch (e) {
      if (this._directFlight?.taskId === taskId) {
        log(`direct launch kept ${taskId}: ${e?.message ?? e}`);
        return;
      }
      log(`direct launch failed ${taskId}: ${e?.message ?? e}`);
      try {
        await this.failExecution(task, {
          taskId,
          recordId: task.record_id,
          started,
          startedMs,
          timeoutSec: 0,
          runId,
          mode: "agent",
          exitPath: "",
          stdoutPath: "",
          stderrPath: "",
        }, e);
      } catch (err) {
        log("direct failure record failed: " + (err?.message ?? err));
      }
    }
  },
};
