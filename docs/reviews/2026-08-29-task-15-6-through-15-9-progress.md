# Task 15.6–15.9 文档状态同步与验收前清单（Checkpoint 3.5）

## 状态

- 结论：Task 15.6–15.9 已完成开发与归档。本快照已由 [Task 15.10 / Checkpoint 3.5 技术验收包](./2026-08-27-task-15-10-technical-acceptance.md)取代；Task 15.10 已实现并完成技术验收，Checkpoint 3.5 用户手动验收仍待执行，Task 16 未开始。
- 执行分支：`feat/skill-document-storyboard-loop`
- 记录日期：`2026-08-29`
- 关联计划：`docs/superpowers/plans/2026-08-22-plan-008-execution.md`

## 已完成文档同步

- `docs/Plan/008-local-mcp-prompt-media-codex-bridge.md`
  - 状态同步为“15.6-15.9 已实现；15.10 待实现与验收”。
- `docs/README.md`
  - Plan 008 当前状态更新，Storage 现状口径切换到 v16。
- `docs/architecture/agent-runtime-boundary.md`
  - Storage 健康约束口径改为 v16，删除旧版 v9 健壮性门槛文案。
- `docs/backend/skills-and-tools.md`
  - 技能快照与信任来源由 v16 作为当前基线。
- `docs/database/agent-runtime-sqlite.md`
  - agent runtime 与 Storage schema 文档口径更新为 v16。
- `docs/database/schema-notes.md`
  - 当前 schema 改为 v16，并补充 v16 的 `project_document_resources` / `provider_file_cleanup` 说明。
- `docs/decisions/ADR-020-separate-planning-documents-from-prompt-execution.md`
  - 状态更新为 Task 15.6–15.9 已实现，15.10 待验收前停顿。
- `docs/decisions/ADR-021-project-document-resources-and-ephemeral-provider-files.md`
  - 状态更新为 Task 15.8 已完成，Checkpoint 依赖 Task 15.10 的实现与验收。
- `docs/maintenance/release-checklist.md`
  - Release 健康项更新为 v16 和 `projectDocumentResources`/`providerFileCleanup`。
- `docs/operations/runtime-setup.md`
- `docs/operations/troubleshooting.md`
- `docs/operations/desktop-dev-shell.md`
  - 启动/健康检查和服务网关检查点改为 schema 16。
- `docs/superpowers/plans/2026-08-22-plan-008-execution.md`
  - 任务执行状态与 Task 15.6–15.9 的验收项打勾同步到最新里程。
- `docs/superpowers/specs/2026-08-27-skill-conversation-document-storyboard-design.md`
  - 规格状态由“未开始”切到“15.6–15.9 已实现，15.10 pending 3.5验收”。
- `docs/architecture/image-generation-and-model-management.md`
  - 运行时文档“当前 schema”口径同步为 v16。
- `docs/architecture/system-architecture.md`
  - 系统架构文档中的 schema 历史与当前口径同步为 v16。

## 变更提交（本地文档）

- 当前文档同步未独立提交；本清单文件与上述文档更新均未打入独立的提交。
- 代码变更提交（供 Checkpoint 对照）：
  - `9a64228`、`10bc250`、`806f212`、`ea54d19`、`50801a2`、`50823dd`、`c2cd69e`
  - 说明：这些提交为 Agent/Storyboard 文档节点与可恢复编辑路径的迭代主体。

## 已在最终验收包补齐的证据

以下自动化证据已在最终验收包回填；手动验收项仍保持未勾选：

1. 自动化证据（每轮 reviewer 结论）
   - 代码级 Focused + 全量门禁通过结果
   - 跳过项与既有 warning 列表
2. 持久化行为
   - TXT/MD/DOCX/PDF 与扫描 PDF 的解析通过性
   - Ark 临时文件删除与重启重试清理记录
   - `project_document_resources` 与 `provider_file_cleanup` 的可恢复记录
3. 文档与提案链
   - Document 三视图（inline/expanded/collapsed）与可应用草稿生效情况
   - Storyboard 显式字段变更、Provenance 与 idempotent 提交
4. 对抗场景
   - saved-before-ACK 重启恢复
   - 重复请求/冲突/响应丢失恢复
5. 边界不侵入
   - 证明 Document / Storyboard 未进入 Prompt Library / Prompt RAG / compiler / 生图链路
6. 手动验收
   - 按你现有 Checklist 执行并产生日志、截图、终端输出

## 风险与待办

- Plan/ADR 中仍保留若干“历史未实现”或“待实现”条目（如 Task 16、MCP 桥接路由、自动匹配等）是有意保留的，不代表本 Checkpoint 回归。
- 最新自动化结果、reviewer 轮次、warning/skip、门禁残余和手动步骤见最终验收包。本文件只保留为 Task 15.6–15.9 的历史进度快照。
