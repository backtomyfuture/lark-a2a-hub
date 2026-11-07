#!/usr/bin/env node
// 从一张活的中台 Base 生成 schema/base-schema.json 与 docs/base-schema.md。
//
// 用法（在本仓库根目录）：
//   APP_ID=<hub应用> APP_SECRET=<...> HUB_BASE_TOKEN=<Base token> \
//       node schema/generate_schema.mjs
//
// 生成的文档以线上字段为准——先改表、再跑本脚本、最后提交，避免文档与
// 实现漂移。表按名字发现（不依赖 table_id），字段类型与单选选项取自字段 API。
// 输出字节与原先的生成器保持一致（字段顺序、缩进、换行、标题文字），
// 所以生成物里的 generated_by 仍写 schema/generate_schema.py。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://open.feishu.cn/open-apis";
const BASE = process.env.HUB_BASE_TOKEN;
const TABLES = [
  ["Tasks", "Task：一件工作的信封与状态机，一行一任务"],
  ["Messages", "Message：任务内全部对话轮次，只追加，一行一消息（正文在 Parts）"],
  ["Parts", "Part：消息与产物的内容块，一行一块，text/file/data 三型"],
  ["Runs", "（本地表）每次执行的起止、结果与报错"],
  ["Artifacts", "Artifact：交付物登记，内容为其 FilePart，修订＝同名新 ID"],
  ["AgentCards", "AgentCard 规范化展开：一行一项能力"],
  ["Rules_路由规则", "（本地表）路由与审批策略的唯一现行来源"],
];

// 字段说明（文档层语义；结构事实以线上字段为准，生成时合并）
const NOTES = {
  Tasks: {
    Task_ID: "业务编号，唯一、人可读，发起方生成后不变",
    Context_ID: "会话键（A2A contextId）：同一件事的全部任务共享",
    Status: "A2A 八态状态机，见标准 §2；终态不可变",
    Status_Msg: "（扩展）指向当前提问/待批消息的 Msg_ID",
    Metadata: "A2A 原生自由字段（JSON）；非核心本地信息放这里，不新增列",
    Target_Node: "（扩展）目标节点名，与 AgentCards.Node 对应",
    Skill_ID: "（扩展）要调用的技能 id，与 AgentCards.Skill_ID 对应",
    Approval_Class: "（扩展）auto / notify / approve，approve 类须走审批流（标准 §8.3）",
    Hop_Count: "（扩展）派生层数，>8 熔断",
    Idempotency_Key: "（扩展）建单幂等键：来源+业务键",
    Claimed_By: "（扩展）认领租约：当前持有节点",
    Heartbeat_At: "（扩展）认领心跳；20 分钟无心跳视为放弃、可回收",
    Retry_Count: "（扩展）失败重试计数，上限 2",
    Latest_Run: "（扩展）最新一条 Run 的 Run_ID",
    Presented: "（扩展）结果是否已呈递给操作者（Yes/No）",
    Source: "（扩展）任务来源：hub / cron / manual / agent-derived 等",
  },
  Messages: {
    Msg_ID: "主键，同时是幂等键（重复投递靠它去重）",
    Kind: "instruction / question / answer / auth_request / auth_decision / progress / result / notice",
    Role: "user（发起方→执行方）/ agent（执行方→发起方）",
    Ref_Task_IDs: "A2A referenceTaskIds：本消息关联/派生的前任任务",
    In_Reply_To: "（扩展）所回复消息的 Msg_ID，构成对话链",
    Artifact_Ref: "（扩展）关联的 Artifact_ID（result 消息用）",
  },
  Parts: {
    Parent_ID: "所属消息 Msg_ID 或产物 Artifact_ID",
    Parent_Type: "message / artifact",
    Kind: "text / file / data（A2A TextPart / FilePart / DataPart）",
    Data: "data 块的 JSON：任务参数、审批决定 {\"decision\": \"approve\"} 等走这里",
    Text: "text 块正文；长内容只放指针，本体进飞书文档",
  },
  Runs: {
    Run_ID: "形如 <Task_ID>-R<序号>",
    Outcome: "succeeded / failed / paused（paused＝等补信息暂停，不计失败）",
    Error_Log: "失败信息；沟通内容不写这里，去 Messages",
  },
  Artifacts: {
    Artifact_ID: "建议 <Task_ID>-A<序号>",
    Name: "产物名；同名再交付即新版本（修订＝同名新 ID）",
    Is_Final: "（扩展）是否终稿（Yes/No）",
  },
  AgentCards: {
    Cap_ID: "（扩展）行主键：CAP-<节点前缀>-<技能>",
    Node: "节点名（AgentCard name 的节点部分）",
    Skill_ID: "技能 id（skill.id）",
    Description: "技能说明（skill.description）",
    Dispatchable: "（扩展）Yes 才可派发",
    Availability: "（扩展）online / work-hours / offline 等在册状态",
    Receive_Mode: "（扩展）唤醒方式：event / poll / automation / webhook",
    Side_Effect: "（扩展）read / write / external，决定默认审批等级",
    Metadata: "A2A 原生自由字段（JSON）；内核登记写入 {kind, mode}，可为空",
  },
  "Rules_路由规则": {
    Match_Type: "按 Skill_ID 或标签匹配",
    Enabled: "是否生效（Yes/No）",
    Priority: "多规则命中时按优先级取一",
  },
};

const _tok = { v: null, exp: 0 };

async function tenantToken() {
  if (_tok.v && Date.now() / 1000 < _tok.exp - 120) return _tok.v;
  const body = JSON.stringify({
    app_id: process.env.APP_ID,
    app_secret: process.env.APP_SECRET,
  });
  const res = await fetch(API + "/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error("tenant token failed: " + d.msg);
  _tok.v = d.tenant_access_token;
  _tok.exp = Date.now() / 1000 + (d.expire ?? 7200);
  return _tok.v;
}

async function api(apiPath, params = "") {
  const res = await fetch(API + apiPath + params, {
    headers: {
      Authorization: "Bearer " + await tenantToken(),
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(60_000),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`api ${d.code}: ${d.msg}`);
  return d.data;
}

async function paged(apiPath) {
  const items = [];
  let page = null;
  while (true) {
    const p = page ? "&page_token=" + page : "";
    const d = await api(apiPath, "?page_size=100" + p);
    items.push(...(d.items ?? []));
    if (d.has_more) page = d.page_token;
    else return items;
  }
}

function fieldEntry(f) {
  const entry = {
    name: f.field_name,
    ui_type: Object.hasOwn(f, "ui_type") ? f.ui_type : "",
    type: f.type === undefined ? null : f.type,
    primary: Boolean(f.is_primary),
  };
  const opts = (f.property ?? {}).options ?? [];
  if (opts.length) {
    // 快照必须忠实于线上：选项污染（测试节点名、误写值）要在 Base 本体清洗，
    // 不在这里过滤——过滤只会让 schema 与线上漂移且无人察觉（doctor 契约检查靠这份快照）。
    entry.options = opts.map((o) => o.name);
  }
  // 默认值同理：设了才记，记了 doctor 才看得见；项目口径为一律不设。
  const dv = (f.property ?? {}).default_value;
  if (dv !== null && dv !== undefined && dv !== "") entry.default_value = dv;
  return entry;
}

export async function main() {
  if (!BASE) throw new Error("缺少环境变量 HUB_BASE_TOKEN");
  const tables = await paged(`/bitable/v1/apps/${BASE}/tables`);
  const byName = {};
  for (const t of tables) byName[t.name] = t.table_id;
  const schema = {
    name: "Agent Hub Base（飞书多维表格）",
    generated_by: "schema/generate_schema.py",
    note: "结构事实由线上 Base 字段 API 生成；字段语义见 docs/base-schema.md 与 docs/standard.md。",
    tables: [],
  };
  for (const [name, role] of TABLES) {
    const tid = byName[name];
    if (!tid) {
      throw new Error(`Base 里找不到表：${name}（现有：${Object.keys(byName).join(", ")}）`);
    }
    const fields = [];
    for (const f of await paged(`/bitable/v1/apps/${BASE}/tables/${tid}/fields`)) {
      fields.push(fieldEntry(f));
    }
    schema.tables.push({ name, role, fields });
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.dirname(here);
  // 与原先 json.dump(..., indent=1) 一样：一级一空格，文件末尾不加空行。
  fs.writeFileSync(path.join(here, "base-schema.json"), JSON.stringify(schema, null, 1));

  const lines = [
    "# Base 结构（七表字段级）",
    "",
    "本文件由 `schema/generate_schema.py` 从一张运行中的 Base 生成：字段名、",
    "类型与单选选项均为线上事实（个别一次性测试值已略）；「说明」列为文档层语义，完整规范见",
    "[中台标准](standard.md)。照此结构在飞书多维表格里建表（或用字段 API",
    "批量创建），即可得到一张可用的中台 Base。",
    "",
  ];
  for (const t of schema.tables) {
    lines.push(`## ${t.name}`);
    lines.push("");
    lines.push(t.role);
    lines.push("");
    lines.push("| 字段 | 类型 | 说明 |");
    lines.push("|---|---|---|");
    const notes = NOTES[t.name] ?? {};
    for (const f of t.fields) {
      let desc = notes[f.name] ?? "";
      if (f.options) {
        const opt = "选项：" + f.options.join(" / ");
        desc = desc ? desc + "（" + opt + "）" : opt;
      }
      if (f.primary) desc = desc ? "主字段。" + desc : "主字段";
      lines.push(`| ${f.name} | ${f.ui_type} | ${desc} |`);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(root, "docs", "base-schema.md"), lines.join("\n"));
  console.log("tables:", schema.tables.map((t) => [t.name, t.fields.length]));
}

// /tmp 在 macOS 上是 /private/tmp 的符号链接，只比 resolve 会把直接运行误判成被导入。
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === path.resolve(self);
  }
}

if (invokedDirectly()) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
