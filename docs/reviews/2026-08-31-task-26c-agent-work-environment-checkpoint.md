# Task 26C Agent Work Environment Checkpoint

## Checkpoint

- Date: 2026-08-31
- Branch: `feat/skill-document-storyboard-loop`
- State: implementation, real-browser checkpoint, and real Codex first-contact discovery passed
- Merge state: feature branch only; do not merge or push `main` until the final real Codex four-kind loop passes

## Completed Boundary

- The Canvas right rail now presents one Agent work environment instead of a separate external-Agent editor.
- The panel shows local Gateway health, configured or recently-active Bridge profile, fixed scopes, explicit PRJ/CVC and revision, Bootstrap Skill, exact trusted Skill pins and projection health, available Tools/writeback kinds, pending proposals, recent failures, and external provenance.
- The local browser receives a strict redacted snapshot. Bridge tokens, repository paths, internal Canvas node IDs, arbitrary filesystem paths, and provider credentials never enter the response.
- A profile selection changes presentation only. External requests remain authorized by their own Bearer profile.
- A CVC change is persisted only after Storage verifies exact project ownership and non-revocation.
- Exact task copy requires selected creative object codes to be immutable members of the resolved CVC. The copied task names PRJ/CVC/object references and tells the Agent to discover Bootstrap → runtime → workspace before reading exact Skills or committing proposals.
- Pending and failed deliveries share the same Inbox. Document, Storyboard, Prompt, and image proposals continue through their established native review/application paths.

## Contract Correction Found By The Real Loop

The first browser run displayed `0/1` authorized objects even though the selected Document belonged to the CVC. The initial implementation treated context-pack `sourceCodes` as membership. Storage uses that field for dependency/evidence references; authoritative CVC members are `entries[].reference.code`. The work-environment response now publishes a separate bounded `objectCodes` list derived only from those entries. Delivery evidence retains its existing `sourceCodes` semantics.

## Verification Evidence

- `agent-runtime/backend/tests/test_bridge_gateway.py` plus `test_bridge_environment.py`: 35 passed.
- strict domain, Runtime client, Agent work-environment component, and Bridge Inbox tests: 115 passed.
- v1-v3 closed contract schema/fixture suite: 52 passed; v1/v2 remain unchanged.
- deterministic Bridge CLI: 8 passed; STDIO/loopback MCP: 10 passed.
- `npx.cmd tsc --noEmit`: passed.
- touched Ruff and ESLint: passed (three pre-existing `no-explicit-any` warnings remain within the repository threshold).
- production build: passed with only the pre-existing CSS selector, dynamic-import, and large-chunk warnings.
- real Storage + Gateway + Vite + Chromium scenario: 1 passed in 57.3 seconds.
- actual Codex CLI + repository-owned STDIO MCP discovery scenario: 1 passed in 1.4 minutes.

The real browser scenario proves:

1. a valid external Bridge Bearer request appears as bounded recent profile activity;
2. the user can activate an explicit same-project CVC through Storage validation;
3. PRJ/CVC, profile/scopes, Bootstrap, Tools, and writeback kinds render from the strict Runtime snapshot;
4. one selected CVC Document is reported as `1/1` authorized and produces an exact copyable task;
5. a CVC owned by another project is rejected and does not replace the active authority.

The real Codex scenario additionally proves that a host with no preloaded PromptCard schema knowledge calls Runtime then Workspace first, reads the exact trusted Skill pin, resolves every CVC object, performs bounded Prompt retrieval, resolves the exact returned Prompt, and reads one authorized image asset. The test asserts captured MCP tool events and result payloads rather than accepting the model's final summary as evidence.

## Deliberately Not Claimed

- This checkpoint does not repeat the final script → Document → Storyboard → Prompt → Codex-generated image loop.
- Browser profile selection, recent activity, and saved CVC preference are not authorization.
- `main` has not been changed.

## Next Exact Slice

1. Run the complete four-kind creative loop, including one requested revision, per-field Storyboard review, Prompt creation, image staging/writeback, replay, and process restart.
2. Record blockers, data risks, and high-friction interactions; fix them test-first and rerun the entire loop.
3. Only after that acceptance passes, update final evidence, merge the feature branch, and push `main`.

## Resume Commands

```powershell
agent-runtime\backend\.venv\Scripts\python.exe -m pytest agent-runtime/backend/tests/test_bridge_gateway.py agent-runtime/backend/tests/test_bridge_environment.py -q -p no:cacheprovider
npx.cmd vitest run src/domain/bridge/agent-work-environment.test.ts src/services/agent-runtime-service.test.ts src/components/canvas/bridge/AgentWorkEnvironment.test.tsx src/components/canvas/bridge/BridgeDeliveryInbox.test.tsx
npm.cmd run test:contracts
npm.cmd run test:bridge-cli
npm.cmd run test:mcp
npx.cmd tsc --noEmit
npm.cmd run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-e2e-tests.ps1 --real-gateway tests/e2e/agent-work-environment.spec.ts --workers=1
npm.cmd run test:e2e:real-codex-discovery
```
