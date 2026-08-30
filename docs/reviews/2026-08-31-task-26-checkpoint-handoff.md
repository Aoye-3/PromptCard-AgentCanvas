# Task 26 Checkpoint Handoff

## Checkpoint

- Date: 2026-08-31
- Branch: `feat/skill-document-storyboard-loop`
- State: Task 26 complete; stop before Task 26A
- Merge state: feature branch only; do not merge or push `main` until the real Codex closed loop passes

## Completed At This Checkpoint

The repository-owned MCP surface now exposes ten host-neutral Tools through the same server factory for STDIO and loopback Streamable HTTP:

- six bounded read Tools;
- `promptcard_delivery_preview`;
- `promptcard_delivery_commit`;
- `promptcard_delivery_status`;
- `promptcard_asset_stage`.

Delivery inputs use closed Bridge v3 schemas for Document, Storyboard, Prompt, and image kinds. Preview and commit are idempotent proposal operations; status is read-only. The shared Bridge CLI client maps the same JSON or multipart requests to Gateway, so MCP does not fork business behavior by host or transport.

Image staging accepts only a workspace-relative path beneath the explicit `PROMPTCARD_BRIDGE_WORKSPACE_ROOT`. Before Gateway I/O it resolves the root and candidate real paths, rejects lexical traversal and symlink/junction escape, requires one regular file, caps size at 30 MiB, checks PNG/JPEG/WebP signature, declared byte length, and SHA-256, then uploads the bytes through the existing Gateway multipart boundary. The external write target remains the returned opaque `AST-*` handle, never the path.

## Verification Evidence

- Bridge v1/v2/v3 contract suite: 52 passed.
- Bridge CLI suite: 8 passed.
- MCP suite: 10 passed across legacy/modern STDIO and HTTP.
- Bridge CLI TypeScript: passed.
- MCP TypeScript: passed.
- `git diff --check`: passed before checkpoint commit.

The MCP coverage includes exact ten-Tool discovery, closed schemas and annotations, stable JSON responses, pure STDIO output, duplicate request replay, request-digest conflict, pending status recovery, valid image staging, path traversal, junction escape, digest change, MIME spoofing, Gateway outage redaction, environment allowlisting, and HTTP Host/Origin/Bearer enforcement.

## Current Product Boundary

- Prompt and image typed writeback are implemented through visual review and durable acceptance.
- MCP can already submit every v3 delivery kind, but Gateway intentionally returns kind-unavailable for Document/Storyboard until their adapters land.
- All external writes remain proposal-only and require user review.
- MCP status polling never repeats a mutation.
- Bridge profile/scopes, exact CVC/source references, Skill pins, ledger identity, and final authorization remain Gateway/Storage authority.
- Asset Shelf and browser connectors remain out of scope.

## Next Exact Slice

Resume at Plan 008 Task 26A: adapt `document.create` and `document.change` into the existing editor-neutral Document AST and visual suggestion workflow.

The first implementation loop should be:

1. Add failing Storage/Gateway tests for exact CVC/CVD/revision/digest, stale base, replay, restart, accept, and reject.
2. Extend the shared v19 delivery ledger service for Document preview/commit/status without changing Bridge v1/v2 or MCP schemas.
3. Reuse the existing red-delete/green-add suggestion renderer and single/all accept/reject paths; do not add another editor.
4. Persist external Agent, Skill revision/digest, source codes, client request identity, proposal identity, and deterministic result identity.
5. Update Plan 008, ADR-023, Storage/Gateway API docs, frontend review docs, and this evidence trail when the slice passes.

Do not begin Task 26B until Document create/change pass their focused backend, frontend, restart, replay, and conflict gates.
