# PromptCard-Manager Documentation

This is the single entry point for the maintained project documentation. Historical plans, extracted notes, and legacy assets live under `archive/`, `Plan/`, and `superpowers/plans/` with an explicit status or supersession note.

## Documentation Map

- [Project Overview](./00-project-overview.md)
- [Architecture](./architecture/README.md)
- [Data Storage And Update System](./architecture/data-storage-and-update-system.md)
- [Architecture Decisions](./decisions/README.md)
- [Tech Stack](./tech-stack/README.md)
- [API](./api/README.md)
- [Frontend](./frontend/README.md)
- [Canvas Agent Omnireference Prompt Editing](./frontend/canvas-agent-reference-editing.md)
- [Skill Host Pins And Projections](./architecture/skill-host-projections.md)
- [Generic Local Agent Bridge Boundary](./decisions/ADR-019-generic-local-agent-bridge-boundary.md)
- [Task 15.5 Technical Acceptance](./reviews/2026-08-24-task-15-5-technical-acceptance.md)
- [Task 15.6-15.9 Progress Snapshot](./reviews/2026-08-29-task-15-6-through-15-9-progress.md)
- [Backend](./backend/README.md)
- [Database and Storage](./database/README.md)
- [Operations](./operations/README.md)
- [Quality](./quality/README.md)
- [Maintenance](./maintenance/README.md)
- [Plans](./Plan/README.md)
- [Official References](./references/volcengine/seedream/README.md)

## Current Project Shape

PromptCard-Manager is a local-first Vite, React, TypeScript application with a Python PromptCard Gateway and a separate pi text Agent runtime. Project and Prompt Library durable data is owned by the local `promptcard-storage` service; the frontend only keeps runtime UI state and compatibility-only browser migration markers.

The current minimal closed loop is Prompt media library construction, Canvas Prompt image generation, and text-Agent prompt analysis/completion. Canvas text editing uses an omnireference-style model: one writable target, multiple read-only reference nodes, atomic `@` relations, anchored interleaved completion, and derived-node rewrite. Project text-Agent conversations and proposal states are durable, each conversation persists a whitelisted model binding, and Media uses an intentionally temporary collaboration dialog. Skill Hub now provides inert package inspection/import, revision history and diff, exact-revision trust review, archive/restore, independent Codex/local-Agent pins, visible projection health, and explicit repair while bounded local-Agent snapshots remain unable to expand Runtime permissions. See [Canvas Agent Omnireference Prompt Editing](./frontend/canvas-agent-reference-editing.md), [Text Agent Runtime Boundary](./architecture/agent-runtime-boundary.md), [Skill Host Pins And Projections](./architecture/skill-host-projections.md), [ADR-016](./decisions/ADR-016-durable-text-agent-conversations-and-bounded-skills.md), and [ADR-019](./decisions/ADR-019-generic-local-agent-bridge-boundary.md).

The Tauri desktop dev shell opens the same Vite app in a native window while keeping the source tree editable. During editable development, projects, Prompt presets, Recent Captures, and media use the ignored repository `data/` directory as their single durable root. Runtime logs and desktop metadata remain under `logs/`. See [Desktop Dev Shell](./operations/desktop-dev-shell.md), [Local App Data Layout](./database/local-app-data-layout.md), and [ADR-007](./decisions/ADR-007-repository-data-root-for-editable-development.md).

The floating toolbar's screenshot loop is a Windows-first native `xcap` capture session: the full display frame remains in memory, while only the user-selected PNG enters Recent Captures. See [Native Screenshot Capture](./architecture/native-screenshot-capture.md) and [ADR-005](./decisions/ADR-005-native-screenshot-session.md).

Capture Bar also imports WeChat/QQ-style clipboard images. Recent Captures can explicitly register one or many reviewed items into Prompt Library, or place image captures on Free Canvas, while all three consumers reuse one physical `assetId`. See [Recent Capture To Prompt Registration](./architecture/recent-capture-prompt-registration.md), [ADR-006](./decisions/ADR-006-explicit-capture-registration-and-shared-asset-identity.md), and [Storage Service API](./api/storage-service-api.md).

Free Canvas includes a provider-neutral project Image Generation Agent. The first adapter is Doubao Seedream 5.0 Pro; credentials stay in the operating-system keyring, and successful results become local assets and Recent Captures. The current Storage schema is v16: v10 introduced public references, v11-v12 immutable Canvas context packs, v13 canonical Skill packages, v14 independent exact host pins and Codex projection recovery, v15 exact-revision trust reviews and Skill management operations, and v16 adds document resources plus provider cleanup tracking for temporary Ark files. Earlier image, asset, resource, conversation, and model-binding migrations remain intact. Legacy generator nodes are read-only. See [Schema Notes](./database/schema-notes.md), [Image Generation And Model Management](./architecture/image-generation-and-model-management.md), [ADR-008](./decisions/ADR-008-provider-neutral-image-generation.md), [ADR-010](./decisions/ADR-010-project-image-generation-conversations.md), and the [current implementation status](./Plan/005-seedream-image-node-frontend-implementation-status.md).

Plan 008 is currently paused at Task 15.10 checkpoint pre-acceptance. The host-neutral `promptcard-bridge/v2` contract and ADR-019 are complete; Task 15.6-15.9 are implemented; Task 15.10 is not yet fully accepted; Task 16 remains blocked.

Contextual image actions and explicit multi-view groups are tracked by [Plan 007](./Plan/007-contextual-image-editing-and-multi-view-plan.md) and the maintained [Contextual Image Actions](./frontend/contextual-image-actions.md) contract. Recoverable placeholders, project-scoped resources, and explicit multi-view request groups are governed by [ADR-013](./decisions/ADR-013-recoverable-image-generation-placeholders.md), [ADR-014](./decisions/ADR-014-project-scoped-resource-library.md), and [ADR-015](./decisions/ADR-015-explicit-multi-view-request-groups.md). Plan 007 remains `Active`: zero-cost Fake Provider evidence is ready, unified human approval is pending, and paid live-provider gates have not been executed.

## Product Vision

PromptCard-Manager is evolving into an AIGC director's storyboard-script workstation. The product direction is to integrate Prompt management, AIGC script grids, storyboard images, and script planning into an external management board that reduces video workflow information overload before work enters video production tools.

Slogan:

```text
让视频制作画布与编导画布分割开来。
```

Roadmap:

| Workstream | Target Completion |
| --- | --- |
| Prompt管理与协作Agent改造 | TBD |
| 自由画布式改造 | TBD |
| 图片API置入 | Seedream 5.0 Pro 自动化适配完成；真实 Ark 发布冒烟待完成 |
| 宫格分镜大师 | TBD |

The root workspace `F:\.Agent-PromptCardManager` is not the project. The project repository is:

```text
F:\.Agent-PromptCardManager\PromptCard-Manager
```

## Maintenance Rule

When code changes, update the nearest documentation category in the same change. If the change touches storage, runtime integration, API routes, or user-visible workflows, also update the relevant verification checklist.

Current-state truth lives in the architecture, API, frontend, backend, database, operations, and ADR sections. Plans explain delivery history and must not override an accepted ADR or a current-state document.

## Future Development Guardrails

- Keep PromptCard UI integrations on the PromptCard Runtime Boundary (`/agent-api/promptcard/runtime/*`); the browser must not call pi or provider APIs directly.
- Preserve project-level Agent conversation isolation. Durable project calls use `conversationId + requestId`; Gateway must validate project, entrypoint, mode, and permission scope before loading bounded SQLite history. The Node Runtime must remain stateless between requests.
- Keep model catalog, connections, and `chat.primary`/`image.primary` assignments unified through Agent Runtime Model Management. Deprecated chat model-config routes are migration compatibility only.
- Keep `PI 原生` text providers, SDK-backed text adapters, and image-generation adapters as separate invocation paths. Sharing connection metadata never authorizes cross-modality model leakage.
- Keep model credentials in the operating-system keyring and external provider calls behind the Python credential boundary. The browser and Node pi runtime may use non-secret descriptors but must never receive or persist a provider credential.
- Keep image-generation conversations, runs, placements, image derivations, text-Agent conversations, per-conversation model bindings, public references, context packs, canonical Skill revisions, exact-revision trust reviews, and host pins in the current PromptCard Storage schema v16. Do not embed image runs or Agent transcripts in project JSON, and do not use browser storage or host projections as authoritative state.
- Treat `workspaceContext.snapshot` as the per-request current workspace view. Do not use selected cards, current rows, or focused fields as the thread identity unless a future spec explicitly changes the product model.
- Keep permission scopes narrow: `prompt-library-agent` is the only Prompt Library write proposal surface; `workspace-chatbot-agent` is the Canvas text proposal surface; `media-analysis-agent` may create a non-mutating preview for one explicit media item but cannot register it. Skill instructions, references, and declared tools cannot add permissions or bypass proposal approval.
- Keep Media conversation history temporary. Each request may include bounded component-memory history, but closing the dialog must discard it and no project Agent conversation may be created.
- Bind first-party feature Skills by stable capability ID. External Skills are explicit and one-shot; record the actual Skill revision and digest used by each durable project turn, and never execute Skill scripts in the current implementation.
- Preserve the Canvas omnireference editing boundary: one writable target, read-only references, `@` mentions as semantics rather than permissions, exact-anchor interleaved completion, and rewrite-to-derived-node behavior with stale-proposal rejection.
- Keep Free Canvas quick messages in the Prompt Library preset model (`category: "quick-message"`); see [ADR-001](./decisions/ADR-001-prompt-library-quick-messages.md).
- Keep editable-development projects, Prompt Library data, and media assets inside the protected ignored `data/` root; keep runtime logs/configuration under `logs/`; see [ADR-007](./decisions/ADR-007-repository-data-root-for-editable-development.md).
- Any pi tool expansion needs documentation of the visible UI affordance, runtime tool permission, and proposal/approval boundary.
- Update this README plus the closest architecture/API/frontend/backend docs whenever Agent routing, storage, model configuration, or project workflows change.
