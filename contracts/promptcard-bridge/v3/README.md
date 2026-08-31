# PromptCard Local Agent Bridge contract v3

Version 3 adds typed creative-object discovery and proposal-only writeback while preserving the v1 reference package and v2 host-neutral trust boundary.

- `CVD-*` identifies a Canvas Document and `CVS-*` identifies a Canvas Storyboard. They are stable public references, not Canvas node IDs.
- The launcher or authenticated transport supplies `profileId` and scopes. Tool payloads cannot submit or expand authority.
- Document, Storyboard, Prompt, and image delivery have independent scopes and always create a reviewable proposal.
- Prompt delivery is create-only. Image delivery consumes an opaque staged-asset handle; commit never accepts a filesystem path or URL.
- Delivery identity is `(profileId, clientRequestId)`. Preview, commit, status, replay, and recovery share one ledger record.
- A write target is an exact `CVC`, `CVD`, or `CVS` reference plus an explicit revision/digest where mutation requires one. Search results, titles, and internal IDs are never write targets.
- Prompt search is a bounded discovery operation: v3 returns exact `PLP-*` references, immutable revision/digest evidence, score components, safe media metadata, and an audit identifier. A consumer must still resolve an exact reference before execution.
- Asset staging is capped at 30 MiB by the schema and both adapters. MCP additionally requires an explicit workspace root and rejects real-path escape before Gateway receives bytes.
- `runtimeDescription.bootstrapSkill.instructions` is the executable built-in first-contact guide. It tells a newly connected host how to discover a fresh explicit Workspace, copy exact four-field Skill pins, construct the closed kind-specific preview envelope, commit only the returned proposal, and stop for visual review. Bootstrap v6 fixes the exact `document.change` `payload.operations` wrapper, directs the host to copy bounded `documentEditEvidence` from exact CVD resolution instead of inventing UTF-8 offsets or digests, spells out the complete Storyboard sequence/row/change shapes, and freezes the six-field `promptcard_asset_stage` input plus the optional exact Storyboard target for `image.place`. The Bootstrap name is not an `SKL-*` reference and must not be passed to `promptcard_skill_read`.

Consumers load the v1 and v2 schemas before this bundle. Runtime, Storage, CLI, MCP, and UI implementations must produce contract-equivalent values.
