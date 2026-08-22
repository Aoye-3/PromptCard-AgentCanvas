from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import time
from pathlib import Path

from .store import DATABASE_NAME, SCHEMA_VERSION, MigrationError, SqliteStore


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
    manifest_path = source / "manifest.json"
    source_database = source / DATABASE_NAME
    if not manifest_path.is_file() or not source_database.is_file():
        raise MigrationError("Backup is missing manifest.json or promptcard.sqlite3")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MigrationError("Backup manifest is invalid") from exc
    if not isinstance(manifest, dict):
        raise MigrationError("Backup manifest is invalid")
    manifest_version = manifest.get("schemaVersion")
    if (
        type(manifest_version) is not int
        or not 1 <= manifest_version <= SCHEMA_VERSION
    ):
        raise MigrationError("Backup schema version is not supported")
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(source_database)
        integrity_row = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity_row is None or integrity_row[0] != "ok":
            raise MigrationError("Backup database integrity check failed")
        version_row = connection.execute(
            "SELECT MAX(version) FROM schema_migrations"
        ).fetchone()
        database_version = version_row[0] if version_row is not None else None
        if (
            type(database_version) is not int
            or not 1 <= database_version <= SCHEMA_VERSION
        ):
            raise MigrationError("Backup database schema version is not supported")
        if database_version != manifest_version:
            raise MigrationError("Backup manifest schema version does not match database")
    except sqlite3.DatabaseError as exc:
        raise MigrationError("Backup database schema metadata is invalid") from exc
    finally:
        if connection is not None:
            connection.close()

    data_dir.mkdir(parents=True, exist_ok=True)
    if (data_dir / DATABASE_NAME).exists():
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        SqliteStore(data_dir).backup(data_dir.parent / "backups" / f"pre-restore-{stamp}")

    temp_database = data_dir / f".{DATABASE_NAME}.restore"
    shutil.copy2(source_database, temp_database)
    os.replace(temp_database, data_dir / DATABASE_NAME)

    source_assets = source / "assets"
    if source_assets.exists():
        temp_assets = data_dir / ".assets.restore"
        if temp_assets.exists():
            shutil.rmtree(temp_assets)
        shutil.copytree(source_assets, temp_assets)
        current_assets = data_dir / "assets"
        if current_assets.exists():
            shutil.rmtree(current_assets)
        os.replace(temp_assets, current_assets)


if __name__ == "__main__":
    main()
