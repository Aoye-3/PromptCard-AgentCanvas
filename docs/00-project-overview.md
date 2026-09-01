# Project Overview

PromptCard-Manager is a local-first, portable creative-context environment. It combines a Prompt media library, Free Canvas, provider-neutral image generation, structured creative documents/storyboards, and focused Agent collaboration without making any one model vendor, Agent client, or external creation platform the product authority.

## Product Direction

The durable product is the project context shared by a creator, Agents, and external creative tools: script and planning material, characters/scenes, references, structured storyboard rows, shot execution information, generated assets, review notes, revisions, and decisions. Free Canvas is the visual workbench for these objects; it is not a competing video/image generation platform or a generic model aggregator.

The host-neutral Local Agent Bridge / MCP foundation defined by ADR-019, ADR-023, and Plan 008 is complete. External Agents work through typed references, Gateway policy, proposal/approval boundaries, and Storage authority rather than UI focus or internal node IDs. The next planning gate is the exact shot data model and its allowed Agent operations; only after that gate should Stage 2 Asset Shelf work begin. Future Asset Shelf and browser connectors remain project-asset delivery surfaces: reliable file/image drag-out, text copy, and execution-package export come before optional platform-specific fill/return integrations. The app must not embed or take over a third-party browser UI as a prerequisite for the creative loop.

## Minimal Closed Loop

The current delivery target is:

1. Prompt media library construction.
2. Image generation from Canvas prompts.
3. Prompt analysis and prompt completion through the text Agent.
4. Contextual image operations and explicit front/left/top multi-view generation with recoverable, independently retryable members.
5. External Agent discovery and review-only typed Document, Storyboard, Prompt, and image writeback through the Local Agent Bridge, with durable replay/conflict and restart recovery.

## Primary Capabilities

- Prompt Library preset management using the `IPreset` compatibility contract.
- Media Library capture, registration, reuse, and image style/prompt analysis.
- Free Canvas text and image nodes.
- Canvas Prompt image generation through the existing provider-neutral Image Generation module.
- Contextual image actions that resolve local edits immediately and require an explicit Generate action for provider-backed operations.
- Explicit multi-view request groups, including the front/left/top shortcut, durable placeholders, partial-failure recovery, and retry of only the failed member.
- A pi-based text Agent that can:
  - maintain project-scoped durable conversations with one whitelisted model binding per conversation;
  - complete one explicitly attached Canvas target through exact anchored black insertions while preserving every existing segment;
  - rewrite by proposing a complete derived text node while leaving the source and references unchanged;
  - search a bounded Prompt Library snapshot only in the explicit read-only `prompt-library` mode;
  - propose new Prompt Library items;
  - analyze one explicitly selected image through a temporary, non-persistent multimodal conversation.
- Storyboard and structured prompt workflows.

All Agent mutations are proposals and require explicit user confirmation.

The contextual image and multi-view work is tracked in [Plan 007](./Plan/007-contextual-image-editing-and-multi-view-plan.md). Its zero-cost Fake Provider automation is complete, but the plan remains `Active` until unified human acceptance is approved; paid live-provider gates have not been executed.

## Runtime Shape

- React/Vite frontend
- PromptCard Storage service
- Python PromptCard Gateway for model management, keyring-owned provider access, SDK text adapters, media access, and independent image generation
- Node pi text runtime for the focused Agent loop and PI provider collection

DeerFlow and LangGraph have been removed from the maintained runtime.

## Repository Boundary

The repository root is `PromptCard-Manager`. The parent folder is a workspace container and may contain reference materials or legacy local-only artifacts.

Model credentials belong in the operating-system keyring. Maintained launchers do not consume `API-Key.txt`.

## Main Commands

```powershell
npm.cmd run dev
npm.cmd run dev:with-agent
npm.cmd run agent:dev
npm.cmd run text-agent:dev
npm.cmd run agent:check
npm.cmd test -- --run
npm.cmd run test:frontend
npm.cmd run test:e2e
npm.cmd run build
```
