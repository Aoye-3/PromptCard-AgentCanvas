# Task 15.5 Technical Acceptance

## Status

Ready for user acceptance on `feat/plan-008-skill-hub-generic-bridge`. Execution is paused before Task 16.

Base: `d354d4f`

## Implementation Commits

- `3e91833` — `feat(skills): complete Skill Hub management workflow`
- `1c3c3dd` — `feat(bridge): freeze host-neutral v2 boundary`

## Delivered Behavior

- Skill Hub now provides two-phase folder/archive inspection, structured blocking findings, inert manifest metadata preview, create/revise import, revision history/diff, exact-revision trust review, archive/restore, and explicit error/recovery states.
- Local-Agent and Codex host cards expose independent enabled state and revision pins. Adding a canonical revision does not move either pin.
- Codex keeps its accurate `.agents/skills` projection name. Repository scopes returned by Storage can be selected independently; stale scope responses cannot overwrite the selected pin. Owned drift can be repaired explicitly against the current pin; missing ownership metadata or an unowned collision fails without overwriting user content.
- Canvas now presents “复制 Agent/MCP 上下文”; the immutable CVC contract remains unchanged.
- `promptcard-bridge/v1` remains unchanged. v2 adds trusted `profileId`/scopes, `promptcard-bridge` provenance, request-side profile forgery rejection, and `(profileId, clientRequestId)` replay isolation.
- ADR-019 and Plan 008 now define a host-neutral Gateway/CLI/MCP/retrieval/delivery core. This historical checkpoint selected Codex and TRAE as intended acceptance targets; Task 28 later verified Codex in a real host and retained TRAE only as an unverified configuration/contract candidate. Doubao and MarsCode remain “待验证”.

## Automated Evidence

| Gate | Result |
| --- | --- |
| PromptCard bridge v1/v2 contracts | 37 passed |
| Focused frontend contracts/components | 62 passed |
| Full frontend suite | 832 passed across 4 shards |
| Skill Hub + Agent/MCP context Chromium E2E | 2 passed |
| Full Storage suite | 307 passed, 3 skipped |
| Full Gateway/backend pytest | 295 passed, 1 existing deprecation warning |
| Agent/runtime health + text-agent TypeScript | passed; Storage schema 15 reported |
| TypeScript `tsc --noEmit` | passed |
| Ruff configured backend + all changed Python surfaces | passed |
| Changed TS/TSX ESLint with zero-warning limit | passed |
| Production build | passed |
| `git diff --check` | passed |
| Independent read-only review | PASS; no Blocking/Important findings |

The three Storage skips are operating-system capability probes where symlink/junction creation is unavailable. Existing frontend warnings remain: server-render `useLayoutEffect`, duplicate test keys, Vite CSS selector parsing for `.w-2/3`, dynamic/static Tauri imports, and the existing large-chunk warning. The full repository ESLint command still reports two pre-existing errors at the base revision in `free-canvas-project.ts` and `free-canvas-multi-view.spec.ts`; all files changed by Task 15/15.5 pass with `--max-warnings 0`.

## Security And Recovery Evidence

- External revisions cannot enable either host until the exact `(skill, revision, digest)` has a trusted review. A wrong digest returns `skill_review_stale`; a new canonical revision starts unreviewed and leaves current pins unchanged.
- An explicit `untrusted` decision globally blocks execution and repair, while a revoked or archived Skill can still be explicitly disabled/unpublished so a previously projected copy is not left discoverable.
- The host-description endpoint exposes opaque repository scope keys and no filesystem paths.
- The Codex repair endpoint uses expected revision/digest compare-and-swap, rejects reparse points in the repository-to-projection parent chain before mutation, accepts only the durable ownership manifest, rescans unsafe links, and repairs only owned entries. The collision test proves a user-owned sentinel survives.
- v2 delivery requests reject both a self-reported `profileId` and legacy `codex-harness` provenance. Two trusted profiles may reuse one request ID/digest without colliding.
- Task 16 is intentionally absent. ADR-019 requires its future bridge credential to be separate from `PROMPTCARD_INTERNAL_TOKEN` and requires 401/403 isolation from internal-chat, model-management, and image-generation routes before acceptance.

## Residual Risks

- SQLite and filesystem projections cannot form a hardware-atomic transaction. The existing journal/recovery protocol remains the compensation boundary; explicit repair now covers verified owned drift without changing the durable pin.
- v2 freezes trust and delivery identity but does not yet expose a Gateway bridge router, CLI, MCP process, credential, or network listener. Those begin only after this acceptance gate.
- Codex and TRAE compatibility claims are based on official transport documentation; real host smoke tests remain a Checkpoint 4 requirement. Doubao and MarsCode are not claimed compatible.

## Manual Acceptance Path

1. Open SkillHub, import a folder or archive, and confirm findings/manifest metadata appear before persistence and no executable control exists.
2. Add a revision, review it, move only the local-Agent pin, and confirm the Codex pin remains unchanged; then reverse the hosts.
3. Modify an owned Codex projection file, refresh its unhealthy state, run explicit repair, and confirm the canonical revision/pin did not move.
4. Create an unowned directory at the publication name and confirm publish/repair returns collision while preserving the directory; choose a different publication name to recover.
5. Archive and restore the Skill and confirm lifecycle actions remain separate from enable/disable and pin selection.
6. Confirm the Canvas action and dialog read “复制 Agent/MCP 上下文”.

Do not begin Task 16 until the user accepts this package.
