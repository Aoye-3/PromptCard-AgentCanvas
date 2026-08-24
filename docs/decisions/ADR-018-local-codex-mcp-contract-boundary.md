# ADR-018: Define The Local Codex MCP Contract Boundary

## Status

Accepted — partially superseded by ADR-019

## Date

2026-08-22

## Supersession

[ADR-019](./ADR-019-generic-local-agent-bridge-boundary.md) supersedes only this ADR's Codex-only/STDIO-only MCP scope and new-delivery `codex-harness` provenance. New Gateway, CLI, MCP, retrieval, and delivery work is host-neutral, supports STDIO plus loopback Streamable HTTP, and emits v2 `promptcard-bridge` provenance from a trusted profile context. The v1 contract and `codex-harness` compatibility input remain valid.

The Storage/Gateway/adapter authority split, public reference semantics, explicit project/context scope, canonical Skill packages, Codex `.agents/skills` projection, local-Agent snapshot adapter, FTS-first retrieval direction, and `clientRequestId` idempotency decision remain in force. The implementation-status paragraph in Consequences records the state when this ADR was accepted; current state is tracked by ADR-019 and the Task 15.5 acceptance package.

## Context

Plan 008 defines a Local Reference Bridge that must make local PromptCard references available to local Agent, CLI, MCP, and Codex workflows without exposing Storage internals or giving instruction packages authority over policy or mutation. The bridge needs stable public contracts, bounded retrieval, auditable delivery, and a transport boundary that can be operated locally.

This decision extends the provider-neutral boundary in [ADR-008](./ADR-008-provider-neutral-image-generation.md), the Agent/runtime boundary in [ADR-012](./ADR-012-pi-text-agent-and-ark-runtime.md), and the durable conversation and Skill boundary in [ADR-016](./ADR-016-durable-text-agent-conversations-and-bounded-skills.md). It is compatible with the durable conversation model binding in [ADR-017](./ADR-017-session-model-binding-and-anchored-canvas-edits.md). The planned delivery work is recorded in [Plan 008](../superpowers/plans/2026-08-22-plan-008-execution.md).

## Decision

The following eleven architecture decisions are accepted for the Local Reference Bridge:

1. **One authority, several adapters.** Storage owns durable identity and state. Gateway owns policy and orchestration. CLI, MCP, local Agent, and Codex projections are adapters, not alternate databases.
2. **Public code is not a primary key.** Existing IDs remain internal. Every public reference uses `PREFIX-ULID`, is accepted case-insensitively, persisted uppercase, and dispatched by prefix before lookup.
3. **Namespace separation is semantic.** `PLM` and `CVM` may refer to identical bytes but remain different business identities and permission boundaries.
4. **No ambient MCP project.** Every Canvas search, resolve, context, or delivery operation carries an exact `PRJ` or `CVC` reference. UI focus and MCP connection state are never authority.
5. **MCP is STDIO-only in the first release.** Pin one stable MCP protocol and SDK version. Do not add HTTP transport, OAuth, MCP Apps, Sampling, Tasks, or general filesystem tools.
6. **Schema dialect is JSON Schema 2020-12.** Store a language-neutral package at `contracts/promptcard-bridge/v1/`. Declare one explicit validator for contract tests rather than relying on a transitive package.
7. **Resolve and Resource share one core.** Exact Tool resolution and every `promptcard://` Resource Template call the same Gateway resolver and permission checks.
8. **FTS before vectors.** The first retrieval slice uses SQLite FTS5/BM25, revision/digest freshness checks, fixed result and evidence budgets, citations, and audit records. Semantic retrieval is a later optional slice requiring explicit provider consent and measured value.
9. **Skill projections are rebuildable.** Storage holds canonical immutable packages and host pins. `.agents/skills` and local-Agent snapshots are derived projections and never become the authority.
10. **Codex delivery has its own ledger.** It reuses asset validation and save-before-placed behavior, but does not reuse provider generation-run identity or provenance; its delivery provenance is `codex-harness` rather than provider-neutral reference provenance.
11. **Canonical idempotency name is `clientRequestId`.** The earlier `deliveryId` example is illustrative only. Every additive Tool and Gateway contract uses `clientRequestId` together with a normalized request digest.

For the first release, delivery defaults to apply-required: discovery, retrieval, and proposal creation do not mutate durable state, and an explicit apply request remains governed by Gateway policy. This is not one of the eleven frozen decisions; Checkpoint 5 still confirms apply-required versus trusted-profile auto-place.

## Alternatives Considered

### Expose Storage IDs And Let Adapters Query Storage Directly

Rejected because internal primary keys would become a public compatibility contract, while direct adapter access would bypass the durable authority and Gateway policy boundary.

### Treat Public Codes As Unnormalized IDs Or Skip Prefix Dispatch

Rejected because case-sensitive, untyped, or post-lookup interpretation would make public references ambiguous and couple callers to Storage internals. Canonical uppercase `PREFIX-ULID` codes and prefix dispatch preserve namespace-safe resolution.

### Merge PLM And CVM When Their Bytes Match

Rejected because byte identity does not establish a shared business identity or permission boundary. Prompt-media and Canvas-media references must remain independently scoped and auditable.

### Infer Project Or CVC From UI Focus Or MCP Connection State

Rejected because ambient state is mutable, non-portable, and cannot establish caller authority. Exact `PRJ` or `CVC` references keep every Canvas request explicitly scoped.

### Start MCP With HTTP, OAuth, Or Broad Optional Features

Rejected because the first local integration needs one clear ownership and operational boundary. The pinned STDIO protocol/SDK path excludes HTTP, OAuth, Apps, Sampling, Tasks, and general filesystem tools; any addition requires a later decision.

### Let Each Adapter Define Its Own Schema Or Validator

Rejected because contract behavior would drift between languages and adapters. The versioned JSON Schema 2020-12 package and explicitly declared validator provide one testable boundary.

### Use Separate Tool And Resource Resolvers Or Permission Paths

Rejected because exact resolution could yield different lifecycle, scope, or redaction results depending on whether it is reached through a Tool or a `promptcard://` Resource Template. Both must use the same Gateway resolver and permission checks.

### Start With Vector Retrieval Or Allow Unbounded Search Evidence

Rejected because semantic retrieval adds provider and evaluation dependencies before lexical relevance is measured, while unbounded results cannot provide predictable context or audit. FTS5/BM25 with freshness checks, budgets, citations, and audit is the initial boundary.

### Make Host Projections The Skill Authority

Rejected because independently mutable `.agents/skills` or local-Agent snapshots could drift from canonical packages and host pins. Projections must be rebuildable from immutable Storage records.

### Reuse Provider Generation Runs For Codex Delivery

Rejected because Codex delivery is not a provider generation run. A separate ledger and `codex-harness` provenance preserve its own idempotency, audit, and recovery record.

### Keep DeliveryId Or Accept Same Idempotency Keys With Different Requests

Rejected because multiple canonical names and unhashed parameter comparison make replay and conflict behavior ambiguous. `clientRequestId` plus a normalized request digest distinguishes replay from conflict.

### Finalize Apply-Required Before Checkpoint 5

Rejected because Plan 008 leaves the final choice between apply-required and trusted-profile auto-place to Checkpoint 5. Apply-required is the initial default, not an accepted decision that closes that checkpoint.

## Consequences

- Future implementation work must preserve the Storage/Gateway/adapter separation, canonical reference-code rules, semantic PLM/CVM separation, and explicit `PRJ`/`CVC` scope.
- Tools and `promptcard://` Resources must produce policy-equivalent exact resolution through one Gateway core; the first MCP surface remains limited to the pinned STDIO boundary.
- Search begins with bounded, fresh, cited, audited FTS5/BM25 evidence; vector retrieval cannot be added without provider consent and measured value.
- Canonical immutable Skill packages and independent host pins remain authoritative; local-Agent and Codex projections must be reproducible from them.
- Codex delivery remains separately idempotent and auditable through `clientRequestId`, normalized request digests, its own ledger, and `codex-harness` provenance.
- The initial apply-required delivery default remains subject to the Checkpoint 5 trusted-profile auto-place decision.
- The public-reference registry, immutable Canvas context packs, canonical Skill packages, independent local-Agent/Codex host pins, Codex projection recovery/health, and bounded Gateway local-Agent snapshot validation are implemented through Storage schema v14. Task 15's Skill Hub management UI, the broader Local Reference Bridge/MCP read surface, and the Codex delivery ledger/runtime remain later work.

## Related Decisions

- [ADR-008: Isolate Image Providers Behind Model Slots And Durable Local Runs](./ADR-008-provider-neutral-image-generation.md)
- [ADR-012: Replace DeerFlow With A Focused pi Text Agent And Extensible Provider Boundary](./ADR-012-pi-text-agent-and-ark-runtime.md)
- [ADR-016: Persist Project Text-Agent Conversations And Inject Bounded Skill Snapshots](./ADR-016-durable-text-agent-conversations-and-bounded-skills.md)
- [ADR-017: Bind Agent Models Per Conversation And Preserve Canvas Source Segments](./ADR-017-session-model-binding-and-anchored-canvas-edits.md)
- [Plan 008: Local Reference Bridge, RAG, Skills, And Codex Delivery](../superpowers/plans/2026-08-22-plan-008-execution.md)
