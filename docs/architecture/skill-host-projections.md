# Skill Host Pins And Projections

PromptCard Storage schema v14 is the authority for Skill host activation. A host never follows a Skill's mutable `currentRevision`: every activation pins one immutable revision and its canonical digest.

## Ownership Model

- Storage owns the canonical Skill package, immutable revisions, lifecycle/trust state, and host pins.
- `local-agent` has one global pin per Skill. Its scope is the empty string and it has no filesystem projection.
- `codex` has one pin per Skill and configured repository scope. The scope is an opaque configuration key, not a caller-supplied filesystem path.
- Codex and local-Agent pins are independent. Updating or disabling one host does not move the other host's revision or digest.
- `.agents/skills` and local-Agent snapshots are derived views. Neither can create or modify a canonical Skill revision.

Built-in Skills receive an enabled local-Agent pin for their exact current revision during schema initialization. External Skills require an explicit host update.

## Codex Projection

Enabling a Codex pin publishes the pinned package to:

```text
<configured-repository>/.agents/skills/<publicationName>/
```

The generated `.promptcard-skill.json` manifest uses `promptcard-codex-projection-v1` and records the repository scope, internal owner, PromptCard source, canonical `SKL` code, revision, digest, and every projected file path/digest. Storage retains the same manifest plus `publicationName` in the pin's projection metadata.

Publication fails closed when the destination is not demonstrably PromptCard-owned. It rejects unsafe or colliding paths, Windows-reserved names, case-folding and file/directory-prefix collisions, symlinks, junctions, reparse points, and an unowned destination. A read of a Codex pin verifies the complete manifest, all expected files and digests, unexpected files or directories, and link/reparse safety. The bounded `projectionHealth` result is:

- `{ "state": "healthy" }` when the durable pin and repository projection match exactly;
- `{ "state": "drifted", "code": "..." }` when files or projection metadata differ;
- `{ "state": "unhealthy", "code": "codex_projection_recovery_required" }` when safe recovery cannot be proved.

Drift is never imported as a new canonical revision. The caller must resolve the collision or drift and explicitly publish again.

## Serialization And Crash Recovery

Codex publish and unpublish operations take repository-, pin-, and publication-path lock files under `.agents/.promptcard-projection-locks`. The locks are operating-system backed, so cooperating Storage service instances serialize publish/publish and publish/unpublish operations, not only threads in one process.

Before changing the projection, Storage writes and flushes a prepared journal under `.agents/.promptcard-projection-journal`. The journal records the exact prior and desired pins plus projection and backup identities. On the next pin operation or health read, recovery compares the durable SQLite pin with those two states:

- durable desired pin: verify and finalize the filesystem change;
- durable prior pin: restore the previous filesystem state;
- neither state, changed backup, or otherwise unprovable state: preserve evidence and report `codex_projection_recovery_required`.

A disabled durable pin is complete only when no live projection remains. Recovery verifies enabled, absent, and disabled prior states before deleting its journal.

SQLite commit and filesystem rename cannot form one hardware-atomic transaction. The guarantee is deterministic compensation/finalization when the durable evidence is sufficient and an explicit non-destructive recovery-required state otherwise. Non-cooperating processes can still change projected files after publication; health verification detects that drift.

## Local-Agent Snapshot Boundary

`GET /api/skill-host-snapshots/local-agent?skillId=...` resolves only the enabled, exact pinned revision. Every read rechecks that the Skill is active and remains `trusted` or `first-party`. Lowercase public `SKL` input is accepted, while the response returns the canonical uppercase code.

The Storage snapshot contains only:

- the root `SKILL.md` instruction;
- UTF-8 text references below `references/` with content type `text/plain`, `text/markdown`, or `application/json`;
- declared capabilities after fixed-key, count, and UTF-8 size validation.

Scripts and assets are not returned. Storage allows at most 64 references and 512 KiB of instruction/reference bytes, plus at most 64 declared capability items of 128 UTF-8 bytes each.

The Gateway independently treats the Storage response as untrusted input. Before model invocation it enforces a 256 KiB instruction limit, 128 KiB per reference, 220 UTF-8 bytes per reference path, 64 references, and 512 KiB total. It also revalidates the canonical `SKL` code, digest, shape, content types, capabilities, and exact tool subset. Non-tool capability requests and tools outside the already validated run scope fail before the model boundary. Capabilities are removed from the snapshot passed onward after validation.

## Delivery Boundary

Task 14 provides the Storage host-pin API, Codex filesystem projection, recovery, health reporting, and Gateway local-Agent snapshot validation. Task 15's Skill Hub management UI and Task 16's broader Gateway/MCP read surface are separate work and are not implied by this backend capability.
