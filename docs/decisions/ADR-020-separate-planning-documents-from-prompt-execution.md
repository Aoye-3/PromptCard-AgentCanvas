# ADR-020: Separate Planning Documents From Executable Prompt Content

## Status

Accepted. Implementation status: Tasks 15.6-15.10 implemented and technically accepted as the regression baseline; Checkpoint 3.5 manual probes are merged into final real-Codex acceptance. Tasks 16-18 now provide the bounded external read/retrieval foundation without changing this separation.

## Date

2026-08-27

## Context

The existing Free Canvas `text` node is executable Prompt content. It is connected to Prompt Library semantics, preserves `preset` versus `user` segments, participates in Prompt-specific Agent edit modes, and can feed image-generation Prompt compilation.

The requested creative workflow needs a different object: long-form planning prose for ideation, character and asset planning, story drafts, and storyboard manuscripts. Treating that content as another Prompt text node would add unnecessary Prompt retrieval and compilation cost, expose long drafts to image-generation context, and erase the visual and permission boundary between planning and executable instructions.

The same workflow needs a normal multi-turn Agent conversation that can use an explicitly enabled Skill, create or revise a planning document, and then create a structured storyboard. That authority must remain narrower than general Canvas mutation and must not change the existing Prompt completion, rewrite, or Prompt Library proposal behavior frozen by ADR-017.

## Decision

1. **Document, Storyboard, and Prompt are separate domain objects.** A Free Canvas Document node stores long-form rich text. A Free Canvas Storyboard node stores structured `IStoryboardSequence`/`IStoryboardRow` data. Neither reuses `IFreeCanvasTextNode.segments` or pretends to be a Prompt node.
2. **Document content never enters Prompt execution implicitly.** It is excluded from Prompt Library registration and indexing, Prompt Library RAG, Prompt compilation, image-generation references, and ordinary ambient workspace snapshots. Ambient context may include only Document identity, revision, digest, title, and a bounded excerpt.
3. **Cross-domain movement is explicit and typed.** The supported transitions are an explicit `Document -> Storyboard` action and an explicit selected Document text or Storyboard shot -> `free_canvas_text_create` proposal. The Prompt handoff creates one new Prompt Canvas node containing only `user` segments after user approval; it never updates an existing Prompt node or writes Prompt Library. There is no automatic Document -> Prompt or Storyboard -> Prompt conversion.
4. **The experimental conversation mode is separate from Prompt edit mode.** Add a top-level `chat-experimental` interaction mode. Do not add it to `CanvasAgentEditMode`; the existing `complete`, `rewrite`, and `prompt-library` values remain Prompt-only.
5. **Skill binding is conversation-scoped only in the experimental mode.** Selected external Skills remain enabled across turns and reload for that conversation. Every turn still resolves the current local-Agent pin and revalidates lifecycle, trust, exact revision/digest, content budget, and tool dependencies before model invocation. Existing one-shot Skill selection outside this mode is unchanged.
6. **Agent writes use narrow tools, not general Canvas authority.** The only new write results are `emit_document_create`, `emit_document_changes`, `emit_storyboard_create`, and `emit_storyboard_changes`. The Gateway validates the interaction mode, project, target kind, base revision/digest, operations, budgets, and allowed fields before returning an edit for frontend application.
7. **Document and Storyboard review semantics differ intentionally.** User Document edits are immediate canonical edits. Agent Document changes use inline suggestions: deleted source stays visible as red strikethrough, inserted text is green, and each change or the whole set can be accepted/rejected. The inserted text and proposed deletion are already reflected in the effective working draft until rejected. Storyboard updates use per-field old/new differences and confirmation. Prompt nodes keep the ADR-017 template protection and proposal behavior.
8. **Direct application is recoverable and idempotent.** Agent-created nodes and validated changes are applied immediately but remain undoable. Each returned edit carries a request ID, deterministic edit ID, target node ID, and expected result digest. Gateway records `pending_apply`. The frontend writes an `AgentAppliedEditMarker` into the affected node in the same project save as the content mutation, then asks Gateway to acknowledge. Gateway never trusts an `applied` claim alone: it reloads the Storage project, verifies project scope/revision, node kind/ID, edit marker, and result digest, and only then records `applied`.
9. **Pending reconciliation has one deterministic state machine.** On retry/startup, a matching marker/result becomes `applied`; no marker plus an unchanged/revalidatable base returns the same edit for retry; no marker plus a changed conflicting base becomes `failed_conflict`; a marker with the wrong kind/digest becomes `failed_integrity`; and a deleted/trashed project or target becomes `failed_target_missing`. A deterministic create node ID prevents a replay from selecting a second identity. Frontend `failed` acknowledgement is advisory until Gateway confirms that no matching saved marker exists. Save failure rolls back local state, and no path silently emits a replacement edit.
10. **Node-kind dispatch stays closed.** Normalization, rendering, public-reference selection, context packing, image Prompt compilation, and drag/drop input handling must use explicit kind branches. An unknown persisted kind becomes an `unsupported` read-only projection holding a deep copy of the original node; serialization writes the original node back unchanged. It cannot be referenced, edited, connected, or treated as `text`/`image`.

## Alternatives Considered

### Reuse The Existing Prompt Text Node

Rejected because Prompt segments, retrieval, compilation, and image-generation affordances are the wrong semantics and cost boundary for planning prose.

### Put `chat-experimental` In `CanvasAgentEditMode`

Rejected because a conversation mode is not an edit operation. Reusing that enum would risk granting Prompt edit/search capabilities to ordinary Skill conversations.

### Use One Generic Canvas Patch Tool

Rejected because arbitrary JSON patches would bypass domain validation, make stale edits difficult to detect, and couple every node type to one permission surface.

### Require Approval Before Any Document Text Becomes Effective

Rejected because the user chose an iterative working-draft model. Suggestions remain visually reviewable, but downstream Agent turns and explicit Storyboard generation use the proposed new draft immediately; rejecting a suggestion restores the prior text.

## Consequences

- Prompt nodes and existing Prompt editing remain behaviorally compatible.
- Document rich text requires a dedicated versioned schema, renderer, persistence path, and plain-text derivation.
- Full Document content is resolved only through explicit attachment, `@Document`, selection, or transform actions with fixed budgets.
- Storyboard Canvas editing must not reuse the standalone storyboard workspace proposal type without an explicit adapter.
- Union extensions require adversarial regression tests at every dispatch point where unknown kinds previously fell through.
- ADR-016 is extended only for `chat-experimental` conversation-scoped Skill binding and typed Document/Storyboard writes. ADR-017 remains authoritative for Prompt editing.

## Verification

- Tests prove Document content is absent from Prompt Library, Prompt RAG, Prompt compilation, image-generation requests, and ambient full-body snapshots.
- Tests prove existing Prompt `complete`, `rewrite`, `prompt-library`, template protection, and one-shot Skill behavior are unchanged.
- Tests prove `chat-experimental` persists its Skill binding while every turn revalidates the current local-Agent pin and fails before model invocation for disabled, untrusted, archived, or incompatible Skills.
- Tests prove direct apply, save failure, response loss, duplicate request, and restart reconciliation never create duplicate nodes or silent audit/Canvas divergence.
- Manual acceptance covers inline/fullscreen/collapsed Document editing, suggestion accept/reject, explicit Storyboard creation, per-field Storyboard review, and explicit Prompt handoff.

## Related Decisions And Plans

- [ADR-016: Durable Text-Agent Conversations And Bounded Skills](./ADR-016-durable-text-agent-conversations-and-bounded-skills.md)
- [ADR-017: Session Model Binding And Anchored Canvas Edits](./ADR-017-session-model-binding-and-anchored-canvas-edits.md)
- [ADR-021: Project Document Resources And Ephemeral Provider Files](./ADR-021-project-document-resources-and-ephemeral-provider-files.md)
- [Plan 008 execution ledger](../superpowers/plans/2026-08-22-plan-008-execution.md)
