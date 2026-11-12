import { randomUUID } from "node:crypto";
import { log as defaultLog } from "../kernel-util.mjs";

// 总线后端：飞书多维表格（一号后端）。
// 只做三件事：拿 tenant token、读写记录、扛住限流与同表写冲突。
// 退避：HTTP 429/500/502/503，以及业务码 1254290（请求过快，HTTP 200）、1254291（同表写冲突）。
// HTTP 429 且响应体 99991403（基础版月度配额用尽）不重试：再试也过不了，只会把配额错误刷成普通 429。
// takeStats() 计的是这里发出的记录请求（含重试那几次），不含 tenant token。
// 零依赖：用 Node >= 24 的全局 fetch。

// 国内飞书与国际版 Lark 是两套域名、两套租户，接口路径相同。node.json 的 domain 选其一，缺省 feishu。
const OPEN_HOSTS = { feishu: "open.feishu.cn", lark: "open.larksuite.com" };

// 取值写错就直接报错，不悄悄回退到飞书：凭据发错域名只会得到一串看不懂的鉴权失败。
export function openHost(domain) {
  const key = String(domain ?? "").trim() || "feishu";
  if (!Object.hasOwn(OPEN_HOSTS, key)) throw new Error(`domain 只能是 feishu 或 lark，收到 ${JSON.stringify(domain)}`);
  return OPEN_HOSTS[key];
}

const DEFAULT_DELAYS_MS = [0, 2000, 5000, 15000];
const STAT_KINDS = new Set(["list", "get", "write", "other"]);

// 只接受像 ENOTFOUND 这样的码。任意 cause.code 可能带路径或主机名，不能进日志。
function netReason(e) {
  const code = e?.cause?.code;
  if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return `net-${code}`;
  return "error";
}

export class FeishuBus {
  constructor({ appId, appSecret, baseToken, tables, domain, log, delaysMs } = {}) {
    this.domain = String(domain ?? "").trim() || "feishu";
    this.apiBase = `https://${openHost(this.domain)}/open-apis`;
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseToken = baseToken;
    this.tables = tables; // { tasks, messages, parts, runs, artifacts, agentCards }
    this._token = null;
    this._tokenExp = 0;
    // log / delaysMs 只给测试注入。空数组会让循环一次都不发请求，退回默认四档。
    this.log = log ?? defaultLog;
    this._delays = Array.isArray(delaysMs) && delaysMs.length ? delaysMs : DEFAULT_DELAYS_MS;
    this._stats = { list: 0, get: 0, write: 0, other: 0, backoff: 0 };
  }

  // 返回自上一次调用以来的计数并清零。一行日志里的数因此是增量，按天相加就是总量。
  takeStats() {
    const snap = { ...this._stats };
    this._stats = { list: 0, get: 0, write: 0, other: 0, backoff: 0 };
    return snap;
  }

  async tenantToken() {
    if (this._token && Date.now() < this._tokenExp - 120_000) return this._token;
    const r = await fetch(`${this.apiBase}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error("tenant token failed: " + d.msg);
    this._token = d.tenant_access_token;
    this._tokenExp = Date.now() + (d.expire ?? 7200) * 1000;
    return this._token;
  }

  // 写冲突、请求过快与 429/5xx 退避。其余业务码直接抛。
  // 日志和耗尽错误只写归一后的 reason：path 里有 base token 和 table_id，e.message 可能带 URL。
  async api(method, path, payload, kind = "other") {
    if (!STAT_KINDS.has(kind)) kind = "other";
    let reason = "error";
    const delays = this._delays;
    for (let i = 0; i < delays.length; i++) {
      // 先记上一次为什么要重发，再发下一次。delay 为 0 也记，否则测试注入的零等待看不出退避。
      if (i > 0) {
        this._stats.backoff += 1;
        this.log(`api backoff reason=${reason} kind=${kind} retry=${i}/${delays.length - 1} wait=${delays[i] / 1000}s`);
        if (delays[i]) await new Promise((res) => setTimeout(res, delays[i]));
      }
      try {
        const token = await this.tenantToken();
        // 令牌请求走 tenantToken 自己的 fetch，不进这四个计数，也不占月度配额。
        this._stats[kind] += 1;
        const r = await fetch(this.apiBase + path, {
          method,
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: payload !== undefined ? JSON.stringify(payload) : undefined,
        });
        if (r.status === 429) {
          const body = await r.json().catch(() => null);
          // 月度配额用尽再退避只是空转。文案以 api code 开头，下面的 catch 会原样抛出。
          if (body?.code === 99991403) {
            throw new Error("api code 99991403: monthly quota exceeded（飞书基础版月度 API 调用量已用尽，重试无效；见 https://open.feishu.cn/document/platform-notices/platform-updates-/custom-app-api-call-limit）");
          }
          reason = "http-429";
          continue;
        }
        if (r.status === 500 || r.status === 502 || r.status === 503) {
          reason = `http-${r.status}`;
          continue;
        }
        const d = await r.json();
        // 1254290 的官方形态是 HTTP 200 + 业务码。这里不抛，避免被 catch 当成不可重试的 api code。
        if (d.code === 1254290 || d.code === 1254291) {
          reason = `code-${d.code}`;
          continue;
        }
        if (d.code !== 0) throw new Error(`api code ${d.code}: ${d.msg}`);
        return d.data;
      } catch (e) {
        if (String(e?.message ?? "").startsWith("api code")) throw e;
        reason = netReason(e);
      }
    }
    // 不拼异常对象。这条错误会进 poll error 日志，e.message 里的请求地址不能跟着出去。
    throw new Error("api retry exhausted: " + reason);
  }

  async listRecords(table) {
    const items = [];
    let page = null;
    for (;;) {
      // 列表接口单页上限 500。整表扫描的请求数随行数线性涨，页开满能少发五分之四。
      let path = `/bitable/v1/apps/${this.baseToken}/tables/${table}/records?page_size=500`;
      if (page) path += "&page_token=" + page;
      const d = await this.api("GET", path, undefined, "list");
      items.push(...(d.items ?? []));
      if (d.has_more) page = d.page_token;
      else return items;
    }
  }

  async getRecord(table, recordId) {
    const d = await this.api("GET", `/bitable/v1/apps/${this.baseToken}/tables/${table}/records/${recordId}`, undefined, "get");
    return d.record;
  }

  // clientToken 可选。传入则原样写入查询参数；不传则本次调用生成一个。
  // api() 的退避重试复用同一条 path，因此同一个 token 不会在响应丢失后插出第二行。
  createRecord(table, fields, clientToken) {
    const token = clientToken || randomUUID();
    const q = "client_token=" + encodeURIComponent(token);
    return this.api(
      "POST",
      `/bitable/v1/apps/${this.baseToken}/tables/${table}/records?${q}`,
      { fields },
      "write",
    );
  }

  updateRecord(table, recordId, fields) {
    return this.api("PUT", `/bitable/v1/apps/${this.baseToken}/tables/${table}/records/${recordId}`, { fields }, "write");
  }

  // 发 IM 消息。content 可以是对象，这里会先变成飞书要求的 JSON 字符串。
  // 只给 hub 角色发卡用；节点认领路径不调用。
  sendMessage(receiveId, msgType, content, receiveIdType = "open_id") {
    const q = "receive_id_type=" + encodeURIComponent(receiveIdType);
    return this.api("POST", `/im/v1/messages?${q}`, {
      receive_id: receiveId,
      msg_type: msgType,
      content: typeof content === "string" ? content : JSON.stringify(content),
    }, "other");
  }

  sendCard(openId, card) {
    return this.sendMessage(openId, "interactive", card, "open_id");
  }
}

// 飞书字段值常为单元素数组，取标量。
export function f1(rec, name) {
  const v = rec?.fields?.[name];
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}
