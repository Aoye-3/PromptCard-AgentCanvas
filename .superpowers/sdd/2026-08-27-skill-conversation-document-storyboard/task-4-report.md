# Task 4 / Plan 008 Task 15.7 Implementation Report

Date: 2026-08-27
Branch: `feat/skill-document-storyboard-loop`
Base: `e3e9894c0b88a3f7c2b046adda6fd496445771af`

## Status

Implemented and verified durable `chat-experimental` conversation metadata, optimistic interaction revision, conversation-scoped external Skill identities, per-turn current local-Agent snapshot resolution, a closed experimental tool policy, browser hydration, stable conversation identity, and same-request retry after response loss. Existing Prompt `CanvasAgentEditMode`, Prompt target/edit behavior, Prompt Library protections, and one-shot `selectedSkillIds` remain separate.

Storage remains schema version 15 for this slice. The implementation adds only idempotent compatibility columns to the existing `agent_conversations` table (`interaction_mode`, `bound_skill_ids_json`, `revision`). It did not create, name, or otherwise take ownership of Task 15.8's schema-v16 `project_document_resources` or `provider_file_cleanup` tables.

## Implementation

- Storage returns legacy defaults (`prompt-edit`, no bound Skills, revision 1), persists interaction metadata project-scoped, and rejects stale `expectedRevision` with the existing revision-conflict contract.
- Gateway loads the stored interaction metadata before Skill/model invocation. Saved-turn replay returns before Skill or model resolution. Experimental turns ignore request-supplied one-shot Skill IDs, resolve every stored identity through the current local-Agent pin, and audit exact `skillId/revision/digest` on each saved turn.
- Experimental mode clears Prompt Canvas context and uses an empty authoritative tool allowlist in this slice. Both Gateway output validation and the Node policy reject Prompt edits, Prompt Library search, proposal kinds, and Canvas edit kinds. Skill declarations cannot add tools.
- Text runtime receives `interactionMode`, builds a conversation-specific system prompt, and keeps Prompt policy as the default for compatibility.
- Browser Storage client supports `PATCH /api/projects/{projectId}/conversations/{conversationId}/interaction`. Conversation hydration restores mode, bound identities, and revision.
- The embedded panel shows `对话模式【测试中】`; its Skill menu says `本对话持续启用`. Prompt mode continues to say `仅作用于下一条消息` and clears only its one-shot selection after success.
- Store-generated request IDs may be supplied explicitly. A failed call retains `{requestId, content}` and the panel exposes `使用原请求重试`; retry sends the original ID. Experimental send stays disabled until a durable conversation has loaded, and returned conversation IDs are captured for consecutive sends.

## Files

- Storage: `promptcard_storage/store.py`, `promptcard_storage/app.py`, `promptcard_storage/tests/test_sqlite_store.py`, `promptcard_storage/tests/test_app.py`
- Gateway: `agent-runtime/backend/app/gateway/promptcard_runtime.py`, `agent-runtime/backend/tests/test_promptcard_runtime_boundary.py`
- Node runtime: `text-agent-runtime/src/proposal-policy.ts`, `text-agent-runtime/src/agent-service.ts` and focused tests
- Browser: `src/models/Agent.model.ts`, `src/storage/storage-service-client.ts`, `src/services/agent-runtime-service.ts`, `src/stores/agent.store.ts`, `src/components/AgentCollaborationPanel.tsx` and focused tests

## RED / GREEN Evidence

1. Storage defaults / optimistic PATCH RED: 2 tests failed with missing `interactionMode`; GREEN: 2 passed. The tests also lock project isolation, stale-revision 409, binding durability, and revision 1→2.
2. Gateway persistence / current pin RED: 6 tests failed because the browser one-shot identity won and five unavailable-Skill cases reached model resolution; GREEN: 6 passed. Two real turns reload the same conversation/history and audit pin revision/digest 1→2. A tightened stale-Prompt-target RED then failed with 422 before stored mode resolution; GREEN defers Canvas context resolution and proves experimental requests ignore stale or malicious Prompt targets.
3. Runtime policy RED: 2 tests failed because interaction mode was dropped and the Prompt system prompt remained active; a tightened selected-node RED then proved target identity still leaked. GREEN: 2 files / 24 tests passed with zero experimental Prompt tools/targets/search/mutations.
4. Frontend retry/hydration/UI RED: 3 tests failed because the interaction PATCH method was absent, explicit request IDs were replaced, and the selector did not exist. GREEN: 3 passed; full focused frontend/runtime suite: 5 files / 81 tests passed.
5. Stored replay compatibility remains covered by `test_persistent_message_reuses_saved_turn_before_model_resolution`, which fails if model invocation or model resolution occurs; the implementation keeps Skill resolution after this short circuit.

## Verification

- `npx.cmd vitest run ...focused files`: 5 files, 81 passed.
- `promptcard_storage` focused pytest: 40 passed.
- Gateway/runtime focused pytest: 63 passed.
- `npm.cmd run text-agent:check`: pass.
- `npx.cmd tsc --noEmit`: pass. An earlier `npm.cmd run type-check` exited 1 because that script does not exist; no compiler ran in that diagnostic attempt.
- Backend full pytest: 301 passed, 1 pre-existing Starlette `TestClient(timeout=...)` deprecation warning.
- Backend Ruff: `All checks passed!` with `--no-cache` (the existing cache directory rejects temp creation).
- Full frontend/runtime: pretest contracts 37 passed; Vitest 122 files / 850 tests passed. Existing warnings: duplicate React key `item-left` and SSR `useLayoutEffect`.
- Standard full Storage gate: `npm.cmd run storage:test` — 308 tests, 3 skipped, pass. Initial environment diagnostics failed once with root venv missing `pillow_heif`, and once with backend venv missing `jsonschema`; the final standard script used only the two existing repository venv dependency sets and installed nothing.
- Production build: 1914 modules transformed, pass. Existing warnings: CSS `.w-2/3`, Tauri dynamic/static imports, and >500 kB chunk.
- `git diff --check`: pass; only line-ending conversion notices.

## Self-review / Concerns

- Reviewed all changed lines against Task 15.7 ownership; no document upload/parser, Ark Files/Responses, schema-v16 tables, Document/Storyboard editor/tool schemas, or Prompt handoff code was touched.
- No same-ID in-flight lease was added; sequential saved replay is covered and remains the requested minimum.
- The full Storage directory Ruff command still reports four pre-existing unrelated unused imports/variables. They were not modified because surgical scope forbids adjacent cleanup; modified backend files are Ruff-clean.
- Build/test warnings above pre-date this slice and do not originate in the changed conversation path.
