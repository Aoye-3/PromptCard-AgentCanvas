# Task 27 Adversarial Boundary Checkpoint

Date: 2026-08-31

Branch: `feat/skill-document-storyboard-loop`

Status: Task 27 passed; Task 28 unlocked; `main` unchanged

## Outcome

The repository now owns a single repeatable adversarial command:

```powershell
npm.cmd run test:bridge-adversarial
```

It composes the already authoritative boundary suites instead of duplicating their implementation details, then adds a real Storage + Gateway attack path. The gate covers:

| Threat | Evidence |
| --- | --- |
| Cross-project IDOR and references outside the explicit CVC | Real Gateway E2E plus Gateway/Storage context tests |
| Revoked or stale CVC | Real Gateway E2E, Context Pack tests, delivery-ledger tests |
| Archived, untrusted, unhealthy, stale, or capability-expanding Skill pins | Skill management/host tests, Workspace/Gateway tests, exact Skill resolver tests |
| Forged profile, scopes, client identity, or internal targets | Closed v1-v3 contracts and real Gateway profile-forgery E2E |
| Traversal, symlink/junction escape, arbitrary paths, MIME/digest/size spoofing | MCP workspace tests and staged-image Storage/Gateway tests |
| Duplicate delivery, different-digest conflict, interrupted mutation, crash/restart replay | Delivery ledger and all four typed delivery suites; final real-Codex restart checkpoint |
| Path, credential, environment, raw body, or internal-exception leakage | Gateway, environment view, CLI, and MCP redaction tests |
| MCP/Agent outage or removal breaking ordinary PromptCard | MCP outage tests plus MCP-absent Canvas, Agent Runtime, Agent work-environment, and startup regressions |

## Defect found and fixed

The first real attack-chain run returned human prose for a missing or invalid Bridge Bearer credential. That shape was inconsistent with the stable error-code boundary used by the Bridge router and forced external hosts to parse English text.

The authentication middleware now returns:

- HTTP 401, `detail.code = bridge_credential_required` for a missing or invalid credential;
- HTTP 503, `detail.code = bridge_configuration_invalid` for invalid server-side profile configuration.

Both responses remain redacted. A focused backend regression and the real Gateway E2E prove the new shape.

## Verification

- contracts: 52 passed;
- Bridge CLI: 8 passed;
- STDIO/HTTP MCP: 10 passed;
- MCP-absent Canvas, Agent Runtime, Agent work-environment, and startup: 186 passed;
- Storage authority, CVC, Skill, and four-kind delivery: 87 passed, 1 platform skip, 36 subtests passed;
- Gateway profile, retrieval, Skill, environment, and redaction: 55 passed;
- real Gateway attack chain: 1 passed;
- TypeScript and touched ESLint: passed;
- owned E2E services stopped and ports 38100-38102 were released.

The platform skip is an existing filesystem-capability branch; the Windows junction path is separately exercised and passed by the MCP suite.

## Remaining work before `main`

- Task 28: package the optional Bridge, contributor launch/configuration templates, diagnostics, supported-host evidence, removal/rollback guidance, and documentation link checks;
- full release matrix and final user acceptance;
- merge and push `main` only after those gates pass.
