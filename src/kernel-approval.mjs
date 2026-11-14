// 审批请求与机主决定。方法挂到 Kernel.prototype，this 仍是内核实例。
import { createHash } from "node:crypto";
import { pickSignedDecision, verifyDecision } from "./approval-sign.mjs";
import { f1 } from "./bus/feishu.mjs";
import { approvalRank, clipText, log, redactValue } from "./kernel-util.mjs";

export const approvalMethods = {

  // 只认 hub/user 对当前 Status_Msg 的 auth_decision，口径与 decisionForRequest 同一份（含验签）。
  async authApproved(task) {
    const statusMsg = String(f1(task, "Status_Msg") ?? "");
    if (!statusMsg) return false;
    const msgs = await this.listMessages(f1(task, "Task_ID"));
    return (await this.decisionForRequest(task, msgs, statusMsg)) === "approve";
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

  // 飞书 client_token 要像 UUID。scope 为空时哈希输入必须与旧静态门逐字节相同，
  // 否则已发出的静态请求在重试时会对不上、再写一条。动态门把本次 runId 接在第二个 NUL 后面。
  authRequestToken(taskId, scope = "") {
    let input = "lah-auth-request\0" + String(taskId);
    if (scope) input += "\0" + String(scope);
    const hex = createHash("sha256").update(input).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  },

  // 认领前的静态门只看没有 scope=dynamic 的 auth_request。缺 DataPart 的旧请求仍算静态。
  // 一次动态批准不能当成 commands.json 下限已满足，一次动态驳回也不能把静态门卡死。
  async preflightAuthRequestOf(task, msgs) {
    const requests = [];
    for (const m of msgs || []) {
      if (f1(m, "Kind") !== "auth_request") continue;
      const data = await this.msgData(m);
      if (String(data.scope ?? "") === "dynamic") continue;
      requests.push(m);
    }
    const pointed = requests.find((m) => f1(m, "Msg_ID") === f1(task, "Status_Msg"));
    return pointed || this.latestMsg(requests);
  },

  // 该请求下最新一条有效决定的值（approve / reject / 其它文本），没有有效决定则 null。
  // 本机配了 hub 公钥时，签名缺失或对不上的决定当作不存在：行上的 From_Node=hub 是自报的，谁都能写（标准 §8.3 第 5 条）。
  async decisionForRequest(task, msgs, requestId) {
    const candidates = (msgs || []).filter((m) =>
      f1(m, "Kind") === "auth_decision" &&
      f1(m, "From_Node") === "hub" &&
      f1(m, "Role") === "user" &&
      f1(m, "In_Reply_To") === requestId)
      .sort((a, b) => (this.msgNewer(a, b) ? -1 : 1));
    const pinned = String(this.cfg.hubPublicKey ?? "").trim();
    const packed = [];
    for (const m of candidates) {
      const data = await this.msgData(m);
      const decision = String(data.decision ?? "");
      if (pinned && !verifyDecision(pinned, { taskId: f1(task, "Task_ID"), requestId, decision }, data.sig)) {
        log(`auth_decision ${f1(m, "Msg_ID")} 签名缺失或无效，按没有这条决定处理`);
        continue;
      }
      packed.push({ decision, sig: data.sig });
    }
    return pickSignedDecision(pinned, f1(task, "Task_ID"), requestId, packed);
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
    const decision = await this.decisionForRequest(task, msgs, mid);
    if (decision === null) {
      await this.ensureRequestText(task, mid);
      if (!(await this.updateTaskState(task, { Status: "auth-required", Status_Msg: mid }, allowed))) return true;
      log("auth-required " + taskId);
      return true;
    }
    if (decision === "approve") {
      // 续跑时 Status_Msg 指向 question，不能改回 auth_request，否则呈递去重对不上。
      if (f1(task, "Status") === "submitted" && f1(task, "Status_Msg") !== mid) {
        await this.updateTaskState(task, { Status_Msg: mid }, ["submitted"]);
      }
      return false;
    }
    return true;
  },

  // 审批卡改读首条 instruction，不再读这段正文。这里只给总线留短说明，
  // 标题已是指令前缀时不再写第二遍，空参数也不写，避免同一段话出现三次。
  async approvalBody(task) {
    const skill = this.capLabel(task) || "(空)";
    const named = String(this.commands[this.capKeyOf(task)]?.name ?? "").trim();
    const cap = named && named !== skill
      ? `${clipText(named, 120)}（${clipText(skill, 80)}）`
      : clipText(skill, 80);
    const instructionRaw = String((await this.instructionText(task)) || "").trim();
    const instruction = clipText(instructionRaw || "(无文字指令)", 500);
    let paramText = "";
    try {
      const params = redactValue(await this.getParams(task));
      const emptyObject = params && typeof params === "object" && !Array.isArray(params) && Object.keys(params).length === 0;
      const emptyArray = Array.isArray(params) && params.length === 0;
      if (params != null && params !== "" && !emptyObject && !emptyArray) paramText = JSON.stringify(params);
    } catch { paramText = ""; }
    if (paramText.length > 800) paramText = paramText.slice(0, 800) + "…";
    const title = String(f1(task, "Title") ?? "").trim();
    const lines = ["需机主批准后执行", `能力：${cap}`, instruction];
    if (paramText && paramText !== "{}" && paramText !== "[]") lines.push(`参数：${paramText}`);
    if (title && !instructionRaw.startsWith(title)) lines.push(`标题：${clipText(title, 200)}`);
    return lines.join("\n");
  },

  // 返回 true 表示本轮必须停手。已有批准则返回 false，续跑不必因为 Status_Msg 已指向 question 而再卡一次。
  async askApproval(task) {
    const taskId = f1(task, "Task_ID");
    const allowed = [f1(task, "Status") === "input-required" ? "input-required" : "submitted"];
    let msgs = await this.reloadMessages(taskId);
    let pending = await this.preflightAuthRequestOf(task, msgs);
    if (pending) return this.settleExistingRequest(task, pending, msgs, allowed);
    // 写前再读一次：上一读与写入之间，另一轮可能已经落下这条静态 auth_request。
    msgs = await this.reloadMessages(taskId);
    pending = await this.preflightAuthRequestOf(task, msgs);
    if (pending) return this.settleExistingRequest(task, pending, msgs, allowed);
    const mid = await this.writeAuthRequest(task);
    msgs = await this.reloadMessages(taskId);
    const winner = await this.preflightAuthRequestOf(task, msgs);
    if (winner && f1(winner, "Msg_ID") !== mid) {
      return this.settleExistingRequest(task, winner, msgs, allowed);
    }
    const useId = (winner && f1(winner, "Msg_ID")) || mid;
    await this.ensureRequestText(task, useId);
    if (!(await this.updateTaskState(task, { Status: "auth-required", Status_Msg: useId }, allowed))) return true;
    log("auth-required " + taskId);
    return true;
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

  // 执行中审批的正文是 Agent 写下的具体动作，不复用认领前的 approvalBody。
  // runId 必须是这次执行段已经持久化的 id：writeRun 在 Run 已 paused 时会另开一行，不能拿它的返回值当 scope。
  async writeDynamicAuthRequest(task, reason, runId) {
    const id = String(runId ?? "").trim();
    if (!id) throw new Error("动态审批缺少稳定 runId");
    const taskId = f1(task, "Task_ID");
    const mid = await this.writeMessage(task, "auth_request", "", {
      clientToken: this.authRequestToken(taskId, id),
      writeParts: false,
    });
    await this.ensureDynamicAuthParts(mid, reason, id);
    return mid;
  },

  async ensureDynamicAuthParts(mid, reason, runId) {
    const parts = await this.listParts(mid);
    const hasText = parts.some((p) => f1(p, "Kind") === "text" && String(f1(p, "Text") ?? "").trim() !== "");
    if (!hasText) {
      const taken = new Set(parts.map((p) => f1(p, "Part_ID")));
      const seq = taken.has(`${mid}-P1`)
        ? this.nextSuffix(parts.map((p) => f1(p, "Part_ID")), /-P(\d+)$/)
        : 1;
      await this.createPart(mid, "message", seq, "text", { text: String(reason ?? "").slice(0, 4000) });
    }
    const again = await this.listParts(mid);
    const hasData = again.some((p) => {
      if (f1(p, "Kind") !== "data") return false;
      try {
        const data = JSON.parse(String(f1(p, "Data") ?? "") || "{}");
        return data.scope === "dynamic" && String(data.run_id ?? "") === String(runId);
      } catch {
        return false;
      }
    });
    if (hasData) return;
    const taken = new Set(again.map((p) => f1(p, "Part_ID")));
    const seq = taken.has(`${mid}-P2`)
      ? this.nextSuffix(again.map((p) => f1(p, "Part_ID")), /-P(\d+)$/)
      : 2;
    await this.createPart(mid, "message", seq, "data", {
      data: JSON.stringify({ scope: "dynamic", run_id: String(runId) }),
    });
  },

  // 续跑时把本任务上每一条已批准的 auth_request 交给执行者。只收验签通过的 approve。
  async collectApprovedAuths(task) {
    const msgs = await this.listMessages(f1(task, "Task_ID"));
    const out = [];
    for (const m of msgs) {
      if (f1(m, "Kind") !== "auth_request") continue;
      const mid = f1(m, "Msg_ID");
      if ((await this.decisionForRequest(task, msgs, mid)) !== "approve") continue;
      const data = await this.msgData(m);
      out.push({
        msg_id: mid,
        text: await this.msgText(m),
        scope: String(data.scope ?? "") || "preflight",
        run_id: String(data.run_id ?? ""),
        decision: "approve",
      });
    }
    return out;
  },
};
