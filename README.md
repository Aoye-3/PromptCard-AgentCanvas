<p align="center">
  <img src="./public/promptcard-manager-icon.png" alt="PMAgent-Canvas logo" width="92">
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="PMAgent-Canvas：连接 Agent、Prompt、参考素材和图像创作的本地桌面画布">
</p>

<p align="center">
  <a href="#演示视频">演示视频</a> ·
  <a href="#产品总览">产品总览</a> ·
  <a href="#一条完整的本地创作链路">创作链路</a> ·
  <a href="#核心功能">核心功能</a> ·
  <a href="#全能参考式提示词辅助编辑">提示词辅助编辑</a> ·
  <a href="#快速启动">快速启动</a> ·
  <a href="#技术架构">技术架构</a>
</p>

PMAgent-Canvas 是面向 AIGC 创作者的本地桌面 Agent 画布。它把参考素材、Prompt、Agent 对话、图片生成、二次编辑和复盘结果放进同一个项目，让创作资料不再散落在聊天记录、生成平台和临时文件夹中。

当前核心模型：

- **Seedream 5.0 Pro**：图片生成、参考图生成与图片编辑。
- **Doubao Seed 2.0**：持久化 Agent 对话、媒体提示词倒推，以及全能参考式 Prompt 补全与重写。

> [!IMPORTANT]
> 当前仓库提供的是 **Windows 桌面开发预览**。双击 `start-desktop.vbs` 可以启动可编辑源码对应的桌面壳；它不是已签名的免环境安装包。

## 演示视频

[▶ 查看 PMAgent-Canvas Demo 演示视频](./assets/readme/demo/demo-video.mp4)

[▶ 百度网盘在线观看（提取码：6666）](https://pan.baidu.com/s/1Dcmho_NYCCUFW-jZm90L6A?pwd=6666)

## 产品总览

画布是 PMAgent-Canvas 的中心层。左侧管理项目主体与素材，中间组织文本、参考图和生成结果，右侧在 Agent、图片生成与 Prompt 库之间切换。三部分围绕同一个项目上下文协作，而不是各自保存一份孤立数据。

<p align="center">
  <img src="./assets/readme/screenshots/canvas-overview.jpg" width="100%" alt="PMAgent-Canvas 画布三栏与主交互流程：Agent 编辑、图片生成和 Prompt 库协作">
</p>

## 一条完整的本地创作链路

从参考素材进入项目，到 Agent 辅助编写提示词，再到图片生成、二次编辑和资产归档，所有关键上下文都留在本地项目中。

<p align="center">
  <img src="./assets/readme/workflow.svg" width="100%" alt="PMAgent-Canvas 从项目素材到 Prompt、图片生成、编辑标注和资产沉淀的工作流">
</p>

PMAgent-Canvas 不试图替代每一个外部生成或剪辑平台。它更关注生成前后的生产资料：参考图、分镜、Prompt、模型参数、生成结果、修改方向和复盘经验，让这些内容可以被继续搜索、复用和交付。

## 核心功能

### 图片生成与项目媒体素材库

在画布中调用 Seedream 5.0 Pro 完成文生图、参考图生成和图片编辑。生成结果进入当前项目媒体库，可以继续加入画布、绑定参考关系或参与下一轮生成。

- 项目主体和项目素材分层管理。
- 支持多张参考图、比例与分辨率设置。
- 可从 Prompt 库拉取媒体和提示词上下文。
- 生成历史与项目资产持久化保存。

<p align="center">
  <img src="./assets/readme/screenshots/image-generation-media-library.jpg" width="100%" alt="PMAgent-Canvas 图片生成面板、全能参考模式、项目主体和媒体素材库">
</p>

### Prompt 库与媒体管理

Prompt 不再只是一次性的文本。PMAgent-Canvas 将提示词、参考媒体、分类、来源和项目用途放在一起，既可供用户检索，也可由 Agent 在明确权限范围内读取和提出新增建议。

- 按主体、动作、场景、风格、镜头、灯光等维度分类。
- Prompt 与参考媒体深度绑定，便于在项目中复用。
- 媒体管理页记录生成、截图和导入的项目素材。
- Agent 写入采用用户确认的提案边界。

<p align="center">
  <img src="./assets/readme/screenshots/prompt-library.jpg" width="100%" alt="PMAgent-Canvas Agent 管理、Prompt 媒体库和媒体管理页面">
</p>

### 图片编辑、切割与二次标注

围绕已有图片继续创作，而不是在每次修改时丢失原始上下文。Seedream 5.0 Pro 负责生成式修改，画布工具负责裁切、拆分、文字和箭头标注。

- 局部修改、多角度生成、扩图、消除与场景图推导。
- 按辅助线切割分镜板或多图素材。
- 添加文字、箭头和区域标注。
- 编辑结果继续回到画布和项目素材中。

<p align="center">
  <img src="./assets/readme/screenshots/image-editing-generation.jpg" width="100%" alt="PMAgent-Canvas 生成式图片编辑、局部编辑、扩图、消除和多角度生成流程">
</p>

<p align="center">
  <img src="./assets/readme/screenshots/image-editing-annotations.jpg" width="100%" alt="PMAgent-Canvas 分镜切割、文字标注、运镜标注和二次编辑流程">
</p>

### 快捷消息节点与 Agent 协作

快捷消息节点是一类可沉淀、可编辑的提示词模板。用户可以在画布中调整内容与样式，也可以从 Prompt 库查看完整上下文，再由 Agent 在规则范围内补全和改写。

<p align="center">
  <img src="./assets/readme/screenshots/agent-collaboration.jpg" width="100%" alt="PMAgent-Canvas 快捷消息节点、悬浮编辑工具、Prompt 库复用和 Agent 协作面板">
</p>

## 全能参考式提示词辅助编辑

Canvas Agent 将图片生成中的“全能参考”关系带到文本提示词编辑：先指定一个被编辑目标，再挂载多个只读参考，通过 `@节点` 明确描述目标与参考之间的关系。节点正文不会被塞进输入框，用户可以在保持对话清晰的同时组织复杂 Prompt 上下文。

- **一个目标、多个参考**：最多挂载 10 个文本节点；左侧唯一目标可写，其余节点始终只读。
- **原子化 `@` 引用**：输入 `@` 只显示已挂载节点，可以表达“以 `@目标` 为修改对象，参考 `@风格` 和 `@镜头`”等关系。
- **补全模式**：Agent 先识别原文缺口，再用精确锚点在目标内部穿插黑色用户段；原文字、颜色和顺序保持不变。
- **重写模式**：生成一个位于原节点右侧的完整派生文本节点；原节点始终不变，便于并排比较。
- **Prompt 库调取模式**：普通对话不加载 Prompt Library；只有显式切换到该只读模式时，Agent 才会基于当前对话搜索 Prompt 与关联媒体，不产生 Canvas 写入提案。
- **模板保护**：模板段只用于语义与结构参考，Agent、Gateway 和提案应用层都不允许修改。
- **先预览再写入**：结果以差异提案显示；节点 revision、模板摘要、用户内容摘要或选区发生变化时，旧提案会被拒绝。
- **稳定节点身份**：文本节点使用 `TXT-XXXXXX` 默认名称，可在画布顶部工具栏重命名；画布标签和 `@` 列表同步更新。
- **持久化聊天视图**：会话历史在独立滚动区域中显示，用户消息靠右、Agent 消息靠左，便于持续讨论与回看。
- **会话级模型选择**：每个会话从设置页白名单中选择自己的对话模型，重启后恢复，并记录每轮实际模型快照。

详细交互、安全边界与请求协议见 [Canvas Agent 全能参考式提示词编辑](./docs/frontend/canvas-agent-reference-editing.md)。

## 使用场景

### AIGC 分镜头指令图制作

把前期收集的素材、分镜 Prompt、参考图和生成结果放进同一块画布，完成从指令图搭建、外部平台生成到结果复盘的闭环。

<details open>
  <summary><strong>查看完整案例：分镜头指令图制作与编辑</strong></summary>
  <br>
  <img src="./assets/readme/screenshots/use-case-storyboard.jpg" width="100%" alt="使用 PMAgent-Canvas 制作、生成和二次编辑 AIGC 分镜头指令图的完整案例">
</details>

### 3D 效果图与初版拆分设计

将三视图、材质参考、风格样本和多角度生成结果组织为可复用模板，再通过生成式编辑与标注完成细化和评审。

<details open>
  <summary><strong>查看完整案例：3D 效果图与初版拆分设计</strong></summary>
  <br>
  <img src="./assets/readme/screenshots/use-case-3d-design.jpg" width="100%" alt="使用 PMAgent-Canvas 完成 3D 效果图、多角度生成和初版拆分设计的案例">
</details>

### 提示词模板化、风格参考与灵感积累

将反复使用的提示词封装为快捷模板，把风格参考沉淀到 Prompt 库，再由 Agent 调用、补全和改写，形成从灵感积累到复用交付的一体化工作流。

<details open>
  <summary><strong>查看完整案例：提示词模板化、风格参考与灵感积累</strong></summary>
  <br>
  <img src="./assets/readme/screenshots/use-case-prompt-workflow.jpg" width="100%" alt="使用 PMAgent-Canvas 完成提示词模板化、风格参考入库、Agent 补全和灵感复用的完整案例">
</details>

## 快速启动

### 环境要求

当前一键启动路径面向 Windows 开发环境。首次启动前请确保以下工具可用：

- Node.js 与 npm
- `uv`（Python 运行时和依赖同步）
- Rust / Cargo（首次构建或 Tauri 源码发生变化时使用）

### 启动桌面壳

```powershell
git clone https://github.com/Aoye-3/PromptCard-Agent.git
cd PromptCard-Agent
```

然后在资源管理器中双击：

```text
start-desktop.vbs
```

启动器会在需要时安装前端依赖、初始化本地服务并打开 PMAgent-Canvas 桌面壳。正常启动会复用现有桌面进程；Rust 或 Tauri 源码变化时会触发重新构建。当前组合启动链路会校验 Storage schema v9，避免把旧 Storage 进程误当作可用服务。

如果启动失败，运行可见终端版本查看完整日志：

```powershell
.\start-desktop.bat
```

### 配置核心模型

打开桌面壳后，在 **Agent 面板 → 模型管理** 中配置连接并绑定模型：

| 能力槽位 | 当前核心模型 | 用途 |
| --- | --- | --- |
| 文本 / Agent | Doubao Seed 2.0 | 持久化对话、媒体提示词倒推、Canvas Prompt 补全与重写 |
| 图片生成 / 编辑 | Seedream 5.0 Pro | 文生图、参考图生成与图片编辑 |

模型凭据由后端写入操作系统密钥环，不进入浏览器存储、项目 JSON、生成历史或 API 响应。未配置凭据时，模型调用会返回 `credential_missing`。

方舟连接只录入一个推理 API Key。设置 `chat.primary` 后，在同一连接的“项目 Agent 可用模型”中勾选允许出现在会话选择器中的官方目录模型。目录由应用版本维护；Ark Runtime SDK 使用该 Key 调用明确的模型 ID，但不通过同一推理凭据发现账号模型。

## 本地项目与数据边界

- 项目数据、画布状态、Prompt、生成历史和素材索引保存在本地持久化存储中。
- 图片结果不会因为删除画布节点或项目视图而直接删除底层历史资产。
- Agent 面板、Prompt 库、画布与媒体分析使用隔离的会话上下文。
- Prompt 库和画布写入采用显式提案与用户确认，不让 Agent 静默覆盖生产资料。

## 技术架构

| 层级 | 当前实现 |
| --- | --- |
| 桌面壳 | Tauri 2 |
| 前端 | Vite、React、TypeScript、Tailwind CSS、Zustand |
| 画布 | React Flow + PMAgent 自有媒体层 |
| 本地存储 | SQLite + 项目资产目录 |
| Agent Runtime | Python PromptCard Gateway + pi text Agent |
| 模型管理 | Provider-neutral connection 与模型槽位绑定 |

更完整的工程资料：

- [技术文档入口](./docs/README.md)
- [系统架构](./docs/architecture/system-architecture.md)
- [Agent Runtime 边界](./docs/architecture/agent-runtime-boundary.md)
- [Agent Runtime API](./docs/api/agent-runtime-api.md)
- [前端应用结构](./docs/frontend/app-shell.md)
- [Canvas Agent 全能参考式提示词编辑](./docs/frontend/canvas-agent-reference-editing.md)
- [图片生成与模型管理](./docs/architecture/image-generation-and-model-management.md)

<details>
  <summary><strong>开发命令</strong></summary>

```powershell
npm.cmd run dev
npm.cmd run dev:with-agent
npm.cmd run agent:dev
npm.cmd run text-agent:dev
npm.cmd run agent:check
npm.cmd test -- --run
npm.cmd run test:frontend
npm.cmd run test:e2e
npm.cmd run build
```

Backend Agent Runtime tests:

```powershell
cd agent-runtime/backend
$env:UV_CACHE_DIR='F:\.Agent-PromptCardManager\.uv-cache'
uv run pytest tests -q -p no:cacheprovider
```

PromptCard Storage release gate (use the existing workspace virtual environment so image-codec dependencies are available):

```powershell
& .\agent-runtime\backend\.venv\Scripts\python.exe -m unittest discover -s promptcard_storage/tests -p "test_*.py"
```

</details>

## 规划中功能

### 本地 MCP、Prompt 库 RAG 与 Codex 创作桥接

计划分别为项目、Prompt 库 Prompt、Prompt 库媒体、画布文本节点、画布媒体和画布选区提供稳定、可复制的引用编码。用户既可以复制精确编码，也可以先给出项目编码，让 Codex 在项目画布与 Prompt 库两个独立索引中查找候选内容，再生成提示词或图片并通过本地受控接口交付回指定画布。

- Codex 作为外部交互入口，不在 PMAgent-Canvas 内嵌 Codex 聊天界面。
- 使用仓库自带的本地 STDIO MCP，分别暴露 Prompt 库搜索/解析与项目画布搜索/解析能力。
- Prompt 库媒体和画布媒体采用独立编码、索引、权限与生命周期；即使复用同一底层资产，也不共用业务编码。
- Codex 生成结果只通过 Gateway/Storage 导入，不直接修改项目 JSON、SQLite 或资产目录。
- PromptCard 不保存 Codex 图片生成所需的外部 API Key；实际生成能力取决于用户自己的 Codex 环境。
- 左侧全局导航规划新增 **Skill Hub**，用于安全导入、审阅、版本化和管理 Agent Skill。
- Skill 使用独立 `SKL` 编码体系；同一固定版本可分别发布给 Codex、启用给本地 Agent，两端权限和启用状态互不联动。
- 导入只读取与校验 Skill 包，不执行其中的脚本、安装器或依赖；本地 Agent 首版只读取受限的指令与参考资料。

本地 Agent 的 Prompt 库手动搜索也将随这次改造升级为有界、可引用、可审计的 RAG 检索；详细设计与分阶段验收见 [Plan 008：本地 MCP、Prompt 库 RAG 与 Codex 桥接](./docs/Plan/008-local-mcp-prompt-media-codex-bridge.md)。

## 未来设想（暂无计划）

以下内容仅记录可能的产品方向，尚未进入正式 Plan，不代表已经排期、确定接口或承诺实现。

### 插件节点 Hub

远期规划在自由画布中加入 **插件节点 Hub**，统一承载可发现、可安装、可版本化并可按项目启用的扩展节点。插件节点 Hub 面向画布能力扩展，与管理 Agent 指令包的 Skill Hub 保持独立边界。

首批插件节点计划按以下顺序探索：

1. **357 头身角色基膜库**：围绕 3、5、7 头身比例组织可复用的角色基膜，为角色设定、姿态设计和后续视觉生成提供一致起点。
2. **基于前端 3D 代码的线稿风格场景生成**：使用前端 3D 代码搭建和调整场景结构，再将视角、构图与空间关系转换为可继续创作的线稿风格场景结果。

### 编剧 Agent Skill 与情绪曲线脚本工作台

在 Skill Hub 接入并稳定后，可进一步引入面向短片创作的编剧 Agent Skill，并设计一套可视化的情绪曲线脚本界面：围绕剧情节点、场景、角色状态和节奏变化组织本地短片脚本创作。标准化短片脚本可继续转换为设定图、分镜图等视觉资产，并通过资产表统一管理角色、场景、道具、镜头、参考素材、Prompt、生成结果及其来源关系。

## 当前状态

PMAgent-Canvas 仍处于活跃开发阶段。当前重点是稳定自由画布、图片生成与编辑、Prompt/媒体资产沉淀、Agent 会话隔离和本地桌面启动链路。对外使用前请以仓库中的实际实现和技术文档为准。
