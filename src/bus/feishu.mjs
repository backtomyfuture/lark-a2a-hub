import { randomUUID } from "node:crypto";

// 总线后端：飞书多维表格（一号后端）。
// 只做三件事：拿 tenant token、读写记录、扛住同表并发写冲突（1254291）与限流重试。
// 零依赖：用 Node >= 24 的全局 fetch。

// 国内飞书与国际版 Lark 是两套域名、两套租户，接口路径相同。node.json 的 domain 选其一，缺省 feishu。
const OPEN_HOSTS = { feishu: "open.feishu.cn", lark: "open.larksuite.com" };

// 取值写错就直接报错，不悄悄回退到飞书：凭据发错域名只会得到一串看不懂的鉴权失败。
export function openHost(domain) {
  const key = String(domain ?? "").trim() || "feishu";
  if (!Object.hasOwn(OPEN_HOSTS, key)) throw new Error(`domain 只能是 feishu 或 lark，收到 ${JSON.stringify(domain)}`);
  return OPEN_HOSTS[key];
}

export class FeishuBus {
  constructor({ appId, appSecret, baseToken, tables, domain }) {
    this.domain = String(domain ?? "").trim() || "feishu";
    this.apiBase = `https://${openHost(this.domain)}/open-apis`;
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseToken = baseToken;
    this.tables = tables; // { tasks, messages, parts, runs, artifacts, agentCards }
    this._token = null;
    this._tokenExp = 0;
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

  // 与参考实现同一套退避：写冲突 1254291 与 429/5xx 重试，其余错误直接抛。
  async api(method, path, payload) {
    let last = null;
    for (const delay of [0, 2000, 5000, 15000]) {
      if (delay) await new Promise((res) => setTimeout(res, delay));
      try {
        const r = await fetch(this.apiBase + path, {
          method,
          headers: {
            Authorization: "Bearer " + (await this.tenantToken()),
            "Content-Type": "application/json",
          },
          body: payload !== undefined ? JSON.stringify(payload) : undefined,
        });
        if ([429, 500, 502, 503].includes(r.status)) {
          last = new Error("http " + r.status);
          continue;
        }
        const d = await r.json();
        if (d.code === 1254291) {
          last = new Error("write conflict 1254291");
          continue;
        }
        if (d.code !== 0) throw new Error(`api code ${d.code}: ${d.msg}`);
        return d.data;
      } catch (e) {
        if (e.message.startsWith("api code")) throw e;
        last = e;
      }
    }
    throw new Error("api retry exhausted: " + last);
  }

  async listRecords(table) {
    const items = [];
    let page = null;
    for (;;) {
      // 列表接口单页上限 500。整表扫描的请求数随行数线性涨，页开满能少发五分之四。
      let path = `/bitable/v1/apps/${this.baseToken}/tables/${table}/records?page_size=500`;
      if (page) path += "&page_token=" + page;
      const d = await this.api("GET", path);
      items.push(...(d.items ?? []));
      if (d.has_more) page = d.page_token;
      else return items;
    }
  }

  async getRecord(table, recordId) {
    const d = await this.api("GET", `/bitable/v1/apps/${this.baseToken}/tables/${table}/records/${recordId}`);
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
    );
  }

  updateRecord(table, recordId, fields) {
    return this.api("PUT", `/bitable/v1/apps/${this.baseToken}/tables/${table}/records/${recordId}`, { fields });
  }

  // 发 IM 消息。content 可以是对象，这里会先变成飞书要求的 JSON 字符串。
  // 只给 hub 角色发卡用；节点认领路径不调用。
  sendMessage(receiveId, msgType, content, receiveIdType = "open_id") {
    const q = "receive_id_type=" + encodeURIComponent(receiveIdType);
    return this.api("POST", `/im/v1/messages?${q}`, {
      receive_id: receiveId,
      msg_type: msgType,
      content: typeof content === "string" ? content : JSON.stringify(content),
    });
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
