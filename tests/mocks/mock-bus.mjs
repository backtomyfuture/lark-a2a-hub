// 内存版飞书总线，给 Kernel 与 hub 的测试用。不读环境变量，不访问网络，不碰 ~/.hub-node。
//
// 用法：
//   import { f1 } from "../../src/bus/feishu.mjs";
//   const bus = new MockFeishuBus({
//     tables: { tasks: "tbl_tasks", messages: "tbl_messages", parts: "tbl_parts",
//               runs: "tbl_runs", artifacts: "tbl_artifacts", agentCards: "tbl_cards" },
//   });
//   const created = await bus.createRecord(bus.tables.tasks, { Task_ID: "TASK-1", Status: "submitted" });
//   f1(await bus.getRecord(bus.tables.tasks, created.record.record_id), "Status") === "submitted"
//   await bus.findRecords(bus.tables.tasks, "Task_ID", "TASK-1")
//
// 字段按线上形态保存：写入的标量收成单元素数组，读的时候仍用 f1() 取标量。
// 已经是数组的值原样保存（飞书多选），不再套一层。
// createRecord 的返回值对齐飞书 data：{ record: { record_id, fields } }。
// getRecord 对齐 d.record；没有这条记录时返回 null，不抛网络错误。
// 带了 client_token 的再次 create 返回已有行，不插第二行（对齐飞书幂等创建）。
//
// 失败注入（落库前抛出，不会留下半行）：
//   bus.failNext({ op: "update", table: bus.tables.tasks }); // 默认错误含 1254291
//   bus.failNext((ctx) => ctx.op === "create", new Error("boom"));
// journal 只记录已经成功的调用，元素为 { op, table, recordId, fields }。
// 后续波次（在途执行账本、回执 later/session/usage）直接复用本类，不要再包一层假 HTTP。

export class MockFeishuBus {
  constructor({ tables } = {}) {
    if (!tables || typeof tables !== "object") throw new Error("MockFeishuBus 需要 tables");
    this.tables = tables;
    this._seq = 1;
    this._rows = new Map();
    this._tokens = new Map();
    this._faults = [];
    this.journal = [];
    this.sent = [];
    for (const id of Object.values(tables)) {
      if (id) this._rows.set(id, []);
    }
  }

  // 对齐 FeishuBus.tenantToken：测试里内核启动会调一次，这里不打开放平台。
  async tenantToken() {
    return "test-tenant-token";
  }

  // partial 为 { op, table } 的子集，或 (ctx) => boolean。用掉一次就摘掉。
  failNext(partial, error = new Error("write conflict 1254291")) {
    const match = typeof partial === "function"
      ? partial
      : (ctx) => Object.entries(partial).every(([k, v]) => ctx[k] === v);
    this._faults.push({ match, error });
    return this;
  }

  async listRecords(table) {
    this._known(table);
    await this._gate({ op: "list", table });
    const rows = this._rows.get(table).map((row) => this._clone(row));
    this._note({ op: "list", table });
    return rows;
  }

  async getRecord(table, recordId) {
    this._known(table);
    await this._gate({ op: "get", table, recordId });
    const row = this._rows.get(table).find((item) => item.record_id === recordId);
    this._note({ op: "get", table, recordId });
    return row ? this._clone(row) : null;
  }

  async findRecords(table, field, value) {
    const rows = await this.listRecords(table);
    return rows.filter((row) => this._scalar(row.fields?.[field]) === value);
  }

  async createRecord(table, fields, clientToken) {
    this._known(table);
    await this._gate({ op: "create", table, fields, clientToken });
    const token = clientToken ? String(clientToken) : "";
    if (token) {
      const hit = this._tokens.get(`${table}\0${token}`);
      if (hit) {
        const existing = this._rows.get(table).find((item) => item.record_id === hit);
        if (existing) {
          this._note({ op: "create", table, recordId: hit, fields: this._clone(existing).fields, idempotent: true });
          return { record: this._clone(existing) };
        }
      }
    }
    const record = {
      record_id: `rec_${this._seq++}`,
      fields: this._wrap(fields),
    };
    this._rows.get(table).push(record);
    if (token) this._tokens.set(`${table}\0${token}`, record.record_id);
    this._note({ op: "create", table, recordId: record.record_id, fields: this._clone(record).fields });
    return { record: this._clone(record) };
  }

  async updateRecord(table, recordId, fields) {
    this._known(table);
    await this._gate({ op: "update", table, recordId, fields });
    const row = this._rows.get(table).find((item) => item.record_id === recordId);
    if (!row) throw new Error(`record not found: ${table}/${recordId}`);
    const wrapped = this._wrap(fields);
    row.fields = { ...row.fields, ...wrapped };
    this._note({ op: "update", table, recordId, fields: this._clone({ fields: wrapped }).fields });
    return { record: this._clone(row) };
  }

  async sendMessage(receiveId, msgType, content, receiveIdType = "open_id") {
    await this._gate({ op: "send", table: "", receiveId, msgType });
    const item = {
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: msgType,
      content: typeof content === "string" ? content : JSON.stringify(content),
    };
    this.sent.push(item);
    this._note({ op: "send", table: "", fields: item });
    return { message_id: `om_${this._seq++}` };
  }

  sendCard(openId, card) {
    return this.sendMessage(openId, "interactive", card, "open_id");
  }

  _known(table) {
    if (!this._rows.has(table)) throw new Error(`unknown table: ${table}`);
  }

  async _gate(ctx) {
    const idx = this._faults.findIndex((fault) => fault.match(ctx));
    if (idx < 0) return;
    const [fault] = this._faults.splice(idx, 1);
    throw fault.error;
  }

  _note(entry) {
    this.journal.push(entry);
  }

  _wrap(fields) {
    const out = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      out[key] = Array.isArray(value) ? value.slice() : [value];
    }
    return out;
  }

  _scalar(value) {
    if (Array.isArray(value)) return value[0] ?? "";
    return value ?? "";
  }

  _clone(row) {
    return structuredClone(row);
  }
}
