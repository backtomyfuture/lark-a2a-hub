// 命令完成后的 outbox：先落盘，再按缺补齐写表。失败不重跑。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { f1 } from "./bus/feishu.mjs";
import { TERMINAL_STATUSES, annotateElapsed, log, nowStr } from "./kernel-util.mjs";

export const outboxMethods = {

  outboxPath(taskId) {
    const id = String(taskId ?? "");
    if (!/^[\w-]+$/.test(id)) throw new Error("非法 Task_ID，拒绝写入 outbox");
    return path.join(this.cfg.configDir, "outbox", `${id}.json`);
  },

  readOutbox(taskId) {
    try {
      return JSON.parse(fs.readFileSync(this.outboxPath(taskId), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  },

  saveOutbox(box) {
    const dir = path.join(this.cfg.configDir, "outbox");
    fs.mkdirSync(dir, { recursive: true });
    const dest = this.outboxPath(box.taskId);
    const tmp = dest + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(box), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, dest);
    fs.chmodSync(dest, 0o600);
  },

  deleteOutbox(taskId) {
    try { fs.unlinkSync(this.outboxPath(taskId)); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  },

  async closeSettledOutbox(task, box) {
    await this.noteUsageOnce(task, box);
    await this.noteLaterOnce(task, box);
    this.dropSession(box.taskId);
    this.deleteOutbox(box.taskId);
    this.clearRetry(box.taskId);
  },

  // 命令已经跑完就先落盘。之后任何写表失败都靠这份文件补齐，不再执行一次。
  beginOutbox(task, info) {
    const box = {
      taskId: f1(task, "Task_ID"),
      outcome: info.outcome,
      res: info.res ?? null,
      raw: info.raw ?? "",
      error: info.error ?? "",
      started: info.started,
      planned: false,
      artId: "",
      runId: info.runId || "",
      msgId: "",
      usage: Object.prototype.hasOwnProperty.call(info, "usage") ? (info.usage ?? null) : (info.res?.usage ?? null),
      usage_noted: false,
      // 只有完成回执才把预约放进出箱。提问和失败的 later 在解析时已经记日志丢掉。
      later: info.outcome === "succeeded" && info.res?.later
        ? { at: info.res.later.at, about: info.res.later.about }
        : null,
      later_noted: false,
      tokens: {
        artifact: randomUUID(),
        artifactPart: randomUUID(),
        run: randomUUID(),
        message: randomUUID(),
        partText: randomUUID(),
      },
    };
    this.saveOutbox(box);
    return box;
  },

  async findBy(table, field, value) {
    if (!value) return null;
    if (table === this.T.messages || table === this.T.parts) {
      const idx = await this.roundIndex();
      const rows = table === this.T.messages ? idx.messages : idx.parts;
      return rows.find((r) => f1(r, field) === value) ?? null;
    }
    const rows = await this.bus.listRecords(table);
    return rows.find((r) => f1(r, field) === value) ?? null;
  },

  async ensurePlan(task, box) {
    box.tokens ??= {};
    let dirty = false;
    for (const k of ["artifact", "artifactPart", "run", "message", "partText"]) {
      if (!box.tokens[k]) {
        box.tokens[k] = randomUUID();
        dirty = true;
      }
    }
    if (box.planned && box.runId && box.msgId) {
      if (dirty) this.saveOutbox(box);
      return box;
    }
    const taskId = box.taskId || f1(task, "Task_ID");
    const msgs = await this.listMessages(taskId);
    const runs = await this.runsOf(taskId);
    const arts = (await this.bus.listRecords(this.T.artifacts)).filter((a) => f1(a, "Task_ID") === taskId);
    const pointer = String(box.res?.artifact ?? "").trim();
    if (!pointer) box.artId = "";
    else if (!box.artId) {
      box.artId = `${taskId}-A${this.nextSuffix(arts.map((a) => f1(a, "Artifact_ID")), /-A(\d+)$/)}`;
    }
    // 认领时已经开过 Run 的，沿用那个 Run_ID，收尾改为更新而不是再编号。
    if (!box.runId) {
      box.runId = `${taskId}-R${this.nextSuffix(runs.map((r) => f1(r, "Run_ID")), /-R(\d+)$/)}`;
    }
    if (!box.msgId) {
      const seq = this.nextMsgSeq(msgs);
      box.msgId = `MSG-${String(taskId).replace("TASK-", "")}-${String(seq).padStart(2, "0")}`;
    }
    box.planned = true;
    this.saveOutbox(box);
    return box;
  },

  async ensureArtifact(task, box) {
    if (!box.artId) return;
    const name = String(box.res?.artifact_name || f1(task, "Skill_ID") || "result");
    if (!(await this.findBy(this.T.artifacts, "Artifact_ID", box.artId))) {
      await this.bus.createRecord(this.T.artifacts, {
        Artifact_ID: box.artId, Task_ID: box.taskId, Context_ID: f1(task, "Context_ID"),
        Name: name, Description: String(box.res?.summary ?? "").slice(0, 500),
        Is_Final: "Yes", Created_By: this.cfg.node, Created_At: nowStr(),
      }, box.tokens.artifact);
    }
    await this.createPart(box.artId, "artifact", 1, "file", {
      fileUri: String(box.res?.artifact ?? ""), fileName: name,
    }, box.tokens.artifactPart);
  },

  async ensureRun(task, box) {
    const finished = nowStr();
    const failed = box.outcome !== "succeeded";
    const outcome = failed ? "failed" : "succeeded";
    const error = failed ? `回执无效：${box.error || ""}；原始输出：${box.raw || ""}` : "";
    const errorLog = annotateElapsed(error, box.started, finished);
    const row = await this.findBy(this.T.runs, "Run_ID", box.runId);
    if (row) {
      const closed = String(f1(row, "Finished_At") ?? "").trim() && f1(row, "Outcome") === outcome;
      if (!closed) {
        await this.bus.updateRecord(this.T.runs, row.record_id, {
          Finished_At: finished, Outcome: outcome, Error_Log: errorLog,
        });
      }
      this._openRunIds.delete(box.taskId);
      return;
    }
    await this.bus.createRecord(this.T.runs, {
      Run_ID: box.runId, Task_Ref: box.taskId, Node: this.cfg.node,
      Worker: f1(task, "Worker_Hint") || "daemon",
      Outcome: outcome, Error_Log: errorLog,
      Started_At: box.started, Finished_At: finished,
    }, box.tokens.run);
    this._openRunIds.delete(box.taskId);
  },

  async ensureResultMessage(task, box) {
    const failed = box.outcome !== "succeeded";
    const content = failed
      ? `回执无法解析，任务终止且不重试。原因：${box.error || "未知"}${box.raw ? "\n原始输出：" + box.raw : ""}`.slice(0, 4000)
      : String(box.res?.summary ?? "").slice(0, 4000);
    if (!(await this.findBy(this.T.messages, "Msg_ID", box.msgId))) {
      const fields = {
        Msg_ID: box.msgId, Task_ID: box.taskId, Context_ID: f1(task, "Context_ID"),
        From_Node: this.cfg.node, To_Node: await this.initiatorOf(task), Role: "agent",
        Kind: failed ? "notice" : "result",
        Artifact_Ref: box.artId || "", In_Reply_To: "", Created_At: nowStr(),
      };
      const created = await this.bus.createRecord(this.T.messages, fields, box.tokens.message);
      this._remember(this.T.messages, this._asRow(fields, created));
    }
    if (content) {
      await this.createPart(box.msgId, "message", 1, "text", { text: content }, box.tokens.partText);
    }
  },

  // Artifacts → Runs → Messages/Parts → Tasks。任一步失败都留着 outbox，下次只补缺的。
  async submitOutbox(task, box) {
    box = await this.ensurePlan(task, box);
    const current = await this.bus.getRecord(this.T.tasks, task.record_id);
    if (!current) throw new Error("任务行不存在 " + box.taskId);
    const st = f1(current, "Status");
    const want = box.outcome === "succeeded" ? "completed" : "failed";
    if (TERMINAL_STATUSES.has(st) && st !== want) {
      log(`outbox drop ${box.taskId}: terminal ${st}`);
      await this.closeSettledOutbox(current, box);
      return;
    }
    await this.ensureArtifact(current, box);
    await this.ensureRun(current, box);
    await this.ensureResultMessage(current, box);
    if (st === want) {
      await this.closeSettledOutbox(current, box);
      return;
    }
    const fields = box.outcome === "succeeded"
      ? { Status: "completed", Latest_Run: box.runId, Heartbeat_At: "", Status_Msg: "" }
      : { Status: "failed", Latest_Run: box.runId, Heartbeat_At: "" };
    // submitted 时认领可能已被清掉，不能要求 Claimed_By；working 仍由 taskForWrite 核对所有权。
    const ok = await this.updateTaskState(current, fields, ["working", "submitted"], false);
    if (!ok) {
      const again = await this.bus.getRecord(this.T.tasks, task.record_id);
      const st2 = f1(again, "Status");
      if (st2 === want) {
        await this.closeSettledOutbox(again, box);
        return;
      }
      if (TERMINAL_STATUSES.has(st2)) {
        log(`outbox drop ${box.taskId}: terminal ${st2}`);
        await this.closeSettledOutbox(again, box);
        return;
      }
      throw new Error(`状态未写入（当前 ${st2 || "missing"}），保留 outbox`);
    }
    await this.closeSettledOutbox(current, box);
    log(`${want} ${box.taskId} -> ${box.runId}`);
  },

  async flushOutbox() {
    const dir = path.join(this.cfg.configDir, "outbox");
    let names;
    try { names = fs.readdirSync(dir); }
    catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const taskId = name.slice(0, -".json".length);
      let box;
      try { box = this.readOutbox(taskId); }
      catch (e) {
        log(`outbox 读失败 ${taskId}: ${e.message}`);
        continue;
      }
      if (!box) continue;
      try {
        const tasks = await this.bus.listRecords(this.T.tasks);
        const task = tasks.find((t) => f1(t, "Task_ID") === taskId);
        if (!task) {
          log("outbox 找不到任务，保留文件 " + taskId);
          continue;
        }
        await this.submitOutbox(task, box);
      } catch (e) {
        log(`outbox 补齐失败 ${taskId}: ${e.message}`);
      }
    }
  },

  // 已有 result 但缺正文时不能当成交付关单，也不能因此再执行一遍。
  async repairLooseResult(task) {
    const taskId = f1(task, "Task_ID");
    if (this.readOutbox(taskId)) return false;
    const msgs = await this.listMessages(taskId);
    const result = this.latestMsg(msgs.filter((m) => f1(m, "Kind") === "result"));
    if (!result) return false;
    const parts = await this.listParts(f1(result, "Msg_ID"));
    const hasBody = parts.some((p) => f1(p, "Kind") === "text" && String(f1(p, "Text") ?? "") !== "");
    if (!hasBody) {
      log(`warning: result ${f1(result, "Msg_ID")} 缺 Parts，且无 outbox，不关单也不重跑 ${taskId}`);
      return true;
    }
    if (f1(task, "Status") === "completed") {
      this.clearRetry(taskId);
      return true;
    }
    if (!(await this.updateTaskState(task, { Status: "completed" }, ["submitted", "working"], f1(task, "Status") === "working"))) {
      return true;
    }
    this.clearRetry(taskId);
    log("reconciled completed " + taskId);
    return true;
  },
};
