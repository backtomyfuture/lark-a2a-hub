// hub 角色建单。严格按「instruction 消息 → Parts → Tasks 行」写入。
// Tasks 行是节点的触发信号，必须最后写，否则节点会抢跑、读到空参数。
// 参数里的执行控制键直接拒绝，规则用 kernel 的 controlKeysIn，写之前就停。
// 停派或 offline 的名片、对不上的父 Context_ID，也在第一笔写之前拒绝，避免门铃已经发出。

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { controlKeysIn } from "../config.mjs";
import { f1 } from "../bus/feishu.mjs";

const APPROVALS = new Set(["auto", "notify", "approve"]);
// 与 src/kernel.mjs 的 HOP_LIMIT 对齐。超过 8 的单节点会直接熔断，这里不落表。
const HOP_LIMIT = 8;

export function formatCreatedAt(date) {
  // 与 kernel.nowStr 同一口径：本地时间 ISO 8601 带时区偏移，跨节点可比可排序。
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}`;
}

function assertNoControl(obj) {
  const bad = controlKeysIn(obj);
  if (!bad.length) return;
  throw new Error(
    `拒绝建单：params 含执行控制键（${bad.join(", ")}）。要执行的命令、目录、语境、Agent 与权限只来自目标节点本机 commands.json；唯一例外是 timeout_sec。`,
  );
}

export function parseParams(raw) {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "object") {
    if (Array.isArray(raw)) throw new Error("params 必须是 JSON 对象");
    assertNoControl(raw);
    return raw;
  }
  let text = String(raw);
  if (text.startsWith("@")) {
    const file = text.slice(1);
    if (!file) throw new Error("--params @文件 缺少路径");
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      throw new Error("读 params 文件失败：" + e.message);
    }
  }
  if (!String(text).trim()) return undefined;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("params 不是合法 JSON");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("params 必须是 JSON 对象");
  assertNoControl(obj);
  return obj;
}

export function parseCreateArgv(argv) {
  const out = {
    configDir: "", from: "", source: "", to: "", cap: "", text: "", paramsRaw: undefined, context: "", ref: "", approval: "", idempotencyKey: "",
  };
  const take = (i, flag) => {
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error(`${flag} 需要参数`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--config") out.configDir = take(i, flag);
    else if (flag === "--from") out.from = take(i, flag);
    else if (flag === "--source") out.source = take(i, flag);
    else if (flag === "--to") out.to = take(i, flag);
    else if (flag === "--cap" || flag === "--skill") out.cap = take(i, flag);
    else if (flag === "--text") out.text = take(i, flag);
    else if (flag === "--params") out.paramsRaw = take(i, flag);
    else if (flag === "--context") out.context = take(i, flag);
    else if (flag === "--ref") out.ref = take(i, flag);
    else if (flag === "--approval") out.approval = take(i, flag);
    else if (flag === "--idempotency-key") out.idempotencyKey = take(i, flag);
    else throw new Error("无法识别的参数：" + flag);
    if (flag.startsWith("--")) i++;
  }
  if (!String(out.to).trim() && !String(out.cap).trim()) {
    throw new Error("task create 需要指定 --to <node> 或 --cap/--skill <cap_id>");
  }
  return out;
}

function splitRefs(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  const ids = String(raw).split(",").map((item) => item.trim()).filter(Boolean);
  for (const id of ids) {
    if (/\s/.test(id)) throw new Error("Ref_Task_IDs 里有无法识别的任务号：" + id);
  }
  return ids;
}

function cardText(card, name) {
  return String(f1(card, name) ?? "").trim();
}

// 标准 §10.1：只接受 Dispatchable=Yes。目标离线（Availability=offline）仍可正常建单入队。
// 返回空数组表示可派；否则是写进错误里的原因，调用方据此在写表前拒绝。
function undispatchableReason(card) {
  const reasons = [];
  const dispatchable = String(f1(card, "Dispatchable") ?? "");
  if (dispatchable !== "Yes") {
    reasons.push(dispatchable === "No"
      ? "已停派（Dispatchable=No）"
      : `不可派（Dispatchable=${dispatchable || "未设置"}，需要 Yes）`);
  }
  return reasons;
}

function rejectBlocked(cards, lead) {
  const detail = cards.map((card) => {
    const skill = cardText(card, "Skill_ID") || "未命名技能";
    const capId = cardText(card, "Cap_ID");
    const node = cardText(card, "Node");
    const tags = [
      node ? `节点 ${node}` : "",
      `技能 ${skill}`,
      capId ? `Cap_ID ${capId}` : "",
    ].filter(Boolean);
    return `${tags.join("，")}：${undispatchableReason(card).join("，")}`;
  }).join("；");
  throw new Error(`拒绝建单：${lead}：${detail}`);
}

function titleOf(text, cap, node) {
  const line = String(text ?? "").split("\n").map((item) => item.trim()).find(Boolean);
  const base = line || `${cap} @ ${node}`;
  return base.length > 200 ? base.slice(0, 200) + "…" : base;
}

function freshTaskId(taken, now) {
  const p = (n) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  for (let i = 0; i < 8; i++) {
    const id = `TASK-${day}-${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
  throw new Error("无法生成不重复的 Task_ID");
}

export async function createTask({
  bus, from = "", source = "", to, cap, text = "", params, context = "", ref = "", approval = "", idempotencyKey = "", now = new Date(), validateTarget = true,
}) {
  if (!bus?.tables?.messages || !bus.tables.parts || !bus.tables.tasks) {
    throw new Error("总线缺少 messages / parts / tasks 表");
  }
  const rawTo = String(to ?? "").trim();
  const rawCap = String(cap ?? "").trim();
  let node = rawTo;
  let skill = rawCap;

  // 若总线提供了 AgentCards 表，尝试自动解析能力与节点并按名册校验
  if (bus.tables.agentCards) {
    let cards = [];
    try {
      cards = await bus.listRecords(bus.tables.agentCards);
    } catch (e) {
      throw new Error(`读取 AgentCards 名册失败：${e?.message ?? e}`);
    }

    // F1 校验：显式 --to 须在 AgentCards 有名片；显式 --cap 须在目标节点已登记该技能。
    // 只校验存在性与 Dispatchable=Yes，不校验 Availability（目标离线仍可建单入队）。
    if (validateTarget) {
      if (rawTo) {
        const nodeCards = cards.filter((card) => cardText(card, "Node") === rawTo);
        if (!nodeCards.length) {
          const existingNodes = [...new Set(cards.map((c) => cardText(c, "Node")).filter(Boolean))];
          const hint = existingNodes.length ? `当前已登记节点：${existingNodes.join(", ")}` : "（当前名册无任何已登记节点）";
          throw new Error(`拒绝建单：目标节点 "${rawTo}" 未在 AgentCards 登记名片。${hint}`);
        }
        if (rawCap) {
          const capMatch = nodeCards.some((card) => {
            if (cardText(card, "Cap_ID") === rawCap) return true;
            if (cardText(card, "Skill_ID") === rawCap) return true;
            if (rawCap.startsWith("CAP-")) {
              const parts = rawCap.split("-");
              if (parts.length >= 3 && parts.slice(2).join("-") === cardText(card, "Skill_ID")) return true;
            }
            return false;
          });
          if (!capMatch) {
            const nodeSkills = [...new Set(nodeCards.map((c) => cardText(c, "Skill_ID")).filter(Boolean))];
            const hint = nodeSkills.length ? `该节点已登记能力：${nodeSkills.join(", ")}` : "（该节点未登记任何能力）";
            throw new Error(`拒绝建单：目标节点 "${rawTo}" 未登记能力 "${rawCap}"。${hint}`);
          }
        }
      } else if (rawCap) {
        const anyMatch = cards.some((card) => {
          if (cardText(card, "Cap_ID") === rawCap) return true;
          if (cardText(card, "Skill_ID") === rawCap) return true;
          if (rawCap.startsWith("CAP-")) {
            const parts = rawCap.split("-");
            if (parts.length >= 3 && parts.slice(2).join("-") === cardText(card, "Skill_ID")) return true;
          }
          return false;
        });
        if (!anyMatch) {
          const allSkills = [...new Set(cards.map((c) => cardText(c, "Skill_ID")).filter(Boolean))];
          const hint = allSkills.length ? `当前名册已登记能力：${allSkills.join(", ")}` : "（当前名册无任何登记能力）";
          throw new Error(`拒绝建单：未找到提供能力 "${rawCap}" 的节点。${hint}`);
        }
      }
    }

    const skillMatches = (skillId) => cards.filter((card) => {
      const sameSkill = cardText(card, "Skill_ID") === skillId;
      const sameNode = node ? cardText(card, "Node") === node : true;
      return sameSkill && sameNode;
    });
    // 先丢掉停派，再在剩下的里面沿用原顺序取第一张（优先挑选 online 节点）。
    // 指定了具体名片时不能改挑另一张，所以 Cap_ID 命中坏名片要直接拒绝。
    const adoptSkill = (matches, lead) => {
      const usable = matches.filter((card) => undispatchableReason(card).length === 0);
      if (!usable.length) {
        rejectBlocked(matches, lead);
      }
      const isOnline = (card) => String(f1(card, "Availability") ?? "").toLowerCase() !== "offline";
      const sorted = usable.slice().sort((a, b) => (isOnline(b) ? 1 : 0) - (isOnline(a) ? 1 : 0));
      const chosen = sorted[0];
      skill = cardText(chosen, "Skill_ID") || skill;
      if (!node) node = cardText(chosen, "Node");
    };

    // 1. 若提供了 cap：尝试在 AgentCards 中精确查找 Cap_ID 或 Skill_ID
    if (skill) {
      const requested = skill;
      const matchCap = cards.find((card) => cardText(card, "Cap_ID") === requested);
      if (matchCap) {
        if (undispatchableReason(matchCap).length) {
          rejectBlocked([matchCap], "指定的能力不可派");
        }
        skill = cardText(matchCap, "Skill_ID") || requested;
        if (!node) node = cardText(matchCap, "Node");
      } else {
        const matches = skillMatches(requested);
        if (matches.length) {
          adoptSkill(matches, "指定的能力不可派");
        } else if (requested.startsWith("CAP-")) {
          // 形如 CAP-<prefix>-<skill>，表里没有这张 Cap_ID 时仍把后缀当 Skill_ID。
          // 不在这里改挑节点：后缀只用来发现「已经命中、且全部不可派」的名片并拒绝。
          // 否则这条回退会把停派技能照样派出去，绕开 §10.1。
          const parts = requested.split("-");
          if (parts.length >= 3) {
            const extracted = parts.slice(2).join("-");
            const extractedMatches = skillMatches(extracted);
            const extractedUsable = extractedMatches.filter((card) => undispatchableReason(card).length === 0);
            if (extractedMatches.length && !extractedUsable.length) {
              rejectBlocked(extractedMatches, "指定的能力不可派");
            }
            skill = extracted;
          }
        }
      }
    }

    // 2. 若未提供 cap 但提供了 to（目标节点）：自动挑选该节点的首选技能。
    // 先滤掉不可派的名片再打分，否则停派的 agent 会以 200 分压过可用技能。
    if (!skill && node) {
      const nodeCards = cards.filter((card) => cardText(card, "Node") === node);
      const usable = nodeCards.filter((card) => undispatchableReason(card).length === 0);
      if (nodeCards.length > 0 && !usable.length) {
        rejectBlocked(nodeCards, `节点 ${node} 没有可派发的能力`);
      }
      if (usable.length > 0) {
        const isOnline = (card) => String(f1(card, "Availability") ?? "").toLowerCase() !== "offline";
        const priority = (card) => {
          const sid = String(f1(card, "Skill_ID") ?? "").toLowerCase();
          const online = isOnline(card) ? 10 : 0;
          let isAgentNode = false;
          try {
            const meta = JSON.parse(String(f1(card, "Metadata") ?? "{}"));
            if (meta?.kind === "agent" || meta?.mode === "inbox") isAgentNode = true;
          } catch {}
          if (sid === "agent" || isAgentNode) return 200 + online;
          if (sid.endsWith("-agent")) return 80 + online;
          if (sid.includes("agent")) return 70 + online;
          return 50 + online;
        };
        const sorted = usable.slice().sort((a, b) => priority(b) - priority(a));
        skill = String(f1(sorted[0], "Skill_ID") ?? "").trim();
      }
    }
  }

  if (!node) throw new Error("task create 需要 --to <node>（或提供可在 AgentCards 反查到节点的 --cap/--skill）");
  if (!skill) throw new Error(`task create 未指定 --cap/--skill，且目标节点 ${node} 未登记任何可用能力`);
  const sender = String(from || source || "hub").trim();
  const taskSource = String(source || from || "hub").trim();
  const data = parseParams(params);
  const approvalClass = String(approval ?? "").trim();
  if (approvalClass && !APPROVALS.has(approvalClass)) {
    throw new Error("--approval 只能是 auto、notify 或 approve");
  }
  const refs = splitRefs(ref);
  const clock = now instanceof Date ? now : new Date(now);
  // 先只读。任何拒绝都发生在第一笔写之前。
  const existing = await bus.listRecords(bus.tables.tasks);
  const taken = new Set(existing.map((row) => String(f1(row, "Task_ID") ?? "")).filter(Boolean));
  let hop = 0;
  let inheritedContext = "";
  if (refs.length) {
    const missing = [];
    const parentContexts = [];
    for (const id of refs) {
      const parent = existing.find((row) => String(f1(row, "Task_ID") ?? "") === id);
      if (!parent) {
        missing.push(id);
        continue;
      }
      parentContexts.push({
        id,
        contextId: String(f1(parent, "Context_ID") ?? "").trim(),
      });
      const parentHop = Number(f1(parent, "Hop_Count"));
      const normalized = Number.isFinite(parentHop) && parentHop > 0 ? parentHop : 0;
      if (normalized + 1 > hop) hop = normalized + 1;
    }
    if (missing.length) throw new Error("引用的任务不存在：" + missing.join(","));
    if (hop > HOP_LIMIT) {
      throw new Error(`拒绝建单：派生后 Hop_Count=${hop} 超过上限 ${HOP_LIMIT}`);
    }
    // 标准 §8.2：没给 --context 才继承。多个父任务会话键不一致就停，
    // 避免把两件不同的事并进一个新会话。显式 --context 以调用方为准。
    if (!String(context ?? "").trim()) {
      const distinct = [...new Set(parentContexts.map((item) => item.contextId))];
      if (distinct.length > 1) {
        const detail = parentContexts.map((item) => `${item.id}=${item.contextId || "空"}`).join("，");
        throw new Error(`拒绝建单：引用的父任务 Context_ID 不一致（${detail}）。请显式指定 --context。`);
      }
      inheritedContext = distinct[0] || "";
    }
  }
  const taskId = freshTaskId(taken, clock);
  // 父任务没有 Context_ID 时无从继承，仍生成新会话键，避免把空字符串写入。
  const contextId = String(context ?? "").trim() || inheritedContext || `CTX-${taskId.slice("TASK-".length)}`;
  const msgId = `MSG-${taskId.slice("TASK-".length)}-01`;
  const createdAt = formatCreatedAt(clock);
  const instruction = String(text ?? "").slice(0, 4000);

  const messageFields = {
    Msg_ID: msgId,
    Task_ID: taskId,
    Context_ID: contextId,
    From_Node: sender,
    To_Node: node,
    Role: "user",
    Kind: "instruction",
    Created_At: createdAt,
  };
  if (refs.length) messageFields.Ref_Task_IDs = refs.join(",");
  await bus.createRecord(bus.tables.messages, messageFields);

  let seq = 0;
  if (instruction.trim()) {
    seq += 1;
    await bus.createRecord(bus.tables.parts, {
      Part_ID: `${msgId}-P${seq}`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: seq,
      Kind: "text",
      Text: instruction,
    });
  }
  if (data) {
    seq += 1;
    await bus.createRecord(bus.tables.parts, {
      Part_ID: `${msgId}-P${seq}`,
      Parent_ID: msgId,
      Parent_Type: "message",
      Seq: seq,
      Kind: "data",
      Data: JSON.stringify(data),
    });
  }

  const taskFields = {
    Task_ID: taskId,
    Title: titleOf(instruction, skill, node),
    Source: taskSource,
    Target_Node: node,
    Skill_ID: skill,
    Status: "submitted",
    Hop_Count: hop,
    // 调用方给了键就用原值：重试同一动作时靠它命中节点侧的重复拒收（标准 §4 幂等）。
    // 不给才生成随机键——那种单永远查不出重复，只作占位。
    Idempotency_Key: String(idempotencyKey ?? "").trim() || `${sender}-${randomUUID()}`,
    Context_ID: contextId,
    Retry_Count: 0,
  };
  if (approvalClass) taskFields.Approval_Class = approvalClass;
  // 最后写任务行。前面的消息和 Parts 已经落表，节点被这条记录叫醒时读得到参数。
  await bus.createRecord(bus.tables.tasks, taskFields);
  return taskId;
}
