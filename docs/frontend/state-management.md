# State and Storage

## Overview

PromptCard-Manager uses Zustand and React state for in-memory editing. The local storage service is the durable source for projects and Prompt Library presets; `localforage` is limited to UI-only cache, history, settings, templates, and legacy migration.

## Zustand Stores

### Card Workspace Store

`card.store` owns card workspace state:

- pages and current page
- active card and active preset selector card
- selected cards
- card CRUD and page switching
- workspace restore
- selected-card prompt assembly

Cards use the `ICard` schema and are grouped into pages from `card-initial-state`.

### Preset Store

`preset.store` owns Prompt library state:

- preset initialization
- legacy Free Canvas quick-message migration
- type filtering
- quick-message category filtering
- create, update, delete
- reorder by category/type
- usage count increments
- text search

The store preserves `IPreset` compatibility and persists changes through `storage.presets`.

Quick messages are stored as `IPreset` records with `category: "quick-message"` and `type: "custom"`.
They are not a new card type. The store migrates old `settings.meta.freeCanvasQuickTextPresets`
records once by preserving each legacy id in `meta.quickMessage.legacyId`.
Quick-message UI drafts contain only `name` and `body`; reference media remains in the preset
`meta.media` payload and old notes remain historical data only.

### Agent Store

`agent.store` owns transient frontend Agent runtime state:

- runtime, catalog, and model-assignment status
- active project conversation identity and the currently rendered message page
- temporary composer draft, running state, one-shot Prompt-edit Skill selection, and durable experimental-conversation Skill binding
- parsed pending Canvas text proposals
- pending Prompt Library create proposals

It delegates HTTP calls to `agent-runtime-service`. For project Agent surfaces, PromptCard Storage is the transcript and proposal-status authority. The store hydrates the selected conversation from Gateway and must not reconstruct model history from browser state. The current implementation retains only the selected conversation ID in `localStorage`; the composer draft is component state, and authoritative messages are never stored there.

Agent permission scope is enforced before proposals reach UI execution:

- `prompt-library-agent` is reserved for Prompt Library decomposition and additive create proposals.
- `workspace-chatbot-agent` is the Free Canvas text-writing surface. Explicit composer state identifies at most one writable target and up to nine read-only references. Completion inserts black user segments at validated exact anchors while preserving all original segments; rewrite creates a complete derived text node and leaves the source unchanged. Proposals carry node revision, template digest, and segment digest and are rejected when any baseline becomes stale. No explicit target means discussion-only.
- `media-analysis-agent` discusses one explicitly selected image and may emit only a non-mutating Prompt preview candidate after an explicit preview request. Prompt registration remains a separate user action.
- The Agent dashboard is diagnostic and model-management oriented; it does not own Prompt Library or Canvas approval.

Project Agent history is durable and project-scoped. Every turn uses `conversationId + requestId`; Gateway validates the project, entrypoint, mode, and permission scope before loading bounded history. Retrying the same request ID returns the stored result rather than duplicating messages or proposals.

Media analysis is intentionally different: `MediaAnalysisDialog` owns its bounded conversation and editable Prompt preview in component memory, includes that history on each request, and discards it when closed. It never creates a project Agent conversation.

Built-in Skills are bound deterministically by feature entrypoint. In `prompt-edit`, external Skill selection is composer state for the next project message only and clears after send. In `chat-experimental`, `interactionMode` and `boundSkillIds` are conversation metadata persisted through an optimistic-revision Storage update and hydrated after reload. The UI may display Skill availability, but Gateway re-resolves the current local-Agent pin every turn and rejects trust/lifecycle/tool incompatibility before invocation.

## Storage Model

`src/utils/storage.ts` is the persistence facade. Project and Prompt Library writes go through the storage service and do not fall back to browser persistence.

Project autosave is idle-based and user-configurable from `我的 -> 设置 -> 自动保存`. Builder changes wait until the user has stopped editing for the configured delay before writing to storage; the default is 10 seconds. The UI should only enter the saving state when that delayed save actually starts. If autosave is disabled, the normal manual save action remains available.

### Autosave Concurrency Contract

Autosave responses must never replace the current in-memory project payload. A save request can complete after the user has already deleted or edited fields, especially in storyboard, three-stage, and free-canvas builders. Applying that older response wholesale can restore deleted content.

`App.tsx` tracks a per-project edit sequence and sends all project writes through `project-save-coordinator.ts`. Each request owns a complete project snapshot, and each project has at most one storage request in progress. Later edits replace the pending snapshot with the newest complete local state; partial metadata updates are never merged onto an older in-flight content snapshot.

- Initial creation is one queued `POST`; edits made while it is running are persisted by a later `PUT` using the returned revision.
- A `409` updates the coordinator revision and retries the newest local snapshot, up to three attempts.
- Network failure retains the newest unsaved snapshot. Local content is not rolled back and the next automatic or manual save retries it.
- Storage responses only acknowledge metadata. They never replace `storyboard`, `threeStage`, canvas nodes, media nodes, or card/page content.
- Save status and last-saved time are stored per project. A response for project A cannot change the visible state of project B.
- The UI displays `saved` only when the acknowledged edit sequence is still current and the coordinator has no in-flight, pending, or retained snapshot for that project.
- Autosave effects depend on editable content snapshots, not revision or save timestamps, so metadata acknowledgements do not create save loops.

Manual save for structured builders follows the same confirmation path. New project types or builder surfaces should reuse this split between content state and storage metadata instead of calling `replaceExistingProject()` from delayed save flows.

## Core Schemas

### `ICard`

`ICard` represents one PromptCard unit. Important fields are:

- `id`
- `type`
- `title`
- `content`
- `mode`
- `color`
- timestamps
- `meta`

Supported card types include subject, action, scene, style, camera, lighting, timing, audio, constraint, and custom.

### `IPreset`

`IPreset` is the Prompt library compatibility contract:

- `id`
- `type`
- `category`
- `label`
- `content`
- `usageCount`
- `meta`
- optional timestamps

Any Agent or UI feature that writes Prompt library data should preserve this contract.

Free Canvas quick messages use this same contract. The prompt body remains `content`, and
`meta.quickMessage.note` is treated only as a legacy field that new writes must not preserve.
Reference media is shared through `meta.media` for Prompt Library preview and is not inserted into
Free Canvas text nodes.

Prompt Library is the only UI surface allowed to approve Agent-generated writes to this contract. Builder chatboxes may select or reuse existing presets, but must not create, update, or archive presets. Prompt Library Agent approvals are additive only; they create new presets and never update, delete, archive, overwrite, or replace existing presets.

### `IPromptProject`

`IPromptProject` is the top-level project record:

- `id`
- `title`
- `type`: `card`, `storyboard`, `three-stage`, or `free-canvas`
- `pages`
- `currentPage`
- optional `storyboard`
- optional `threeStage`
- optional `freeCanvas`
- timestamps
- `meta`

Card projects mainly use `pages`; storyboard projects use `storyboard`; three-stage projects use `threeStage`; Free Canvas projects use `freeCanvas`.

### `IStoryboardProject`

`IStoryboardProject` contains:

- `aspectRatio`
- `sequences`
- selected sequence and row IDs
- `meta`
- deprecated legacy flat storyboard fields for migration support

Loading normalizes legacy flat storyboard data into the sequence model.

### `IThreeStageProject`

`IThreeStageProject` contains:

- `character`, `storyboard`, and `videoPrompt` structured sections
- `selectedStage` and `selectedFieldId` for the right-side field editor
- section-level `fields`, `focusedFieldId`, timestamps, and `meta`

Three-stage fields are stored as sparse string maps. Empty fields remain absent or empty and are not included in copied stage output.

### `IFreeCanvasProject`

`IFreeCanvasProject` contains:

- standalone `nodes` for text, image, arrow, legacy image-generator, Document, Storyboard, and read-only unsupported content
- user-created `edges`
- optional viewport and selected node IDs
- `meta`

Text nodes split visible text into `preset` and `user` segments. Prompt/template text remains a red preset segment, while user-authored text defaults to black. Agent updates may only mutate user segments.

Document nodes store the editor-neutral `PlanningDocumentV1` block AST, linked project document-resource IDs, optional run provenance, and an optional `AgentAppliedEditMarker`. Storyboard nodes store a structured `IStoryboardSequence`, exact source provenance, pending field changes, revision/digest, and the same receipt type. Tiptap editor JSON and provider file identities are never part of project state.

Unknown node kinds normalize to `unsupported` with immutable `originalKind` and untouched `originalNode`; saving must serialize the original JSON rather than projecting it through a known node shape.

Image nodes may contain `annotations`, an array of image-local annotation records. These records are part of the image node payload rather than standalone canvas nodes:

- supported `kind` values are `text`, `rect`, `arrow`, `freehand`, and `shotNumber`
- `x`, `y`, `width`, and `height` are normalized to the image bounds
- `arrow.points` stores two normalized endpoints when available
- `freehand.points` stores the normalized path
- `shotNumber` is rendered as a square black sticker with editable white text

Project normalization must keep old image nodes without `annotations` loadable by defaulting to an empty array. Saving from the annotation editor replaces the full annotation array for that image node in one project update.

### `PromptLibraryWriteProposal`

`PromptLibraryWriteProposal` captures Agent-suggested Prompt library writes:

- proposal identity and runtime context
- Agent name
- operation: create, update, or archive
- target preset ID when applicable
- preset draft
- rationale
- pending/approved/rejected status
- creation timestamp

The proposal is not a preset until the user approves it.

### `AgentWorkspaceProposal`

`AgentWorkspaceProposal` is the shared parsed output shape for Agent-authored changes. The maintained pi runtime emits:

- `free_canvas_text_insertions`: add black user segments at validated anchors inside the explicit target without changing existing segments;
- `free_canvas_text_create`: create a complete derived node for rewrite while preserving the source;
- `prompt_library_write_proposal`: create a new Prompt Library preset after approval in Prompt Library scope.

All three remain pending until explicit Apply/Reject. Prompt Library proposals are filtered out of workspace scope, and Canvas proposals are not accepted in Prompt Library scope. Historical `free_canvas_text_update` records remain in the parsed union for revision 1/2 proposal compatibility but are not emitted by revision 3.

The TypeScript union and parser retain older `workspace_card_*`, `storyboard_update`, and `three_stage_field_update` shapes for compatibility. The focused pi runtime has no tools that emit them.

Experimental creative-document writes are returned separately as `AgentCanvasEdit`, not as a legacy workspace proposal. The closed kinds are `document_create`, `document_changes`, `storyboard_create`, and `storyboard_changes`; each carries deterministic conversation/request/edit identity, authoritative base state, expected result digest, and provenance. Prompt handoff remains a pending `free_canvas_text_create` proposal because it requires explicit approval before creating the new all-user Prompt node.

The Prompt Library page owns batch proposal approval. Selected pending create proposals are converted into `IPreset` drafts through `preset.store.addPreset()`, then marked approved. Batch rejection only marks proposals rejected; it does not mutate Prompt Library records.

### Durable Agent Conversation Records

Project Agent conversations are stored separately from image-generation conversations:

- `AgentConversation` is the project-scoped lifecycle record and supports active and Trash states.
- `AgentConversationMessage` preserves ordered visible content, normalized blocks, and tool summaries.
- `AgentConversationProposal` preserves the proposal payload and approval state across reloads.
- A completed turn is indexed by its request ID for idempotent retries.
- `interactionMode`, `boundSkillIds`, and conversation `revision` preserve experimental mode/binding independently from message records.

Conversation history, rename, Trash, restore, and permanent-delete operations all go through the Storage-backed Gateway contract. Prompt Library assistant sessions and Media analysis sessions are excluded from this list.

## Merge and Normalization Behavior

After one-time legacy browser migration, project loading uses the storage service as the durable source. Loaded projects are sorted by `lastOpenedAt` and then `updatedAt`; browser project data is not merged back into the active project list.

Storyboard loading normalizes missing or legacy fields:

- missing sequences become a default sequence with one row
- legacy `rows`, `sequenceStyle`, and `sequenceConstraints` are converted into the sequence model
- selected sequence and row IDs fall back to valid existing records

Three-stage loading normalizes missing project data by creating empty `character`, `storyboard`, and `videoPrompt` sections with the default focused field.

Free Canvas loading normalizes missing project data by creating an empty `freeCanvas` payload. Legacy three-stage projects with `meta.builderTemplateId: "free-canvas"` are migrated into standalone Free Canvas projects; their form outputs become text nodes and their media nodes/valid edges are remapped.

## Roadmap / Not Yet Implemented

- There is no production multi-user server database; the local Storage service and SQLite schema v19 are the durable authority.
- SQLite migrations are owned by Storage. Frontend normalization remains responsible only for versioned project JSON and legacy browser-data compatibility.
- Skill script execution, hooks/installers, automatic semantic matching, general Canvas update/delete tools, local OCR, asset-card/plugin nodes, and MCP server remain unimplemented. The bounded Bridge router, JSON CLI, and transactional Prompt retrieval are implemented; Document/Storyboard tools otherwise remain behind explicit proposal/write contexts.
- The completed Skill Hub management workflow is documented in [Skill Host Pins And Projections](../architecture/skill-host-projections.md) and the [Task 15.5 acceptance package](../reviews/2026-08-24-task-15-5-technical-acceptance.md).
