# ADR-022: Position PromptCard-Manager As A Portable Creative Context Environment

## Status

Accepted

## Date

2026-08-30

## Context

Image/video generation canvases, model aggregators, and end-to-end video-production pipelines are crowded and improve rapidly with upstream vendors. Competing on an embedded model catalogue, a generic canvas, or automation of a particular third-party website would make PromptCard-Manager responsible for vendors' changing interfaces, login/session behavior, upload rules, and generation capability.

Creators instead work across multiple Agent applications and creation tools. Their reusable value is the project context that must survive those handoffs: scripts and planning material, character/scene constraints, references, structured storyboard rows, shot execution information, generated results, review notes, revisions, and the decisions that explain why a result was accepted or rejected.

The repository already has two relevant foundations: typed Document and Storyboard work from Plan 008 Phase 3.5, and the host-neutral Local Agent Bridge boundary in ADR-019. The MCP/Gateway implementation itself has not started; Tasks 15.6–15.10 are technically accepted and await Checkpoint 3.5 human acceptance before Task 16.

OpenStory and DramaClaw are reference repositories for future research into structured storyboard interaction and Agent-oriented creative workflows. They do not define PromptCard-Manager's product boundary, implementation scope, or license terms.

## Decision

1. **The product is a portable, cross-platform creative-context environment.** The authoritative product state is the creator's project context, not a model vendor, Agent client, browser page, or canvas presentation.
2. **Free Canvas is the human/Agent workbench.** It visualizes and edits typed project objects but is not positioned as a competing generation product or generic model aggregator.
3. **External Agent collaboration is the near-term integration priority.** Stabilize the Local Agent Bridge / MCP in the phased Plan 008 sequence. External Agents use explicit typed references, Gateway policy, Storage authority, narrow scopes, and reviewable proposals. The application may offer its own Agent experiences, but they do not replace the host-neutral boundary.
4. **The first product loop is script/reference to structured storyboard to human review to an executable shot asset package.** A shot is the next product-level object to converge, linking source material, characters/scenes, references, instructions, results, notes, and history. This does not authorize a general-purpose Canvas mutation API; new typed operations require their own accepted plan.
5. **External-tool integration is progressive.** The future Asset Shelf and connectors let creators retrieve the correct project assets beside their existing browser or creation tool. The baseline is reliable file/image drag-out, text copy, and execution-package export. Platform-specific fill, result return, or automation is optional and added only after compatibility and value are demonstrated.
6. **Do not embed or take over third-party browser experiences as a prerequisite.** Browser plugins/connectors remain later work. No roadmap commitment is made to universal text drag-and-drop, arbitrary website automation, or persistence of third-party login/session state.

## Implementation Outcome

Plan 008 completed and merged to `main` on 2026-09-01. The delivered Stage 1 baseline includes the host-neutral Local Agent Bridge, bounded Prompt retrieval, ten-tool STDIO/loopback HTTP MCP, typed review-only Document/Storyboard/Prompt/image writeback, durable replay/conflict/restart recovery, and a verified real-Codex closed loop. The next gate under Plan 009 is an accepted exact shot data model and allowed Agent operations; Asset Shelf and browser-connector work remains unauthorized until that gate is satisfied.

## Consequences

- Product and technical documents must describe the canvas as the interface to portable project context, not the core competitive moat.
- Local Agent Bridge / MCP work proceeds before an Asset Shelf or browser connector implementation. Ordinary local PromptCard workflows remain usable with MCP absent.
- New Agent or connector features must identify the exact project object, scope, proposed mutation, review path, and provenance rather than passing an unbounded canvas snapshot or relying on UI focus.
- Future platform integrations should preserve user control: support manual asset handoff first, then narrow, tested integrations. Their generated results must return with source/platform metadata and attach to the originating project object where available.
- The project may study interaction patterns and architecture from OpenStory and DramaClaw, but importing code requires a separate license, security, dependency, and maintenance review.

## Alternatives Considered

### Compete As A Unified Image/Video Generation Canvas

Rejected. Vendor capability, pricing, and interface changes would dominate maintenance while the user's cross-tool creative state remained fragmented.

### Embed A Browser And Automate Third-Party Creation Websites First

Rejected. It creates fragile coupling to website DOMs, authentication/session state, upload affordances, and permissions before the project context and Agent contract are proven.

### Build A First-Party Agent To Replace External Agent Hosts

Rejected. It narrows the product to one Agent capability race. PromptCard-Manager should improve as external Agents improve while retaining its own controlled local experiences where useful.

## References

- [Plan 008: Local Agent Bridge, Prompt Library RAG, and host adapters](../Plan/008-local-mcp-prompt-media-codex-bridge.md)
- [Plan 009: Portable Creative Context Environment](../Plan/009-portable-creative-context-environment.md)
- [ADR-019: Generic Local Agent Bridge Boundary](./ADR-019-generic-local-agent-bridge-boundary.md)
- [OpenStory reference repository](https://github.com/Aoye-3/openstory)
- [DramaClaw reference repository](https://github.com/Aoye-3/dramaclaw)
