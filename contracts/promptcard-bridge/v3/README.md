# PromptCard Local Agent Bridge contract v3

Version 3 adds typed creative-object discovery and proposal-only writeback while preserving the v1 reference package and v2 host-neutral trust boundary.

- `CVD-*` identifies a Canvas Document and `CVS-*` identifies a Canvas Storyboard. They are stable public references, not Canvas node IDs.
- The launcher or authenticated transport supplies `profileId` and scopes. Tool payloads cannot submit or expand authority.
- Document, Storyboard, Prompt, and image delivery have independent scopes and always create a reviewable proposal.
- Prompt delivery is create-only. Image delivery consumes an opaque staged-asset handle; commit never accepts a filesystem path or URL.
- Delivery identity is `(profileId, clientRequestId)`. Preview, commit, status, replay, and recovery share one ledger record.
- A write target is an exact `CVC`, `CVD`, or `CVS` reference plus an explicit revision/digest where mutation requires one. Search results, titles, and internal IDs are never write targets.
- Prompt search is a bounded discovery operation: v3 returns exact `PLP-*` references, immutable revision/digest evidence, score components, safe media metadata, and an audit identifier. A consumer must still resolve an exact reference before execution.

Consumers load the v1 and v2 schemas before this bundle. Runtime, Storage, CLI, MCP, and UI implementations must produce contract-equivalent values.
