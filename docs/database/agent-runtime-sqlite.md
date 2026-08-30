# Agent Runtime Persistence

The pi text Agent does not use a separate SQLite database and does not own process-local conversation truth. It receives bounded normalized history on every invocation and returns only the current turn.

Durable PromptCard data remains in PromptCard Storage:

- projects and Canvas state;
- Prompt Library presets;
- media assets and captures;
- image-generation conversations, runs, placements, and derivations;
- project text-Agent conversations, ordered messages, proposal state, and idempotent completed turns;
- canonical local Skills and immutable Skill revisions.

PromptCard Storage is the sole durable authority for project text-Agent history. Schema v9 introduced the nullable `agent_conversations.model_binding_json` on top of the v8 conversation rows; schema v19 is now the active database version and adds a Bridge delivery ledger without changing conversation rows. Gateway loads that history and binding, validates the owning project, entrypoint, mode, permission scope, model whitelist, and current connection readiness before calling pi. Media analysis is intentionally temporary and never writes conversation rows.

Each completed turn stores a `modelSnapshot` in its idempotent result envelope. Retrying the same `(conversationId, requestId)` returns the first result and its first model snapshot; it never silently reruns under a newly selected model.

The Python Gateway stores only provider-neutral model connection metadata under `PROMPTCARD_RUNTIME_STATE_DIR`; credentials remain in the operating-system keyring.
