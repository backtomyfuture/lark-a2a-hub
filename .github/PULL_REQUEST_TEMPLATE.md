## 变更说明 / Summary

## 检查清单 / Checklist

- [ ] 与 docs/standard.md 冲突时，先改标准并在 CHANGELOG 记一笔
- [ ] 改了表结构：先改线上 Base，再跑 `node schema/generate_schema.mjs`，生成物与代码一起提交（不手改 schema/base-schema.json 与 docs/base-schema.md）
- [ ] 发版变更同步 bump：package.json、package-lock.json、DAEMON_VERSION
- [ ] 未提交任何凭据、app.env、.hub-node/ 本地状态文件
- [ ] 新增写表路径经 FeishuBus 并串行（同表写不并发）
