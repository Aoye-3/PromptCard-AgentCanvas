# Plan 008: Local MCP, Prompt Library RAG, and Codex Bridge

## Status

Completed. Tasks 15.6-15.10 are the accepted automated regression baseline. Checkpoint 3.5 manual probes were merged into and satisfied by the final real-Codex closed-loop gate. Tasks 16-28 and the repository-wide release matrix completed on `feat/skill-document-storyboard-loop`: Codex passed first-contact discovery, the complete Document/Storyboard create/change → Prompt create → generated-image review chain, four-kind replay, digest conflict, process restart recovery, the adversarial boundary matrix, optional Bridge packaging/diagnostics, and all build/regression/browser/security/documentation gates. The feature was merged to `main` by `7b64cf8`, and the final documentation handoff was merged by `d09a0ab` on 2026-09-01.

The unchecked boxes retained in the original design body below are historical planning criteria, not active work or the completion source of truth. Final implementation and verification status lives in the [execution ledger](../superpowers/plans/2026-08-22-plan-008-execution.md) and [release matrix](../reviews/2026-09-01-plan-008-final-release-matrix.md).

## Current Normative Boundary

This plan began with Codex-specific product language. That historical design remains useful for reference identities, retrieval, and delivery flows, but it is no longer normative where it makes MCP, Gateway, CLI, retrieval, or delivery Codex-only.

[ADR-019](../decisions/ADR-019-generic-local-agent-bridge-boundary.md) and the [Plan 008 execution ledger](../superpowers/plans/2026-08-22-plan-008-execution.md) define the current `PromptCard Local Agent Bridge`: a host-neutral core with trusted profiles/scopes, v2 `promptcard-bridge` provenance, and STDIO plus loopback Streamable HTTP. Codex is the first verified real host. TRAE is a configuration/contract candidate only; Doubao and MarsCode remain “待验证”. Codex `.agents/skills` and the local-Agent snapshot remain accurately named concrete Host Adapters.

Task 15, Task 15.5, and Tasks 15.6-15.10 are implemented and technically accepted; see the [Task 15.5 acceptance package](../reviews/2026-08-24-task-15-5-technical-acceptance.md) and [Checkpoint 3.5 acceptance package](../reviews/2026-08-27-task-15-10-technical-acceptance.md). On 2026-08-30 the user folded the remaining manual probes into final real-Codex acceptance and authorized Task 16. Bridge v3 and ADR-023 now freeze the typed Document/Storyboard/Prompt/image writeback boundary; runtime implementation follows the execution ledger.

## Date

2026-08-02

## Timezone

Europe/London

## Product Decision

Codex is an external creative workbench for PromptCard, not an embedded chat surface inside PMAgent-Canvas.

The user talks to Codex in the Codex desktop app, CLI, or IDE extension. PromptCard exposes two precise, local, permission-scoped content indexes through a repository-owned STDIO MCP server: a Prompt Library index and a project-scoped Canvas index. The Prompt Library index is also upgraded into a bounded RAG retrieval core for the local text Agent. MCP/Codex and the local Agent reuse canonical retrieval records and ranking primitives through separate host adapters; the local Agent does not connect through MCP, and neither host inherits the other's permissions. A separate Skill Hub manages reusable Agent Skill packages and publishes approved, pinned revisions to Codex and the local Agent through host-specific adapters. Codex may return additive Prompt nodes and generated image assets through the same local boundary. PMAgent-Canvas remains the authority for projects, revisions, assets, Canvas placement, Skill packages, and approval-sensitive writes.

This plan does not replace the existing pi text Agent or the provider-neutral image-generation runtime.

## Problem Statement

PromptCard's core value is not a generic chat panel. It is the durable combination of:

- reusable Prompt content;
- ordered Prompt media;
- project and Canvas context;
- reusable task instructions packaged as Skills;
- generated results and their provenance.

Codex can only use that value reliably when the user can name the exact Prompt Library item, media item, or Canvas selection intended for a task. Titles, search terms, database row order, and the currently focused UI state are too ambiguous for this boundary.

The product needs four complementary interaction paths:

1. **Project scope:** the user copies a stable project code so Codex knows which Canvas index may be searched.
2. **Library or Canvas reference:** the user copies a stable code from a Prompt Library item, Prompt Library media, Canvas text node, or Canvas media node and includes it in a Codex request.
3. **Canvas context pack:** the user explicitly selects Canvas nodes in PMAgent-Canvas, chooses **Copy Codex context**, and receives a stable code representing exactly that selection and revision.
4. **Skill selection:** the user imports and reviews a Skill in the global **Skill Hub**, then independently enables a pinned revision for Codex, the local Agent, or both.

Example:

```text
In project PRJ-01K3Z6B4H8N2Q7R5T9V1X3Y6AC,
use PLP-01K3Z7M7V6Q8Y3A9T2D5F4H1JN as the Prompt Library bundle,
use CVM-01K3Z83C5F8H2K6N9Q1T4V7XAM as the Canvas reference image,
and use CVC-01K3Z85W2P4K6N9R1T7V3X5Y8A as the return context.
Generate a 16:9 image and deliver the result back to that context.
```

## Primary Interaction Chain

The primary product chain is bidirectional:

```text
Codex request
  -> identify project scope
  -> resolve explicit typed codes
  -> separately search Prompt Library and Canvas for unresolved intent
  -> present or confirm ambiguous candidates
  -> load the selected Prompt/media context
  -> generate a Prompt or image in Codex
  -> deliver an additive result to the target Canvas
  -> PromptCard persists, places, and records provenance
```

### Exact reference path

When the user's instruction contains codes, Codex parses and resolves them by namespace. Exact codes take priority over labels, recency, search ranking, and current UI focus.

For example:

```text
Use PLP-... and CVM-... to generate a new image, then place it after CVC-....
```

Codex resolves the Prompt Library bundle through the Prompt Library boundary, resolves the Canvas media through the Canvas boundary, and uses the Canvas context pack only as the delivery target. It does not merge these records into one generic “media” identity.

### Natural-language reverse-index path

When the user provides a project code plus natural-language intent but no exact item codes, Codex may search for candidates:

1. Resolve the `PRJ` code and obtain the allowed project scope.
2. Search the project Canvas index for text and media candidates.
3. Search the Prompt Library index independently for Prompt and media candidates.
4. Preserve the source namespace on every result.
5. If one candidate is decisively identified, resolve its exact code before execution.
6. If multiple plausible candidates remain, ask the user to choose by code instead of guessing.

Natural-language search is a discovery aid, not an exact target contract. Every generation or delivery request is compiled into an explicit context manifest containing typed codes before execution.

### Return-to-Canvas path

- A generated Prompt is delivered as an additive Canvas text-node proposal and receives a new `CVT` code after persistence.
- A generated image is imported as a new Canvas media entity and receives a new `CVM` code after persistence.
- The delivery target is a `CVC` context pack or another explicit Canvas placement target within the resolved `PRJ` project.
- Existing nodes are never overwritten through this first-release chain.

## Success Criteria

- A copied project code resolves to exactly one local project scope.
- A copied Prompt Library code resolves to exactly one active or recoverable Prompt Library record.
- Resolving a Prompt returns its Prompt text, classification metadata, revision, and ordered media references.
- A copied Prompt Library media code resolves only through the Prompt Library boundary.
- A copied Canvas media code resolves only through the named project Canvas boundary.
- The same underlying Storage asset may have distinct Prompt Library and Canvas codes; neither code aliases the other.
- A Canvas context code resolves to an immutable snapshot of the user-selected nodes, their Prompt/media references, project revision, and placement target.
- Codex can create an additive Prompt node proposal or deliver a generated image against a context code without reading or rewriting the complete project JSON.
- Repeated MCP calls with the same client request ID are idempotent.
- Every imported Skill receives an immutable `SKL` identity, revision, content digest, source record, and trust state.
- The left sidebar exposes one global **Skill Hub** for importing, reviewing, versioning, enabling, disabling, and archiving Skills.
- Codex and the local Agent resolve the same canonical Skill revision, while enablement and execution permissions remain independent for each host.
- Importing or reading a Skill never executes its scripts, hooks, or declared tool dependencies.
- Prompt Library discovery uses bounded, cited retrieval evidence instead of sending a browser-selected or full-library snapshot to the local Agent or Codex.
- Exact `PLP`/`PLM` codes resolve before ranked retrieval; RAG discovery never substitutes for an exact write or delivery target.
- The local Agent receives Prompt evidence only in explicit Prompt Library RAG mode. Canvas `complete`, `rewrite`, ordinary discussion, and media analysis remain isolated from library retrieval.
- PromptCard continues to start and manage local data when Codex or the MCP server is unavailable.
- The integration does not require an OpenAI or image-provider API key to be stored in PromptCard. Codex-hosted generation still depends on the user's Codex environment and entitlements.

## Current Baseline

Prompt Library records already have internal `id` and `revision` fields. Attached media is stored in `meta.media` and points to Storage assets through `assetId`. Canvas image nodes may point to those or other assets through Canvas-owned node metadata. These identities are suitable for internal joins but are not designed as user-facing, portable references. A shared `assetId` is a byte-storage relationship, not permission to collapse Prompt Library and Canvas identities.

The maintained runtime also has important boundaries that this plan preserves:

- frontend code owns Canvas interaction and Apply/Reject behavior;
- PromptCard Storage owns projects, revisions, Prompt records, assets, Skill packages, and generation history;
- the Python Gateway owns the trusted browser/runtime boundary;
- the pi text Agent has no direct filesystem, Storage, or Canvas write access;
- current provider image generation is independent from text-Agent sessions.

The current left navigation includes the complete Task 15 Skill Hub management surface. PromptCard Storage schema v19 owns canonical Skill packages, immutable revisions and digests, provenance, lifecycle, exact-revision trust reviews, independent host pins, typed creative references, transactional Prompt retrieval/audit records, and the profile-scoped Bridge delivery ledger. Skill Hub supports inert folder/archive inspection, structured findings, import, history/diff, archive/restore, exact review, Codex/local-Agent controls, projection health, and explicit owned-drift repair. The Gateway continues to supply exact bounded snapshots to the local text Agent without expanding Runtime permissions.

Codex `.agents/skills` is a derived native projection, not the canonical store. Canonical revision updates do not move either host pin. Skill scripts, hooks, installers, automatic semantic matching, and MCP Skill resources remain unimplemented. Task 16's host-neutral read surface resolves Codex pins only through a trusted profile repository scope; Task 18 Prompt search remains discovery-only and requires an explicit `CVC-*`.

The Canvas Agent `prompt-library` mode and dedicated Prompt Library assistant now send only a bounded query/filter/exact-code request. Gateway loads revision-pinned evidence from Storage schema v18, caps the injected body, records digest-only retrieval audit metadata, and returns resolvable citations plus an explicit degraded state. Ordinary Canvas editing, discussion, media analysis, and `chat-experimental` receive neither the retriever nor Prompt evidence. The pi Runtime still exposes its model-facing `search_prompt_library` tool, but that tool searches only Gateway-supplied evidence and has no Storage authority.

Agent-delivered images must not be represented as successful Seedream or other provider generation runs. New delivery records use v2 `promptcard-bridge` provenance and a profile-scoped ledger; v1 `codex-harness` remains compatibility-only. Delivery uses a separate additive asset path.

## Shared Prompt Library Retrieval and Local-Agent RAG

### Shared core, separate host adapters

Gateway and Storage own one canonical Prompt retrieval core. It serves two explicit product paths:

- the local text Agent's **Prompt Library RAG** mode, which grounds a persistent conversation with a small Prompt evidence set; and
- the read-only local MCP search/resolve surface, which helps Codex discover typed Prompt and media references before generation or delivery.

The shared core covers normalized retrieval documents, index lifecycle, exact-code resolution, lexical and optional semantic candidate generation, deterministic ranking, evidence budgets, and provenance. The Agent Runtime adapter and MCP adapter have different request/response schemas, permission scopes, audit records, and available tools. Sharing retrieval infrastructure does not route Agent traffic through MCP or grant Codex access to Agent conversations.

### User experience

- Rename the Canvas Agent's manual/snapshot-style Prompt Library mode to **Prompt 库 RAG** when the new backend is active.
- The user asks naturally in the persistent project conversation and may provide type/category filters or exact Prompt codes.
- Exact codes resolve directly. Natural-language requests run bounded discovery.
- The Agent answer identifies the Prompt records and associated media it used; every citation opens the current library record.
- A visible degraded state explains when semantic retrieval is unavailable and lexical retrieval was used instead.
- RAG mode remains read-only for Canvas and cannot produce a completion or rewrite proposal.

### Retrieval contract

The frontend sends only the user query, conversation identity, explicit filters, and typed references; it never sends the full Prompt Library. Gateway then:

1. Builds a bounded query from the current message and only the recent conversation text needed to resolve references.
2. Resolves exact `PLP`/`PLM` codes before ranked retrieval.
3. Produces lexical candidates with SQLite FTS5/BM25 over active Prompt label, body, category, type, tags, and safe media captions.
4. If the user has explicitly configured an approved embedding backend, produces semantic candidates from a versioned index.
5. Fuses and ranks candidates deterministically, then returns at most eight Prompt bundles within a fixed character/token budget.
6. Re-resolves selected records by identity and revision before model invocation so stale, trashed, or unbound records are not injected.
7. Persists retrieval audit metadata with the Agent turn or MCP operation, not a duplicate of the whole library.

Each evidence bundle contains a stable Prompt identity/code, revision, digest, bounded content, matched fields, score components, retrieval reason, and safe associated-media metadata. It never contains media bytes, local paths, credentials, raw vectors, or unrestricted metadata.

The contract distinguishes `lexical`, `semantic`, `hybrid`, and `degraded_lexical` execution. Semantic failure falls back to bounded lexical retrieval with a visible reason; it never silently expands result count or uploads content elsewhere.

### Index lifecycle and privacy

- Prompt create/update/archive/restore updates the lexical index transactionally with the authoritative Prompt revision.
- Trash is excluded from ordinary retrieval.
- Semantic rows record Prompt revision, content digest, embedding model identity, dimensions, and index version.
- A changed or removed Prompt becomes ineligible before stale evidence can reach either host.
- Index rebuild exposes status and diagnostics and does not modify Prompt revisions.
- Prompt Library and Canvas indexes remain separate even when they refer to the same underlying asset.
- No embedding provider receives Prompt content unless the user explicitly configures and enables that provider for indexing.

### Agent permission and audit contract

- Replace the request-array `search_prompt_library` tool with a policy-locked `retrieve_prompt_library` operation or equivalent Gateway-preloaded evidence contract.
- The model may provide a query and allowed filters, but cannot choose Storage paths, arbitrary limits, Trash scope, or permissions.
- Only explicit Prompt Library RAG mode and the dedicated Prompt Library assistant receive this capability.
- Canvas `complete` and `rewrite`, ordinary discussion, and media analysis receive no Prompt retriever.
- Retrieved evidence cannot emit `free_canvas_text_insertions` or `free_canvas_text_create`.
- Skills may teach query construction and evidence use but cannot increase budgets, add tools, or bypass citations and approval.

The persistent Agent turn records the normalized query digest, retrieval mode, retriever/index version, candidate identities/revisions/scores, selected evidence identities, degradation reason, and actual model/Skill snapshots. Prompt bodies remain authoritative in Storage and are not copied wholesale into conversation rows. MCP audit uses its own operation identity and permission scope rather than an Agent conversation ID.

## Stable Reference Model

### Internal identity versus public reference

Existing `id` fields remain primary keys. Each externally referencable entity gains a separate immutable `referenceCode`. The code prefix identifies both entity type and permission boundary:

| Prefix | Entity | Example |
| --- | --- | --- |
| `PRJ` | Project scope and Canvas index boundary | `PRJ-01K3Z6B4H8N2Q7R5T9V1X3Y6AC` |
| `PLP` | Prompt Library Prompt bundle | `PLP-01K3Z7M7V6Q8Y3A9T2D5F4H1JN` |
| `PLM` | Prompt Library-owned media reference | `PLM-01K3Z7Q1C8M4P6R2V9X5Y3A7BN` |
| `CVT` | Project Canvas text/Prompt node | `CVT-01K3Z82A6D9F1H4K7M2Q5R8VBN` |
| `CVM` | Project Canvas-owned media node/reference | `CVM-01K3Z83C5F8H2K6N9Q1T4V7XAM` |
| `CVC` | Immutable Canvas context pack | `CVC-01K3Z85W2P4K6N9R1T7V3X5Y8A` |
| `SKL` | Skill Hub package identity | `SKL-01K3Z8C4M7Q2V5X9A1D6F8H0JN` |

Reference codes use a type prefix and a 26-character Crockford Base32 ULID:

```text
^(PRJ|PLP|PLM|CVT|CVM|CVC|SKL)-[0-9A-HJKMNP-TV-Z]{26}$
```

Input is accepted case-insensitively and normalized to uppercase for display and persistence.

Reference rules:

- codes are generated once, persisted, and never reused;
- renaming, recategorizing, or reordering a Prompt does not change its code;
- deleting and restoring an item preserves its code;
- duplicating an item creates new codes for the duplicate and its independently owned media bindings;
- export, backup, and restore preserve codes;
- import detects code collisions and fails closed unless the imported record is demonstrably the same identity;
- existing records receive codes in a one-time idempotent migration;
- internal IDs, asset paths, SQLite row order, and mutable labels are never accepted as substitutes for public codes at the MCP boundary;
- Prompt Library and Canvas codes use separate indexes, resolvers, permission checks, and lifecycle rules;
- a `PLM` code identifies one ordered media binding owned by one `PLP` record, not the underlying Storage asset; reusing the same bytes in another Prompt Library record creates another `PLM` code;
- a `CVM` code identifies one media node/reference owned by one project Canvas; duplicating a Canvas placement creates another `CVM` code even when both nodes share asset bytes;
- placing a `PLM` item onto a Canvas creates a new `CVM` identity with `derivedFrom: PLM-...`; it does not reuse the `PLM` code;
- saving a Canvas media item into Prompt Library creates a new `PLM` identity with `derivedFrom: CVM-...`; it does not reuse the `CVM` code;
- two codes may reference the same underlying asset bytes while remaining distinct business entities;
- a `SKL` code belongs only to the Skill Hub namespace and never aliases a Prompt Library, Canvas, project, or media code;
- updating a Skill creates an immutable revision under the same `SKL` identity; each host resolves an explicitly pinned revision rather than mutable files by name.

### Separate reverse indexes

Prompt Library and Canvas maintain different reverse indexes because they answer different questions.

**Prompt Library index**

- Scope: the user's local Prompt Library profile.
- Entities: `PLP` Prompt bundles and their owned `PLM` media bindings.
- Searchable fields: label, Prompt content, type, category, tags, usage metadata, media title, media kind, media annotation, and safe filename metadata.
- Meaning: reusable knowledge and reference material independent from any current Canvas placement.

**Canvas index**

- Scope: exactly one resolved `PRJ` project.
- Entities: `CVT` text/Prompt nodes and `CVM` media nodes/references.
- Searchable fields: bounded visible text, node kind, user label, Canvas-specific tags, source/provenance, generation metadata, media annotations, and explicitly indexed spatial relationships.
- Meaning: the current project's working state, placement, and task context.

The underlying asset table is not a third user-facing search index. It stores bytes and lifecycle metadata for other business entities.

Both search APIs return typed results such as:

```json
{
  "namespace": "canvas",
  "projectCode": "PRJ-01K3Z6B4H8N2Q7R5T9V1X3Y6AC",
  "referenceCode": "CVM-01K3Z83C5F8H2K6N9Q1T4V7XAM",
  "revision": 3,
  "score": 0.94,
  "matchedFields": ["label", "annotation"],
  "summary": "雨夜街道参考图"
}
```

The first implementation should prefer deterministic metadata filtering and local full-text search. Semantic/vector retrieval is optional later and may improve candidate discovery, but it never changes exact code resolution or authorizes a write target. Search results from different namespaces are not deduplicated by `assetId` and are never silently promoted from one boundary to another.

### Prompt bundle resolution

Resolving a `PLP` code returns a bounded object:

```json
{
  "referenceCode": "PLP-01K3Z7M7V6Q8Y3A9T2D5F4H1JN",
  "revision": 4,
  "label": "雨夜霓虹街道",
  "type": "scene",
  "category": "城市",
  "content": "...",
  "media": [
    {
      "referenceCode": "PLM-01K3Z7Q1C8M4P6R2V9X5Y3A7BN",
      "kind": "image",
      "title": "street-reference.png",
      "contentType": "image/png",
      "order": 0,
      "resourceUri": "promptcard://library-media/PLM-01K3Z7Q1C8M4P6R2V9X5Y3A7BN"
    }
  ]
}
```

The ordinary code resolves the latest active revision. Context packs pin the exact revision used when the pack was created. A future explicit revision syntax may be added only if real workflows require it.

### Prompt Library media resolution

Resolving a `PLM` code returns safe Prompt Library metadata plus an MCP resource URI. It never returns Canvas placement or node state, even when the underlying bytes are also visible on a Canvas.

The MCP adapter may read media bytes from the trusted local Storage API and provide image content to Codex subject to size, MIME, lifecycle, and permission checks. Missing or trashed media is reported explicitly instead of silently substituting another asset.

### Canvas text and media resolution

Resolving `CVT` or `CVM` requires an allowed `PRJ` project scope. Canvas resolution returns project/node revision, bounded node content, Canvas-specific provenance, and safe media resources. It never returns or mutates a Prompt Library record merely because the Canvas node originated there.

Canvas search and Prompt Library search remain different MCP tools. Their results may be combined by Codex only in an explicit context manifest that preserves every source code and boundary.

## Canvas Context Packs

A Canvas context pack is the answer to “which Canvas content should Codex use and where should the result return?” It is created by an explicit PMAgent-Canvas action, not inferred from whichever window happens to be focused when Codex calls a tool.

### Creation UX

- With one or more supported Canvas nodes selected, show **Copy Codex context**.
- The action creates an immutable context pack and copies its `CVC` code.
- With no selection, the action is disabled. A separate explicit **Copy whole Canvas context** action may be considered later.
- The UI shows which nodes, Prompt references, and media references are included before copying.
- The context pack can be revoked from PromptCard.

### Snapshot contents

```json
{
  "referenceCode": "CVC-01K3Z85W2P4K6N9R1T7V3X5Y8A",
  "projectCode": "PRJ-01K3Z6B4H8N2Q7R5T9V1X3Y6AC",
  "projectRevision": 12,
  "createdAt": 1785686400000,
  "nodes": [
    {
      "nodeCode": "CVT-01K3Z82A6D9F1H4K7M2Q5R8VBN",
      "kind": "text",
      "text": "...",
      "promptLibraryReferences": ["PLP-01K3Z7M7V6Q8Y3A9T2D5F4H1JN"],
      "canvasMediaReferences": ["CVM-01K3Z83C5F8H2K6N9Q1T4V7XAM"]
    }
  ],
  "placementHint": {
    "mode": "after-selection",
    "anchorNodeCodes": ["CVT-01K3Z82A6D9F1H4K7M2Q5R8VBN"]
  }
}
```

The snapshot stores bounded text and references, not duplicated media bytes. Resolution rechecks asset lifecycle and reports unavailable resources. Packs are local-only and must not expose absolute paths.

The first release keeps packs until explicitly revoked so a Codex task remains reproducible across sessions. Retention limits may be added after measuring actual usage.

## Skill Hub

Skill Hub is a global library for importing and managing Agent Skills. It is a first-class item in the main left sidebar, adjacent to Prompt Library and Agent Panel, and is available outside any individual project. It is not a Codex chat surface and it does not replace the Agent Panel: Skill Hub owns packages and host availability, while Agent Panel continues to show runtime status, assignments, and proposals.

The UI label is **Skill Hub**. `SkillHub` may be used as an internal component name, but persisted schemas and user-facing documentation use `skill` and `skillHub` consistently.

### Independent identity and package model

Skill Hub is a third business boundary alongside Prompt Library and Canvas. It has its own `SKL` namespace, resolver, storage tables, permissions, lifecycle, and search index. Skill assets do not receive `PLM` or `CVM` codes merely because a package contains examples or templates.

Each Skill has one stable `SKL` code and one or more immutable revisions. A revision records:

- required `SKILL.md` content and parsed name/description metadata;
- optional `scripts/`, `references/`, `assets/`, and `agents/openai.yaml` package entries;
- semantic version when declared, PromptCard revision number, and canonical content digest;
- original import source, import time, source digest, and review/trust state;
- declared tool, network, executable, model, or other runtime requirements;
- independent Codex and local-Agent publication state.

The canonical package is stored once under PromptCard Storage. Codex and the local Agent receive generated projections or bounded snapshots from a pinned revision; they do not maintain unrelated editable copies. If a published projection is changed outside Skill Hub, drift detection marks it unhealthy and requires republishing instead of silently treating it as a new canonical revision.

### Left-sidebar experience

Selecting **Skill Hub** opens a global management screen with:

- import from a local Skill folder or archive;
- search and filters for source, trust state, enabled host, update state, and declared capabilities;
- package detail and safe preview of `SKILL.md`, references, assets, scripts, metadata, and validation findings;
- revision history, content digest, source provenance, dependency declarations, and per-host publication status;
- **Copy code** for the stable `SKL` identity, with the pinned revision and digest shown alongside it;
- independent **Publish to Codex** / **Unpublish from Codex** and **Enable for local Agent** / **Disable for local Agent** controls;
- archive and safe deletion actions.

The list must distinguish at least `imported`, `review_required`, `ready`, `published`, `disabled`, `drifted`, `invalid`, and `archived`. Enabling one host never enables the other. Deleting a Skill revision that is pinned by an active Agent run, context manifest, or audit record fails closed; archiving remains available.

### Import and validation chain

```text
Skill Hub
  -> choose folder or archive
  -> inspect without executing package content
  -> validate structure, metadata, limits, and declared capabilities
  -> show review findings and requested host access
  -> import canonical immutable revision
  -> assign or preserve SKL identity
  -> independently publish to Codex and/or enable for local Agent
  -> record host, revision, and digest for every resolution
```

Import is data ingestion, never installation or execution. The importer:

- requires exactly one package root with `SKILL.md`;
- rejects path traversal, unsafe links, duplicate normalized paths, oversized archives, excessive file counts, and unsupported entry types;
- validates frontmatter and normalizes searchable metadata without rewriting the source instructions;
- computes the digest from canonical relative paths and bytes;
- never runs scripts, hooks, package managers, or dependency installers;
- never copies credentials, keyring material, absolute paths, or environment values into the Skill record;
- treats every new or changed revision as untrusted until its validation and review requirements are satisfied.

An update to the same logical Skill creates a new immutable revision. The user previews the diff and chooses whether each host moves from its current pinned revision. Importing a package with an existing `SKL` code but a mismatched identity or provenance fails closed instead of overwriting it.

### Codex publication adapter

Codex consumes Skills through its native Skill discovery mechanism. In the first release, **Publish to Codex** creates a generated repository-scoped projection under the PromptCard workspace's `.agents/skills/<publication-name>` directory from the selected canonical revision, including compatible optional package directories. The projection manifest records `SKL`, revision, digest, and PromptCard source so it can be reconciled or removed safely. Profile-wide publication is deferred until PromptCard can request and display that broader filesystem scope explicitly.

MCP may expose Skill search, metadata, and exact resolution, but MCP tool descriptions are not a substitute for native Codex Skill publication. The first release does not edit unrelated global Codex configuration or overwrite a user-owned Skill with the same target name. A collision is shown in Skill Hub and requires the user to choose a different publication name or explicitly replace a projection already owned by PromptCard.

Codex publication means that Codex may read the Skill instructions and compatible bundled resources. It does not grant PromptCard permissions, MCP scopes, credentials, network access, shell access, or permission to write to Canvas. Those remain enforced independently by the Codex host and PromptCard Gateway.

### Local-Agent adapter

The local pi Agent reads a bounded Skill snapshot from the Gateway for each run. The snapshot contains the selected `SKL` code, pinned revision, digest, instructions, allowed reference content, and capability declarations. The runtime catalog may advertise enabled Skill metadata, but the first release loads full content only for an explicitly selected Skill.

The first release supports instruction and reference consumption only:

- package scripts are never executed by the local Agent;
- bundled assets are exposed only through bounded, typed resources;
- declared tool dependencies must map to tools already allowed by the run's `permissionScope`;
- Skill text cannot expand proposal types, filesystem access, Storage access, network access, or Canvas write permissions;
- system policy, Gateway validation, and proposal approval always outrank Skill instructions.

Automatic Skill matching may be added after explicit selection is reliable. It must return compact candidates and then pin the selected revision before the run starts. A running session never switches revisions because a Skill was updated in the background.

### Shared source, separate host policy

Codex and the local Agent share package identity and revision content, but not trust decisions or runtime capabilities:

| Concern | Codex | Local Agent |
| --- | --- | --- |
| Package source | Canonical `SKL` revision | Canonical `SKL` revision |
| Availability | Explicit native projection | Gateway-provided run snapshot |
| Enablement | Independent publish/unpublish state | Independent enable/disable state |
| Script execution | Controlled by Codex host policy; never granted by import | Disabled in the first release |
| PromptCard access | MCP scopes and exact references | Existing Gateway tools and `permissionScope` |
| Revision changes | Explicit republish | Explicit host pin update |

The audit trail records which host resolved which `SKL` revision and digest, without storing model secrets or unbounded conversation content.

## Local Agent Creative Document Loop (Implemented regression baseline)

Checkpoint 3.5 added a project-local creative planning loop for the existing text Agent. Its automated tests are the regression baseline, while its remaining manual probes are part of final real-Codex acceptance. The detailed design is frozen by [ADR-020](../decisions/ADR-020-separate-planning-documents-from-prompt-execution.md), [ADR-021](../decisions/ADR-021-project-document-resources-and-ephemeral-provider-files.md), and the [implementation plan](../superpowers/plans/2026-08-27-skill-conversation-document-storyboard.md).

The loop introduces a top-level **对话模式【测试中】** that can keep explicitly selected local-Agent Skills bound across turns, accept project-scoped TXT/Markdown/PDF/DOCX attachments, and directly create or revise a long-form Document working draft. Document is a separate Canvas node and storage domain: it does not reuse Prompt segments and never enters Prompt Library, Prompt RAG, Prompt compilation, image-generation inputs, or ambient full-body workspace context.

Document changes use inline suggestion review while their proposed state is the effective working draft. The user must explicitly invoke `Document -> Storyboard`; later Storyboard changes use per-field differences. Moving selected Document text or a Storyboard shot into Prompt content is another explicit action that creates a pending `free_canvas_text_create` proposal for one new all-`user` Prompt Canvas node; it cannot update an existing Prompt or read/write Prompt Library.

This project-local loop does not use MCP, Bridge credentials/profiles, or the Bridge delivery ledger. Skills remain inert bounded instruction/reference packages; each turn revalidates the current local-Agent pin, trust, lifecycle, exact revision/digest, and tool dependencies. The user authorized Task 16 on 2026-08-30 and merged Checkpoint 3.5 manual acceptance into the final external-Agent closed-loop gate.

## MCP Boundary

### Transport and ownership

- Use a repository-owned STDIO MCP server launched by Codex.
- Do not expose a new public or fixed network port.
- The MCP server is an adapter over PromptCard Gateway and Storage APIs, not an independent database writer.
- Ship one versioned manifest and JSON Schema set shared by the CLI, MCP adapter, and Gateway contracts.
- Provide a repository-local CLI using the same contracts for diagnostics, tests, and hosts without MCP support.
- Browser code never connects directly to MCP.

### Read tools

| Tool | Purpose |
| --- | --- |
| `promptcard_runtime_describe` | Discover the local runtime instance, schema version, supported capabilities, and offline state. |
| `promptcard_project_resolve` | Resolve one exact `PRJ` code and establish the allowed Canvas scope. |
| `promptcard_library_search` | Search Prompt Library only; return compact `PLP` and `PLM` results. |
| `promptcard_library_resolve` | Resolve exact `PLP` and `PLM` codes through the Prompt Library boundary. |
| `promptcard_canvas_search` | Search text/media inside one `PRJ` project only; return compact `CVT` and `CVM` results. |
| `promptcard_canvas_resolve` | Resolve exact `CVT` and `CVM` codes inside their project boundary. |
| `promptcard_context_resolve` | Resolve one `CVC` code into the immutable Canvas context pack. |
| `promptcard_skill_search` | Search Skill Hub metadata and return compact `SKL` revision candidates visible to the caller. |
| `promptcard_skill_resolve` | Resolve one exact `SKL` code and pinned revision into bounded metadata/resources allowed for that host. |

Search is for discovery. Codes are for execution. A write-capable tool must receive exact codes and must not accept a search query as its target.

### Additive output tools

| Tool | Purpose |
| --- | --- |
| `promptcard_prompt_node_propose` | Create an additive text/Prompt node proposal for a `CVC` context. |
| `promptcard_image_deliver` | Import a Codex-generated image and create a pending Canvas placement for a `CVC` context. |
| `promptcard_delivery_get` | Read proposal or delivery status without repeating the mutation. |

Every output tool requires:

- `clientRequestId` for idempotency;
- exact `CVC` target and its `PRJ` scope;
- separately listed source `PLP`/`PLM` and `CVT`/`CVM` codes used by Codex;
- safe provenance such as `codexThreadId` when the host supplies it;
- an immutable request digest;
- an operation limited to additive creation in the first release.

Updates, deletes, arbitrary node movement, full-project replacement, Storage SQL, arbitrary shell, and arbitrary filesystem access are outside the first tool surface.

## Image Delivery Contract

The trusted Gateway receives image bytes through a dedicated multipart boundary, for example:

```text
POST /api/promptcard/runtime/harness/image-results
```

Required metadata:

```json
{
  "deliveryId": "codex-client-request-id",
  "contextCode": "CVC-01K3Z85W2P4K6N9R1T7V3X5Y8A",
  "sourceLibraryPromptCodes": ["PLP-01K3Z7M7V6Q8Y3A9T2D5F4H1JN"],
  "sourceLibraryMediaCodes": ["PLM-01K3Z7Q1C8M4P6R2V9X5Y3A7BN"],
  "sourceCanvasMediaCodes": ["CVM-01K3Z83C5F8H2K6N9Q1T4V7XAM"],
  "title": "雨夜霓虹街道",
  "prompt": "The actual generation instruction",
  "source": "codex-harness"
}
```

The Gateway:

1. validates the context, MIME type, decoded dimensions, byte limit, and request identity;
2. stores the file through PromptCard Storage;
3. creates additive media/capture provenance with `source: codex-harness`;
4. creates or reuses an idempotent pending Canvas placement;
5. returns `pending`, `placed`, `rejected`, or `failed` distinctly.

The MCP adapter may accept a workspace-local generated file from Codex, but it must read and upload the bytes itself. The Gateway never accepts an arbitrary local path or remote URL.

## Prompt Node Delivery Contract

The first text output is additive only:

```json
{
  "clientRequestId": "codex-request-01",
  "contextCode": "CVC-01K3Z85W2P4K6N9R1T7V3X5Y8A",
  "kind": "free_canvas_text_create",
  "content": "Generated Prompt text",
  "sourceLibraryPromptCodes": ["PLP-01K3Z7M7V6Q8Y3A9T2D5F4H1JN"],
  "sourceCanvasMediaCodes": ["CVM-01K3Z83C5F8H2K6N9Q1T4V7XAM"]
}
```

The result is a persistent proposal or pending placement. PMAgent-Canvas applies it through the existing project revision and save coordinator. The MCP server never writes a full project snapshot.

## Permissions and Safety

Define server-enforced scopes:

- `library.read`;
- `context.read`;
- `skill.read`;
- `canvas.propose`;
- `asset.deliver`.

Additional rules:

- Skill instructions and MCP annotations are not authorization.
- Skill import, review, host enablement, publication, and deletion are authenticated PromptCard management operations and are not exposed as MCP mutations in the first release.
- Permission to read a Skill does not imply permission to execute scripts, invoke declared tools, read bundled secrets, or access the network.
- The server validates scope, runtime instance, context ownership, lifecycle state, and request schema.
- MCP startup returns the resolved repository root, runtime instance ID, and profile identity so Codex cannot silently target another PromptCard instance.
- Credentials remain in the operating-system keyring and are never exposed to MCP.
- Tool responses are bounded and redact internal paths, tokens, provider response bodies, and raw exceptions.
- A Prompt or media code is a locator, not a secret. Users must assume anyone with local MCP access and the code can request that local resource.
- Codex-generated content records provenance but is never mislabeled as a PromptCard provider generation run.

## Offline and Failure Semantics

- PromptCard unavailable: return `runtime_unavailable`; never read SQLite directly as a fallback.
- MCP unavailable: PromptCard remains fully usable.
- Codex image generation unavailable: read/search/context resolution still work.
- Media missing: return `media_unavailable` with the exact `PLM` or `CVM` code and its namespace.
- Unknown code: return `reference_not_found`; do not fall back to fuzzy search or another namespace.
- Revoked context: return `context_revoked`.
- Invalid, archived, or unreviewed Skill: return `skill_unavailable`; do not fall back to a similarly named package.
- Missing or drifted Codex projection: return `skill_projection_unhealthy` and require explicit republish.
- A local-Agent run pinned to an unavailable Skill revision fails before model invocation instead of switching revisions.
- Stale project revision: additive delivery may remain pending; update-like operations fail with `revision_conflict`.
- Duplicate `clientRequestId` with the same digest returns the original result; a different digest returns `delivery_conflict`.

## Phased Delivery

### Phase 0: Contract and Fixtures

**Goal:** Freeze terminology and verify the reference model before runtime work.

- Define JSON Schemas for references, Prompt bundles, media resources, context packs, Skill packages/revisions/host pins, proposals, and deliveries.
- Create fixtures for successful resolution, unknown codes, trashed assets, revoked contexts, invalid Skill packages, host pinning, duplicate requests, and revision conflicts.
- Record the stable architectural decision in a new ADR before implementation begins.

**Acceptance:**

- [ ] One schema package is shared by planned CLI, MCP, and Gateway adapters.
- [ ] Fixtures demonstrate that search results cannot substitute for exact execution references.
- [ ] ADR explicitly separates Codex-hosted generation from PromptCard provider generation and records the canonical Skill registry plus two host adapters.

### Phase 1: Stable Prompt and Media Codes

**Goal:** Make Prompt Library content precisely copyable.

- Add immutable `referenceCode` storage and separate uniqueness constraints for Prompt Library and Canvas namespaces.
- Backfill active and trashed Prompt records, Prompt Library media, projects, and existing Canvas text/media nodes.
- Add **Copy code** independently to Prompt Library records/media and Canvas nodes/media.
- Include `PLP`/`PLM` codes in Prompt Library responses and `CVT`/`CVM` codes in project Canvas responses.
- Preserve codes in backup, restore, export, and import.

**Acceptance:**

- [ ] Every Prompt Library record has one `PLP` code.
- [ ] Every MCP-visible Prompt Library media item has one `PLM` code.
- [ ] Every project has one `PRJ` code and every MCP-visible Canvas text/media entity has one `CVT` or `CVM` code.
- [ ] Moving media between Prompt Library and Canvas creates a new target-namespace code with provenance instead of reusing the source code.
- [ ] Restore and rename preserve codes; duplication creates new codes.
- [ ] Code lookup is exact, case-insensitive, indexed, and bounded.

### Phase 2: Canvas Context Packs

**Goal:** Let the user explicitly tell Codex which Canvas content to use.

- Add **Copy Codex context** for supported selected nodes.
- Persist immutable `CVC` context packs containing bounded snapshots and typed references.
- Add context inspection and revocation UI.
- Reject unsupported or empty selections with clear guidance.

**Acceptance:**

- [ ] Copied `CVC` resolves the same snapshot after selection or project focus changes.
- [ ] Context creation never copies the whole Canvas implicitly.
- [ ] Revocation prevents future resolution without deleting project content.
- [ ] Missing referenced media is reported precisely.

### Phase 3: Skill Hub and Canonical Skill Registry

**Goal:** Let users import and manage one versioned Skill source for concrete Host Adapters, initially Codex and the local Agent.

**Implemented local-Agent slice (2026-08-05):**

- [x] Added SkillHub to the global left sidebar with search, source filtering, and revision/trust/tool detail inspection.
- [x] Added schema v8 local Skill and immutable revision storage with digest, source, trust state, capability, instructions, references, and declared tool dependencies.
- [x] Added deterministic first-party capability binding and explicit one-shot external Skill selection for the local text Agent.
- [x] Added Gateway snapshot audit and rejection when a Skill requires tools outside the current `permissionScope`.
- [x] Kept scripts disabled and prevented Skill content from expanding tools, proposal types, or approval permissions.

**Completed management and host slice (2026-08-24):**

- [x] Added canonical `SKL` identity, immutable revisions, package digests, provenance, lifecycle, exact-revision trust reviews, and host-specific pin state.
- [x] Added inert folder/archive inspection, structured validation findings, preview/import, revision history/diff, and archive/restore.
- [x] Added independent Codex and local-Agent enablement with exact revision/digest pins; canonical updates move neither pin.
- [x] Added the Codex native projection, health/recovery and explicit owned-drift repair while preserving unowned collisions.
- [x] Kept local-Agent snapshots bounded and prevented scripts, hooks, installers, and package declarations from granting tools.

**Acceptance:**

- [x] The left-sidebar Skill Hub can import a valid Skill without executing package content.
- [x] Invalid paths, links, oversized packages, malformed metadata, and identity collisions fail closed with reviewable findings.
- [x] Updating a Skill creates a revision and does not silently move either host's pin.
- [x] Codex and the local Agent can read the same pinned `SKL` revision and digest through their own adapters.
- [x] Enabling or disabling one host does not change the other host.
- [x] The local Agent cannot execute Skill scripts or gain tools outside its existing `permissionScope`.

### Phase 3.5: Skill Conversation And Creative Documents (Planned)

**Goal:** Complete a recoverable local Skill conversation -> file -> Document -> Storyboard -> explicit Prompt proposal loop without changing Prompt or external Bridge semantics.

- [ ] Add `chat-experimental` as a conversation mode separate from Prompt edit modes, with persistent conversation-scoped Skill binding and per-turn pin/trust/tool revalidation.
- [x] Add Storage schema v16 project document resources for TXT/Markdown/PDF/DOCX; keep image project resources unchanged.
- [ ] Use local safe text/DOCX extraction and an isolated Ark Files/Responses path for PDF, with per-invocation remote deletion and durable cleanup retry.
- [ ] Add isolated Document and Storyboard Canvas nodes, explicit kind dispatch, bounded context resolution, persistence, command history, and old-project compatibility.
- [ ] Apply Agent Document suggestions and Storyboard field differences through typed operations, frontend persistence acknowledgement, rollback, and idempotent restart reconciliation.
- [ ] Require explicit Document -> Storyboard and selected text/shot -> Prompt actions; prove Document/Storyboard never enter Prompt Library/RAG/compiler/image-generation implicitly.
- [x] Deliver Checkpoint 3.5 evidence and stop for user acceptance before Task 16.

### Phase 4: Read-Only CLI and Local MCP

**Goal:** Give verified MCP-capable Agent hosts safe access to Prompt Library, Canvas context, and Skill Hub references through one host-neutral core.

- Implement runtime discovery plus the separate project, Prompt Library, Canvas, context, and Skill Hub read tools.
- Add distinct MCP resource URI families for Prompt Library, Canvas, context, and Skill Hub records.
- Provide the same operations through a deterministic JSON CLI.
- Publish reviewed installation/configuration guidance for Codex and TRAE without branching core tools or schemas by client name.

**Acceptance:**

- [x] The host-neutral MCP/CLI contract resolves user-copied `PRJ`, `PLP`, `PLM`, `CVT`, `CVM`, `CVC`, and `SKL` codes through the same core; real Codex is the current acceptance host and TRAE remains contract-compatibility coverage rather than a manual gate.
- [ ] Prompt Library search never returns Canvas identities, and Canvas search never returns Prompt Library identities.
- [ ] A broad search returns compact typed codes and summaries, not unbounded asset data.
- [x] No read tool exposes local paths, credentials, internal asset IDs, or unrestricted project JSON.
- [x] STDIO and loopback Streamable HTTP pass the frozen protocol-era, authentication, origin, response-budget, and cleanup gates without downloading runtime dependencies at launch.

### Phase 4A: Shared Prompt Library RAG

**Goal:** Replace request-snapshot Prompt lookup with one bounded, auditable retrieval core used through separate local-Agent and MCP adapters.

- Add normalized Prompt retrieval documents and transactional SQLite FTS5 maintenance.
- Add the bounded Storage/Gateway contract with exact-code short-circuiting, deterministic ranking, evidence budgets, and stale-record re-resolution.
- Replace browser Prompt-array transport in the local Agent mode and expose citations, degraded state, and durable turn audit.
- Reuse the retrieval core from MCP search without sharing Agent conversation state, Canvas scope, credentials, tools, or mutation permissions.
- Add an optional, provider-neutral, versioned semantic-index adapter only after explicit indexing consent is defined.
- Remove the legacy request-snapshot path after migration and compatibility tests pass.

**Acceptance:**

- [x] Agent RAG requests contain no browser-supplied full Prompt array; MCP reuses the same bounded Storage/Gateway retrieval core through its own Bridge profile and audit identity.
- [ ] Exact Prompt/media codes resolve deterministically before ranking.
- [ ] Chinese and English paraphrases retrieve relevant active Prompts with reviewable reasons.
- [x] Result count and injected context remain bounded as the library grows.
- [x] Create, update, archive, and restore keep retrieval indexes consistent and exclude Trash from ordinary results.
- [x] Missing retrieval infrastructure produces an explicit no-evidence degraded state and does not fail the local-Agent turn; semantic retrieval remains deferred.
- [x] Agent citations and MCP results expose resolvable Prompt identities, revisions, and digests.
- [x] Canvas completion/rewrite, ordinary discussion, media analysis, and experimental chat cannot call the retriever.
- [ ] RAG mode cannot mutate Canvas or Prompt Library without a separate valid proposal and user approval.
- [ ] Disabling RAG leaves ordinary Agent, Canvas, media analysis, exact-code resolution, and non-RAG MCP tools available.

### Phase 5: Prompt Node and Image Delivery

**Goal:** Return Local Agent Bridge outputs to the correct Canvas safely.

- [x] Implement additive Prompt node proposal delivery. Preview is non-mutating, commit enters the visual CVC-scoped review queue, accept saves one deterministic all-`user` Prompt before terminal acknowledgement, and reject remains audited.
- Implement multipart image delivery with v2 `promptcard-bridge` provenance and profile-scoped idempotency; accept v1 `codex-harness` only at the compatibility boundary.
- Add idempotent generic pending Canvas placements independent of provider generation runs.
- Reuse the existing save-before-placed reconciliation order.
- Surface delivery state in PromptCard without adding a client-specific chat panel.

**Acceptance:**

- [ ] Repeated delivery does not create duplicate assets or nodes.
- [x] A Prompt node or image targets the Canvas identified by the `CVC` pack.
- [ ] Project save failure leaves delivery pending and recoverable.
- [x] No bridge-delivered asset is recorded as a Seedream/provider generation run.
- [x] PromptCard shows provenance and the source codes used.

### Phase 6: Hardening and Distribution

**Goal:** Make the integration safe to ship as an open-source optional capability.

- Package the locked local MCP launcher, a reviewed default Skill Hub Skill, and configuration guidance.
- Add Skill import security, revision pinning, host publication, drift detection, and local-Agent scope tests.
- Add contract, migration, permission, redaction, idempotency, and recovery tests.
- Add an end-to-end evaluation set covering real copy-code workflows.
- Document supported Codex hosts and image-generation capability caveats.

**Acceptance:**

- [ ] A new contributor can enable the MCP bridge without adding a provider key to PromptCard.
- [ ] PromptCard works normally when the optional integration is absent.
- [ ] Tests distinguish discovery, resolution, generation-host, delivery, Storage, and Canvas failures.
- [ ] Tests prove that Skill import does not execute package content and that Codex/local-Agent enablement is independent.
- [ ] Release documentation states that Codex-hosted image generation is not offline model inference bundled with PromptCard.

## Verification Strategy

- Storage tests: code uniqueness, migration, backup/restore, trash/restore, context revocation, Skill revision pinning, package digest, idempotency, FTS freshness, semantic-index invalidation, and rebuild safety.
- Gateway tests: permission scopes, exact resolution, Skill snapshot bounds, RAG query/evidence budgets, ranking provenance, stale-candidate rejection, degraded lexical fallback, multipart validation, redaction, provenance, and conflict errors.
- Frontend tests: copy-code affordances, selection preview, context creation, absence of full-library Agent payloads, RAG citations/degraded state, Skill Hub navigation/import/review/host toggles, pending delivery, save-before-placed, and recovery.
- Runtime tests: only explicit Prompt Library RAG mode receives bounded evidence or the retrieval tool.
- MCP/CLI contract tests: identical schemas and results for every shared operation.
- Skill package security tests: traversal, unsafe links, duplicate normalized paths, archive limits, malformed metadata, collision, and no-execution guarantees.
- Creative-document tests: experimental conversation/Skill persistence, document format and provider cleanup security, Document suggestion semantics, Storyboard field review, apply/replay recovery, explicit transforms, and Prompt/image isolation.
- End-to-end tests:
  - copy a `PLP` code, resolve Prompt and ordered `PLM` media;
  - resolve a `PRJ`, search Canvas `CVT`/`CVM`, and separately search Prompt Library `PLP`/`PLM`;
  - create a `CVC` code from selected nodes and resolve it after focus changes;
  - import one Skill, publish the same pinned revision to Codex, and enable it independently for the local Agent;
  - update the Skill and verify neither host moves revisions without explicit approval;
  - bind a local-Agent Skill across an experimental conversation, attach each supported document format, create/revise a Document, explicitly create a Storyboard, and explicitly create one pending `free_canvas_text_create` proposal from a selection;
  - deliver a Prompt node and image to that context;
  - repeat the same request and verify no duplicate node or asset;
  - disable Codex/MCP and verify PromptCard local workflows still work.

## Not Doing

- No embedded Codex chat UI in PMAgent-Canvas.
- No replacement of the existing pi text Agent in this plan.
- No automatic execution of imported Skill scripts, hooks, installers, or package-manager commands.
- No assumption that publishing a Skill grants its requested tools, MCP scopes, filesystem access, credentials, or network access.
- No automatic modification of unrelated user-owned Codex Skills or global Codex configuration.
- No direct Codex access to SQLite, full project JSON, keyring, or arbitrary filesystem paths.
- No fuzzy title matching for write targets.
- No ambient Prompt Library retrieval during Canvas completion/rewrite, ordinary discussion, or media analysis.
- No unbounded full-library injection into an Agent or Codex context.
- No silent upload of Prompt content to a remote embedding service.
- No shared generic media code spanning Prompt Library and Canvas.
- No copying the entire Canvas when the user has not explicitly requested it.
- No updates, deletes, or destructive Canvas operations in the first MCP/Bridge write surface; the separately accepted project-local Document/Storyboard typed operations do not create a general Canvas mutation API.
- No representation of Codex image output as a successful PromptCard provider run.
- No promise that an open-source clone receives free or offline image generation.

## Open Questions

- Should the first release require PMAgent-side Apply for additive deliveries, or may a trusted local profile auto-place after an explicitly approved Codex tool call?
- Which Canvas node kinds are safe and useful in the first context-pack release?
- Should context packs remain indefinitely, expire by policy, or support both persistent and temporary modes?
- Which Prompt metadata fields are stable enough to expose as the initial MCP search filters?
- Should a future portable project export namespace reference codes to prevent collisions when two independent libraries are merged?
- Which Skill import sources should follow local folder/archive after the first release: Git repository URL, registry, or neither?
- Should local-Agent Skill matching remain explicit-only or support deterministic metadata matching after the first release?
- Should the first RAG release remain lexical-only until an explicit embedding consent flow exists?
- Which local or remote embedding backend should be supported first?
- Should hybrid retrieval initially use fixed reciprocal-rank fusion or a separately versioned reranker?
- When a Codex host supports script-bearing Skills, should PromptCard expose script compatibility as information only or require a separate per-revision execution approval?
