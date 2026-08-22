from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .backup import BackupManager
from .store import (
    DATABASE_NAME,
    SCHEMA_VERSION,
    SERVICE_VERSION,
    JsonCollectionStore,
    MigrationError,
    SqliteStore,
    _PUBLIC_REFERENCE_EDGE_WHITESPACE_SQL,
    iso_now,
)


_V10_TABLES = {
    "agent_conversation_messages",
    "agent_conversation_proposals",
    "agent_conversation_turns",
    "agent_conversations",
    "assets",
    "browser_imports",
    "image_asset_derivations",
    "image_generation_canvas_placements",
    "image_generation_conversations",
    "image_generation_runs",
    "presets",
    "project_resource_folders",
    "project_resources",
    "projects",
    "public_references",
    "recent_captures",
    "schema_migrations",
    "skill_revisions",
    "skills",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="PromptCard storage maintenance")
    parser.add_argument("--data-dir", type=Path, required=True)
    subcommands = parser.add_subparsers(dest="command", required=True)
    backup = subcommands.add_parser("backup")
    backup.add_argument("destination", type=Path)
    subcommands.add_parser("diagnose-assets")
    restore = subcommands.add_parser("restore")
    restore.add_argument("source", type=Path)
    args = parser.parse_args()

    if args.command == "restore":
        restore_backup(args.data_dir, args.source)
        return

    store = SqliteStore(args.data_dir)
    result = store.backup(args.destination) if args.command == "backup" else store.diagnose_assets()
    print(json.dumps(result, ensure_ascii=False, indent=2))


def restore_backup(data_dir: Path, source: Path) -> None:
    if not (source / "manifest.json").is_file() or not (source / DATABASE_NAME).is_file():
        raise MigrationError("Backup is missing manifest.json or promptcard.sqlite3")
    data_dir.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    staging_dir = data_dir.parent / f".{data_dir.name}.restore-{token}"
    try:
        shutil.copytree(source, staging_dir)
        manifest_version = _read_manifest_version(staging_dir / "manifest.json")
        _validate_database(
            staging_dir / DATABASE_NAME,
            expected_version=manifest_version,
            require_strong_v10_registry=manifest_version == SCHEMA_VERSION,
        )
        try:
            JsonCollectionStore(staging_dir)
        except Exception as exc:
            if isinstance(exc, MigrationError):
                raise
            raise MigrationError("Backup staging migration failed") from exc
        _checkpoint_database(staging_dir / DATABASE_NAME)
        _validate_database(
            staging_dir / DATABASE_NAME,
            expected_version=SCHEMA_VERSION,
            require_strong_v10_registry=True,
            require_v10_tables=True,
        )

        data_dir.mkdir(parents=True, exist_ok=True)
        if (data_dir / DATABASE_NAME).exists():
            _checkpoint_database(data_dir / DATABASE_NAME)
        _commit_staged_restore(data_dir, staging_dir, token)
    except MigrationError:
        raise
    except Exception as exc:
        raise MigrationError("Backup staging validation failed") from exc
    finally:
        _remove_path(staging_dir)


def _read_manifest_version(manifest_path: Path) -> int:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MigrationError("Backup manifest is invalid") from exc
    if not isinstance(manifest, dict):
        raise MigrationError("Backup manifest is invalid")
    version = manifest.get("schemaVersion")
    if type(version) is not int or not 1 <= version <= SCHEMA_VERSION:
        raise MigrationError("Backup schema version is not supported")
    return version


def _validate_database(
    database_path: Path,
    *,
    expected_version: int,
    require_strong_v10_registry: bool,
    require_v10_tables: bool = False,
) -> None:
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(database_path)
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity is None or integrity[0] != "ok":
            raise MigrationError("Backup database integrity check failed")
        columns = {
            row[1]: row for row in connection.execute(
                "PRAGMA table_info(schema_migrations)"
            )
        }
        if set(columns) != {"version", "name", "applied_at"}:
            raise MigrationError("Backup migration history schema is invalid")
        if (
            columns["version"][2].upper() != "INTEGER"
            or columns["version"][5] != 1
            or not columns["name"][3]
            or not columns["applied_at"][3]
        ):
            raise MigrationError("Backup migration history schema is invalid")
        rows = connection.execute(
            "SELECT version, typeof(version) FROM schema_migrations ORDER BY version"
        ).fetchall()
        if not rows or any(kind != "integer" for _, kind in rows):
            raise MigrationError("Backup migration history is invalid")
        versions = [row[0] for row in rows]
        if (
            len(versions) != len(set(versions))
            or versions != list(range(versions[0], versions[-1] + 1))
            or versions[-1] != expected_version
            or not 1 <= versions[0] <= expected_version <= SCHEMA_VERSION
        ):
            raise MigrationError("Backup migration history is invalid")
        if require_v10_tables:
            tables = {
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            if not _V10_TABLES.issubset(tables):
                raise MigrationError("Backup schema v10 structure is incomplete")
            if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise MigrationError("Backup schema v10 foreign keys are invalid")
        if require_strong_v10_registry:
            _validate_strong_v10_registry(connection)
    except sqlite3.DatabaseError as exc:
        raise MigrationError("Backup database schema metadata is invalid") from exc
    finally:
        if connection is not None:
            connection.close()


def _validate_strong_v10_registry(connection: sqlite3.Connection) -> None:
    columns = {
        row[1]: row for row in connection.execute(
            "PRAGMA table_info(public_references)"
        )
    }
    public_code = columns.get("public_code")
    schema_row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='public_references'"
    ).fetchone()
    schema_sql = schema_row[0] if schema_row and schema_row[0] else ""
    if (
        public_code is None
        or not public_code[3]
        or _PUBLIC_REFERENCE_EDGE_WHITESPACE_SQL not in schema_sql
    ):
        raise MigrationError("Backup schema v10 public reference registry is weak")


def _checkpoint_database(database_path: Path) -> None:
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        connection.close()


def _commit_staged_restore(data_dir: Path, staging_dir: Path, token: str) -> None:
    target_database = data_dir / DATABASE_NAME
    target_assets = data_dir / "assets"
    staged_database = staging_dir / DATABASE_NAME
    staged_assets = staging_dir / "assets"
    rollback_database = data_dir / f".{DATABASE_NAME}.rollback-{token}"
    rollback_assets = data_dir / f".assets.rollback-{token}"
    had_database = target_database.exists()
    replace_assets = staged_assets.exists()
    had_assets = replace_assets and target_assets.exists()
    database_moved = False
    assets_moved = False
    database_installed = False
    assets_installed = False
    try:
        if had_database:
            os.replace(target_database, rollback_database)
            database_moved = True
        if had_assets:
            os.replace(target_assets, rollback_assets)
            assets_moved = True
        if had_database:
            _backup_rollback_copy(
                rollback_database,
                rollback_assets if assets_moved else target_assets,
                data_dir,
            )
        os.replace(staged_database, target_database)
        database_installed = True
        if replace_assets:
            os.replace(staged_assets, target_assets)
            assets_installed = True
    except Exception as exc:
        if database_moved:
            try:
                os.replace(rollback_database, target_database)
            except OSError:
                pass
        elif database_installed:
            target_database.unlink(missing_ok=True)
        if assets_moved:
            try:
                if assets_installed:
                    _remove_path(target_assets)
                os.replace(rollback_assets, target_assets)
            except OSError:
                pass
        elif assets_installed:
            _remove_path(target_assets)
        raise MigrationError("Backup restore commit failed") from exc
    else:
        _remove_path(rollback_database)
        _remove_path(rollback_assets)


def _backup_rollback_copy(
    rollback_database: Path,
    current_assets: Path,
    data_dir: Path,
) -> None:
    @contextmanager
    def connect() -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(rollback_database)
        try:
            yield connection
        finally:
            connection.close()

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    destination = data_dir.parent / "backups" / f"pre-restore-{stamp}"
    suffix = 1
    while destination.exists():
        destination = data_dir.parent / "backups" / f"pre-restore-{stamp}-{suffix}"
        suffix += 1
    BackupManager(
        rollback_database,
        current_assets,
        DATABASE_NAME,
        SERVICE_VERSION,
        SCHEMA_VERSION,
        connect,
        iso_now,
    ).create(destination)


def _remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
