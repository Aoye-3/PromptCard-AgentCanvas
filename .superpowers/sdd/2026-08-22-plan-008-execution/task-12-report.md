# Task 12 Report: Canonical Immutable Skill Packages

## Outcome

Implemented schema v13 canonical Skill package revisions in PromptCard Storage. Existing builtin and external instruction/reference revisions migrate deterministically into ordered package entries, while new revisions can preserve exact binary instruction, reference, script, and asset bytes as inert BLOB data.

## Public identity and compatibility

- Existing internal `skills.id` and slug lookups remain accepted by `get_skill` and `add_skill_revision`.
- Responses retain the existing `id` field for compatibility and add `referenceCode` as the authoritative stable public `SKL` identity.
- Exact `SKL` lookup is case-insensitive through `public_references`; the same code survives revision creation, archive, restore, backup, and restore.
- List responses remain summaries and do not include package bytes. Detail revisions return a closed entry DTO with `type`, normalized `path`, `contentType`, `size`, SHA-256 `digest`, and strict canonical `contentBase64`.
- Legacy `instructions` and `references` response fields remain available to the current local-Agent adapter.

## Canonical digest decision

New and migrated revisions expose `digestVersion: skill-package-v1`. The revision digest uses SHA-256 over an unambiguous length-prefixed preimage containing:

1. the digest format version;
2. the entry count;
3. each entry's type;
4. its normalized relative POSIX path; and
5. its exact bytes.

Entries are sorted by canonical path before hashing, so caller input order does not affect the digest. A one-byte, path, or type change does affect it. Paths normalize backslashes to `/` and Unicode to NFC, and reject absolute/drive paths, NUL, empty segments, `.`, and `..`. Duplicate canonical paths fail before the Storage transaction begins.

The v12 legacy digest is not relabeled as canonical. Migration stores it in `legacyDigest`, records it in closed provenance `legacyMetadata`, and replaces the revision's primary `digest` with canonical v1. This gives an explicit compatibility boundary rather than two meanings for one digest field.

## Schema and immutability

Schema v13 adds:

- Skill lifecycle columns (`active` / `archived`);
- revision digest-version, legacy-digest, provenance, and declared-capability columns;
- `skill_package_entries` with canonical order/path, typed metadata, exact BLOB bytes, size, and per-entry digest; and
- six triggers that reject revision/entry UPDATE, DELETE, and `INSERT OR REPLACE` replacement.

The replacement guards do not depend on recursive delete triggers, and tests run the bypass matrix with `PRAGMA recursive_triggers=OFF`.

Archive and restore update only Skill lifecycle fields. Revisions, entries, digests, provenance, capabilities, and the public `SKL` row remain unchanged.

## Provenance and capabilities

- Provenance is closed to `source`, `originLabel`, and migration-owned `legacyMetadata`.
- `source` is derived as `builtin` or `external`; callers cannot override it through provenance.
- Absolute/local path-shaped labels and credential-shaped labels are rejected.
- Declared capabilities are closed to normalized arrays for tools, network, executables, models, and other declarations.
- These declarations create no host pins, tool grants, execution permission, projection, or runtime policy change.

No package ingestion/read/migration path imports, evaluates, executes, or invokes stored content. Script, asset, and reference bytes are handled only as data.

## API changes

- Added `POST /api/skills/{skill_id}/archive`.
- Added `POST /api/skills/{skill_id}/restore`.
- Existing list/get/create/revision routes remain compatible and now project canonical package metadata.
- Added the two response fields used by the frontend summary type: `referenceCode` and `lifecycleStatus`.

Host pinning/projection remains Task 14. Folder/archive inspection, archive bomb/link/credential/frontmatter findings, and import-source security remain Task 13. Skill Hub management interactions remain Task 15.

## TDD evidence

Initial RED: 5 expected failures covering digest sensitivity/order, normalized path collisions, binary round trip, stable public identity/lifecycle, and closed provenance/capabilities.

Second RED: archive route returned 404. A later focused RED proved migrated provenance lacked closed `legacyMetadata` before that field was implemented.

Focused final result:

```text
Ran 15 tests in 5.243s
OK
```

## Verification

- Full Storage release gate, using workspace `agent-runtime/backend/.venv` Python 3.12 plus root `.venv/Lib/site-packages` on `PYTHONPATH` for `jsonschema`, with workspace-local `TEMP`/`TMP`:

  ```text
  Ran 196 tests in 90.540s
  OK (skipped=1)
  ```

  The one conditional skip is the existing Windows symlink-privilege case.

- Raw schema tests verify BLOB storage, exact bytes, v13 metadata columns, the exact six-trigger set, v12 migration, migrated bypass rejection, and restored trigger presence.
- `npx.cmd tsc --noEmit`: PASS. (`npm run typecheck` is not defined in this repository.)
- `npm.cmd run build`: PASS after rerunning outside the restricted sandbox so Vite could spawn the workspace-local esbuild process. Existing CSS/chunk-size warnings remain.
- `npm.cmd test -- --run src/components/skills/SkillHubScreen.test.tsx`: contract tests 29/29 PASS; focused Vitest 1/1 PASS.

No dependency was installed and no Task 5 fixture or execution-plan file was included.
