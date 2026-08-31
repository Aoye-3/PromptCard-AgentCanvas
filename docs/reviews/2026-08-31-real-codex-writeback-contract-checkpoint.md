# Real Codex Writeback Contract Checkpoint

## State

- Branch: `feat/skill-document-storyboard-loop`
- Scope: real-Codex Document create/change writeback and Bridge v3 first-contact usability
- Merge state: feature branch only; `main` remains unchanged
- Acceptance state: real Codex Document create/change review slice passed; Storyboard, Prompt, image, replay, and restart remain open

## What The Real Host Proved

An actual newly connected Codex process completed the packaged first-contact sequence without prior PromptCard schema knowledge: Runtime description, Workspace description, exact approved Skill read, and exact source-object resolution. It then constructed the intended `document.create` preview through the repository-owned MCP Tool.

The first preview was rejected with HTTP 422 before Gateway routing. The v3 schema and MCP Tool correctly emitted `skillCode`, `revision`, `digest`, and `projectionHealth`; Gateway, Storage, and the strict browser parser still consumed the older three-field shape. Existing tests used empty pins or manually reduced fixtures and therefore did not exercise the normative host payload.

The next real runs exposed two usability/lifecycle problems. Runtime returned the Bootstrap only as an identity, so Codex had to infer the closed preview union by trial. The Canvas could also schedule an idle save before CVC creation and execute it later, advancing the project revision while Codex was working. Workspace originally did not report this until delivery.

Extending the harness through Document change exposed the remaining first-contact ambiguity. A new Codex could resolve the exact Document but should not be required to calculate a SHA-256 leaf digest; after bounded edit evidence was added, it still selected the Storyboard-style `payload.changes` key because the Bootstrap described operation members without freezing the outer wrapper. The strict MCP schema rejected both attempts. The accepted correction keeps validation closed and makes the environment executable: exact CVD reads provide the evidence, and Bootstrap v4 explicitly requires `payload.operations`.

## Correction

- Gateway requires all four fields and compares `projectionHealth` with the currently trusted Workspace pin.
- A changed health value fails closed as `skill_pin_stale`.
- Storage validates and preserves the same closed four-field evidence in preview, commit, replay, and provenance.
- The browser accepts only the same closed enum-backed shape.
- Focused tests now use non-empty approved Skill pins so the drift cannot hide behind empty arrays.
- Bootstrap revision 4 is returned with executable first-contact instructions covering fresh CVC discovery, exact Skill pins, six writeback shapes, the exact Document `payload.operations` wrapper, preview/commit, and visual review.
- Exact authorized CVD resolution supplies bounded block text, UTF-8 byte length, and SHA-256 digest evidence so a host never has to infer byte coordinates or calculate the conflict digest.
- Workspace rejects a CVC behind the current project revision as `context_stale` before an Agent attempts delivery.
- CVC creation flushes the current Canvas and snapshots the Storage-returned authoritative revision; persisted edit-sequence tracking suppresses later idle saves when no new edit exists.

## Verification

- Bridge contracts: 52 passed.
- Gateway Bridge/environment regression: 37 passed.
- Document/image Storage delivery: 10 passed plus 4 subtests.
- Strict Storage client and Bridge review UI: 63 passed.
- MCP STDIO/HTTP and workspace-asset boundary: 10 passed.
- TypeScript: passed.
- CVC creation, App save coordination, and native Canvas regression: 110 passed.
- Bootstrap strict parsing/service/UI regression: 107 passed.
- Actual Codex Document create, visual acceptance, exact-base change, native tracked review, and final persistence: 1 passed in 2.9 minutes.

The inaccessible legacy pytest-cache warnings are environmental and did not affect test results. The initial failed command that named `contracts/promptcard-bridge/tests` was a runner-path mistake; the repository's normative `npm.cmd run test:contracts` command passed all 52 cases.

## Accepted Boundary And Resume Point

The Document slice is accepted because actual Codex proposals created exactly one `CVD`, then changed that exact base through the native red-delete/green-add review. The user-facing flow accepted the proposal and all revisions, persisted the replacement text with zero suggestions, and preserved source, four-field Skill pin, profile, CVC, request identity, and public Document identity. The strict harness recorded no failed PromptCard Tool call in the passing run. This is not Checkpoint 5.

Extend the same real-host fixture from the accepted CVD into Storyboard create/change and its per-field review. Prompt create, Codex image generation/staging/placement, replay of every delivery, and process restart remain after that slice.
