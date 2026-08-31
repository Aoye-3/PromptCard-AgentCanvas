# Local Agent Bridge And MCP Operations

The Local Agent Bridge gives an external Agent a bounded PromptCard work environment: explicit `PRJ-*`/`CVC-*` authority, approved Skill revisions, exact project objects, ten stable Tools, and review-only typed writeback. It is optional. PromptCard's ordinary Canvas, Prompt, image, and first-party Agent workflows do not depend on MCP being installed, configured, or running.

## Host support status

| Host | Status | Evidence |
| --- | --- | --- |
| Codex CLI / Codex app | Verified | Real first-contact and full Document → Storyboard → Prompt → generated-image writeback, replay, conflict, and restart acceptance are recorded in [the restart checkpoint](../reviews/2026-08-31-real-codex-restart-replay-checkpoint.md). Codex officially supports local STDIO and Streamable HTTP MCP servers; see the [official MCP guide](https://developers.openai.com/codex/mcp/) and [configuration reference](https://developers.openai.com/codex/config-reference/). |
| TRAE | 候选 / unverified | The repository carries a syntax candidate using the same STDIO launcher and core Tool contract. No official transport evidence plus real-host smoke has been accepted, so PromptCard does not claim TRAE compatibility. |
| Doubao desktop/web, MarsCode | 待验证 | No supported-host claim until official MCP-host evidence and a real acceptance run both exist. |

Client names are audit metadata, never authorization. Every host receives the same Tool names, schemas, permissions, budgets, and results from the shared server factory.

## Prerequisites And Least-Authority Start

1. Install repository dependencies once with the repository's normal `npm.cmd install` workflow. The launcher never performs a package install or runtime download.
2. Start the normal PromptCard Storage and Gateway services.
3. Copy `config/promptcard-bridge/profiles.read-only.example.json`, replace its token and repository-scope placeholders locally, and set the complete JSON as `PROMPTCARD_BRIDGE_PROFILES_JSON` in the Gateway process.
4. Set the same loopback Gateway origin and selected profile token in the host process as `PROMPTCARD_BRIDGE_URL` and `PROMPTCARD_BRIDGE_TOKEN`. Do not put a real token in a tracked template or command transcript.
5. Check the package without contacting Gateway:

```powershell
npm.cmd run bridge:diagnose:offline
```

6. Check both packaging and the live Gateway:

```powershell
npm.cmd run bridge:diagnose
```

These checks require no image/text provider key. Their JSON reports configuration booleans and a stable failure layer, never a credential value, repository path, provider body, or internal exception.

## Register Codex Over STDIO

The tracked `config/promptcard-bridge/codex-stdio.example.toml` follows the official Codex MCP configuration fields. Replace the repository path locally, keep only the six read Tools enabled for first contact, and expose the Bridge origin/token through the launching environment. An equivalent CLI registration is:

```text
codex mcp add promptcard --env PROMPTCARD_BRIDGE_URL=http://127.0.0.1:8000 --env PROMPTCARD_BRIDGE_TOKEN=<local-token> -- powershell.exe -NoProfile -ExecutionPolicy Bypass -File <absolute-repository-path>\scripts\start-promptcard-mcp.ps1 -Transport stdio
```

Avoid pasting a production credential into shared shell history. Verify registration with `codex mcp list` and inspect the server from Codex's MCP UI. First call `promptcard_runtime_describe`; after the user explicitly selects a project and creates or chooses a fresh CVC, call `promptcard_workspace_describe`. Exact approved Skills and objects are then available through the remaining read Tools.

## Opt In To Review-Only Writeback

Read-only is the default onboarding profile. To test the full closed loop, configure a separate token/profile based on `profiles.full-review.example.json` and explicitly enable:

- `promptcard_delivery_preview`
- `promptcard_delivery_commit`
- `promptcard_delivery_status`
- `promptcard_asset_stage`

The Gateway independently enforces `bridge:deliver:document`, `bridge:deliver:storyboard`, `bridge:deliver:prompt`, `bridge:deliver:image`, and `bridge:status`. Commit creates or replays a visual proposal; it never auto-applies durable Canvas content. Image staging is limited to the configured real-path workspace root and still requires MIME, size, digest, CVC, target, and human-review checks.

## Failure Isolation

| Layer | Typical signal | Check / owner |
| --- | --- | --- |
| Discovery | Host does not list PromptCard or MCP exits at startup | Run `npm.cmd run bridge:diagnose:offline`; check the absolute launcher path, Node version, locked dependency presence, transport token, and host config. |
| Resolution | `PRJ`, `CVC`, Skill, Prompt, or asset is missing/stale/revoked | Open Agent 工作环境, select an explicit project, create a fresh CVC, and copy the exact public reference/revision/digest. Gateway/Storage own this rejection. |
| Generation host | Codex cannot analyze or generate an image | Inspect the external host's model/tool availability and account limits. PromptCard does not operate or bill that generation call. |
| Delivery | Preview/commit/status returns scope, conflict, staging, or provenance failure | Check the trusted profile scope, exact Skill pin, `clientRequestId`, canonical digest, and source/target membership. Never replace an exact code with a title or internal node ID. |
| Storage | Gateway reports lifecycle, persistence, ledger, or asset validation failure | Check Storage health and schema v19. Retry the same request ID/content for recovery; changing content under the same ID must conflict. |
| Canvas | Proposal is durable but not visible/accepted | Open the same project/CVC and Agent 工作环境, then use the native Document, Storyboard, Prompt, or image review surface. Canvas acceptance remains a user action. |

## Provenance And Cost

External-host reasoning and image generation use the external host's account, model availability, retention policy, and pricing. PromptCard cannot predict or waive those costs. PromptCard's own configured providers are a separate billing path. An externally generated image is staged as imported evidence with host/Skill/source/request provenance; PromptCard does not fabricate a provider generation run or claim that it generated the file.

## Disable Or Remove

Disable the `promptcard` MCP entry in the host, or remove it from Codex with:

```text
codex mcp remove promptcard
```

Then remove the corresponding Bridge profile from the Gateway launch environment and restart Gateway. This does not delete projects, CVC snapshots, approved Skill revisions, Canvas objects, imported assets, proposal decisions, provenance, or ledger history. PromptCard remains usable without the MCP process; re-enabling later requires a newly selected local profile/token and follows the same exact-reference rules.

## Contributor Verification

```text
npm.cmd run test:bridge-package
npm.cmd run bridge:cli:check
npm.cmd run mcp:check
npm.cmd run test:bridge-cli
npm.cmd run test:mcp
npm.cmd run test:bridge-adversarial
```

Task 28 also requires the repository build and full regression matrix before merging the feature branch into `main`; the focused packaging commands alone are not release acceptance.
