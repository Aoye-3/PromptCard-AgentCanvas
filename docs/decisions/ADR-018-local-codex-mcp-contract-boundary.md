# ADR-018: Define The Local Codex MCP Contract Boundary

## Status

Accepted

## Date

2026-08-22

## Context

Plan 008 defines a Local Reference Bridge that must make local PromptCard references available to local Agent, CLI, MCP, and Codex workflows without exposing Storage internals or giving instruction packages authority over policy or mutation. The bridge needs stable public contracts, bounded retrieval, auditable delivery, and a transport boundary that can be operated locally.

This decision extends the provider-neutral boundary in [ADR-008](./ADR-008-provider-neutral-image-generation.md), the Agent/runtime boundary in [ADR-012](./ADR-012-pi-text-agent-and-ark-runtime.md), and the durable conversation and Skill boundary in [ADR-016](./ADR-016-durable-text-agent-conversations-and-bounded-skills.md). It is compatible with the durable conversation model binding in [ADR-017](./ADR-017-session-model-binding-and-anchored-canvas-edits.md). The planned delivery work is recorded in [Plan 008](../superpowers/plans/2026-08-22-plan-008-execution.md).

## Decision

The following eleven architecture decisions are accepted for the Local Reference Bridge:

- Public contracts use typed references with stable public codes. Public codes are never Storage internal primary keys.
- Storage remains the sole authority for persistent identity and state. It owns canonical records and their durable lifecycle.
- Gateway remains the policy and orchestration boundary. It validates requests, applies scope and mutation policy, resolves references, and coordinates Storage and adapters.
- CLI, MCP, local Agent, and Codex are adapters only. They neither become durable authorities nor bypass Gateway policy.
- Every externally initiated operation carries a caller-provided `clientRequestId` for correlation and idempotent request handling at the Gateway boundary.
- Public request and response contracts use JSON Schema 2020-12. Schema validation is part of the boundary rather than an adapter-specific convention.
- Reference discovery is FTS-first. Structured filtering and direct typed-reference resolution complement full-text search; adapters do not implement competing local search indexes.
- CVC has explicit request scope. A caller must identify the CVC scope it is allowed to read or act within; CVC is not inferred from ambient client state.
- Mutations are apply-required. Discovery, retrieval, and proposal creation do not mutate durable state; a separate explicit apply request is required and is governed by Gateway policy.
- Local-Agent Skills and Codex-delivery Skills are separate projections of the same governed reference material. They may share provider-neutral source metadata, but their packaging, selection, and lifecycle are not interchangeable.
- MCP version one is owned and served only through STDIO. Codex delivery records its own ledger and `codex-harness` provenance, distinct from provider-neutral reference provenance.

## Alternatives Considered

### Expose Storage IDs And Let Adapters Query Storage Directly

Rejected because internal primary keys would become a public compatibility contract, while direct adapter access would bypass the durable authority and Gateway policy boundary.

### Let Each Adapter Choose Its Own Request IDs, Schemas, Search, Or CVC Scope

Rejected because correlation, validation, retrieval semantics, and CVC authorization would diverge across CLI, MCP, local Agent, and Codex entrypoints. Gateway-owned `clientRequestId`, JSON Schema 2020-12, FTS-first discovery, and explicit CVC scope keep one auditable contract.

### Permit Retrieval Or Proposal Calls To Apply Changes Implicitly

Rejected because callers could not distinguish inspection from durable mutation. Explicit apply-required requests preserve approval and policy enforcement.

### Publish One Skill Package For Both Local Agent And Codex

Rejected because the two consumers have different delivery and lifecycle boundaries. A shared source may be projected separately without making either package an authority or a permission system.

### Start MCP With HTTP Or Multiple Transports

Rejected because the first local integration needs one clear ownership and operational boundary. STDIO is the only MCP transport in version one; any additional transport requires a later decision.

### Treat Codex Harness Evidence As Provider-Neutral Reference Provenance

Rejected because Codex delivery needs its own ledger and `codex-harness` provenance. Conflating it with provider-neutral provenance would make delivery audit records indistinguishable from reference-source metadata.

## Consequences

- Future implementation work must preserve the Storage/Gateway/adapter separation and cannot use public codes as internal Storage primary keys.
- Adapters can share contracts and governed reference material while remaining unable to expand permissions or apply durable changes implicitly.
- Search and CVC behavior are inspectable at one Gateway boundary, and Codex delivery can be audited independently from provider-neutral reference provenance.
- This ADR records the target contract and delivery boundary only. It does not claim that the Local Reference Bridge, MCP server, Skills projections, ledger, or runtime behavior has been implemented.

## Related Decisions

- [ADR-008: Isolate Image Providers Behind Model Slots And Durable Local Runs](./ADR-008-provider-neutral-image-generation.md)
- [ADR-012: Replace DeerFlow With A Focused pi Text Agent And Extensible Provider Boundary](./ADR-012-pi-text-agent-and-ark-runtime.md)
- [ADR-016: Persist Project Text-Agent Conversations And Inject Bounded Skill Snapshots](./ADR-016-durable-text-agent-conversations-and-bounded-skills.md)
- [ADR-017: Bind Agent Models Per Conversation And Preserve Canvas Source Segments](./ADR-017-session-model-binding-and-anchored-canvas-edits.md)
- [Plan 008: Local Reference Bridge, RAG, Skills, And Codex Delivery](../superpowers/plans/2026-08-22-plan-008-execution.md)
