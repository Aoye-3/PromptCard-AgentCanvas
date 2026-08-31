# Seedream 项目级图片生成 Agent 实施状态

更新时间：2026-07-16
分支：`feat/seedream-5-pro-full-capability`

## 文档优先级

- 当前产品和技术基线是项目级图片生成 Agent、独立单轮请求和 schema v5 永久会话/派生资产。
- 早期[节点式前端交互 PRD](./005-seedream-image-node-frontend-interaction.md)已由 [ADR-010](../decisions/ADR-010-project-image-generation-conversations.md)取代，仅作为历史需求演进记录。
- 新开发不得恢复可执行 `image-generator` 节点、节点属性自动生成或隐式历史上下文。

## 已完成

- Runtime 图片生成诊断、Ark SDK 兼容性、Keyring 状态、连接依赖与 assignment 门禁。
- 文字模型与图片生成模型分入口管理，支持连接保存、测试、默认模型和安全凭据交互。
- 画布右栏重构为 `Agent｜图片生成｜Prompt库`；工具栏改为手动打开项目级图片生成，不再创建可执行生成节点。
- 项目级新对话、永久会话历史 Dialog、独立单轮请求、显式画布文字/图片注入和本地参考图上传。
- 结构化 `@`、稳定 `referenceId`、文生图、参考图生成、智能改图和局部修改四种工作流。
- point/bbox 大图区域编辑 Dialog，包括焦点恢复、撤销/重做、移动、删除、缩放和适应画面。
- 生成状态与安全错误恢复、结果操作、媒体库跳转、成功结果 pending placement 与普通图片节点幂等落画布。
- 旧 `image-generator` 节点只读预览，所有端口禁止新增连接，仅保留用户手动继续创作入口。
- Storage schema v4：项目会话、conversation run、placement 状态机和 v3→v4 无损迁移。
- Storage schema v5：JPEG/PNG/WebP/BMP/TIFF/GIF/HEIC/HEIF 原件导入、provider/preview/annotation 派生图、强引用与 v4→v5 无损迁移。
- Ark SDK 原生 `standard/fast` Prompt 优化、URL/Base64 单图响应、安全结果本地化、请求 ID/usage/尺寸解析。
- 2K 默认、八种预设比例、自定义尺寸、PNG/JPEG、水印、主图/参考图角色和 10 张总上限。
- 视觉标记编辑：自由画笔、箭头、矩形、椭圆、文字、颜色/线宽、删除、撤销/重做、缩放和栅格化派生图。
- 共享 Runtime HTTP 客户端统一 Cookie/CSRF 与安全错误 envelope；Storage/Runtime Python 依赖全部落在 F: 工作区。
- 开发/测试双 Flag 默认开启；生产新建入口保持灰度；旧节点、结果与历史不受入口 Flag 影响。

## 自动化验证

- Vitest：86 个文件，529 项通过。
- 前端构建：通过。
- PromptCard Storage：68 项及 17 个子测试通过，含真实 HEIC 编解码。
- Runtime 图片生成、模型管理、CSRF、结果下载和 Storage 集成：168 项通过；阿拉伯语、日语和德语 Prompt 保真映射已覆盖。
- 启动链路：schema v5 健康门禁与桌面启动脚本 26 项通过。
- Rust：10 项通过；Agent Check、Ruff、`git diff --check` 和高置信度 secret 扫描通过。
- Playwright：模型管理和项目级图片生成闭环 2 项通过，使用真实 Runtime HTTP、真实 SQLite Storage 和 Provider DI fake。
- Runtime 全仓测试：3378 项通过、32 项跳过、49 项失败；失败集中在 Windows 无符号链接权限、缺少 DeepSeek 实时凭据、POSIX/Docker 脚本假设及既有跨平台路径测试，不属于本次图片链路。
- ESLint：0 个错误；全仓当前 41 个历史警告已冻结为 ratchet 基线，`npm.cmd run lint` 在 41 条时通过、出现第 42 条时失败。pytest/测试输出目录已从源码枚举排除，避免受限 ACL 阻断门禁。后续应单独降低基线，不应在图片功能改动中顺带重构无关文件。

## 发布前仍需完成

- 使用真实 Windows Credential Locker 与真实 Ark 账号完成人工冒烟：文生图、2–10 图、多参考 `@`、智能改图、point、bbox、视觉标记派生图。
- 覆盖真实 Ark 的 standard/fast、1K/2K、预设/自定义尺寸、PNG/JPEG、水印以及阿拉伯语、日语、德语文字系统。
- 单独治理并逐步下调全仓 ESLint 41 个既有警告，以及 Runtime 全仓测试的 Windows/POSIX/实时凭据环境基线；功能分支不得上调 ratchet。

## 维护约束

- 永久历史和派生资产无普通删除入口，Storage schema v5 不回滚。
- API Key 只进入操作系统凭据库，不写入前端、项目、SQLite 或日志。
- SDK HTTP 接口只做状态检测和重新检测，不执行安装或修复命令。
- 连接的画布依赖数量不可确认时，删除操作必须 fail closed。

相关文档：

- [前端交互 PRD](./005-seedream-image-node-frontend-interaction.md)
- [图片生成与模型管理架构](../architecture/image-generation-and-model-management.md)
- [Agent Runtime API](../api/agent-runtime-api.md)
- [ADR-009：能力目录与就绪门禁](../decisions/ADR-009-capability-driven-image-model-readiness.md)
- [ADR-010：项目级图片会话与画布 placement](../decisions/ADR-010-project-image-generation-conversations.md)
- [ADR-011：原件与派生图片资产](../decisions/ADR-011-original-and-derived-image-assets.md)
