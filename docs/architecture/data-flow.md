# Data Flow

## Project Data

Project data is represented by `IPromptProject`. Card projects mainly use `pages`; storyboard projects use the normalized `storyboard` shape; three-stage projects use the `threeStage` shape; Free Canvas projects use `freeCanvas` with closed node-kind dispatch for Prompt text, images, arrows, legacy generators, Documents, Storyboards, and read-only unsupported nodes.

Three-stage projects use a page-based form model under `threeStage.pages`. Each page contains ordered independent `form` items for character, storyboard, video-prompt, and optional object boards. The legacy top-level `threeStage.character`, `threeStage.storyboard`, `threeStage.videoPrompt`, `selectedStage`, and `selectedFieldId` fields remain compatibility mirrors and are synchronized from the selected page/form during normalization and UI updates.

Loading now goes through the local `promptcard_storage` service. During editable development, active and Trash project rows live in `data/promptcard.sqlite3`. Browser project cache and legacy JSON files are imported only through explicit/idempotent migration paths and are not ongoing project sources.

Project normalization is pure domain logic in `src/domain/projects/project-normalization.ts`. It is responsible for defaulting legacy card projects, migrating legacy flat storyboard rows into the sequence model, creating missing three-stage payloads, repairing known display-text mojibake, and sorting by recent activity. UI components and stores should call the storage facade instead of duplicating this logic.

Three-stage page normalization and mutations are pure helpers in `src/domain/three-stage/three-stage-pages.ts`. UI handlers should use those helpers for page duplication, independent form creation, deletion, ordering, selected-form changes, and legacy-field synchronization.

## Prompt Library Data

Prompt Library presets use `IPreset`. UI and Agent approval flows should call preset store methods instead of writing storage directly.

The local storage service owns Prompt Library rows in the profile SQLite database. The old Prompt JSON files are read-only migration sources. A completely empty database is seeded by the service from the bundled preset JSON, and the frontend no longer seeds durable presets.

Frontend project and preset storage calls use `/storage-api/*`, proxied to the storage service. The older Vite dev JSON endpoints are read-only compatibility helpers; their write methods return `410`.

## Floating Screenshot Capture Data

The Capture Bar page creates `capture-toolbar` on demand. It is a separate Tauri window rendered from `?window=capture-toolbar`; it is not created at desktop startup. On screenshot click, the toolbar stays visible in a disabled `正在准备截图…` state and emits `capture:screenshot-requested` to `main`.

The main window calls `capture_begin_selection`. Rust resolves the display containing the toolbar, reserves the single in-memory session, and creates `capture-selection` hidden at `?window=capture-selection&session=<id>`. Once that React page has loaded, it calls `capture_activate_selection`; Rust then hides the toolbar, captures one `xcap` frame on Tauri's blocking worker, and explicitly shows/focuses the gray monitor-sized selector. The selector submits a logical drag rectangle; Rust converts it to source-frame pixels, crops and PNG-encodes the image, then releases the full source frame. A session that does not become ready within 30 seconds is cleared and the toolbar is restored.

The selector converts the returned data URL into a `File`, uploads it through `storage.assets.upload`, and creates a Recent Capture through `storage.recentCaptures.create`. It then dispatches `recent-captures:changed` so Media reloads without a full-app refresh. Copy and local save are explicit user-clicked browser actions. Canvas placement is offered only when the screenshot began in an active Free Canvas project; it reuses the same `assetId` and never registers the capture in Prompt Library.

The Capture Bar page also owns a visible clipboard intake region. Direct reads use `navigator.clipboard.read()`; denied or unavailable reads focus the same region for Ctrl+V. DataTransfer and ClipboardItem paths accept PNG, JPEG, and WebP, then use the same dimension/upload/Recent Capture import service as the native screenshot flow. Clipboard records use `kind: "pastedMedia"` and preserve the original MIME type, filename, and import time.

## Recent Captures To Prompt Library And Canvas

Recent Capture registration is explicit. The Media page can register one item, register a batch as one Prompt per item, or merge a batch into one Prompt. A single storage endpoint validates every Capture revision and asset before inserting Presets and updating Capture links in one SQLite transaction. Prompt `meta.media` and Canvas image nodes both retain the Capture's existing `assetId`; neither path uploads another file.

```text
Recent Capture(assetId A)
  -> atomic registration -> Prompt meta.media(assetId A)
  -> explicit placement  -> Free Canvas image node(assetId A)
```

`registeredPromptId` is the authoritative registration link. Canvas links are independent fields, so placement cannot erase registered state. Asset diagnostics scans active/Trash Presets as well as projects and captures. Raw Recent Captures remain outside Agent context; only the resulting Prompt preset enters the curated Agent-visible source.

Media row selection only changes the detail-panel selection. Opening the analysis dialog requires the explicit Edit action. **Remove record** sends the Capture id and current revision to `DELETE /api/recent-captures/{id}` and removes only the Capture metadata row. Prompt/Canvas references and the shared asset remain intact; if the asset has no remaining consumer, diagnostics reports it as unreferenced for a future reference-aware cleanup workflow.

Recent Capture metadata is stored in SQLite beside projects and presets. During editable development, screenshot and clipboard-image assets remain under the repository `data/assets/`, and asset diagnostics treats Recent Capture `assetId` values as live references. Native captures add `origin.engine: "xcap"`, the display name, and native crop pixels for diagnosis. See [Native Screenshot Capture](./native-screenshot-capture.md) for the session lifecycle and permission boundary.

## Durable Data And Runtime Boundaries

Editable-development Storage Service data is rooted at the ignored repository `data/` directory, with storage backups under `backups/`. Runtime logs, the dynamic-port manifest, generated Tauri configuration, and desktop/update metadata may remain under `logs/`. All are local user/runtime state and must remain outside source updates. See [ADR-007](../decisions/ADR-007-repository-data-root-for-editable-development.md).

Source updates must treat durable data and local runtime state as out of scope. The sidebar Update module checks source revisions, previews changed source paths, creates a Storage Service backup under `backups/`, and applies source changes with a fast-forward Git merge without editing `data/`, `backups/`, or local runtime state under `logs/`. The legacy `git_pull_source` command remains only for compatibility with old desktop builds.

## Agent Collaboration Data

The frontend sends user-visible text plus bounded node identities and roles through the Python Gateway. Gateway resolves authoritative Canvas content by ID. Prompt Library items are loaded only for the explicit `prompt-library` mode, not for ordinary project conversation or Canvas editing.

The maintained pi runtime may return these pending proposal kinds:

- `free_canvas_text_insertions`: insert black user segments at exact anchors inside the one attached target while preserving all existing segments;
- `free_canvas_text_create`: create a complete derived text node for `rewrite` while preserving the source node;
- `free_canvas_text_create` with a validated `handoffBasis`: create one new all-user Prompt node only after explicit Document-selection/Storyboard-shot approval;
- `prompt_library_write_proposal`: add one new Prompt Library preset.

An explicit `chat-experimental` planning action may instead return at most one durable Canvas edit envelope:

- `document_create` or `document_changes` against an editor-neutral Document AST;
- `storyboard_create` or `storyboard_changes` against a structured Canvas Storyboard.

Gateway enriches these envelopes with authoritative project/node bases, deterministic identities, expected result digests, and exact model/Skill provenance. The frontend persists the node plus `AgentAppliedEditMarker` before ACK; Gateway reloads Storage before marking the edit applied. Document changes remain reviewable as tracked suggestions, and Storyboard changes remain reviewable as per-field differences.

Historical `free_canvas_text_update` proposals remain readable and approvable for compatibility, but revision 3 Canvas runs do not emit them.

Media analysis is read-only and returns no mutation proposal. Every maintained proposal remains pending until the user explicitly selects Apply or Reject. Planning Canvas edits are not legacy proposals: they exist only after an explicit user action and pass the Storage-backed save/ACK protocol above.

The frontend parser still recognizes older card, standalone-storyboard, and three-stage proposal shapes for compatibility with existing tests and historical responses. Those shapes are not the Canvas Storyboard mutation path and must not be treated as current Agent capability.
