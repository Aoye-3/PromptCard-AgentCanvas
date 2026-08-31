# Real Codex Writeback Contract Checkpoint

## State

- Branch: `feat/skill-document-storyboard-loop`
- Scope: first real-Codex Document writeback slice and Bridge v3 Skill-pin alignment
- Merge state: feature branch only; `main` remains unchanged
- Acceptance state: real Codex Document-create slice passed; Document change and the remaining total loop are still open

## What The Real Host Proved

An actual newly connected Codex process completed the packaged first-contact sequence without prior PromptCard schema knowledge: Runtime description, Workspace description, exact approved Skill read, and exact source-object resolution. It then constructed the intended `document.create` preview through the repository-owned MCP Tool.

The first preview was rejected with HTTP 422 before Gateway routing. The v3 schema and MCP Tool correctly emitted `skillCode`, `revision`, `digest`, and `projectionHealth`; Gateway, Storage, and the strict browser parser still consumed the older three-field shape. Existing tests used empty pins or manually reduced fixtures and therefore did not exercise the normative host payload.

The next real runs exposed two usability/lifecycle problems. Runtime returned the Bootstrap only as an identity, so Codex had to infer the closed preview union by trial. The Canvas could also schedule an idle save before CVC creation and execute it later, advancing the project revision while Codex was working. Workspace originally did not report this until delivery.

## Correction

- Gateway requires all four fields and compares `projectionHealth` with the currently trusted Workspace pin.
- A changed health value fails closed as `skill_pin_stale`.
- Storage validates and preserves the same closed four-field evidence in preview, commit, replay, and provenance.
- The browser accepts only the same closed enum-backed shape.
- Focused tests now use non-empty approved Skill pins so the drift cannot hide behind empty arrays.
- Bootstrap revision 2 is returned with executable first-contact instructions covering fresh CVC discovery, exact Skill pins, six writeback shapes, preview/commit, and visual review.
- Workspace rejects a CVC behind the current project revision as `context_stale` before an Agent attempts delivery.
- CVC creation flushes the current Canvas and snapshots the Storage-returned authoritative revision; persisted edit-sequence tracking suppresses later idle saves when no new edit exists.

## Verification

- Bridge contracts: 52 passed.
- Gateway Bridge/environment regression: 36 passed.
- Document/image Storage delivery: 10 passed plus 4 subtests.
- Strict Storage client and Bridge review UI: 63 passed.
- MCP STDIO/HTTP and workspace-asset boundary: 10 passed.
- TypeScript: passed.
- CVC creation, App save coordination, and native Canvas regression: 110 passed.
- Bootstrap strict parsing/service/UI regression: 107 passed.
- Actual Codex Document create/preview/commit plus Chromium visual acceptance: 1 passed in 2.2 minutes.

The inaccessible legacy pytest-cache warnings are environmental and did not affect test results. The initial failed command that named `contracts/promptcard-bridge/tests` was a runner-path mistake; the repository's normative `npm.cmd run test:contracts` command passed all 52 cases.

## Accepted Boundary And Resume Point

The Document-create slice is accepted because the actual Codex proposal committed, appeared in the visual Inbox, was accepted, and preserved exactly one `CVD`, source, four-field Skill pin, profile, CVC, request identity, and text. This is not Checkpoint 5.

Extend the same fixture with an exact fresh CVC for that accepted CVD. Codex must propose `document.change` against its exact revision/digest, the user must review the resulting native red-delete/green-add suggestion, and acceptance must persist before Storyboard work starts. Storyboard create/change, Prompt create, Codex image generation/staging/placement, replay of every delivery, and process restart remain after that slice.
