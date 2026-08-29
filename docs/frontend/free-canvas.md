# Free Canvas Workspace

Selected-image toolbar, More/right-click menus, modal image-operation workbenches, visible export and multi-view result groups are documented in [Contextual Image Actions](./contextual-image-actions.md). These surfaces are independent from the existing right-side `Agent / 图片生成 / Prompt库` workspace.

Free Canvas is a standalone builder project type: `IPromptProject.type === "free-canvas"`.
It is no longer a three-stage template variant and does not use `threeStage.pages`,
three-stage forms, Page constraints, or `threeStage.meta.freeCanvas` as its source of truth.

## Data Model

- Free Canvas content lives in `project.freeCanvas`.
- `IFreeCanvasProject.nodes` stores text, image, arrow, provider-neutral legacy `image-generator`, planning `document`, structured `storyboard`, and read-only `unsupported` nodes.
- `IFreeCanvasProject.edges` stores user-created React Flow connections.
- The default project is empty: no nodes, no edges, no required Page/Form fallback.
- Old projects with `type: "three-stage"` and `meta.builderTemplateId: "free-canvas"` are migrated on load:
  - three-stage form outputs become normal text nodes;
  - legacy media nodes become standalone image/text/arrow nodes;
  - valid legacy edges are remapped to migrated node IDs.

## Text Nodes

Text nodes store visible text as ordered segments:

- `source: "preset"` segments are template text and default to red.
- `source: "user"` segments are user-authored text and default to black.
- The UI presents both as one editable-looking node; color is the only visible distinction.
- Agent completion preserves all existing segments and proposes anchored black `user` insertions. Agent rewrite creates a separate derived text node; it never overwrites the source. Historical `free_canvas_text_update` records remain compatible but are not emitted by the current revision 3 flow.

Quick messages are Prompt Library presets in the dedicated `quick-message` category. Clicking a
quick message creates a new text node with the preset content as a red `preset` segment; later
typing creates or updates black `user` text.

Quick-message reference media belongs to Prompt Library preview (`meta.media`). It is not inserted
into the canvas when a quick message is clicked.

Legacy quick messages from `settings.meta.freeCanvasQuickTextPresets` are read as a compatibility
source and migrated into Prompt Library presets with `meta.quickMessage.legacyId`. New quick
message creates, edits, deletes, Trash, and restores use the Prompt Library preset store.

Quick-message notes are historical only. The Free Canvas drawer and lightweight quick-message
dialog show and edit only the name and template body; they do not display or write
`meta.quickMessage.note`.

### Interaction Rules

- Empty canvas left-drag creates a React Flow selection rectangle for multi-select.
- Hold `Space` while left-dragging the empty canvas to pan the viewport.
- Node dragging remains enabled from the node body when the node is not in an editing state.
- Text node toolbars are single-selection only. Multi-select must not show per-node edit controls.
- Text node toolbars expose Edit, Copy, font size, and user-text color controls. Copy writes the ordered visible text segments to the clipboard and preserves segment newlines.
- The text node font-size selector keeps the stored `small`, `medium`, `large`, `extra-large`, and `huge` values while rendering with high-contrast closed-state text on the dark toolbar.
- Text nodes created from quick messages start selected but not editing, so they can be moved or deleted immediately.
- Empty text nodes created from the toolbar still enter editing mode immediately.

## Images and Edges

- Image uploads still go through the image asset service and store durable `assetId` references.
- Image nodes keep width, height, optional crop rectangles, source node metadata, and image-local annotations.
- The bottom toolbar exposes `Image`, not `Arrow`. `Image` opens a local file picker for PNG, JPEG, and WebP files.
- Multiple selected image files are uploaded through the same path as drag/drop images and become multiple image nodes with the existing upload offset behavior.
- Image nodes render only the image body. The canvas UI may show a selection ring or React Flow handles, but the node does not add a white card background or padding around the image content.
- Single selected image nodes expose a compact node toolbar with only `Edit image annotations` and `Crop image`.
- Image resizing uses React Flow `NodeResizer` with aspect-ratio preservation. Resize commits write back the image node frame, while image-local annotations keep their normalized positions.
- Existing `arrow` nodes remain supported for loading, rendering, and deletion, but the UI no longer has an active arrow creation button.
- Removing any node removes connected Free Canvas edges.
- Deleting the final node is valid and leaves an empty canvas.

## Project Subject And Material Library

Free Canvas has a project-scoped resource rail below the project title. It enters each project collapsed at 44 px. The expanded panel is 280 px; at 1440 px and wider it reserves canvas width, while narrower windows use an overlay that closes on canvas click or Escape. Switching projects clears the old snapshot before loading and resets the panel to the Subject tab.

Subjects use a dense three-column grid. Hover or keyboard focus waits 250 ms before showing a large preview and closes 150 ms after leaving. `加入本轮` appends the provider-ready asset to the current image Composer as a stable `reference-image`, preserves the original source asset identity, enforces duplicate/model limits, opens the right image-generation tab, and never sends a request.

Materials may be uploaded into arbitrary-depth folders. Folder expansion, inline renaming, moving, and ordering use native HTML drag and drop. Indentation grows by 12 px per level and is visually capped at 48 px; the full path remains available as a tooltip. These operations update metadata only. `置入画布` creates a normal image node from the preview asset and saved dimensions near the visible canvas center.

A material card may also be dragged directly from the left library onto the central canvas. The card carries a dedicated project-material payload alongside the library's internal sort payload. A same-project drop creates the same ordinary preview-backed image node at the pointer location; this is a copy/placement operation, so the resource remains in its folder and no image is uploaded again. Cross-project payloads are rejected. Subject cards remain Composer-only and cannot be placed on the canvas through this path.

Resource state is optimistic. Failed writes restore the previous snapshot; a revision conflict reloads the entire active-project snapshot. The global MiniMap lives at the canvas lower right, immediately left of the zoom controls.

### Drag-and-drop surface boundaries

Free Canvas has three mutually exclusive image-file drop surfaces:

| Surface | Active bounds | Drop result |
| --- | --- | --- |
| Project resource library | Expanded content area to the right of the 44 px icon rail | Imports supported image files into the active Subject tab or the selected Material folder. |
| Central canvas | React Flow canvas area after left/right panel insets | Uploads external image files and creates ordinary image nodes at the pointer location; also accepts the active project's internal material-card payload without re-uploading it. |
| Image-generation workbench | Right conversation/Composer panel only | Imports supported image files as ordered references in the current in-memory draft, subject to the active model limit. |

Each surface owns its own drag depth, overlay, `dragover`, and `drop` handling. A handled drop stops propagation so the full-screen canvas overlay cannot remain stuck and one file cannot be imported by two destinations. Leaving or completing a drop clears only the owning surface's overlay. Composer drops open the image-generation mode when needed but never create a run or call the provider; material-card payloads are deliberately ignored there because project materials are not a Composer attachment source.

## Project Image Generation Agent And Legacy Nodes

The right rail has three peer tabs: `Agent | 图片生成 | Prompt库`. `图片生成` is a project-level task Agent UI backed directly by the image Runtime; it does not call the text LLM. Every send is one independent image request. Previous turns are displayed from immutable run snapshots and are never appended to the next provider request.

The browser reaches the local Runtime through `/agent-api/promptcard/runtime/image-generations`. The Runtime itself owns `POST /api/promptcard/runtime/image-generations`; browser code must not send that path through Vite's vendor-facing `/api` proxy.

The bottom toolbar action is `打开图片生成`. It only opens the project Image Generation tab; it never creates an `image-generator` node and is not draggable. Opening the tab preserves the active conversation, or restores the project's most recently updated conversation when the project has stored history. A conversation row is created only when the first queued run is persisted.

The shared right workbench is 456 px wide and reserves 56 px when collapsed. Canvas viewport-center calculations, material placement, pending generation placement, quick-message dialogs, and the bottom toolbar use those same insets; changing the visual width without updating those calculations is a layout bug. The workbench uses one 44 px title/status row and one 32 px peer-tab switcher instead of repeating page and feature titles inside each mode. Its full-height surface and both Composer surrounds are pure white; neutral gray is reserved for tab tracks, hover states, controls, and separators.

The Image Generation tab contains one compact project/conversation row with icon-only new-conversation and project-history actions, chronological turn cards, and a bottom Composer. On project entry, the first conversation returned by the `updatedAt DESC` project history query is selected and its runs are rendered chronologically in this main conversation area. The blank starter state is reserved for projects without history or for an explicit click on `新建对话`; that explicit new-conversation intent wins over any history request that finishes later. Model readiness appears in the shared workbench header; the conversation row exposes only the remediation action when configuration is required. Empty conversations keep starter actions near the top rather than vertically centering a large placeholder. This interaction update does not change the `Agent | 图片生成 | Prompt库` tabs, their 456 px workbench width, or the responsibilities of the other two tabs.

The Composer is one compact visual surface with a fixed 40 px attachment strip, a flexible prompt editor, and one fixed 28–32 px bottom toolbar. Its top border exposes an accessible horizontal separator: dragging upward expands the Composer, dragging downward contracts it, and Arrow Up/Down plus Home/End provide the keyboard equivalent. The minimum height is 168 px; the maximum is 70% of the right workbench while preserving at least 160 px for the scrollable conversation area. The height is front-end session state only: it survives a new image conversation inside the mounted workbench but resets after a page reload and is never written to project data. All additional height belongs to the prompt editor, not the attachment strip or parameter toolbar. Workflow, ready model, ratio/resolution/custom size, output format, prompt optimization, and watermark settings open in anchored popovers instead of occupying permanent vertical space. It supports local uploads through the picker or a file drop anywhere inside the right workbench, explicit injection of the current React Flow selection, and the point/bounding-box region dialog.

Each Composer reference thumbnail has separate hit targets. Clicking the image body opens a modal, object-contained full-image preview; clicking its top-right remove control deletes only that ordered Composer input and its draft-local regions. It never deletes the source canvas node or the underlying asset. The small `主图 / 参考` role badge remains the entry to ordering, role, and visual-annotation controls.

Canvas nodes are injected only after the user clicks `加入所选节点`. Visible ordered text is appended to the draft and image nodes with local `assetId` values become references. Selection, dragging, connecting, restoring a project, or editing node properties never injects content or invokes the provider. Rejected selections report a concrete reason.

The same asset may occupy source and reference roles, but each role counts toward the ten-image limit. Composer inputs keep stable `referenceId` values and explicit order. Provider-side `图1`/`图2` labels are derived from that order rather than persisted into the prompt.

The prompt editor stores `{ type: "text" }` and `{ type: "reference" }` segments, never `contentEditable` HTML. Its controlled editing projection renders text segments as text and reference segments as inline 24 px thumbnail tokens. DOM input is converted back into `PromptDocument` units immediately; markup, token HTML, and selection objects never enter project persistence, runtime snapshots, or provider requests. Stable `referenceId` values remain the source of truth, and visible text nodes enter the draft only through the explicit selection-injection action.

Typing ASCII `@` outside IME composition opens a keyboard-accessible picker containing only images already added to the current draft. The picker supports filtering, pointer selection, Arrow Up/Down, Enter/Tab, and Escape. The toolbar `@` button opens the same flow. After selection, the prompt shows the image thumbnail and a small `图N` badge at the reference position instead of visible `@label` text; the accessible name and tooltip retain the image name, display number, and source/reference role. Repeated mentions may reference the same image. Backspace/Delete removes an adjacent token as one unit, paste accepts plain text only, IME composition commits once at composition end, and logical caret offsets are restored after controlled updates. Removing an input preserves its token as a red unresolved thumbnail and blocks generation until the user removes or rebinds it; regions bound to the removed input are still removed.

The attachment strip shows the compiled `图N`, source/reference role, and mention usage. Its per-image menu owns reordering, role changes, visual annotations, and removal. Visual-annotation actions identify the image by stable `referenceId`; region edit separately exposes the current region count and opens the point/bounding-box editor.

Composer validation separates submission blocking from inline presentation. Empty prompt, model readiness, and connection readiness still disable Generate, but an untouched empty prompt does not render a red error and model remediation remains in the header. Actionable draft errors such as unresolved mentions, invalid custom dimensions, missing source/reference inputs, and missing regions render near the send button.

The user-facing workflow is distinct from the provider mode:

| Workflow | Required intent | Runtime mode |
| --- | --- | --- |
| Text to image | Prompt, no required image | `generate` |
| Reference generation | Prompt plus reference images | `generate` |
| Smart edit | Prompt plus source image | `edit` |
| Region edit | Prompt, source image, and point/bbox | `region-edit` |

Old `image-generator` nodes stay at their original position as read-only previews. They preserve old results, model/size summaries, and existing edge anchors, but all handles reject new connections and no Inspector, Generate, history, reconciliation, or automatic execution path remains. Their only active control is a user-clicked `打开图片生成` or `继续创作`, which copies the old snapshot into a new project draft without sending it.

The current Seedream catalog exposes:

- `generate`, `edit`, and `region-edit` modes;
- 1K/2K, smart/preset/custom aspect ratios, PNG/JPEG, and watermark selection;
- point and bounding-box regions using integer 0-999 coordinates;
- one output and no streaming, cancellation, 4K, native mask, sequential, or grouped output controls.

Region editing uses a large-image dialog with point, bounding-box, select/move, delete, undo/redo, zoom, and fit controls. It traps focus, supports keyboard operation, and returns focus to its trigger on close. Draft coordinates remain normalized integers from 0 to 999 until Save. Regions bind to a reference ID and are removed or rebound when their source disappears; the canvas explicitly describes this as point/box region reference, not native binary-mask upload.

Turn UI localizes queued, running, succeeded, and failed states. It does not invent percentage progress or expose an unsupported cancellation action. Retry and Generate Again copy an immutable request snapshot into the composer and create a new run only after another explicit Generate click. A successful result becomes a `generatedResult` Recent Capture and a pending ordinary-image canvas placement.

Result actions include Generate Again, Re-edit, Smart Edit, use as reference, idempotent canvas placement, and Media navigation. The selected-image and multi-view `作为参考` action is a direct bridge into this same Composer: it appends the asset as an ordered reference, opens the 图片生成 tab, preserves the current prompt/conversation, and never opens a secondary workbench or sends a request. `生成历史` opens a project-scoped selector and preview: conversation summaries and thumbnails are on the left, and the selected immutable turn stream is on the right. Continuing a historical conversation makes it the active conversation and renders the same turn stream in the main right-rail conversation area; the Composer remains a blank next-turn input because history is grouping and display state, not provider prompt context.

Conversation drafts, loads, visible turns, and placement handling are partitioned by `projectId`. Switching projects clears the previous project's visible state, aborts its history reads, then restores the new project's latest conversation when available. An old project generation may finish in the background, but it cannot write into the active project. Returning to the source project processes its pending placements. Each ordinary result node stores `generationRunId`, `conversationId`, local `assetId`, and source metadata; placement deduplication checks `generationRunId` before creating a node.

Sending requires `settings.meta.featureFlags.imageGenerationNodeV1 === true`. Development uses an enabled default unless a persisted setting overrides it; production defaults to the gray rollout state. Real generation additionally requires the Agent Runtime server flag and an enabled, credentialed, successfully tested `image.primary` connection with a compatible SDK. Turning off sending keeps conversations, old nodes, results, history, and Media assets readable.

The project-level missing-model action preserves `{projectId, returnTarget}` while navigating to image-model management and returns to the source project after assignment. Legacy-node continuation may additionally carry `nodeId`, but new project conversations never bind or mutate a canvas generator node. See [Image Generation And Model Management](../architecture/image-generation-and-model-management.md).

## Image Annotations

`ImageAnnotationEditor` owns all editable image annotation interactions. The canvas image node itself only displays saved annotations and must not host inline inputs, drawing gestures, or draggable annotation controls.

Supported annotation kinds:

- `text`: movable text box with editable content.
- `rect`: white rectangle overlay with resize handles.
- `arrow`: two-point arrow created by press-drag-release.
- `freehand`: freehand path created by press-drag-release.
- `shotNumber`: black square with editable white number text.

Annotation coordinates are normalized to the image bounds (`0..1`) and live in `IFreeCanvasImageNode.annotations`. They are not independent React Flow nodes. Moving or resizing the image node must preserve each annotation's relative placement.

The editor uses a type-mode filter:

- Opening the editor starts with no active annotation mode.
- Toolbar buttons only enter a mode; they do not create annotations directly.
- In `text`, `rect`, or `shotNumber` mode, clicking empty image space creates that kind of annotation.
- In `arrow` or `freehand` mode, press-drag-release on empty image space creates the annotation.
- Only annotations whose `kind` matches the active mode can be selected, moved, resized, edited, or deleted.
- Other annotation kinds remain visible but are pointer-inert and show no selection frame, delete button, resize handles, or arrow endpoints.

The editor uses local draft history. Undo/redo, creation, move, resize, delete, freehand completion, and arrow completion update only the modal draft until `Save annotations` replaces the image node annotations. `Cancel` discards the draft.

Keyboard and pointer events are isolated while the annotation or crop modal is open:

- React Flow deletion is disabled with `deleteKeyCode={null}` while a modal is open.
- The modal captures keyboard, pointer, mouse, and click events so they do not reach the canvas.
- `Delete` / `Backspace` delete only the selected annotation of the current mode.
- Text and shot-number inputs keep normal text-editing behavior for `Delete` / `Backspace`.
- Arrow and freehand drawing or movement must end on `pointerup`, `pointercancel`, `lostpointercapture`, `blur`, or when pointer movement reports no pressed buttons.

## Image Cropping

Double-clicking an uncropped image node with an `assetId` opens `ImageCropEditor`.

The crop editor uses edge-pull behavior:

- Drag from the left or right image edge to create a vertical crop line.
- Drag from the top or bottom image edge to create a horizontal crop line.
- Drag an existing crop line to reposition it.
- Double-click a crop line, or drag it back to the outer edge, to remove it.
- Confirming creates new image nodes from the crop grid and preserves the source asset reference.

The editor is an adapter around the legacy `FreeCanvasMediaNode` crop utility. Free Canvas project data still stores the resulting nodes as `IFreeCanvasImageNode`; no new image node schema is introduced.

## Document And Storyboard Nodes

Planning Documents and Prompt text nodes are different domains. A Document stores `PlanningDocumentV1`: an editor-neutral block AST with revision, deterministic digest, and tracked suggestions. Supported blocks are headings, paragraphs, bullet/ordered/check lists, block quotes, and basic tables; inline content supports text, bold, italic, and links. Tiptap `3.30.3` adapts that AST for editing but its JSON is never persisted or sent to Gateway.

Document nodes provide one canonical state across inline, expanded, and collapsed views. Direct user edits update canonical content through the Canvas command/save coordinator. Agent insertions are shown as green effective text; Agent deletions remain visible as red strikethrough but are excluded from effective text. Linked replacements resolve atomically. Single/all accept/reject and undo/redo preserve deterministic content and digest.

Agent Document operations are editor-neutral `insert`, `delete`, and `replace` records. Their coordinates are NFC-normalized UTF-8 byte offsets within one leaf block. Cross-block ranges, invalid code-point boundaries, stale block digests, Tiptap JSON, and arbitrary patch objects are rejected. A successful Canvas save writes the content and `AgentAppliedEditMarker` together before Gateway acknowledgement.

Storyboard nodes reuse `IStoryboardSequence` and `IStoryboardRow` field definitions, but they do not use the standalone Storyboard proposal mutation path. Explicit Document -> Storyboard records source Document revision/digest, attached resource digests, model, and exact Skill provenance. Later Agent revisions appear as per-field old/new differences with single/all accept/reject and stale-base checks.

Prompt handoff is also explicit. A non-empty Document selection or one Storyboard shot creates a pending `free_canvas_text_create` proposal. Approval creates exactly one new Prompt text node containing only `user` segments. The handoff never updates an existing Prompt or reads/writes Prompt Library.

Unknown node kinds normalize to read-only `unsupported` projections and preserve the untouched original JSON. They never fall through to text/image behavior.

## Agent Context

Free Canvas uses `free-canvas-workspace` Agent context. The snapshot includes selected node,
all bounded nodes, edges, and text fields split into:

- `displayText`
- `presetText`
- `userText`
- `segments`

Document entries in ambient snapshots expose identity, title, revision, digest, and a bounded excerpt only. Full effective Document text is resolved by Gateway only for an explicit attachment, `@Document`, selected range, or Document -> Storyboard action. Storyboard and Document bodies never become implicit Prompt, Prompt Library, Prompt compiler, or image-generation context.

Builder chatboxes remain workspace scoped and do not grant Prompt Library write permissions.

The current pi policy is attachment- and role-driven:

- **补全** on a text node attaches it as the single writable target; **发送到 Agent** attaches it as a read-only reference;
- the Agent composer displays up to ten full node labels, with the target first, and supports atomic `@` references to attached nodes;
- completion uses exact segment or unique in-segment text anchors to interleave black user segments without changing any original character, color, source, or order;
- rewrite creates a complete derived node to the source node's right; text selection no longer changes rewrite behavior;
- template segments, all existing target segments, and reference nodes are always read-only, and explicit context without a target is discussion-only;
- every proposal requires explicit Apply or Reject and passes node revision, template digest, segment digest, and anchor freshness checks before application.

The complete interaction and request contract is maintained in [Canvas Agent Omnireference Prompt Editing](./canvas-agent-reference-editing.md).

## Right Panel Prompt Library Preview

The Free Canvas right panel has an `Agent` / `图片生成` / `Prompt库` segmented switcher.

- `Agent` keeps the existing `free-canvas-workspace` Agent chat flow inside the shared compact shell. Its context/runtime state uses a 40 px strip, empty-state commands stay near the top, and the bottom Composer embeds context and send controls in one bordered surface. Enter sends; Shift+Enter inserts a newline.
- `图片生成` owns project conversations, explicit canvas injection, generation turns, result actions, and the history dialog.
- `Prompt库` embeds the reusable prompt library preview panel.
- Prompt library preview supports search, category filters, preset/media preview, and copy actions.
- The preview category filter includes `快捷消息`, backed by Prompt Library quick-message presets.
- Prompt clicks open `PromptPresetPreviewDialog`; they do not insert text into the canvas or fill the Agent input.
- Management functions such as edit mode, add-to-library, Trash, and Agent ingestion are intentionally hidden in the embedded preview.
- `previewMode` still disables Agent Runtime, while Prompt library preview can read locally available presets.

## Image Generation Placeholder Lifecycle

An Image Generation send is represented by one durable ordinary image node from submission through completion. The frontend creates a run ID in the form `image-run-<32 lowercase hex>` and uses it for the optimistic conversation turn, Runtime request, Storage run, placement, and node metadata. The node ID is `free-image-generation-${runId}`; reconciliation must use `meta.generationRunId` as the semantic identity and must never create a second node for the same run.

Submission order is part of the provider-call safety boundary:

1. Validate the draft and persist any reference-image or annotation derivatives.
2. Create a placeholder at the next visible canvas position. Fit the requested aspect ratio inside a 320 px box; `smart` uses 320 x 320.
3. Persist the project containing the placeholder.
4. Call the Runtime only after that save succeeds.

The placeholder carries this generation metadata:

| Field | Contract |
| --- | --- |
| `generationRunId` | Stable run identity shared with Runtime and Storage. |
| `conversationId` | Owning project image-generation conversation. |
| `generationState` | `running`, `succeeded`, or `failed`. |
| `generationErrorCode` | Safe normalized code, present only for failed nodes. |
| `source` | Always `image-generation-conversation`. |
| `generatedResult` | Present and `true` only after success. |

A running node renders a busy placeholder with `aria-busy`, permits selection, movement, and resizing, and suppresses crop, annotation, secondary-creation, and deletion actions. Deletion is blocked both in the node UI and in the shared canvas deletion path. A terminal node is deletable.

Success updates only `assetId`, the local asset URL, and generation metadata on the matching node. It must preserve node ID, position, width, height, selection, and other canvas changes made while the request was in flight. Failure retains the same node at the user's chosen frame and stores only a safe error code; retry remains a right-panel history action and creates a new run.

On project load, running nodes are reconciled against Storage by `generationRunId`. `queued` or `running` records keep the busy state and are polled; `failed` records restore a failed placeholder; `succeeded` records hydrate from the first output asset. A missing run or missing successful output becomes a stable failed placeholder. Pending placement processing hydrates an existing node first and marks the placement `placed` only after project persistence. Creating a new result node remains a compatibility fallback for successful runs that predate placeholders.

### Contextual multi-view placeholder groups

Contextual multi-view uses the same ordinary image-node presentation but not the project conversation ownership above. Its placeholders use `source: contextual-image-operation`, have no conversation ID, and are related by provider-neutral group/item/view metadata. Submission is ordered as complete canvas persistence, atomic batch preparation, then concurrency-one provider execution. A failure in either of the first two phases produces zero provider calls.

Each failed-member retry is tied to the clicked canvas `nodeId`, its group/item/view tuple, the original/canvas/provider source identities and the source node identity. A valid retry puts a new run on that same node and preserves its position and dimensions; the previous failed run remains immutable and successful group members are not submitted again. Reload and project switching reconcile by both run ID and node ID so the existing node is hydrated or resumed without duplicate provider work or placement.

This differs from the project Image Generation Agent lifecycle in [ADR-013](../decisions/ADR-013-recoverable-image-generation-placeholders.md): ADR-013 gives a foreground conversation run one stable run-derived placeholder identity. Contextual multi-view follows [ADR-015](../decisions/ADR-015-explicit-multi-view-request-groups.md), where an explicitly selected failed member can retain its canvas node while receiving a new retry run.

## Verification

```powershell
npm.cmd test -- --run src/domain/free-canvas/free-canvas-project.test.ts src/utils/agent-workspace.test.ts src/services/agent-runtime-service.test.ts src/utils/storage.test.ts
npm.cmd test -- --run src/domain/documents/planning-document.test.ts src/domain/documents/document-suggestions.test.ts src/components/canvas/document/planning-document-tiptap.test.ts src/components/canvas/nodes/DocumentNode.test.tsx src/domain/storyboard/canvas-storyboard.test.ts
npm.cmd test -- --run src/domain/project-resources/project-resource-drag.test.ts src/components/canvas/ProjectResourceLibrary.test.tsx src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx
npm.cmd test -- --run src/components/AgentCollaborationPanel.test.tsx src/components/canvas/image-generation/ImageGenerationConversationPanel.test.tsx src/components/canvas/image-generation/ImageGenerationComposer.test.tsx
npm.cmd run test:e2e -- free-canvas-image-crop.spec.ts
npm.cmd run test:e2e -- free-canvas-text-node.spec.ts
npm.cmd run test:e2e -- free-canvas-document.spec.ts
npm.cmd run test:e2e -- tests/e2e/free-canvas-dense-right-panel.spec.ts --project=chromium
npm.cmd run test:e2e -- tests/e2e/project-resource-library.spec.ts --project=chromium
npm.cmd run test:e2e -- -c playwright.image-generation.config.ts
npm.cmd run build
```

Manual checks should cover creating an empty Free Canvas project, adding free text, adding a
quick-message text node, changing text size/color, selecting multiple nodes, deleting the last
node, adding images by toolbar/drag/paste, resizing a single selected image, opening the image
annotation editor, verifying mode-filtered annotation editing, checking that modal `Delete` never
deletes the image node, confirming arrow/freehand gestures stop on pointer release, cropping an
image from each edge direction, connecting nodes, switching the side panel between Agent and
Prompt library preview, renaming a text node, attaching target/reference labels, inserting `@`
mentions, switching the conversation model, previewing multi-anchor interleaved completion, and approving or rejecting insertion and derived-node rewrite proposals. Approval must leave every original segment unchanged; stale anchors or source revisions must reject the whole proposal.

Quick-message manual checks should confirm the drawer and lightweight dialog have no note field,
and that clicking a quick message inserts only a red preset text node even when the preset has
reference media in Prompt Library.

Resource-library drag checks should cover all three destination bounds independently: dropping an external file inside the expanded left list imports it only into the active library location; dropping it on the canvas creates only a canvas node; dropping it on the right workbench creates only a draft reference. Dragging a same-project material card onto the canvas must place it at the drop point without moving the library record or uploading another asset. Subject cards and cross-project material payloads must not use that path. Every overlay must clear after drop or cancellation.

Image-generation manual checks should confirm connection/assignment selection, explicit canvas text/image injection, right-workbench file drops, stable multi-reference `@` binding after reorder, source/reference role switching, 1K/2K/custom validation, point/bbox save and undo, visual-markup rasterization, placeholder appearance before the delayed Runtime response, running-node movement/resizing and deletion blocking, in-place success without frame reset, retained failure, failed-run retry as a new row, generated-result placement and Media reuse, reload recovery, and history retention after project deletion. A file drop or failed placeholder save must not call the provider. Node selection, edge changes, project reload, and result-node continuation must not call the provider until the user presses Generate. Do not perform a live Ark smoke test unless the user has configured a keyring credential and explicitly enabled the server rollout flag.
