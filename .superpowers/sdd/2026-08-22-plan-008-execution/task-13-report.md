# Task 13 Report: Safe Skill Folder And Archive Inspection

## Outcome

Implemented a separate, non-executing Skill package inspector/importer for local folders, ZIP archives, and TAR-family archives. Inspection is bounded, deterministic, read-only, and returns closed structured findings plus a sanitized manifest. Persistence is available only through a short-lived `inspectionId` that refers to the exact immutable in-memory snapshot reviewed by the caller.

No Task 14 host pin/projection or Task 15 Skill Hub UI behavior was added. Failed or dirty inspection/import paths do not create a Skill, revision, package entry, public `SKL`, or host projection.

## Threat model and trust boundary

- Untrusted input: every folder/archive path, member name, metadata field, frontmatter byte, script, asset, and reference byte.
- Protected assets: immutable canonical revisions, public `SKL` identity, local filesystem contents outside the selected root, Storage/host authority, and credentials.
- STRIDE emphasis: tampering through path/race ambiguity, information disclosure through errors/findings, decompression/count/metadata denial of service, and elevation through scripts/hooks/installers/package managers.
- Inspection never calls `exec`, `eval`, dynamic imports, subprocesses, shells, package managers, archive extraction, or filesystem projection. Script/hook/installer/package-manifest content is retained only as inert typed bytes or rejected with a closed finding.

## Folder and archive safety

Folder inspection uses sorted `scandir`, explicit `os.lstat`, `follow_symlinks=False`, reparse-point rejection, regular-file/directory allowlisting, excluded cache/VCS/dependency directories, root-containment checks, and bounded reads. Each file is compared by device/inode/type/size/mtime before opening, on the open handle before and after reading, and against the path after reading. A mismatch is a blocking `folder.file_changed` finding.

ZIP and TAR inspection uses only Python standard-library enumeration and bounded streaming reads. It never extracts to disk. ZIP encrypted entries and non-regular Unix modes are rejected. TAR symlinks, hardlinks, devices, FIFOs, sparse/non-regular entries are rejected. Count, compressed input, per-file, total uncompressed, ratio, and metadata consistency checks happen before or during bounded reads.

All paths reuse Task 12 `normalize_package_path` for POSIX/NFC canonicalization, with additional rejection for control characters, depth/length limits, Windows reserved names, ADS colons, trailing dot/space, unsafe links, nested archives, and NFC/casefold collisions. Directory entries never become canonical package entries.

## Frontmatter and credential boundary

`SKILL.md` must be bounded UTF-8 with closed frontmatter. The dependency-free parser supports required string `name`/`description`, optional safe quoted or plain scalar `license`/`compatibility`, one-level string `metadata`, and inert `allowed-tools`. It rejects duplicate keys, unknown fields, implicit bool/null/number types, anchors, aliases, tags, block/flow/list/complex YAML, excessive depth/count/length, and malformed delimiters.

This conservative subset is an explicit compatibility boundary. Double-quoted JSON-style strings and safe single-quoted strings preserve colons, `#`, and escapes; unsupported YAML produces reviewable findings instead of permissive coercion. The complete original `SKILL.md` bytes, including its body, are persisted unchanged. Parsed `allowed-tools` values are declarations only and cannot grant runtime or host permissions.

Credential checks report only a fixed rule name, canonical relative path, and line number. Messages never contain matched input. Rules cover private-key headers, known token prefixes, and credential assignments, while common placeholders such as `<password>`, `YOUR_API_KEY`, and `changeme` remain clean.

## Two-phase review and atomic import

The API exposes:

- `POST /api/skill-package-inspections/folder`
- `POST /api/skill-package-inspections/archive`
- `POST /api/skill-package-imports`

Inspection responses contain only `inspectionId`, clean state, canonical digest, sanitized manifest, and findings. Folder source paths and entry bytes are never returned. Archive requests accept strict canonical base64 plus a display filename; URLs are not accepted. Request bodies are streamed into a fixed bound before JSON/base64 materialization, and base64 encoded length is checked before decoding.

The cache uses unguessable IDs, TTL, session-count, per-snapshot, total-byte, and ID-generation retry limits under one lock. Dirty sessions retain no entry bytes. Import accepts only `inspectionId`, `create|revise`, and closed target metadata; it never reads the source again. Storage collisions and failures leave the same clean snapshot available for retry. Successful import immediately drops all snapshot/entry bytes and cached-byte accounting while retaining a minimal consumed tombstone until TTL, so replay returns 409 without retaining inert scripts/assets.

Task 12 `create_skill`/`add_skill_revision` remain the sole persistence boundary and provide the `BEGIN IMMEDIATE` transaction. A failure injected after Skill/revision/entry rows were staged but before public `SKL` creation rolled every raw table back, and the identical inspection snapshot then imported successfully.

## Central limits

| Limit | Default |
| --- | ---: |
| Archive input | 16 MiB |
| Members | 256 |
| One file | 2 MiB |
| Total uncompressed | 8 MiB |
| Compression ratio | 100:1 |
| Path / segment / depth | 240 chars / 120 chars / 16 |
| `SKILL.md` / frontmatter | 256 KiB / 64 KiB |
| Frontmatter / metadata fields | 6 / 32 |
| Scalar / allowed tools / tool name | 4096 chars / 32 / 120 chars |
| Findings | 256 |
| Control request / JSON overhead | 16 KiB / 4 KiB |
| Inspection TTL / sessions | 900 seconds / 16 |
| One cached snapshot / all snapshots | 8 MiB / 32 MiB |
| Inspection ID attempts | 8 |

Small injected limits provide N-1/N/N+1 coverage without large fixtures.

## TDD and security evidence

Initial RED failed collection because `promptcard_storage.skill_importer` did not exist. The next behavior batches produced expected RED for missing folder identity handling, missing API service injection/routes, missing archive depth/control-character rejection, unsafe import identifiers, and unbounded request materialization.

The final Task 13 focused suite covers:

- clean folder/ZIP/TAR canonical digest equivalence and binary round trip;
- traversal, root escape, symlink privilege case, controlled reparse/junction bit, and file race;
- ZIP/TAR links, hardlinks, devices, FIFO, encryption, count/size/ratio bombs, duplicates, casefold/NFC, Windows ambiguous names, and nested archives;
- malformed/complex frontmatter, credentials/placeholders, inert unsupported package content, and no-execution probes;
- inspection TTL/capacity/consumed behavior, source replacement after inspection, success byte release, Storage retry, create/revise, and raw rollback;
- fixed/redacted API errors, URL/unknown field rejection, strict base64, unsafe metadata, and request-body bounds.

No-execution probes place a marker-writing Python installer and package-manager hook metadata in an archive, patch `eval`, `exec`, dynamic import, subprocess entry points, and `os.system` to fail immediately, and verify the marker remains absent while exact script bytes survive inspection.

## Verification

- Task 13 focused tests: `Ran 39`, `OK (skipped=1)` for the conditional Windows symlink case.
- Focused Ruff: all checks passed.
- Full Storage release gate: `Ran 241 tests in 112.328s`, `OK (skipped=2)`.
- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run build`: passed (`1911` modules). Existing CSS syntax, mixed Tauri import, and chunk-size warnings remain.

No dependency was added. All test TEMP/output paths stayed inside the current F: workspace and were removed after verification.
