# PromptCard Local Agent Bridge contract v2

Version 2 layers host-neutral identity and authorization context over the unchanged v1 reference and additive-item schemas.

- A launcher or authenticated transport resolves `profileId` and `scopes`; an MCP tool request cannot submit either value.
- `clientInfo.name` and `clientInfo.version` are optional audit metadata only. Implementations must not use them for authorization, tool schemas, or behavior branches.
- New delivery requests and records use `promptcard-bridge` provenance. The v1 `codex-harness` value remains valid only at the v1 compatibility boundary.
- Replay identity is `(profileId, clientRequestId)`. The same client request ID in two trusted profiles is independent.
- v2 reuses the stable v1 exact-reference and additive-item definitions. Consumers must load `../v1/schema.json` before this schema bundle.

The bridge runtime and transports are implemented in later tasks. This package freezes their trust and delivery contract; it does not expose a network endpoint.
