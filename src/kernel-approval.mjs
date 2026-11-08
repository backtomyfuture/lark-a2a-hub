// 审批请求与机主决定。方法挂到 Kernel.prototype，this 仍是内核实例。
import { createHash } from "node:crypto";
import { f1 } from "./bus/feishu.mjs";
import { approvalRank, clipText, log, redactValue } from "./kernel-util.mjs";

export const approvalMethods = {

  // 表字段名是 Kind。只认 hub/user 对当前 Status_Msg 的 auth_decision，多条以 Msg_ID 序号（其次创建时间）最新的一条为准。
  // 决定值只读 DataPart，不看 TextPart，也不看任务行上的标记。
  async authApproved(task) {
    const statusMsg = String(f1(task, "Status_Msg") ?? "");
    if (!statusMsg) return false;
    const msgs = await this.listMessages(f1(task, "Task_ID"));
    const decisions = msgs.filter((m) =>
      f1(m, "Kind") === "auth_decision" &&
      f1(m, "From_Node") === "hub" &&
      f1(m, "Role") === "user" &&
      f1(m, "In_Reply_To") === statusMsg);
    const latest = this.latestMsg(decisions);
    if (!latest) return false;
    return (await this.msgData(latest)).decision === "approve";
  },

  effectiveApproval(task, skill) {
    const row = f1(task, "Approval_Class");
    const local = this.commands[skill]?.approval_class;
    // 本地下限只收紧不放宽：取秩更高的一侧。
    return approvalRank(local) >= approvalRank(row) ? (local || "auto") : (row || "auto");
  },

  // 审批去重不能用本轮扫表快照：hub 提前写和目标节点认领分属两个进程，
  // 快照会看不见对方刚落下的 auth_request，从而再写一条。
  async reloadMessages(taskId) {
    this._round = null;
    return this.listMessages(taskId);
  },

  // 飞书 client_token 要像 UUID。同一任务的提前写与节点认领共用这一把，服务端只落一行。
  authRequestToken(taskId) {
    const hex = createHash("sha256").update("lah-auth-request\0" + String(taskId)).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  },

  authRequestOf(task, msgs) {
    const requests = (msgs || []).filter((m) => f1(m, "Kind") === "auth_request");
    const pointed = requests.find((m) => f1(m, "Msg_ID") === f1(task, "Status_Msg"));
    return pointed || this.latestMsg(requests);
  },

  decisionForRequest(msgs, requestId) {
    return this.latestMsg((msgs || []).filter((m) =>
      f1(m, "Kind") === "auth_decision" &&
      f1(m, "From_Node") === "hub" &&
      f1(m, "Role") === "user" &&
      f1(m, "In_Reply_To") === requestId));
  },

  async ensureRequestText(task, mid) {
    const parts = await this.listParts(mid);
    const hasText = parts.some((p) => f1(p, "Kind") === "text" && String(f1(p, "Text") ?? "").trim() !== "");
    if (hasText) return;
    const taken = new Set(parts.map((p) => f1(p, "Part_ID")));
    const seq = taken.has(`${mid}-P1`)
      ? this.nextSuffix(parts.map((p) => f1(p, "Part_ID")), /-P(\d+)$/)
      : 1;
    await this.createPart(mid, "message", seq, "text", {
      text: (await this.approvalBody(task)).slice(0, 4000),
    });
  },

  // 返回 true 表示本轮必须停手。allowed 由调用方限定，避免把 working 改回 auth-required。
  async settleExistingRequest(task, pending, msgs, allowed) {
    const taskId = f1(task, "Task_ID");
    const mid = f1(pending, "Msg_ID");
    const decision = this.decisionForRequest(msgs, mid);
    if (!decision) {
      await this.ensureRequestText(task, mid);
      if (!(await this.updateTaskState(task, { Status: "auth-required", Status_Msg: mid }, allowed))) return true;
      log("auth-required " + taskId);
      return true;
    }
    if ((await this.msgData(decision)).decision === "approve") {
      // 续跑时 Status_Msg 指向 question，不能改回 auth_request，否则呈递去重对不上。
      if (f1(task, "Status") === "submitted" && f1(task, "Status_Msg") !== mid) {
        await this.updateTaskState(task, { Status_Msg: mid }, ["submitted"]);
      }
      return false;
    }
    return true;
  },

  // 枢纽审批卡直接读这条正文，所以要带上即将执行的内容，而不是只留标题。
  async approvalBody(task) {
    const skill = f1(task, "Skill_ID") || "(空)";
    const capName = this.commands[skill]?.name || skill;
    const instruction = clipText((await this.instructionText(task)) || "(无文字指令)", 500);
    let paramText = "{}";
    try { paramText = JSON.stringify(redactValue(await this.getParams(task))); }
    catch { paramText = "{}"; }
    if (paramText.length > 800) paramText = paramText.slice(0, 800) + "…";
    return [
      "此任务为 approve 类，执行前需机主批准。",
      `任务：${clipText(f1(task, "Title"), 200)}`,
      `能力：${clipText(capName, 120)}（${clipText(skill, 80)}）`,
      `指令摘要：${instruction}`,
      `参数摘要：${paramText}`,
    ].join("\n");
  },

  // 返回 true 表示本轮必须停手。已有批准则返回 false，续跑不必因为 Status_Msg 已指向 question 而再卡一次。
  async askApproval(task) {
    const taskId = f1(task, "Task_ID");
    const allowed = [f1(task, "Status") === "input-required" ? "input-required" : "submitted"];
    let msgs = await this.reloadMessages(taskId);
    let pending = this.authRequestOf(task, msgs);
    if (pending) return this.settleExistingRequest(task, pending, msgs, allowed);
    // 写前再读一次：上一读与写入之间，hub 可能已经落下唯一的那条 auth_request。
    msgs = await this.reloadMessages(taskId);
    pending = this.authRequestOf(task, msgs);
    if (pending) return this.settleExistingRequest(task, pending, msgs, allowed);
    const mid = await this.writeAuthRequest(task);
    msgs = await this.reloadMessages(taskId);
    const winner = this.authRequestOf(task, msgs);
    if (winner && f1(winner, "Msg_ID") !== mid) {
      return this.settleExistingRequest(task, winner, msgs, allowed);
    }
    const useId = (winner && f1(winner, "Msg_ID")) || mid;
    await this.ensureRequestText(task, useId);
    if (!(await this.updateTaskState(task, { Status: "auth-required", Status_Msg: useId }, allowed))) return true;
    log("auth-required " + taskId);
    return true;
  },

  // 行级 approve 在目标节点认领前由 hub 调用。allowed 只有 submitted：
  // 写完发现已经是 working 时，updateTaskState 拒绝把状态改回去。
  async primeSubmittedApproval(task) {
    if (String(f1(task, "Approval_Class") ?? "").trim() !== "approve") return { acted: false };
    const open = async () => {
      const row = await this.bus.getRecord(this.T.tasks, task.record_id);
      if (!row) return { closed: true, reason: "missing" };
      const status = String(f1(row, "Status") ?? "");
      const claimed = String(f1(row, "Claimed_By") ?? "").trim();
      if (status !== "submitted" || claimed) return { closed: true, reason: status || "claimed", row };
      return { closed: false, row };
    };
    let gate = await open();
    if (gate.closed) return { acted: false, skipped: gate.reason };
    const taskId = f1(gate.row, "Task_ID");
    let msgs = await this.reloadMessages(taskId);
    let pending = this.authRequestOf(gate.row, msgs);
    if (!pending) {
      gate = await open();
      if (gate.closed) return { acted: false, skipped: gate.reason };
      msgs = await this.reloadMessages(taskId);
      pending = this.authRequestOf(gate.row, msgs);
    }
    if (pending) {
      const mid = f1(pending, "Msg_ID");
      const decision = this.decisionForRequest(msgs, mid);
      if (decision && (await this.msgData(decision)).decision === "approve") {
        // 已经批准：留在 submitted，让目标节点认领执行，不要打回 auth-required。
        if (f1(gate.row, "Status_Msg") !== mid) {
          await this.updateTaskState(gate.row, { Status_Msg: mid }, ["submitted"]);
        }
        return { acted: false, approved: true, msgId: mid };
      }
      if (decision) return { acted: false, rejected: true, msgId: mid };
      await this.ensureRequestText(gate.row, mid);
      const ok = await this.updateTaskState(gate.row, { Status: "auth-required", Status_Msg: mid }, ["submitted"]);
      return { acted: ok, reused: true, msgId: mid, status: ok ? "auth-required" : await this.freshStatus(task) };
    }
    const mid = await this.writeAuthRequest(gate.row);
    msgs = await this.reloadMessages(taskId);
    const winner = this.authRequestOf(gate.row, msgs);
    const useId = (winner && f1(winner, "Msg_ID")) || mid;
    await this.ensureRequestText(gate.row, useId);
    // 这里的回读在 updateTaskState 里：状态已不是 submitted（例如 working）则整笔状态更新取消。
    const ok = await this.updateTaskState(gate.row, { Status: "auth-required", Status_Msg: useId }, ["submitted"]);
    if (ok) log("auth-required (row prime) " + taskId);
    else log("row prime left state unchanged " + taskId);
    return { acted: ok, wrote: true, msgId: useId, status: ok ? "auth-required" : await this.freshStatus(task) };
  },

  async freshStatus(task) {
    const row = await this.bus.getRecord(this.T.tasks, task.record_id);
    return String(f1(row, "Status") ?? "");
  },

  // From_Node 用目标节点名，To_Node 仍由 writeMessage 对 auth_request 固定为 hub。
  // 正文分开写：client_token 命中已有行时不能按本地新编号再插一条 Part。
  async writeAuthRequest(task) {
    const taskId = f1(task, "Task_ID");
    const target = String(f1(task, "Target_Node") ?? "").trim();
    return this.writeMessage(task, "auth_request", "", {
      fromNode: target,
      clientToken: this.authRequestToken(taskId),
      writeParts: false,
    });
  },
};
