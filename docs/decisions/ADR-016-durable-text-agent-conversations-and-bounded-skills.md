# ADR-016: Persist Project Text-Agent Conversations And Inject Bounded Skill Snapshots

## Status

Accepted; Canvas edit semantics and conversation model binding are superseded by [ADR-017](./ADR-017-session-model-binding-and-anchored-canvas-edits.md). Experimental conversation Skill binding and creative-document context extend this decision through [ADR-020](./ADR-020-separate-planning-documents-from-prompt-execution.md) and [ADR-021](./ADR-021-project-document-resources-and-ephemeral-provider-files.md).

## Date

2026-08-05

## Context

The project text Agent previously had two incompatible histories: visible messages were cached in browser `localStorage`, while model context lived in a Node-process `Map`. Restarting the frontend and restarting the text runtime therefore produced different results. The UI could display an old conversation that the model no longer remembered.

Canvas completion and media reverse-prompt work also needed reusable task instructions. Those instructions must not become an alternate permission system: a Skill cannot grant tools, write directly to Canvas or Storage, or bypass proposal approval. Media analysis additionally needs short-lived discussion without adding every asset exploration to project history.

## Decision

Use PromptCard Storage as the sole durable authority for project text-Agent conversations.

- The Python Gateway coordinates every persistent turn. It validates `projectId`, `entrypoint`, and `mode`, loads bounded history from SQLite, injects current workspace context and Skill snapshots, invokes the Node runtime, and persists the returned increment.
- The Node pi runtime is request-driven and stateless across calls. It receives normalized history and returns only the current turn's delta.
- Every persistent request carries `conversationId` and an idempotent `requestId`. The `(conversationId, requestId)` pair identifies one stored turn.
- Messages, proposal status, and the `SKL + revision + digest` values used by a turn are stored for reload and audit.
- Project conversations have their own project-scoped list and Trash lifecycle. Prompt Library diagnostics and media analysis do not create project conversations.
- Media analysis is intentionally ephemeral. The browser sends at most 40 temporary messages on each request, the Gateway reloads the one selected image, and closing the dialog discards the discussion.
- Built-in Skills are bound deterministically by capability. Prompt-edit external Skills are explicitly selected for one message and cleared after send; `chat-experimental` may persist an explicit conversation-scoped binding under ADR-020 while revalidating the current exact host pin every turn.
- A Skill snapshot contains instructions and bounded references only. Scripts are not executed. Declared tool dependencies must already be permitted by the request's `permissionScope`; the Gateway rejects mismatches.
- Canvas requests explicitly distinguish one writable target from up to nine read-only references. Atomic `@` mentions describe relationships but never grant write access.
- Canvas text-update proposals bind an edit mode, target-node revision, template digest, and user-content digest. Completion appends a new user segment; rewrite replaces either a validated selection or the entire user part. The frontend reapplies all freshness checks before writing, and template segments remain immutable.

## Alternatives Considered

### Keep Browser History And Reconstruct Context Client-Side

- Simpler Storage schema.
- Rejected because browser data is not authoritative, cannot provide reliable cross-restart audit, and can diverge across windows.

### Keep Node Runtime Sessions And Persist Snapshots Periodically

- Preserves the old session abstraction.
- Rejected because process memory would still be a competing source of truth and recovery would depend on snapshot timing.

### Persist Media Analysis As Ordinary Project Conversations

- Reuses the project conversation UI.
- Rejected because exploratory asset discussion is intentionally disposable and should not pollute project Agent history.

### Let Skills Register Or Enable Their Own Tools

- Makes Skill packages more autonomous.
- Rejected because instructions are untrusted content. Runtime policy, tool schemas, and user approval must remain the authority.

## Consequences

- Restarting the frontend, Gateway, or Node text runtime does not erase project conversation context.
- Storage schema v8 owns Agent conversations and the minimal canonical Skill registry.
- Persistent Agent calls now depend on Storage availability; failure is explicit rather than falling back to a stale local transcript.
- The Gateway performs more coordination and validation but gains one auditable request boundary.
- Prompt-edit external Skill selection is one-shot. Experimental conversation binding is explicit, visible, durable, and revalidated every turn; it cannot silently widen tools or permission scope.
- Media discussions disappear on dialog close by design; only an explicitly registered Prompt and its source-asset relationship become durable.
- Skill package inspection/import, archive/restore, exact-revision review, and Codex publication are now implemented. Skill script execution, automatic matching, the Task 16 Bridge, CLI, and MCP publication remain future Plan 008 work.
