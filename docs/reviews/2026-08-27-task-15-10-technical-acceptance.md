# Task 15.10 Technical Acceptance And Checkpoint 3.5 Handoff

## Decision

- Date: `2026-08-29`
- Branch: `feat/skill-document-storyboard-loop`
- Reviewed implementation HEAD: `cecdae2`
- Decision: Tasks 15.6-15.10 are implemented and technically accepted with the baseline/infrastructure residuals listed below.
- Pause: Checkpoint 3.5 user manual acceptance is pending. Task 16 has not started and remains blocked.

This package does not claim that the manual acceptance script has passed. It records automated evidence, review rounds, known gate residuals, and the exact manual checks the user must still perform.

## Delivered Behavior And Boundaries

- `chat-experimental` is a top-level interaction mode. A conversation keeps its selected model and bound Skills across turns/restart, while each turn revalidates the current local-Agent pin, exact revision/digest, trust, lifecycle, budget, and tool compatibility.
- TXT/Markdown/DOCX/PDF are project-local document resources under schema v16. TXT/Markdown use strict UTF-8; DOCX uses pinned `python-docx==1.2.0`; PDF input uses ephemeral Ark Files/Responses upload with `finally` deletion and durable redacted startup retry on failure.
- Document, Storyboard, and Prompt remain independent domain objects. Document persistence uses an editor-neutral block AST; all selected Tiptap packages remain pinned to `3.30.3`; unknown Canvas kinds round-trip as read-only `unsupported` nodes.
- Document edits support inline, expanded, and collapsed views, reversible user edits, tracked Agent insert/delete/replace suggestions, single/all accept/reject, effective-draft semantics, undo/redo, and NFC UTF-8 byte anchors constrained to one block.
- Gateway apply authority is Storage state: it reloads the project, requires one unique target and one unique `AgentAppliedEditMarker`, and verifies node kind, identity, request/edit identity, and result digest. Saved-before-ACK, lost response, repeat, conflict, missing target, integrity failure, and restart reconciliation are covered.
- Document -> Storyboard is explicit. Storyboard creation records Document revision/digest, resource digests, model, and exact Skill provenance; later Agent changes are reviewed per field with stale-base rejection.
- Selected Document text or one Storyboard shot -> Prompt is explicit. Approval may only create one new all-`user` `free_canvas_text_create` node. It cannot update a Prompt node or read/write Prompt Library.
- Adversarial boundaries keep Document/Storyboard out of Prompt Library, Prompt RAG, Prompt compilation, image-generation input, media/reference codes, standalone Storyboard mutation, and ambient full-body context.

## Commit Ledger

The commits below are local to the checkpoint branch and are grouped by delivered slice. Some hardening commits exercise more than one slice.

### Task 15.6

- `6b5bea7`, `8fc5ddc`, `e3e9894`: isolated Document/Storyboard contracts, closed dispatch, unknown-node preservation, and interaction-mode boundary.

### Task 15.7

- `4604a36`, `180890a`, `97eeeb2`: durable experimental conversation and Skill binding.
- `6a790f8`, `bb38822`, `4cd24a5`: apply identity/durability hardening shared by later Agent writes.

### Task 15.8

- `759a04e`, `8ac106c`, `d2ecbdd`, `932367c`, `1379811`, `97ae87a`, `1e5989b`: schema v16 document resources, bounded extraction, Ark Responses, cleanup persistence/retry, and provider isolation.

### Task 15.9

- `07362bf` through `9a64228`: Document AST/editor, suggestion semantics, durable apply acknowledgement, conflict/replay/restart recovery, and authority serialization.
- `7c53cb1`: Task 15.6-15.9 documentation snapshot.

### Task 15.10

- `cf34347`, `baf1de2`, `b7afb46`, `4f131be`, `49813d9`, `c0fb9b0`, `e8d5c9f`, `32fd302`, `a727d4e`: explicit Storyboard creation, field review, provenance, acknowledgement, replay, and recovery hardening.
- `a9d6150`, `bd68b05`, `14b5c43`, `eae7655`, `229b90a`, `bc6e2cb`, `87b0f9f`, `59bc01f`, `9df3291`, `1b431a3`: Prompt isolation/handoff and Storage/Gateway authority hardening.
- `7668443`, `297aae6`, `68c652b`, `2746de6`, `74b8fc0`, `4b30d79`, `5b21400`, `cecdae2`: final lint, duplicate-authority, browser-fixture, editor-sync, control-layout, and deterministic Prompt receipt fixes.

## Independent Review

Fresh read-only reviewers were dispatched after implementation and after every Blocking/Important fix round.

1. Round 1 found explicit `@Document`, Storage-ledger authorization, and provenance gaps. Each was reproduced with a RED test and fixed.
2. Round 2 found duplicate backend Canvas node IDs could create ambiguous authority. RED tests preceded `297aae6`; Gateway now returns conflict or terminal integrity failure instead of selecting one node.
3. Round 3 found equivalent duplicate frontend authority paths. RED tests preceded `2746de6`; draft/apply/marker/review/ACK/recovery paths now require exactly one node.
4. Round 4 found deterministic Prompt handoff inspection could select one of duplicate receipt targets. RED tests preceded `cecdae2`; marker identity and deterministic node ID must each resolve uniquely to the same node.
5. Final fresh reviewer verdict: **Approve**, with no Blocking or Important findings. Its focused audit ran 395 frontend/domain, 168 Gateway, 70 text-runtime, and 37 bridge-contract tests: 670 unique tests passed, 0 skipped, 0 warnings.

## Automated Evidence

| Gate | Result |
| --- | --- |
| Full Storage | 339 collected: 336 passed, 3 skipped; document-resource, schema v16, backup/restore, and cleanup-ledger coverage included |
| Full Gateway/backend | 457 passed; 1 existing Starlette deprecation warning |
| Full frontend/domain | 1,377 passed across 132 files and four shards |
| Task 15.10 reviewer focus | 670 unique tests passed; 0 skipped/warnings |
| TypeScript | Main application and text-agent-runtime checks passed |
| Ruff | Full configured Storage/Gateway/text-runtime scope passed |
| Production build | Passed, 1,974 modules transformed |
| Browser: Document persistence | 1/1 passed on final behavior, including inline edit, expand/collapse, save/reload |
| Browser: multi-view isolation group | 3/3 passed in isolated current-HEAD run |
| Browser: full suite | 33/33 passed at `5b21400`; on `cecdae2`, 30 passed, 1 failed from one startup-time Storage proxy error, and 2 serial dependants did not run |

Focused/adversarial coverage includes:

- three-turn Skill binding, independent local-Agent/Codex pins, current-pin provenance, and disabled/untrusted/archived/missing-tool rejection before model invocation;
- response-loss reuse of the same request result and restart hydration without duplicate turns;
- strict TXT/Markdown, valid and corrupt/encrypted/oversize/zip-bomb DOCX, normal/scanned PDF, MIME/signature spoofing, count/aggregate budgets, unsupported provider/model, Ark delete in `finally`, durable redacted retry, and startup cleanup;
- Document rich text, three views, selection preservation, suggestion single/all accept/reject, effective draft, save rollback, stale base, UTF-8 boundary/cross-block rejection, saved-before-ACK, response loss, repeated request, conflict, and restart recovery;
- Storyboard source provenance, field differences, single/all accept/reject, stale rejection, replay, duplicate authority, and restart recovery;
- Prompt handoff pending state, explicit approval, new all-user node only, response loss, repeated request, conflict, restart, missing/duplicate receipt, and marker/node identity disagreement;
- unchanged Prompt editor/Library, image generation, Skill projection, standalone Storyboard, context pack, project normalization, and public reference-code behavior.

## Gate Residuals And Warnings

These are disclosed rather than reported as passing:

- Repository-wide ESLint reaches 0 errors but reports 41 warnings against the configured maximum of 30. `git blame` shows the warning lines predate Task 15.10; every changed/scoped file is clean. Package-level filesystem scans also cannot traverse ignored ACL-protected pytest cache directories. Their permissions were not changed and they were not deleted.
- `npm run startup:test` still polls fixed ports 8002/8001, while the current desktop launcher writes dynamically selected ports to `logs/dev-runtime.json`. The run started Vite and dynamic Storage/Agent services successfully but failed by polling the stale defaults. Startup scripts were left untouched because this is outside Task 15.10.
- Current-HEAD full Playwright replay repeatedly captured one transient `Storage service is unavailable` console error in the first Plan 007 multi-view test after earlier suites. The Storage process stayed healthy and continued returning 200 responses; the same current-HEAD serial spec passed 3/3 alone, and the full suite had passed 33/33 before the final Prompt-receipt-only change. This remains a gate-infrastructure flake, not a hidden green result.
- Existing non-blocking warnings remain: React duplicate-key/useLayoutEffect test warnings, CSS parser warning for `.w-2/3`, mixed static/dynamic Tauri imports, a bundle-size warning, and the Starlette deprecation warning above.

## Hygiene And Leakage Checks

- Generated `dist`, `test-results`, and `.tmp/e2e-services` outputs from the final runs were removed after their results were recorded.
- No listeners remained on the checkpoint test/dev ports after the runners exited.
- The final diff check, staged-file check, tracked absolute-path scan, credential/provider-ID boundary tests, and branch/status check are recorded immediately before the documentation commit.
- ACL-protected ignored pytest caches and unrelated historical `.tmp`/`logs` material were not taken over or broadly cleaned.

## Manual Acceptance Script (Pending)

1. In Skill Hub, import and review a `storyboard-master` Skill. Enable one exact local-Agent revision only; keep the Codex pin independent. Confirm disabled, untrusted, archived, or missing-tool states reject the next turn visibly.
2. Open `对话模式【测试中】`, bind that Skill, send three turns, reload/restart, and verify the same conversation/model/binding persists while every new turn records the then-current pin revision/digest.
3. Upload TXT, Markdown, DOCX, normal PDF, and scanned PDF. Confirm each valid resource survives restart; confirm spoofed, corrupt/encrypted, oversize, and excessive files fail visibly. Exercise Ark deletion and a simulated failed-delete restart retry if provider credentials are available.
4. Create a character/asset planning Document. Edit inline, expand, collapse, save, reload, and confirm one canonical draft. Request Agent changes; inspect red deletion/green insertion, accept/reject one and all, and confirm the next turn uses the effective draft.
5. Use the explicit Document -> Storyboard action. Inspect source Document/resource/model/Skill provenance, request a field revision, compare old/new values, and accept/reject one and all.
6. Convert selected Document text and one Storyboard shot to Prompt proposals. Before approval verify each is pending; after approval verify one new all-`user` Prompt Canvas node is created and no existing Prompt is updated.
7. Repeat/reload around approval to exercise saved-before-ACK, lost response, duplicate request, conflict, and restart recovery. Confirm there is never more than one target, marker, suggestion set, or Prompt handoff receipt.
8. Inspect Prompt Library, Prompt RAG/search, Prompt compiler preview, image-generation request/context, ambient workspace context, standalone Storyboard, and reference codes. Confirm no Document/Storyboard body appears implicitly.

After these checks, record pass/fail evidence and explicitly authorize or reject progression. Until then, Checkpoint 3.5 remains paused and Task 16 must not begin.
