# Real Codex Writeback Contract Checkpoint

## State

- Branch: `feat/skill-document-storyboard-loop`
- Scope: first real-Codex Document writeback slice and Bridge v3 Skill-pin alignment
- Merge state: feature branch only; `main` remains unchanged
- Acceptance state: focused regression green; real Codex Document rerun and the remaining total loop are still open

## What The Real Host Proved

An actual newly connected Codex process completed the packaged first-contact sequence without prior PromptCard schema knowledge: Runtime description, Workspace description, exact approved Skill read, and exact source-object resolution. It then constructed the intended `document.create` preview through the repository-owned MCP Tool.

The preview was rejected with HTTP 422 before Gateway routing. The v3 schema and MCP Tool correctly emitted `skillCode`, `revision`, `digest`, and `projectionHealth`; Gateway, Storage, and the strict browser parser still consumed the older three-field shape. Existing tests used empty pins or manually reduced fixtures and therefore did not exercise the normative host payload.

## Correction

- Gateway requires all four fields and compares `projectionHealth` with the currently trusted Workspace pin.
- A changed health value fails closed as `skill_pin_stale`.
- Storage validates and preserves the same closed four-field evidence in preview, commit, replay, and provenance.
- The browser accepts only the same closed enum-backed shape.
- Focused tests now use non-empty approved Skill pins so the drift cannot hide behind empty arrays.

## Verification

- Bridge contracts: 52 passed.
- Gateway Bridge regression: 32 passed.
- Document/image Storage delivery: 10 passed plus 4 subtests.
- Strict Storage client and Bridge review UI: 63 passed.
- MCP STDIO/HTTP and workspace-asset boundary: 10 passed.
- TypeScript: passed.

The inaccessible legacy pytest-cache warnings are environmental and did not affect test results. The initial failed command that named `contracts/promptcard-bridge/tests` was a runner-path mistake; the repository's normative `npm.cmd run test:contracts` command passed all 52 cases.

## Resume Point

Rerun `npm.cmd run test:e2e:real-codex-loop`. Only after the actual Codex Document proposal commits, appears in the visual Inbox, is accepted, and preserves its `CVD`, source, Skill pin, profile, request identity, and text should the same scenario expand to Document change, Storyboard create/change, Prompt create, Codex image generation/staging/placement, replay, and process restart.
