# Skill Conversation, Document, And Storyboard Design

## Status

Approved design; Task 15.6-15.9 implemented, Task 15.10 pending Checkpoint 3.5 acceptance activities.

## Goal

Add a test-only normal Agent conversation mode that can keep an explicitly selected local-Agent Skill active across turns, accept project documents, create and revise long-form Document nodes, and explicitly transform the effective draft into a structured Storyboard node without changing existing Prompt-node behavior.

## User Loop

1. In a project, the user selects **对话模式【测试中】** and enables one or more eligible Skills for that conversation.
2. The user uploads or drags TXT, Markdown, PDF, or DOCX. PromptCard validates and stores each file locally as a project document resource before sending any model request.
3. The Agent uses the conversation history, exact current Skill snapshots, explicit attachments, and explicitly referenced Canvas nodes to discuss the material and plan characters/assets.
4. The Agent may directly create a Document node. The user can edit it inline, expand it into a large editor, or collapse it to a title/summary.
5. Later Agent changes appear as suggestions. Old deleted/replaced text remains red and struck through; inserted text is green. The user accepts/rejects one suggestion or all. Until rejected, the new suggestion state is the effective draft used by later Agent turns and transforms.
6. The user explicitly invokes **从文档创建分镜表**. The Agent creates a structured Storyboard Canvas node using the effective Document draft and records exact source/model/Skill provenance.
7. Later Storyboard edits show per-field old/new differences. Moving selected Document text or one Storyboard shot into Prompt content is a separate explicit action that creates a pending `free_canvas_text_create` proposal for one new all-`user` Prompt Canvas node.

## Domain And Interface Boundaries

### Interaction and Skill state

- Add `AgentInteractionMode = 'prompt-edit' | 'chat-experimental'`; do not extend `CanvasAgentEditMode`.
- Persist `interactionMode` and `boundSkillIds` on the Storage conversation. Existing conversations normalize to `prompt-edit` with an empty persistent binding.
- Existing Prompt workflows retain one-shot `selectedSkillIds`. Only `chat-experimental` exposes and uses `boundSkillIds` across turns.
- Each invocation resolves the current local-Agent pin for every bound Skill and records the exact `skillId`, revision, and digest used. Pin changes take effect on the next turn; disabled/untrusted/archived/incompatible Skills fail before model invocation.

### Document resources

- Storage schema v16 adds a separate `project_document_resources` table and lifecycle/API; it does not extend image `project_resources`.
- The browser uploads the file first, then sends `documentResourceIds: string[]`. Gateway resolves project scope and local bytes; neither local paths nor provider file IDs are accepted from the browser.
- Limits: TXT/MD 5 MiB, DOCX 20 MiB, PDF 50 MiB, five attachments, 100 MiB aggregate per turn.
- TXT/MD are strict UTF-8; DOCX is locally normalized with exactly `python-docx==1.2.0`; PDF is sent through the Ark Responses/Files adapter when the selected model declares PDF support.
- Ark file IDs are deleted after each invocation in `finally`. Failed deletion creates a redacted durable retry record processed on startup and by bounded retries.

### Canvas nodes

- Add `IFreeCanvasDocumentNode` with `kind: 'document'`, a versioned editor-neutral `PlanningDocumentBlockV1[]` AST, revision/digest, linked document resources, provenance, suggestion state, and ordinary node geometry/meta. Tiptap JSON is an adapter projection, not an Agent/Gateway/persistence contract.
- Add `IFreeCanvasStoryboardNode` with `kind: 'storyboard'`, one `IStoryboardSequence`, source provenance, field-difference state, and ordinary node geometry/meta.
- Tiptap uses exact version `3.30.3` across `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, task-list/task-item, link, table/table-row/table-header/table-cell, plus one local block-ID/suggestion adapter. Do not mix Tiptap versions or expose Tiptap JSON to the runtime/Gateway.
- Document blocks are limited to headings, paragraphs, bold, italic, bullet/ordered lists, quote, checklist, link, and basic table. No embedded image/file, collaboration, page layout, comments, or arbitrary HTML.
- Unknown persisted node kinds normalize to a read-only `unsupported` projection containing the untouched original node. Serialization round-trips the original JSON byte-for-structure; renderers, public references, context packs, image Prompt inputs, drag/drop, edges, and writes reject that projection.

The canonical block contract is editor-neutral:

```ts
type PlanningInlineV1 = { text: string; bold?: true; italic?: true; href?: string }
type PlanningDocumentBlockV1 =
  | { id: string; type: 'paragraph' | 'blockquote'; content: PlanningInlineV1[] }
  | { id: string; type: 'heading'; level: 1 | 2 | 3; content: PlanningInlineV1[] }
  | { id: string; type: 'bulletList' | 'orderedList'; items: Array<{ id: string; content: PlanningInlineV1[] }> }
  | { id: string; type: 'checkList'; items: Array<{ id: string; checked: boolean; content: PlanningInlineV1[] }> }
  | { id: string; type: 'table'; rows: Array<{ id: string; cells: Array<{ id: string; content: PlanningInlineV1[] }> }> }
```

### Agent write contracts

- `emit_document_create`: one new Document node per turn, with title, validated editor-neutral blocks, linked resource IDs, rationale, and provenance.
- `emit_document_changes`: typed block/range insert/delete/replace operations bound to `nodeId`, base revision/digest, block ID, and expected text digest. No arbitrary JSON patch.
- `emit_storyboard_create`: one new Storyboard node per explicit transform, with validated sequence/rows and source Document revision/digest.
- `emit_storyboard_changes`: typed sequence-field or row-field replacements bound to the target node and base revision/digest.
- Text ranges use UTF-8 byte offsets into NFC-normalized block plain text. Offsets must land on code-point boundaries and stay within one block. Inserted text strictly inside one inline span inherits its bold/italic/link marks; a boundary insertion or replacement is unmarked. Delete/replace preserves untouched span marks.
- Gateway stores edit status `pending_apply` with deterministic edit/node IDs and expected result digest. Frontend validates freshness, applies through command history, writes an `AgentAppliedEditMarker` into the same node mutation, and persists once. Gateway reloads the Storage project and verifies the marker, node kind/ID, project revision, and result digest before recording `applied`; frontend acknowledgement alone is never authoritative.
- Reconciliation is deterministic: matching marker/result -> `applied`; no marker plus revalidatable base -> replay the same edit; no marker plus conflicting base -> `failed_conflict`; mismatched marker/result -> `failed_integrity`; missing/trashed project or target -> `failed_target_missing`. Failed persistence rolls back. `(conversationId, requestId, editId)` never creates a replacement identity.

## Document Suggestion Semantics

- User edits are canonical and do not create suggestions.
- Insert suggestions are green and included in effective text. Reject removes them; accept removes only the suggestion mark.
- Delete suggestions keep the old text red/struck through but exclude it from effective text. Reject restores it; accept removes it.
- Replacement is a linked delete+insert group and resolves atomically.
- Later Agent requests and Document -> Storyboard use effective text, not the visual old+new concatenation.
- Conflicting base revision/digest, missing block/anchor, or text-digest mismatch rejects the whole edit without mutating the node.

## Storyboard And Prompt Semantics

- The Storyboard node reuses existing field names from `IStoryboardSequence` and `IStoryboardRow`; it does not reuse the standalone workspace `AgentStoryboardUpdateProposal` mutation path.
- Initial explicit Storyboard creation is directly applied and undoable. Later Agent changes remain field differences until accepted/rejected.
- Document/Storyboard content does not receive `CVT`/`CVM` automatically in this slice and is absent from Prompt Library/RAG and image-generation compilation.
- The only Prompt handoff is an explicit selected-text/shot action that creates a pending `free_canvas_text_create` proposal for one new Prompt Canvas node containing only `user` segments. It never updates an existing Prompt node or reads/writes Prompt Library.

## Failure And Privacy Semantics

- A missing Storage service, invalid document, unsupported PDF model, stale node, unavailable Skill, or failed project save is visible and never falls back to a weaker or different semantic path.
- Model inputs contain only bounded normalized text, explicit PDFs, explicit node content, and compact ambient metadata. Ordinary workspace snapshots never include an entire Document body.
- Logs and diagnostics redact credentials, local paths, provider file IDs, raw provider bodies, and full document content.
- Skill scripts, hooks, installers, and package managers remain inert; a Skill cannot grant tools or broaden the interaction mode's permission scope.

## Acceptance Boundary

Complete Tasks 15.6-15.10 and Checkpoint 3.5 in Plan 008, deliver technical and manual evidence, then stop. Do not implement Task 16, the external MCP Bridge router/server, general Canvas update/delete tools, automatic Skill matching, local OCR, or new asset-card node types.

## References

- [ADR-020](../../decisions/ADR-020-separate-planning-documents-from-prompt-execution.md)
- [ADR-021](../../decisions/ADR-021-project-document-resources-and-ephemeral-provider-files.md)
- [Tiptap JSON persistence](https://tiptap.dev/docs/editor/core-concepts/persistence)
- [Tiptap schema](https://tiptap.dev/docs/editor/core-concepts/schema)
- [Doubao Seed 2.0 Lite PDF input](https://www.volcengine.com/docs/82379/1795150)
- [Volcengine Responses API document understanding](https://volcengine.github.io/veadk-python/cn/docs/framework/agent/responses-api/)
- [python-docx 1.2.0](https://pypi.org/project/python-docx/)
