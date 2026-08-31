# Real Codex Restart And Replay Checkpoint

Date: 2026-08-31

Branch: `feat/skill-document-storyboard-loop`

Status: real four-kind delivery checkpoint passed; `main` unchanged

## Outcome

The external-Agent creative environment now survives a real service and host restart across the complete accepted creative chain:

1. a schema-naive Codex discovers Bootstrap v6, explicit PRJ/CVC authority, the exact approved Skill pin, and the closed Tools;
2. it creates and changes one Document proposal, creates and changes one Storyboard proposal, creates one all-`user` Prompt proposal, and uses Codex image generation to stage and place one real PNG;
3. the browser accepts every proposal through the native Document, Storyboard, Prompt, and image review paths;
4. Storage, Gateway, Vite, and Codex stop and restart;
5. a new Codex repeats discovery, resolves the exact four-object CVC, and replays the identical asset-stage request plus all six delivery preview/commit/status sequences;
6. the ledger returns the original accepted outcomes, a different digest under the same request key is rejected as HTTP 409 `delivery_conflict`, and a new browser restores one unique `CVD-*`, `CVS-*`, `CVT-*`, and `CVM-*` with provenance and versions intact.

Storage also proves that the Bridge image created no PromptCard provider generation run. Successful image staging remains externally opaque: the public result exposes `accepted`, `AST-*`, and digest evidence, but no internal asset ID or path.

## Product defect fixed during the checkpoint

The bounded final selection revealed that the legacy 20×16 global node offset placed large Bridge-created Document and Storyboard nodes on top of each other, allowing one node to intercept another node's review controls. The four external create/place paths now use a conservative three-column collision-free slot allocator. Ordinary manual Canvas placement is unchanged.

The allocator was developed test-first. Its RED test initially failed because the placement module did not exist; after implementation, the focused Document, Storyboard, image, and placement suite passes 9 tests.

## Verification evidence

- `npm.cmd run test:e2e:real-codex-restart`
  - prepare: complete four-kind real-Codex loop and visual acceptance passed in approximately 8.1 minutes;
  - process boundary: Storage, Gateway, Vite, and Codex stopped and restarted;
  - recover: exact discovery, replay, conflict, uniqueness, provenance, and new-browser restore passed in approximately 1.9 minutes.
- focused Vitest: 4 files, 9 tests passed;
- full frontend regression: 4 shards, 140 files and 1,425 tests passed;
- Bridge contracts: 52 tests passed; deterministic Bridge CLI: 8 tests passed; STDIO/HTTP MCP: 10 tests passed;
- TypeScript: `npx.cmd tsc --noEmit` passed;
- touched ESLint and `git diff --check` passed.

The runner preserves failed prepared state for diagnosis and removes its dedicated fixture only after recovery succeeds. Cleanup is limited to `real-codex-loop-*` projects, `loop-story-planning-*` Skills, their CVCs, and the dedicated generated image; it does not touch user projects or Skills.

## Remaining work before `main`

- complete Plan 008 Task 27 adversarial boundary matrix;
- complete Task 28 optional Bridge packaging and contributor diagnostics;
- run every full frontend, Storage, Gateway, Runtime, MCP/CLI, TypeScript, build, browser, security, and documentation gate;
- perform the final acceptance/handoff, then merge and push `main` only if all gates are green.

This checkpoint explicitly does not authorize Asset Shelf, a browser connector, generic Canvas mutation Tools, or automatic application of external results.
