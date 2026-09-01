# Long-Term Plans

This folder stores time-sensitive, multi-stage plans that are expected to guide work across multiple sessions.

Use this folder for plans that:

- describe a product or engineering direction that may change over time;
- need phased execution rather than a single pull request;
- include explicit checkpoints, acceptance criteria, and review dates;
- should remain visible to future contributors and agents.

Do not use this folder for permanent architecture records. Stable decisions belong in `docs/decisions/`. Completed or obsolete plans should stay here with their status updated instead of being deleted.

## Plan Status Values

- `Active`: currently guiding implementation.
- `Paused`: intentionally stopped, but may resume.
- `Completed`: all planned checkpoints are done or superseded by shipped work.
- `Superseded`: replaced by a newer plan.
- `Archived`: retained for history only.

## Naming

Use numbered filenames:

```text
001-cross-platform-clipboard-asset-workbench.md
002-next-plan-name.md
```

## Active Plans

- [001: Cross-Platform Clipboard Asset Workbench](./001-cross-platform-clipboard-asset-workbench.md)
- [002: Floating Capture Video Asset MVP](./002-floating-capture-video-asset-mvp.md)
- [004: Update Module Integration](./004-update-module-integration.md)
- [007: Provider-Neutral Contextual Image Editing And Multi-View](./007-contextual-image-editing-and-multi-view-plan.md)
- [009: Portable Creative Context Environment](./009-portable-creative-context-environment.md) — product-direction guardrail: use the completed Local Agent Bridge / MCP baseline to define the exact shot model before Asset Shelf or browser connectors.

## Completed Plans

- [008: Local Agent Bridge, Prompt Library RAG, and host adapters](./008-local-mcp-prompt-media-codex-bridge.md) — completed and merged to `main` on 2026-09-01; the filename/title is historical, while ADR-019 and ADR-023 define the host-neutral and typed-writeback boundaries.

## Implemented Baselines

- [005: Seedream Project Image Generation Implementation Status](./005-seedream-image-node-frontend-implementation-status.md)
- [006: pi Text Agent Minimal Closed Loop](./006-pi-text-agent-minimal-closed-loop.md)

## Superseded Plans

- [003: Agent Positioning And Harness Engineering](./003-agent-positioning-and-harness-engineering.md) — superseded by ADR-012 and Plan 006.
- [005: Seedream Image Node Frontend Interaction](./005-seedream-image-node-frontend-interaction.md) — superseded by ADR-010 and the project-level image-generation implementation.
