# Task 28 Optional Bridge Packaging Checkpoint

## Checkpoint

- Branch: `feat/skill-document-storyboard-loop`
- Date: 2026-09-01 (Europe/London)
- Status: focused Task 28 gate passed; final repository-wide release matrix next; `main` unchanged

## Delivered

- A repository-owned PowerShell 5.1-compatible launcher for STDIO or loopback Streamable HTTP. It accepts only a loopback Bridge origin, verifies Node 22.6+ and the existing locked MCP package, validates optional image-staging root and HTTP credential, emits stable safe errors, and performs no install/download.
- Redacted diagnostics with an offline packaging mode and an optional live Gateway runtime probe. Output contains configuration state, not credentials, repository paths, raw remote bodies, or internal exceptions.
- Least-authority read-only and explicit full-review Gateway profile examples.
- A current Codex STDIO TOML example that starts with only six read Tools enabled and write-approval behavior, plus a TRAE syntax candidate clearly labeled unverified.
- One maintained operations guide for onboarding, scope upgrade, six-layer failure isolation, provenance/cost, removal, contributor commands, and supported-host evidence.
- Current-state README, API, architecture, Plan 008, CLI/MCP package documentation, and documentation indexes synchronized in the same slice.

## Evidence

| Gate | Result |
| --- | --- |
| `npm.cmd run test:bridge-package -- --reporter=dot` | 6 passed |
| `npm.cmd run bridge:diagnose:offline` | passed on Node 24.13.1; `downloadsAtLaunch=false`; credential absent from output |
| `npm.cmd run bridge:cli:check` | passed |
| `npm.cmd run mcp:check` | passed |
| `npm.cmd run test:bridge-cli` | 8 passed outside the restrictive child-process sandbox |
| `npm.cmd run test:mcp` | 10 passed outside the restrictive child-process sandbox; both protocol eras and both transports covered |
| `codex --version` | `codex-cli 0.151.0-alpha.7.2` |
| `codex mcp add --help` | confirms STDIO `--env KEY=VALUE -- <COMMAND>` and Streamable HTTP registration |
| Official Codex references | current MCP and configuration pages confirm STDIO/HTTP, command/args/cwd/env/env_vars, enabled/disabled Tools, approval, required, and timeout fields |
| `git diff --check` | passed; only existing Windows line-ending notices |

The first sandboxed CLI/MCP test attempt failed with `spawn EPERM`; the identical repository commands passed when permitted to create their local test child processes. This is execution-environment evidence, not a product defect.

## Host Claims

- Codex: verified by official transport/configuration evidence plus real first-contact, four-kind writeback, replay/conflict, and restart acceptance.
- TRAE: unverified candidate only. The template proves shared contract intent, not compatibility.
- Doubao desktop/web and MarsCode: pending official MCP-host evidence and a real smoke test.

## Removal And Data Safety

Disabling or removing the host MCP entry and removing its Gateway profile stops new external requests. It does not delete or rewrite projects, CVCs, Skill revisions, Canvas objects, imported assets, proposal decisions, provenance, or profile-scoped ledger history. Ordinary PromptCard workflows do not require the MCP process.

## Resume Point

Run the final Plan 008 release matrix: full frontend, Storage, Gateway, text-runtime, contract, CLI, MCP, build, browser, security, and documentation gates. Fix only blocking defects, data risks, or high-friction closed-loop issues, synchronizing the nearest technical document with each correction. Do not merge or push `main` until the complete matrix passes.
