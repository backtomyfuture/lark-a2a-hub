// Tasks.Metadata 上的 usage / later 合并写。写失败只记日志，不影响已经落下的回执。
import { f1 } from "./bus/feishu.mjs";
import { log, readTaskMeta } from "./kernel-util.mjs";
import { addUsage } from "./receipt.mjs";

export const metadataMethods = {

  // 先读后合并。写失败只记日志：回执已经落在 Tasks 状态上，不能因为用量或复查再失败一次。
  async mergeTaskMeta(task, label, mutate) {
    try {
      const fresh = await this.bus.getRecord(this.T.tasks, task.record_id);
      if (!fresh) return;
      const read = readTaskMeta(f1(fresh, "Metadata"));
      if (!read.ok) {
        log(`Tasks.Metadata 无法合并，跳过 ${label}（不影响回执）`);
        return;
      }
      mutate(read.meta);
      await this.bus.updateRecord(this.T.tasks, fresh.record_id, {
        Metadata: JSON.stringify(read.meta),
      });
    } catch (e) {
      log(`Tasks.Metadata.${label} 写失败（不影响回执）：` + (e?.message ?? e));
    }
  },

  async applyUsage(task, report) {
    await this.mergeTaskMeta(task, "usage", (meta) => {
      meta.usage = addUsage(meta.usage, report ?? null);
    });
  },

  // 只在完成回执上写。不覆盖 usage、presented_keys 等已有键。
  async applyLater(task, later) {
    if (!later || typeof later.at !== "string" || typeof later.about !== "string") return;
    await this.mergeTaskMeta(task, "later", (meta) => {
      meta.later = { at: later.at, about: later.about };
    });
  },

  // 补交 outbox 时不能把同一轮用量再加一次，所以标记先落盘再写总线。
  async noteUsageOnce(task, box) {
    if (!box || box.usage_noted) return;
    box.usage_noted = true;
    try { this.saveOutbox(box); }
    catch (e) { log("usage 标记写失败：" + (e?.message ?? e)); }
    await this.applyUsage(task, box.usage ?? null);
  },

  // 与用量同一顺序：先落标记再写总线。写失败不再重试，避免补交时把同一条预约写两遍。
  async noteLaterOnce(task, box) {
    if (!box || box.later_noted || !box.later) return;
    if (box.outcome !== "succeeded") return;
    box.later_noted = true;
    try { this.saveOutbox(box); }
    catch (e) { log("later 标记写失败：" + (e?.message ?? e)); }
    await this.applyLater(task, box.later);
  },
};
