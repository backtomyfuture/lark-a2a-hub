// direct 在途命令编排。方法挂到 Kernel.prototype，this 仍是内核实例。
// MAX_RETRIES 与 kernel.mjs 同值。不从 kernel.mjs 导入，避免循环依赖。
import fs from "node:fs";
import { f1 } from "./bus/feishu.mjs";
import { KILL_GRACE_MS } from "./carrier.mjs";
import {
  beginLaunchEntry,
  classifyEntry,
  cleanupRunFiles,
  readBoundedFile,
  readEntry,
  readExitCode,
  readProcStartMs,
  saveEntry,
  signalGroup,
  spawnWrapped,
} from "./direct-ledger.mjs";
import { log, nowStr } from "./kernel-util.mjs";
import { InvalidReceipt, NeedInput } from "./receipt.mjs";

const MAX_RETRIES = 2;

export const directMethods = {

  // 未写 context 时直跑就是 direct。inbox 与 carrier 不进账本，避免改变它们的同步语义。
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
    return {
      taskId: f1(task, "Task_ID"),
      recordId: task.record_id,
      started: entry.started_at || nowStr(),
      startedMs: Number(entry.started_ms) || Date.now(),
      timeoutSec: Number(entry.timeout_sec) || 0,
      runId: entry.run_id || "",
      mode: entry.mode || "agent",
      exitPath: entry.exit_path || "",
      stdoutPath: entry.stdout_path || "",
      stderrPath: entry.stderr_path || "",
      pid: entry.pid ?? null,
      pgid: entry.pgid ?? entry.pid ?? null,
      stopAt: Number(entry.stop_at_ms) || 0,
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
    // 60 秒一次，和原来 execute 里的间隔相同。扫表写总线时先等它结束，见 stopFlightHeartbeat。
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
    entry.pid = cls.pid;
    entry.pgid = cls.pgid;
    entry.proc_start_ms = cls.procStartMs ?? null;
    entry.state = "running";
    this.rememberEntry(entry);
    flight.pid = entry.pid;
    flight.pgid = entry.pgid;
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
      const box = this.beginOutbox(current, {
        outcome: "succeeded", res, started: flight.started, runId: flight.runId,
        usage: res.usage ?? null,
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
      await this.failExecution(current, flight, e);
    }
  },

  async enforceTimeout(task, flight) {
    const entry = this.loadFlightEntry(flight);
    if (!entry || entry.broken) {
      await this.terminateUncertain(task, flight);
      return;
    }
    const cls = classifyEntry(entry);
    this.applyClass(flight, entry, cls);
    if (cls.kind === "dead" || cls.kind === "fail") return;
    if (cls.kind === "exited") return;
    // 启动时间戳对不上时 classify 会改去找包装进程。仍不确定就不发信号，免得打死复用了 pid 的无关进程。
    if (cls.kind === "uncertain" && entry.proc_start_ms != null && cls.rebound !== true) {
      const identLive = readProcStartMs(entry.pid);
      if (identLive != null && Math.abs(identLive - Number(entry.proc_start_ms)) > 5000) {
        entry.disposition = "fail";
        entry.fail_error = "pid 已复用，原进程不在，且没有退出码文件";
        this.rememberEntry(entry);
        return;
      }
    }
    // 守护重启后接管的进程组，pid 可能已被系统复用给无关进程。没有本进程的 child 句柄、
    // 启动时间戳又对不上（或根本没记）时一律不发信号，宁可让超时收口去失败，也不误杀别人的进程。
    let canSignal = !!flight.child || cls.rebound === true;
    if (!canSignal && entry.proc_start_ms != null) {
      const liveStart = readProcStartMs(entry.pid);
      canSignal = liveStart != null && Math.abs(liveStart - Number(entry.proc_start_ms)) <= 5000;
    }
    if (!canSignal) {
      if (!flight.signalSkipLogged) {
        flight.signalSkipLogged = true;
        log(`direct timeout ${flight.taskId}: 无法确认进程身份，不向进程组发信号`);
      }
    }
    const now = Date.now();
    if (!flight.stopAt) {
      const signaled = canSignal ? signalGroup(flight.pgid || flight.pid, "SIGTERM") : false;
      flight.stopAt = now;
      entry.stop_at_ms = now;
      entry.state = "running";
      this.rememberEntry(entry);
      this.armFlightTimer(flight);
      log(`direct timeout SIGTERM ${flight.taskId} signaled=${signaled}`);
      return;
    }
    if (now - flight.stopAt >= KILL_GRACE_MS) {
      if (canSignal) signalGroup(flight.pgid || flight.pid, "SIGKILL");
      log("direct timeout SIGKILL " + flight.taskId + (canSignal ? "" : "（未发信号）"));
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
    const cls = classifyEntry(entry);
    this.applyClass(flight, entry, cls);
    if (cls.kind === "exited") {
      await this.finishFlightFromOutput(task, flight);
      return;
    }
    if (cls.kind === "dead" || cls.kind === "fail") {
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
        await this.finishFlightFromOutput(task, flight);
        return;
      }
      if (after.kind === "dead" || after.kind === "fail") {
        await this.failExecution(task, flight, new Error(again?.fail_error || "在途命令超时后进程已结束且没有退出码文件，按执行失败处理"));
        return;
      }
      if (flight.stopAt && Date.now() - flight.stopAt >= KILL_GRACE_MS && after.kind === "uncertain") {
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
    const flight = this.flightFrom(task, entry);
    const cls = classifyEntry(entry);
    this.applyClass(flight, entry, cls);
    this._directFlight = flight;
    if (cls.kind === "exited") {
      log("adopt exited ledger " + taskId);
      await this.finishFlightFromOutput(task, flight);
      return;
    }
    if (cls.kind === "dead" || cls.kind === "fail") {
      log("adopt dead ledger " + taskId);
      await this.failExecution(task, flight, new Error(entry.fail_error || "在途进程已结束且没有退出码文件，按执行失败处理"));
      return;
    }
    flight.uncertain = cls.kind === "uncertain";
    await this.touchHeartbeat(task);
    this.startFlightHeartbeat(flight);
    this.armFlightTimer(flight);
    log(`adopt live ledger ${taskId} pid=${flight.pid || "none"} uncertain=${flight.uncertain}`);
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
    const skill = f1(task, "Skill_ID");
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
