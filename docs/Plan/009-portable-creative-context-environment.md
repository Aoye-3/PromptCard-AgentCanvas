# Plan 009: Portable Creative Context Environment

## Status

Active

## Date

2026-08-30

## Purpose

This is a product-direction guardrail for future planning. It does not replace the detailed Plan 008 execution ledger or authorize new implementation work by itself.

PromptCard-Manager is not pursuing feature parity with image/video generation canvases, model aggregators, or end-to-end video-production systems. It is a portable, cross-platform creative-context environment that lets a creator, external Agents, and external creation tools work from the same durable project state.

## Durable Product Context

The product must preserve and connect these project assets:

- script and planning material;
- character, scene, and world constraints;
- references and source provenance;
- structured storyboard rows and future shot execution information;
- Prompt/instruction packages and generation inputs;
- generated assets, review notes, revisions, and acceptance/rejection decisions.

Free Canvas is the visual workbench for this context. It is not the source of authority, and it must not become a generic mechanism for external Agents to mutate arbitrary project state.

## Sequenced Direction

### Stage 1: Stabilize External Agent Read/Write Collaboration

Finish the gated Plan 008 sequence before adding browser-facing integration. The Local Agent Bridge / MCP must give Codex and other supported MCP-capable hosts a host-neutral, narrow, typed surface through Gateway and Storage.

The first user-facing loop is:

```text
Script and references
  -> Agent creates or proposes structured storyboard material
  -> creator reviews and makes a scoped change
  -> Agent returns a reviewable proposal against the exact object/revision
  -> accepted content becomes an executable shot asset package
```

Scope requirements:

- Every Agent operation resolves an exact project object and revision/context, not a screenshot, current UI focus, or entire canvas dump.
- Changes remain proposal-based, user-reviewable, attributable, and recoverable.
- The initial product-level convergence object is the shot. Its fields and mutation operations need a separate accepted implementation plan after the existing Document/Storyboard boundaries are accepted.

### Stage 2: Portable Asset Delivery

Introduce an Asset Shelf beside the creator's existing browser or creation software. It retrieves project assets by project, scene, shot, character, or task and exposes a small reliable set of outputs:

1. drag files or images out;
2. copy the relevant text/instruction block;
3. export an execution package containing selected assets and metadata.

Text drag-and-drop across arbitrary websites is not a baseline requirement. Every important text asset also needs a copy/export path.

### Stage 3: Selective External-Tool Connectors

After Stage 2 is validated, add connectors only for external platforms with a clear user benefit and a supportable compatibility contract. A connector may offer targeted form filling or result return, but it must not require embedded browsing, universal site automation, or retained third-party login/session state.

Returned results should keep source-platform metadata and attach to the originating shot/context when an exact association is available.

## Non-Goals

- Do not become a primary image/video model marketplace or model aggregator.
- Do not build a generic external-Agent canvas update/delete API.
- Do not make a browser plugin or embedded browser a prerequisite for the first closed loop.
- Do not promise reliable automation or text dragging on arbitrary third-party websites.
- Do not make first-party Agent capability a substitute for the external-Agent integration boundary.

## Relationship To Existing Plans

- [Plan 001](./001-cross-platform-clipboard-asset-workbench.md) remains the asset-management foundation; its manual copy/paste loop aligns with Stage 2.
- [Plan 002](./002-floating-capture-video-asset-mvp.md) remains the capture/inbox foundation; it does not make raw captures ambient Agent context.
- [Plan 008](./008-local-mcp-prompt-media-codex-bridge.md) is the active detailed execution ledger for Stage 1. Its checkpoints and acceptance gates take precedence for implementation order.
- [ADR-019](../decisions/ADR-019-generic-local-agent-bridge-boundary.md) defines the host-neutral Bridge boundary.
- [ADR-022](../decisions/ADR-022-portable-creative-context-environment.md) records the durable product decision behind this plan.

## Research References

- [OpenStory](https://github.com/Aoye-3/openstory): reference for future study of structured storyboard and creative interaction patterns.
- [DramaClaw](https://github.com/Aoye-3/dramaclaw): reference for future study of Agent-oriented creative workflow patterns.

These repositories are research inputs only. Any source reuse requires a separate licensing, security, dependency, and maintenance review.

## Review Gates

Before starting Stage 2:

- [ ] Plan 008's relevant Local Agent Bridge / MCP acceptance gates have passed.
- [ ] A human has confirmed the script/reference → storyboard → scoped review → executable asset-package loop.
- [ ] The exact shot data model and its allowed Agent operations have an accepted plan.

Before adding a platform-specific connector:

- [ ] The manual file/image drag-out, copy, and export paths are validated with creators.
- [ ] The platform's supported handoff/return behavior and failure fallback are documented.
- [ ] No third-party credential, session state, or broad browser authority is stored by PromptCard-Manager.
