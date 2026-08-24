# ADR-019: Freeze The Generic Local Agent Bridge Boundary

## Status

Accepted

## Date

2026-08-24

## Context

ADR-018 froze stable PromptCard references, Storage/Gateway ownership, canonical Skill packages, and the first delivery contract. Its MCP and delivery language treated Codex as the only external host. Plan 008 now needs one local boundary that can connect to multiple MCP-capable Agent applications without allowing the claimed client name to become identity or policy.

Official host documentation confirms that Codex supports STDIO and Streamable HTTP MCP servers and that TRAE supports STDIO, Streamable HTTP, and legacy SSE. The MCP TypeScript SDK v2 splits the server and Node transport packages and implements the 2026-07-28 protocol line. The MCP transport specification requires Origin validation, recommends localhost-only binding for local HTTP, and requires connection authentication. Legacy SSE exists only in the deprecated compatibility package and is not part of this bridge.

This decision supersedes ADR-018 only where ADR-018 says MCP is Codex-only/STDIO-only or delivery uses `codex-harness`. It preserves the v1 contract, public reference semantics, Storage/Gateway authority split, Codex `.agents/skills` projection, local-Agent snapshot adapter, and Storage v14 host enum/journal/manifest/recovery protocol. Storage v15 adds revision trust review and management operations without generalizing that host enum.

## Decision

1. **The product boundary is `PromptCard Local Agent Bridge`.** Gateway, CLI, MCP, retrieval, and delivery contracts are host-neutral. Codex and TRAE are configuration/acceptance adapters; the local Agent remains a separate in-process host adapter. No business handler selects behavior from a client product name.
2. **Trusted profiles come from launch or authentication context.** A launcher or authenticated HTTP context resolves `profileId` and scopes. Tool arguments cannot submit or override them. Optional client name/version are audit metadata only and cannot select authorization, tools, schemas, budgets, or results.
3. **Bridge credentials are separate and router-scoped.** A bridge credential is not `PROMPTCARD_INTERNAL_TOKEN`. It can reach only the bridge router and carries `bridge:read`, with later opt-in `bridge:deliver:prompt`, `bridge:deliver:image`, and `bridge:status`. The same credential must receive 401/403 from internal chat, model-management, and image-generation routes.
4. **v1 remains compatible; new work emits v2.** `contracts/promptcard-bridge/v1` and all fixtures remain unchanged. `contracts/promptcard-bridge/v2` layers trusted `profileId`/scopes over stable v1 reference and additive-item schemas, uses `promptcard-bridge` provenance, and keys replay identity by `(profileId, clientRequestId)`. v1 `codex-harness` is a compatibility input only; new records never emit it.
5. **The core MCP surface stays small and portable.** The initial tools are `promptcard_runtime_describe`, `promptcard_reference_resolve`, `promptcard_prompt_search`, and `promptcard_asset_read`; delivery preview/commit/status tools arrive later. Tools with text results are the compatibility baseline. Structured results, Resources, and `ImageContent` are optional enhancements with Tool/Text fallbacks. The total remains below 40 tools and each description below TRAE's 8,000-character budget.
6. **Task 21 pins the v2 SDK and both current transports.** The implementation will use exact `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/node@2.0.0`, exercising the 2025-11-25 and 2026-07-28 protocol eras. STDIO stdout contains protocol messages only. Streamable HTTP binds only `127.0.0.1`, validates Host and Origin, and requires a high-entropy Bearer credential. The first release has no `0.0.0.0`, legacy SSE, or OAuth endpoint.
7. **Host claims remain evidence-based.** Codex and TRAE are initial verified acceptance targets. Doubao web/desktop and MarsCode remain candidates marked “待验证” until official MCP-host evidence and a real smoke test exist. Host adapters may differ only in installation templates and smoke scripts.

## Security And Compatibility Consequences

- A request with a forged `profileId` is invalid before business logic. The trusted profile is injected after transport authentication.
- The same `clientRequestId` can exist independently in two profiles; replay/conflict comparison never crosses that boundary.
- Bridge read credentials cannot become an alternate internal API token. Route-isolation tests must run before Task 16 acceptance.
- The core cannot depend on Resources, image blocks, client-specific extensions, or structured-content rendering. Those improve capable hosts without changing the Tool/Text result.
- Codex `.agents/skills` remains the accurate name for its native projection. Updating a canonical Skill revision still does not move either the Codex or local-Agent pin.
- Existing v1 consumers remain valid. Compatibility code may read v1 `codex-harness`, but all new delivery writes use v2 `promptcard-bridge` provenance and profile-scoped idempotency.
- Local HTTP increases the transport test surface. It is accepted only with loopback binding, Host/Origin validation, Bearer authentication, EOF/session cleanup, response budgets, and no service dependency for ordinary PromptCard workflows.

## Alternatives Considered

### Branch Core Behavior By Client Name

Rejected because a client-provided name is forgeable and would create divergent schemas, permissions, and outcomes. Host differences belong in installation templates and acceptance scripts.

### Keep Codex-Only Delivery And Add More Product-Specific Copies

Rejected because separate Codex/TRAE/Doubao delivery ledgers would duplicate authorization and recovery logic while making provenance and idempotency incompatible.

### Reuse The Internal Gateway Token

Rejected because that credential has a broader trust domain than an external local MCP host. A leaked bridge token must not authorize chat, model, or image-generation operations.

### Implement Legacy SSE For TRAE

Rejected because both verified hosts support STDIO or Streamable HTTP, while the v2 SDK keeps SSE in a deprecated legacy package.

## Verification

- v1 fixtures continue to compile and validate unchanged.
- v2 fixtures prove neutral provenance, trusted-context separation, forged-profile rejection, and cross-profile replay isolation.
- Task 16 security tests prove bridge-router access and 401/403 isolation from internal-chat, model-management, and image-generation routes.
- Checkpoint 4 runs STDIO and Streamable HTTP against both protocol eras, plus real Codex and TRAE core-tool smoke tests, stdout-purity, EOF cleanup, pagination, response-budget, path-redaction, and MCP-absent degradation checks.

## References

- [Codex MCP documentation](https://developers.openai.com/codex/mcp)
- [TRAE MCP FAQ](https://forum.trae.cn/t/topic/65)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP 2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [ADR-018: Define The Local Codex MCP Contract Boundary](./ADR-018-local-codex-mcp-contract-boundary.md)
- [Plan 008 execution plan](../superpowers/plans/2026-08-22-plan-008-execution.md)
