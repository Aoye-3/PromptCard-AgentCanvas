# Skill Conversation, Document, And Storyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the project-local `对话模式【测试中】 -> persistent Skill -> file attachment -> Document working draft -> explicit Storyboard -> explicit Prompt proposal` loop and stop at Plan 008 Checkpoint 3.5.

**Architecture:** Storage remains the durable authority for conversations, local document resources, and apply status. Gateway resolves Skills/files and enforces typed write policies; text-agent-runtime only emits validated domain operations; the frontend applies them through project command/save coordination. Document, Storyboard, Prompt, image resources, and the future Local Agent Bridge remain separate domains.

**Tech Stack:** React 18, TypeScript 5, Zustand, XYFlow, Tiptap `3.30.3`, FastAPI/Python 3.12, SQLite schema v16, `python-docx==1.2.0`, `volcengine-python-sdk[ark]==5.0.36`, Vitest, pytest, Playwright.

**Spec:** [Skill Conversation, Document, And Storyboard Design](../specs/2026-08-27-skill-conversation-document-storyboard-design.md)

**Plan 008 mapping:** Tasks 1 -> 15.6; Tasks 2-3 -> 15.8; Tasks 4-5 -> 15.7; Tasks 6-7 -> 15.9; Tasks 8-9 -> 15.10; Task 10 -> Task 15.10 Technical Acceptance Gate / Checkpoint 3.5.

## Global Constraints

- Work only in the opened repository and current working directory. Before implementation, create/switch to `feat/skill-document-storyboard-loop` in place; never use a worktree, clone, temporary repository, or `C:` for project artifacts/caches.
- Preserve the existing unrelated startup-script changes; do not stage, rewrite, or commit them with this feature.
- Implement Tasks 15.6-15.10 only. Task 16 Bridge router/MCP, general Canvas mutation, automatic Skill matching, local OCR, asset-card nodes, and browser-plugin nodes remain out of scope.
- Existing Prompt `complete`, `rewrite`, `prompt-library`, template protection, one-shot Skill selection, Prompt Library/RAG, image generation, and standalone Storyboard workflows must stay compatible.
- New dependencies are exact: all selected `@tiptap/*` packages `3.30.3`, `python-docx==1.2.0`; do not upgrade the Ark SDK.
- Every mutation is test-first, one focused commit per task, and independently reviewed before the next task.

---

### Task 1: Freeze Cross-Domain Types And Dispatch Guards

**Files:**
- Modify: `src/models/PromptHistory.model.ts`
- Modify: `src/models/Agent.model.ts`
- Create: `src/domain/agent/agent-provenance.ts`
- Modify: `src/domain/free-canvas/free-canvas-project.ts`
- Test: `src/domain/free-canvas/free-canvas-project.test.ts`
- Test: focused Agent model/normalization tests

**Interfaces:**

```ts
export type AgentInteractionMode = 'prompt-edit' | 'chat-experimental'

export type PlanningInlineV1 = { text: string; bold?: true; italic?: true; href?: string }
export type PlanningDocumentBlockV1 =
  | { id: string; type: 'paragraph' | 'blockquote'; content: PlanningInlineV1[] }
  | { id: string; type: 'heading'; level: 1 | 2 | 3; content: PlanningInlineV1[] }
  | { id: string; type: 'bulletList' | 'orderedList'; items: Array<{ id: string; content: PlanningInlineV1[] }> }
  | { id: string; type: 'checkList'; items: Array<{ id: string; checked: boolean; content: PlanningInlineV1[] }> }
  | { id: string; type: 'table'; rows: Array<{ id: string; cells: Array<{ id: string; content: PlanningInlineV1[] }> }> }

export interface IFreeCanvasDocumentNode extends IFreeCanvasBaseNode {
  kind: 'document'
  document: PlanningDocumentV1
  linkedDocumentResourceIds: string[]
  provenance?: AgentRunProvenance
}

export interface IFreeCanvasStoryboardNode extends IFreeCanvasBaseNode {
  kind: 'storyboard'
  sequence: IStoryboardSequence
  source: StoryboardSourceProvenance
  pendingFieldChanges: StoryboardFieldChange[]
}

export interface IFreeCanvasUnsupportedNode extends IFreeCanvasBaseNode {
  kind: 'unsupported'
  originalKind: string
  originalNode: Record<string, unknown>
}
```

- [ ] Write RED tests proving legacy projects normalize unchanged, `document`/`storyboard` round-trip without becoming `text`, and an unknown kind becomes a read-only `unsupported` projection whose `originalNode` serializes back unchanged.
- [ ] Add the two node kinds, editor-neutral block/suggestion types, and top-level interaction mode. Move the existing `AgentRunProvenance` type to the neutral domain module and import it from both model files to avoid a circular PromptHistory -> Agent dependency. Keep `CanvasAgentEditMode` unchanged.
- [ ] Replace the current normalization fallthrough with explicit branches. Add the ADR-020 invariant comment at the closed dispatch point.
- [ ] Audit compile errors from the expanded union. Add explicit unsupported branches only; do not cast or add a default text/image fallback.
- [ ] Run focused tests and `npm run build`; commit `feat(canvas): define isolated document and storyboard nodes`.

### Task 2: Add Schema v16 Project Document Resources

**Files:**
- Modify: `promptcard_storage/store.py`
- Create: `promptcard_storage/document_resources.py`
- Create: `promptcard_storage/provider_file_cleanup.py`
- Modify: `promptcard_storage/app.py`
- Test: `promptcard_storage/tests/test_project_document_resources.py`
- Test: `promptcard_storage/tests/test_sqlite_store.py`

**Interfaces:**

```text
project_document_resources(
  resource_id, project_id, relative_path, original_filename, content_type,
  size, sha256, extraction_kind, extraction_status, normalized_text,
  normalized_text_digest, revision, lifecycle_status, created_at, updated_at
)

provider_file_cleanup(
  cleanup_id, provider_id, connection_id, remote_file_id,
  created_at, last_attempt_at, attempt_count, next_attempt_at, last_error_code
)

POST   /api/projects/{projectId}/document-resources
GET    /api/projects/{projectId}/document-resources
GET    /api/projects/{projectId}/document-resources/{resourceId}
DELETE /api/projects/{projectId}/document-resources/{resourceId}
POST   /api/projects/{projectId}/document-resources/{resourceId}/restore
```

- [ ] Write RED migration/validation tests for one schema v15 -> v16 migration that creates both document-resource and provider-cleanup tables; cover backup/restore, health diagnostics, project isolation/lifecycle, and no change to image `project_resources`.
- [ ] Write RED format tests: strict UTF-8 TXT/MD, `%PDF-` PDF, valid Office Open XML DOCX; reject MIME/extension mismatch, NUL/binary text, corrupt/encrypted DOCX, traversal/remote relationships, excessive ZIP entries/ratio/uncompressed bytes, and fixed size/count budgets.
- [ ] Implement a dedicated document store under the repository data root using temp-file + fsync + replace and one compensating transaction. Do not expand the ordinary image/video upload endpoint.
- [ ] Add exact `python-docx==1.2.0`; extract DOCX paragraphs and tables in document order after container validation. Ignore embedded objects/macros/remote relationships and never fetch them.
- [ ] Add the provider-cleanup repository in this migration task, including idempotent enqueue/get-due/mark-succeeded/mark-retry operations and redacted diagnostics. Expose project-scoped document APIs and typed frontend client methods returning resource identity/metadata, never absolute paths.
- [ ] Run focused Storage tests and full `npm run storage:test`; commit `feat(storage): add project document resources`.

### Task 3: Isolate Ark File-Backed Responses And Cleanup

**Files:**
- Create: `agent-runtime/backend/app/gateway/ark_responses.py`
- Create: `agent-runtime/backend/app/gateway/provider_file_cleanup.py`
- Modify: `agent-runtime/backend/app/gateway/promptcard_runtime.py`
- Modify: `agent-runtime/backend/pyproject.toml`
- Test: `agent-runtime/backend/tests/test_ark_document_responses.py`

**Interfaces:**

```py
def complete_ark_response(
    payload: dict[str, Any], *, api_base: str, credential: str,
    model_id: str, pdf_assets: list[ResolvedDocumentAsset]
) -> dict[str, Any]: ...

def retry_provider_file_cleanup(*, limit: int = 20) -> CleanupSummary: ...
```

- [ ] Write RED adapter tests for Files create -> Responses create -> Files delete, tool-call normalization, mixed text/image/PDF input, and unchanged no-file Chat Completions dispatch.
- [ ] Write RED failure tests for model error, client disconnect, delete failure, restart retry, repeated cleanup, unsupported provider/model, over-budget attachments, and redacted logs/errors.
- [ ] Implement a file-bearing Ark Responses adapter without editing the current `complete_ark_chat` semantics. Upload each attached PDF per invocation and delete every remote file in `finally`.
- [ ] Consume the Task 2 `provider_file_cleanup` repository. Retry on Gateway startup and bounded maintenance calls; never mutate schema v16 or expose file IDs, paths, credentials, raw provider bodies, or document text in ordinary logs.
- [ ] Add `document_input_not_supported` and model capability checks before provider invocation. TXT/MD/DOCX use normalized bounded text; PDF has no silent local fallback.
- [ ] Run focused Gateway/provider tests, configured Ruff, and full backend tests; commit `feat(gateway): add ephemeral Ark PDF responses`.

### Task 4: Persist Experimental Conversation Mode And Skill Binding

**Files:**
- Modify: `promptcard_storage/store.py`
- Modify: `agent-runtime/backend/app/gateway/promptcard_runtime.py`
- Modify: `src/stores/agent.store.ts`
- Modify: `src/components/AgentCollaborationPanel.tsx`
- Test: focused Storage/Gateway/store/component conversation tests

**Interfaces:**

```ts
interface AgentConversationMetadata {
  interactionMode: AgentInteractionMode
  boundSkillIds: string[]
}

PATCH /api/projects/{projectId}/conversations/{conversationId}/interaction
{ interactionMode: 'prompt-edit' | 'chat-experimental', boundSkillIds: string[] }
```

- [ ] Write RED tests for two consecutive messages sharing one conversation, a lost-response retry reusing the same request ID/result, frontend/Gateway restart hydration, and legacy conversation defaults. These tests satisfy Task 19's durability prerequisite early.
- [ ] Write RED Skill tests proving the experimental binding survives turns/reload, a pin move changes the next turn's exact provenance, and disabled/untrusted/archived/missing-tool Skills fail before model invocation.
- [ ] Persist `interactionMode`/`boundSkillIds` with optimistic conversation revision. Keep existing one-shot `selectedSkillIds` and clearing behavior in Prompt workflows.
- [ ] Add the user-facing `对话模式【测试中】` selector. In this mode no Prompt target is required, and the Skill menu says `本对话持续启用`; in Prompt mode current labels/behavior stay unchanged.
- [ ] Make the runtime system prompt and tool allowlist depend on authoritative interaction mode. A Skill cannot add tools or broaden the permission scope.
- [ ] Run focused frontend/Storage/Gateway/runtime tests; commit `feat(agent): persist experimental skill conversations`.

### Task 5: Add File Upload And Explicit Document Context

**Files:**
- Create: `src/components/agent/AgentDocumentAttachments.tsx`
- Modify: `src/components/agent/CanvasAgentComposer.tsx`
- Modify: `src/services/agent-runtime-service.ts`
- Modify: `src/utils/agent-workspace.ts`
- Test: focused composer/service/workspace tests

**Interfaces:**

```ts
interface AgentDocumentAttachment {
  resourceId: string
  name: string
  contentType: DocumentContentType
  size: number
  sha256: string
}

sendMessage({ documentResourceIds: string[], explicitDocumentNodeIds: string[] })
```

- [ ] Write RED UI tests for button upload and drag/drop of all four types, local persistence before send, progress/error/removal, five-file/aggregate budgets, and request bodies containing IDs only.
- [ ] Write RED context tests proving ambient workspace snapshots include only Document ID/title/revision/digest/bounded excerpt, while explicit `@Document`, selection, attachment, or transform can resolve bounded full effective text through Gateway.
- [ ] Implement upload using the project document-resource API. Do not create browser object URLs or pass local paths/provider IDs to the Agent runtime.
- [ ] Keep file chips and conversation attachment audit after reload; attachment selection for a message is explicit and clears after successful send unless the user reattaches it.
- [ ] Run focused frontend tests and `npm run build`; commit `feat(agent): attach project documents safely`.

### Task 6: Build The Document Node And Rich-Text Working Draft

**Files:**
- Create: `src/components/canvas/nodes/DocumentNode.tsx`
- Create: `src/components/canvas/document/DocumentEditor.tsx`
- Create: `src/domain/documents/planning-document.ts`
- Modify: `src/components/canvas/FreeCanvasBuilderScreen.tsx`
- Modify: `package.json` and lockfile
- Test: focused Document domain/component/browser tests

**Interfaces:**

```ts
interface PlanningDocumentV1 {
  version: 1
  blocks: PlanningDocumentBlockV1[]
  revision: number
  digest: string
  suggestions: DocumentSuggestion[]
}
```

- [ ] Install exact `3.30.3` versions of `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, task-list/task-item, link, table/table-row/table-header/table-cell. Configure npm cache inside the workspace drive.
- [ ] Write RED schema/domain tests for the editor-neutral block AST, deterministic derived effective text/digest, invalid content rejection, deep clone, Tiptap adapter round-trip, stable block IDs, and old-project normalization. `effectiveText` is recomputed on every read/write and is never a second authority.
- [ ] Write RED component tests for complete inline editing, expanded editor, collapsed title/summary, one shared content state, keyboard/focus behavior, and no Canvas pan/drag while editing.
- [ ] Implement the restricted Tiptap schema as an adapter over `PlanningDocumentBlockV1[]`, including a local stable-block-ID extension and persistent suggestion marks/decorations. Reject unsupported nodes/marks and pasted arbitrary HTML; never expose or persist Tiptap JSON as the runtime/Gateway contract.
- [ ] Route user edits through a reversible Document update command and project save coordinator. Save failure restores the prior node and presents retry.
- [ ] Run focused tests, TypeScript, and production build; commit `feat(canvas): add planning document node`.

### Task 7: Add Tracked Agent Document Changes And Apply ACK

**Files:**
- Modify: `src/models/Agent.model.ts`
- Modify: `text-agent-runtime/src/agent-service.ts`
- Modify: `agent-runtime/backend/app/gateway/promptcard_runtime.py`
- Create: `src/domain/documents/document-suggestions.ts`
- Modify: frontend apply/persistence coordination
- Test: runtime/Gateway/domain/component/recovery tests

**Interfaces:**

```ts
type DocumentChangeOperation =
  | { kind: 'insert'; blockId: string; utf8Offset: number; text: string; expectedTextDigest: string }
  | { kind: 'delete'; blockId: string; utf8Start: number; utf8End: number; expectedTextDigest: string }
  | { kind: 'replace'; blockId: string; utf8Start: number; utf8End: number; text: string; expectedTextDigest: string }

interface AgentAppliedEditMarker {
  conversationId: string
  requestId: string
  editId: string
  resultDigest: string
}

POST /api/projects/{projectId}/conversations/{conversationId}/edits/{editId}/ack
{ requestId: string, status: 'applied' | 'failed', errorCode?: string }
```

- [ ] Freeze text coordinates as UTF-8 byte offsets into NFC-normalized single-block plain text. Validate code-point boundaries in Python and TypeScript. Strictly interior insertions inherit the containing inline span's bold/italic/link marks; boundary insertions and replacements are unmarked; delete/replace preserves untouched marks.
- [ ] Write RED tool-schema/policy tests for `emit_document_create` and `emit_document_changes`; tools emit editor-neutral blocks/operations and reject Tiptap JSON, arbitrary JSON patch, Prompt targets, multiple write tools in one turn, stale base, invalid UTF-8 anchors, cross-block edits, oversize operations, and unbound interaction mode.
- [ ] Write RED suggestion tests for green insert, red strikethrough delete, linked replace, single/all accept/reject, effective draft semantics, and undo/redo.
- [ ] Implement typed operations and deterministic suggestion IDs/groups. Later Agent turns read `effectiveText`; deleted visual text is never concatenated into model input.
- [ ] Implement `pending_apply` with deterministic edit ID, deterministic create node ID, and expected result digest. Frontend applies one command and writes `AgentAppliedEditMarker` into the affected node in the same project save before sending ACK.
- [ ] Make Gateway reload the Storage project before terminal acknowledgement. Matching kind/ID/marker/result -> `applied`; no marker plus revalidatable base -> replay the identical edit; conflicting base -> `failed_conflict`; marker/digest mismatch -> `failed_integrity`; missing/trashed project or target -> `failed_target_missing`. A frontend `failed` ACK is advisory until absence is verified.
- [ ] Add retry/restart reconciliation tests at every crash point, especially project saved before ACK, proving `(conversationId, requestId, editId)` cannot duplicate nodes/changes and cannot report applied when the marker/result is absent.
- [ ] Run focused/full Agent and frontend gates; commit `feat(agent): apply tracked document changes safely`.

### Task 8: Add Explicit Storyboard Node And Field Review

**Files:**
- Create: `src/components/canvas/nodes/StoryboardNode.tsx`
- Create: `src/domain/storyboard/canvas-storyboard.ts`
- Modify: `text-agent-runtime/src/agent-service.ts`
- Modify: `agent-runtime/backend/app/gateway/promptcard_runtime.py`
- Modify: `src/components/canvas/FreeCanvasBuilderScreen.tsx`
- Test: focused Storyboard tool/domain/component/recovery tests

**Interfaces:**

```ts
interface StoryboardSourceProvenance {
  documentNodeId: string
  documentRevision: number
  documentDigest: string
  documentResourceDigests: string[]
  model: AgentRunProvenance['model']
  skills: AgentRunProvenance['skills']
}
```

- [ ] Write RED tests requiring an explicit `Document -> Storyboard` action and proving the source uses effective Document text/revision/digest.
- [ ] Add `emit_storyboard_create` validation using existing `IStoryboardSequence`/`IStoryboardRow` fields, fixed row/text budgets, and one undoable direct creation per turn.
- [ ] Add `emit_storyboard_changes` for explicit allowed sequence/row fields. Render per-field old/new differences with single/all accept/reject and stale revision/digest rejection.
- [ ] Keep this mutation path separate from standalone `AgentStoryboardUpdateProposal`; share only field definitions and pure validators.
- [ ] Reuse the apply ACK/idempotency protocol from Task 7 and record exact source/resource/model/Skill provenance.
- [ ] Run focused tests, TypeScript, and build; commit `feat(canvas): add explicit storyboard transform`.

### Task 9: Prove Prompt And Image Isolation, Then Add Explicit Prompt Handoff

**Files:**
- Modify: `src/domain/image-generation/prompt-compiler.ts`
- Modify: `src/domain/image-generation/project-conversation.ts`
- Modify: `src/utils/agent-workspace.ts`
- Modify: explicit Canvas action/menu files
- Test: focused Prompt compiler/context/reference/action tests

- [ ] Write RED adversarial tests proving Document/Storyboard cannot become a Prompt reference, `CVT`/`CVM`, Prompt Library/RAG record, image Prompt connection/input, or ambient full-body context through any union fallback.
- [ ] Add closed explicit kind checks and ADR-020 comments at the normalization, Prompt compiler, image conversation, reference-code, and compact-context boundaries.
- [ ] Add **选中文本转为 Prompt 提案** and **镜头转为 Prompt 提案** actions. Each creates one pending `free_canvas_text_create` proposal for a new Prompt Canvas node made only of `user` segments. Approval creates that node; the action cannot update an existing Prompt node or read/write Prompt Library.
- [ ] Run existing Prompt Library, Canvas Prompt editor, image-generation, context-pack, reference-code, and project normalization suites; commit `test(boundary): enforce document prompt isolation`.

### Task 10: Technical Acceptance And Documentation Handoff

**Files:**
- Update current-state frontend/backend/database/API/quality docs only after implementation is true
- Update: `docs/superpowers/plans/2026-08-22-plan-008-execution.md`
- Create: `docs/reviews/2026-08-27-task-15-10-technical-acceptance.md`

- [ ] Dispatch a fresh read-only reviewer for the full Task 15.6-15.10 diff. Fix Blocking/Important findings test-first and use a new reviewer after every fix round.
- [ ] Run focused Storage/Gateway/runtime/frontend/browser suites, full Storage and backend suites, configured Ruff, TypeScript, lint within the existing warning budget, production build, and startup regression tests.
- [ ] Run adversarial probes for invalid files, scanned PDF, remote deletion/retry, Skill state changes, Document suggestions, Storyboard field review, explicit Prompt handoff, apply crash/replay, path/credential/provider-ID leakage, old projects, and no Prompt/image regressions.
- [ ] Perform workspace hygiene checks for staged/untracked files, temp directories, orphan processes, generated secrets/paths, and the unrelated startup changes. Do not stage those unrelated files.
- [ ] Update current-state docs, the execution ledger, and an evidence package containing commits, test counts/skips/warnings, manual probes, and residual risks. Mark Checkpoint 3.5 technically complete and stop before Task 16 for user acceptance.

## Checkpoint 3.5 Manual Acceptance Script

- [ ] Import/review a storyboard-master Skill and enable its exact revision for local Agent only.
- [ ] Start `对话模式【测试中】`, bind the Skill, send three turns, reload/restart, and confirm the binding/conversation/provenance persists.
- [ ] Upload TXT, Markdown, DOCX, normal PDF, and scanned PDF; confirm invalid/oversize/spoofed files fail visibly.
- [ ] Ask for character/asset planning and a Document node; edit inline, expand, collapse, save, and reload.
- [ ] Ask the Agent to revise the Document; inspect red deletion/green insertion, accept/reject individual and all changes, and confirm the next turn uses the effective draft.
- [ ] Explicitly create a Storyboard; inspect source provenance, edit a cell through Agent, and accept/reject the field difference.
- [ ] Explicitly convert selected Document text or one shot into a Prompt proposal; confirm no Document/Storyboard content appears automatically in Prompt Library, Prompt RAG, Prompt compiler, or image-generation context.
- [ ] Restart the app and confirm conversation, files, Document, suggestions, Storyboard, provenance, and accepted/rejected states remain correct without duplicates.
