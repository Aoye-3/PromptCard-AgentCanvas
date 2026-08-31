# ADR-023: Use A Typed Creative Writeback Boundary And Discoverable Agent Workspace

## Status

Accepted

## Date

2026-08-30

## Context

The existing Bridge v1/v2 contract covers exact Prompt/media/Canvas/Skill references, host-neutral profiles, and additive Prompt/image delivery. The accepted product direction now requires an external Agent to enter PromptCard without prior knowledge of internal schemas, understand one explicitly selected project context, and propose work across Planning Documents, Storyboards, Prompts, and images.

Reusing internal Canvas node IDs, UI focus, fuzzy titles, or arbitrary filesystem paths would couple an external Agent to presentation details and weaken project, revision, and path authority. Adding Document and Storyboard to the old additive item union would also change the already frozen v1/v2 compatibility boundary.

## Decision

1. Bridge v1 and v2 remain unchanged. Bridge v3 composes them and adds the typed creative boundary.
2. `CVD-*` is the stable public identity of a Canvas Planning Document and `CVS-*` is the stable public identity of a Canvas Storyboard. Internal node IDs remain private.
3. External writeback supports only six operations: `document.create`, `document.change`, `storyboard.create`, `storyboard.change`, `prompt.create`, and `image.place`.
4. Document and Storyboard changes require their exact public reference, revision, and digest. A Storyboard row is addressed by ordinal against that exact base revision; no internal row ID crosses the Bridge.
5. Prompt writeback is create-only and produces one new all-`user` Prompt proposal. It cannot update an existing Prompt or write Prompt Library.
6. Image bytes first enter a bounded workspace staging operation. Delivery consumes only an opaque `AST-*` handle and never an arbitrary path or remote URL. Placement does not create a provider generation run.
7. Every write creates a visual proposal and requires user acceptance or rejection. There is no trusted-profile auto-apply in v3.
8. A single profile-scoped ledger owns preview, commit, status, replay, conflict, recovery, provenance, and result identities for all six operations.
9. The built-in `promptcard-bootstrap` Skill and the `promptcard_runtime_describe` / `promptcard_workspace_describe` Tools are progressive-disclosure entry points. Workspace discovery requires an explicit `PRJ` and `CVC`; current UI focus is never authority.
10. Read, Document, Storyboard, Prompt, image, and status authority use independent scopes. Client name/version are audit metadata only and cannot select behavior or permissions.

## Consequences

- Storage must assign and preserve `CVD/CVS` public references independently of project JSON node identities.
- Gateway, CLI, MCP, and frontend must validate and emit the same v3 contract values.
- Existing Document suggestion and Storyboard field-review components remain the visual application mechanisms; external delivery adapts into them instead of building a second editor.
- The Agent workspace UI can explain connection, profile, scope, context, Skill pins, Tools, proposals, failures, and provenance without exposing paths or internal IDs.
- Search remains discovery only. A search result must be explicitly re-resolved before it can become source context and can never become a write target.

## Implementation Note

Task 24 implements the `prompt.create` vertical slice. Preview and commit are separate profile-scoped ledger operations; commit creates only a pending visual proposal. Free Canvas persists a deterministic all-`user` Prompt and receives its Storage-owned `CVT-*` before the delivery can become `accepted`. A failed save or failed acknowledgement leaves the proposal pending and retryable, while an existing exact marker is reused after restart. The selected CVC is explicit UI state and local preference only; it never replaces Storage validation or Bridge profile authority.

Task 25 implements the `image.place` vertical slice without borrowing provider-generation identity. The external host uploads bounded multipart bytes and closed metadata; Gateway validates scope, path shape, MIME, filename, size, and digest before Storage mutation. Storage validates and prepares the image with the existing asset pipeline, records an idempotent `asset.stage`, and exposes only an opaque `AST-*` handle externally. Preview/commit produces a visual placement proposal, while Free Canvas saves a deterministic ordinary image carrying `promptcard-bridge` provenance and acknowledges acceptance only with the resulting same-project `CVM-*`. A crash after file creation, lost response, restart, or repeated acceptance converges on the same asset and node and never creates an image-generation run.

Task 26 exposes the v3 write surface through the same repository CLI client and MCP server used by the read Tools. STDIO and loopback HTTP now publish identical closed schemas for delivery preview, commit, status, and asset staging. Staging requires an explicit absolute workspace root and resolves the candidate's real path before reading, so traversal and symlink/junction escape fail before Gateway I/O; size, signature, declared length, and digest are rechecked locally and again by Gateway. Status remains read-only, while preview/commit are declared idempotent, non-destructive proposal operations. Codex and other hosts therefore share one Tool contract rather than client-specific adapters.

Task 26A's first checkpoint implements the Storage-owned Document delivery kernel. `document.create` accepts the closed simple Document AST, and `document.change` resolves only an exact `CVD-*` contained by the selected `CVC-*`. Revision/digest, leaf identity, expected text digest, NFC UTF-8 boundaries, pending suggestions, and overlapping ranges are checked before the ledger preview is created. Preview/commit/replay/restart share the same profile-scoped ledger and an accepted delivery must resolve to exactly one same-project `CVD-*`.

Task 26A's second checkpoint implements the Gateway adapter without adding a client-specific MCP path. The public v3 router validates a discriminated closed Document request, strips absent optional fields, canonicalizes CVC/CVD/source references, rechecks exact enabled Skill pins, and requires the independent Document delivery scope. Preview and proposal-kind commit route only to internal-token Document Storage endpoints; status remains the existing read-only ledger lookup.

Task 26A's third checkpoint implements the browser/Canvas adapter. The Storage client fails closed on unknown fields, internal targets, mismatched CVD/base/proposal data, or divergent provenance. The Inbox exposes Agent, exact Skill revision, source references, request identity, and create/change intent. Acceptance creates one deterministic native Document or converts exact CVD-targeted operations into the existing tracked suggestion representation; it does not acknowledge the ledger until Canvas persistence returns one CVD. A Canvas-side Bridge marker detects retries and tampering, while the public CVD is preserved by node normalization so restart does not erase external authority. Task 26A remains open only for the real process-level preview/commit/browser/restart probe; Storyboard work does not start before that evidence.

## Alternatives Considered

### Extend Bridge v2 In Place

Rejected because it would silently change frozen scope and delivery semantics for existing consumers.

### Expose Generic Canvas Node Mutation

Rejected because it would make presentation IDs and arbitrary Canvas state an external write API.

### Allow Trusted Profiles To Auto-Apply

Rejected for the first release. Human review is part of the product boundary and recovery model.

## References

- [Plan 008 execution ledger](../superpowers/plans/2026-08-22-plan-008-execution.md)
- [Plan 009: Portable Creative Context Environment](../Plan/009-portable-creative-context-environment.md)
- [ADR-019: Generic Local Agent Bridge Boundary](./ADR-019-generic-local-agent-bridge-boundary.md)
- [ADR-020: Separate Planning Documents From Prompt Execution](./ADR-020-separate-planning-documents-from-prompt-execution.md)
- [Bridge v3 contract](../../contracts/promptcard-bridge/v3/README.md)
