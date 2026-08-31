# Real Codex First-Contact Discovery Checkpoint

## Checkpoint

- Date: 2026-08-31
- Branch: `feat/skill-document-storyboard-loop`
- State: passed against an actual signed-in Codex CLI and repository-owned STDIO MCP
- Merge state: feature branch only; the final four-kind writeback/review/restart loop still blocks `main`

## Proven User Boundary

A newly connected external Agent does not need PromptCard's internal database or Canvas schema. The acceptance prompt supplies only explicit `PRJ-*` and `CVC-*` public references and asks the host to follow the environment's progressive-disclosure guidance. Captured MCP events prove that Codex:

1. calls `promptcard_runtime_describe` first;
2. calls `promptcard_workspace_describe` second with the explicit PRJ/CVC;
3. reads the exact trusted Skill revision/digest advertised by the workspace;
4. resolves both authorized CVC objects by stable public code;
5. performs bounded Prompt retrieval using a unique evidence marker and resolves the exact returned `PLP-*`;
6. reads one CVC-authorized image asset; and
7. performs no proposal or mutation in this read-only first-contact turn.

The test inspects tool names, statuses, and bounded result payloads. A plausible final answer from the model is not treated as evidence.

## Harness Boundary

`scripts/run-e2e-tests.ps1 --real-codex` starts the real Storage, Gateway, and Vite services on the existing E2E ports. It assigns Storage and the Bridge profile the same isolated `real-codex-e2e` repository scope, then exposes only these environment variables to the STDIO MCP child:

- `PROMPTCARD_BRIDGE_URL`
- `PROMPTCARD_BRIDGE_TOKEN`
- `PROMPTCARD_BRIDGE_WORKSPACE_ROOT`

Codex does not inherit arbitrary parent environment variables into an MCP server. The test therefore declares this allowlist explicitly in the temporary Codex MCP configuration. No credential is written to a repository file or emitted in the acceptance output.

The Codex process runs with repository inspection, shell, browser, apps, plugins, and multi-Agent tools disabled for this turn. All creative evidence must come through PromptCard's ten-tool MCP contract.

## Verification Evidence

```powershell
npm.cmd run test:e2e:real-codex-discovery
```

Result: `1 passed (1.4m)`. The runner also verified that Storage, Gateway, and Vite became healthy and released ports `38100-38102` during cleanup.

The RED sequence identified and corrected three harness/test issues before this pass:

- Vite/esbuild must run outside the restricted command sandbox; product code was not changed for the sandbox-only `spawn EPERM`.
- external Skill `id` and `slug` must occupy distinct identifiers, matching the canonical registry invariant.
- Prompt retrieval uses a per-run unique marker so historical test data cannot invite an otherwise-correct out-of-CVC rejection before the current exact result is read.

## Deliberately Not Claimed

- No Document, Storyboard, Prompt, or image write is exercised by this checkpoint.
- No Codex-generated image has yet been staged and accepted through Canvas.
- Duplicate replay, user review, and PromptCard/Codex restart are still part of the final total-loop gate.
- `main` remains unchanged.

## Next Exact Slice

Drive an actual Codex session through Document create/accept/revise, Storyboard create/per-field review, Prompt create, Codex image generation/staging/writeback, duplicate replay, and service/host restart. Fix blocking, data-risk, and high-friction findings test-first, then rerun the complete loop before merging `main`.
