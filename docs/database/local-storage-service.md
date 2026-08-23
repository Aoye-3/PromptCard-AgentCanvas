# Local Storage Service

`promptcard_storage` is the sole durable owner of projects, Prompt Library presets, Trash state, asset metadata/bytes, Recent Capture metadata, image-generation runs, public references, immutable context packs, canonical Skill packages, and host pins. During editable development, `PROMPTCARD_STORAGE_DATA_DIR` resolves to the repository data root:

```text
data/
  promptcard.sqlite3
  assets/
```

Every maintained launcher must use this same path and reject a healthy Storage Service whose `/health` response reports a different storage root. Packaged builds may move the same database/assets contract only through an explicit migration.

## SQLite Contract

- `SqliteStore` is the compatibility facade for project, Prompt Library, and Recent Capture CRUD plus transaction ownership. `StorageInitializer`, `AssetStore`, and `BackupManager` own JSON initialization, asset files/diagnostics, and consistent backup creation respectively.
- FastAPI routes are registered by `create_app(storage)`, allowing route contract tests to inject an isolated temporary store while the exported default `app` keeps the existing service startup contract.
- Schema version `1` uses `projects`, `presets`, `assets`, `schema_migrations`, and `browser_imports`.
- Schema version `2` adds `recent_captures`. Existing version `1` databases migrate in place at startup by creating the table and recording the migration.
- Schema version `3` adds append-only `image_generation_runs` plus project/node pagination indexes. Existing version `2` databases migrate in place without rewriting projects, presets, captures, or assets.
- Schema version `4` adds project image-generation conversations, nullable conversation/node run ownership, project/conversation indexes, and durable canvas placements. Existing version `3` runs are deterministically grouped without creating migration placements.
- Schema version `5` adds permanent `image_asset_derivations` for previews, provider inputs, and rasterized visual annotations. Existing originals, derivatives, runs, conversations, and placements remain forward-only.
- Schema version `6` adds asset lifecycle state and tombstones. Schema version `7` adds project resource folders/resources; version `8` adds durable project Agent conversations and the initial Skill registry; version `9` adds nullable per-conversation model binding.
- Schema version `10` adds canonical public reference codes. Version `11` adds immutable Canvas context packs, and version `12` prevents replacement of an existing context snapshot.
- Schema version `13` migrates Skills to immutable canonical package entries with provenance, lifecycle, declared capabilities, and versioned digests.
- Schema version `14` adds independent exact-revision pins for `local-agent` and repository-scoped `codex` hosts. Codex projection files remain derived state coordinated through OS-backed locks and a prepared recovery journal.
- Projects and presets retain their existing JSON payload. Indexed columns own revision, status, ordering, usage, and timestamps.
- Recent Capture rows retain their full JSON payload while indexed columns own `asset_id`, `kind`, `status`, capture time, timestamps, and revision.
- Image-generation rows retain the immutable normalized request snapshot and terminal result/error payload while indexed columns own project, optional conversation/node, connection, provider, model, state, and lifecycle timestamps. Conversation, placement, and derivation rows are permanent and have no ordinary delete path.
- Active and Trash records share one table. Delete and restore are single transactions.
- Connections enable WAL, foreign keys, a busy timeout, and full synchronous durability. Writes begin with `BEGIN IMMEDIATE`.
- Duplicate creates and stale revisions return conflicts instead of overwriting data.
- Asset diagnostics include references from active/Trash projects, active/Trash Prompt presets, Recent Capture records, succeeded generation-run `outputAssetIds`, and both sides of every derivation before reporting unreferenced files.

Image-generation history is not a child collection of a project. Deleting a node, trashing a project, or permanently deleting project Trash leaves matching runs queryable and their generated output assets strongly referenced. There is no ordinary run deletion API or automatic retention cleanup.

## JSON Migration

When `promptcard.sqlite3` is absent, startup strictly reads the four legacy JSON files. Invalid JSON, invalid shapes, or conflicting duplicate IDs abort startup without creating a database. If an active record and Trash record share an ID with identical business payloads, the newer active state wins and the redundant Trash copy is omitted. Valid source files and an asset manifest are copied to `backups/storage-json-v1-<UTC>/`, then imported and verified in one migration transaction.

Legacy JSON remains unchanged after migration and is never written again. The Vite compatibility endpoints are read-only.

## Maintenance

Use the maintenance module while the storage service is stopped. Point `--data-dir` at the active profile data directory:

```powershell
python -m promptcard_storage.maintenance --data-dir logs\desktop-profile\data backup logs\desktop-profile\backups\manual-backup
python -m promptcard_storage.maintenance --data-dir logs\desktop-profile\data diagnose-assets
python -m promptcard_storage.maintenance --data-dir logs\desktop-profile\data restore logs\desktop-profile\backups\manual-backup
```

Backups use the SQLite backup API and include the database, assets, and a manifest. Restore validates schema and database integrity and creates a pre-restore snapshot when current storage exists. Repository-local Codex projections are reproducible derived state and are not part of the Storage database/assets backup.

## Verification

The Storage release gate discovers every `test_*.py` file under `promptcard_storage/tests` with the repository Agent backend environment. Use that explicit workspace interpreter so FastAPI and image-codec dependencies such as `pillow_heif` are present; do not install them into system Python to make an ambient `npm.cmd run storage:test` pass:

```powershell
.\agent-runtime\backend\.venv\Scripts\python.exe -m unittest discover -s promptcard_storage/tests -p "test_*.py"
.\agent-runtime\backend\.venv\Scripts\python.exe -m unittest promptcard_storage.tests.test_app
.\agent-runtime\backend\.venv\Scripts\python.exe -m pytest promptcard_storage/tests/test_image_runs.py -q
.\agent-runtime\backend\.venv\Scripts\python.exe -m pytest promptcard_storage/tests/test_image_assets_v5.py -q
Push-Location agent-runtime\backend
.\.venv\Scripts\python.exe -m pytest tests\test_image_generation_storage_integration.py -q
Pop-Location
```
