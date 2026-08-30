# Text Agent Tools

The pi text Agent has a deliberately small tool surface:

- `search_prompt_library`: searches only the bounded snapshot supplied by the frontend.
- `emit_canvas_prompt_edit`: the only tool exposed to new Canvas edit requests. Gateway locks its schema to exact anchored insertions for `complete` or a complete derived-node draft for `rewrite`.
- `emit_prompt_library_create`: proposes one additive Prompt Library preset.
- `emit_media_prompt_preview`: creates or updates an editable Prompt candidate only for an explicit media `preview` action.

The following tools are not general catalog capabilities. Runtime policy supplies exactly one of them only for a Gateway-validated explicit `chat-experimental` planning action:

- `emit_document_create`: creates one editor-neutral planning Document.
- `emit_document_changes`: emits NFC UTF-8 byte-anchored insert/delete/replace operations for one bound Document.
- `emit_storyboard_create`: creates one structured Storyboard from the effective bound Document.
- `emit_storyboard_changes`: changes only allowed fields on one bound Canvas Storyboard.
- `emit_prompt_handoff`: creates one pending new-Prompt proposal from an exact Document selection or Storyboard shot.

There are no filesystem, shell, web-search, sandbox, MCP, subagent, or direct-write tools.

Prompt and Prompt Library proposal tools create pending proposals. Document/Storyboard tools return one enriched Canvas edit after the explicit action; the frontend persists its reviewable state with `AgentAppliedEditMarker`, then Gateway reloads Storage before terminal acknowledgement. `emit_media_prompt_preview` is non-mutating: writing its editable result uses the explicit Recent Capture registration transaction.

## Skill snapshots

PromptCard Storage schema v17 is the canonical source for canonical Skill packages, exact-revision trust reviews, and independent host pins. Each run receives the exact enabled local-Agent pin as a bounded snapshot rather than an editable package copy:

```json
{
  "skillId": "internal-skill-id",
  "skillReferenceCode": "SKL-01K...",
  "revision": 3,
  "digest": "sha256:...",
  "instructions": "...",
  "references": []
}
```

Built-in Skills are bound by capability:

- Canvas text editing binds `canvas.prompt.edit` / `canvas-prompt-editor` revision 3. Revisions 1 and 2 remain immutable for audit compatibility.
- Media collaboration binds `media.prompt.reverse` / `media-prompt-reverse`.

In `prompt-edit`, external Skills are explicitly selected by the user for the next project-Agent message and clear after send. In `chat-experimental`, the conversation persists the explicitly bound Skill IDs across turns and restart. In both modes, Gateway resolves the current exact immutable revision/digest pinned for local-Agent on every turn and records it with the turn; it never falls back to the package's mutable `currentRevision`.

Skill instructions never grant permissions. Storage rechecks enabled state, active lifecycle, trust, snapshot size, and declared capabilities on every read. The Gateway then independently validates the public `SKL` identity, digest, instruction/reference budgets, content types and paths, and declared capabilities. Declared tools must be a subset of the exact tool set already allowed by `permissionScope`; non-tool capabilities and missing, unavailable, malformed, or over-privileged selections fail before model invocation. System rules, proposal validation, tool schemas, and user approval outrank Skill content.

The model-facing snapshot exposes only root `SKILL.md` instructions and bounded UTF-8 `references/*` text. Canonically stored scripts/assets are never exposed or executed. Skill Hub now exposes inert folder/archive inspection and import, structured findings, revision history/diff, exact-revision trust review, archive/restore, independent host pins, Codex projection health, and explicit repair. Task 16's read-only Bridge router is in progress and reads only an exact enabled/trusted Codex pin from the trusted profile's configured repository scope. Hooks/package installers, automatic semantic matching, CLI, and MCP server remain unimplemented.

See [Skill Host Pins And Projections](../architecture/skill-host-projections.md) for the projection ownership, health, recovery, and budget contract.

## Canvas target and edit contracts

The attached-node list is the permission boundary. A request can attach up to ten unique text nodes: one target and zero or more read-only references. `@` mentions describe semantic relationships only and cannot promote a reference or select a different target. The Gateway reloads all node content from the current project snapshot instead of trusting browser-supplied node bodies.

`canvas-prompt-editor` revision 3 defines two mutually exclusive result contracts:

- `complete`: at most 16 exact `segment` or unique `text` anchors. Applying the proposal preserves all existing characters, segment order, sources, and colors and inserts only black user segments.
- `rewrite`: one complete black user-text draft for a new node derived from the source. It never updates the source or a reference node.

The Runtime tool does not accept a node ID or editing mode from the model. Gateway policy binds both from the validated request and records `baseNodeRevision`, `templateDigest`, and `baseSegmentsDigest`. The apply path rechecks those values and every anchor. Any mismatch rejects the whole stale proposal and asks the user to generate a new one. Old `emit_canvas_text_update` proposal records remain readable for compatibility but are not exposed to revision 3 Canvas runs.

## Creative-document write contracts

The browser supplies only a minimal closed operation request. Gateway reloads the project and expands it into the authoritative `documentWriteContext`; model tool arguments cannot choose project/conversation/request IDs, target IDs, revisions, digests, provenance, or receipt identity.

Document create accepts restricted editor-neutral blocks. Document changes accept one-block NFC UTF-8 byte offsets and reject cross-block ranges, invalid code-point boundaries, stale digests, overlapping ranges, Tiptap JSON, and arbitrary JSON patch. Storyboard create/change reuses the existing sequence/row field validators while keeping Canvas mutation separate from standalone Storyboard proposals. One write-once guard is shared across all emit tools for the turn.

The Gateway ledger and Canvas `AgentAppliedEditMarker` bind `(conversationId, requestId, editId)` to one unique node and expected result digest. Missing or duplicate targets/markers, stale bases, and digest disagreement fail closed. A saved project before ACK is recovered by Storage verification; a response loss or duplicate request replays the identical edit rather than generating another node or change set.
