# Text Agent Tools

The pi text Agent has a deliberately small tool surface:

- `search_prompt_library`: searches only the bounded snapshot supplied by the frontend.
- `emit_canvas_prompt_edit`: the only tool exposed to new Canvas edit requests. Gateway locks its schema to exact anchored insertions for `complete` or a complete derived-node draft for `rewrite`.
- `emit_prompt_library_create`: proposes one additive Prompt Library preset.
- `emit_media_prompt_preview`: creates or updates an editable Prompt candidate only for an explicit media `preview` action.

There are no filesystem, shell, web-search, sandbox, MCP, subagent, or direct-write tools.

Every Canvas or Prompt Library `emit_*` tool creates a pending proposal. The frontend must present Apply/Reject controls and remains the only component that can commit a Canvas or Prompt Library change. `emit_media_prompt_preview` is non-mutating: writing its editable result uses the explicit Recent Capture registration transaction.

## Skill snapshots

PromptCard Storage schema v16 is the canonical source for canonical Skill packages, exact-revision trust reviews, and independent host pins. Each run receives the exact enabled local-Agent pin as a bounded snapshot rather than an editable package copy:

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

External Skills are explicitly selected by the user and apply only to the next project-Agent message. The Gateway resolves the exact immutable revision/digest pinned for local-Agent and records them with the turn; it never falls back to the package's mutable `currentRevision`. The selection is cleared after send.

Skill instructions never grant permissions. Storage rechecks enabled state, active lifecycle, trust, snapshot size, and declared capabilities on every read. The Gateway then independently validates the public `SKL` identity, digest, instruction/reference budgets, content types and paths, and declared capabilities. Declared tools must be a subset of the exact tool set already allowed by `permissionScope`; non-tool capabilities and missing, unavailable, malformed, or over-privileged selections fail before model invocation. System rules, proposal validation, tool schemas, and user approval outrank Skill content.

The model-facing snapshot exposes only root `SKILL.md` instructions and bounded UTF-8 `references/*` text. Canonically stored scripts/assets are never exposed or executed. Skill Hub now exposes inert folder/archive inspection and import, structured findings, revision history/diff, exact-revision trust review, archive/restore, independent host pins, Codex projection health, and explicit repair. Hooks/package installers, automatic semantic matching, the Task 16 bridge router, CLI, and MCP server remain unimplemented.

See [Skill Host Pins And Projections](../architecture/skill-host-projections.md) for the projection ownership, health, recovery, and budget contract.

## Canvas target and edit contracts

The attached-node list is the permission boundary. A request can attach up to ten unique text nodes: one target and zero or more read-only references. `@` mentions describe semantic relationships only and cannot promote a reference or select a different target. The Gateway reloads all node content from the current project snapshot instead of trusting browser-supplied node bodies.

`canvas-prompt-editor` revision 3 defines two mutually exclusive result contracts:

- `complete`: at most 16 exact `segment` or unique `text` anchors. Applying the proposal preserves all existing characters, segment order, sources, and colors and inserts only black user segments.
- `rewrite`: one complete black user-text draft for a new node derived from the source. It never updates the source or a reference node.

The Runtime tool does not accept a node ID or editing mode from the model. Gateway policy binds both from the validated request and records `baseNodeRevision`, `templateDigest`, and `baseSegmentsDigest`. The apply path rechecks those values and every anchor. Any mismatch rejects the whole stale proposal and asks the user to generate a new one. Old `emit_canvas_text_update` proposal records remain readable for compatibility but are not exposed to revision 3 Canvas runs.
