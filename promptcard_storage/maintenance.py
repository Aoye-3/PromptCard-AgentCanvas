from __future__ import annotations

import argparse
import hashlib
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
from .reference_codes import ReferenceCodeError, ReferenceNamespace, parse_reference_code
from .store import (
    DATABASE_NAME,
    SCHEMA_VERSION,
    SERVICE_VERSION,
    JsonCollectionStore,
    MigrationError,
    SqliteStore,
    _PUBLIC_REFERENCE_EDGE_WHITESPACE,
    iso_now,
)


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
    _validate_assets_path(source / "assets")
    data_dir.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    staging_dir = data_dir.parent / f".{data_dir.name}.restore-{token}"
    validation_dir = data_dir.parent / f".{data_dir.name}.validation-{token}"
    try:
        shutil.copytree(source, staging_dir)
        _validate_assets_path(staging_dir / "assets")
        manifest_version = _read_manifest_version(staging_dir / "manifest.json")
        _validate_database(
            staging_dir / DATABASE_NAME,
            expected_version=manifest_version,
        )
        JsonCollectionStore(validation_dir)
        _checkpoint_database(validation_dir / DATABASE_NAME)
        if manifest_version == SCHEMA_VERSION:
            _validate_schema_matches(
                staging_dir / DATABASE_NAME,
                validation_dir / DATABASE_NAME,
            )
            _validate_reference_rows(staging_dir / DATABASE_NAME)
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
        )
        _validate_schema_matches(
            staging_dir / DATABASE_NAME,
            validation_dir / DATABASE_NAME,
        )
        _validate_reference_rows(staging_dir / DATABASE_NAME)

        data_dir.mkdir(parents=True, exist_ok=True)
        if (data_dir / DATABASE_NAME).exists():
            _checkpoint_database(data_dir / DATABASE_NAME)
        _commit_staged_restore(data_dir, staging_dir, token)
    except MigrationError:
        raise
    except Exception as exc:
        raise MigrationError("Backup staging validation failed") from exc
    finally:
        _remove_path_best_effort(staging_dir)
        _remove_path_best_effort(validation_dir)


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
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise MigrationError("Backup schema foreign keys are invalid")
    except sqlite3.DatabaseError as exc:
        raise MigrationError("Backup database schema metadata is invalid") from exc
    finally:
        if connection is not None:
            connection.close()


def _validate_schema_matches(database_path: Path, canonical_path: Path) -> None:
    if _schema_fingerprint(database_path) != _schema_fingerprint(canonical_path):
        raise MigrationError("Backup schema does not match canonical schema v10")


def _schema_fingerprint(database_path: Path) -> tuple[object, ...]:
    connection = sqlite3.connect(database_path)
    try:
        table_rows = connection.execute(
            """SELECT name, sql FROM sqlite_master
               WHERE type='table' AND name NOT LIKE 'sqlite_%'
               ORDER BY name"""
        ).fetchall()
        fingerprint: list[object] = []
        for table_name, table_sql in table_rows:
            quoted_table = table_name.replace("'", "''")
            indexes = []
            for index_row in connection.execute(
                f"PRAGMA index_list('{quoted_table}')"
            ).fetchall():
                index_name = index_row[1]
                quoted_index = index_name.replace("'", "''")
                index_sql_row = connection.execute(
                    "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
                    (index_name,),
                ).fetchone()
                indexes.append((
                    tuple(index_row[1:]),
                    tuple(connection.execute(
                        f"PRAGMA index_xinfo('{quoted_index}')"
                    ).fetchall()),
                    _normalize_schema_sql(
                        index_sql_row[0] if index_sql_row else None
                    ),
                ))
            fingerprint.append((
                table_name,
                _normalize_schema_sql(table_sql),
                tuple(connection.execute(
                    f"PRAGMA table_info('{quoted_table}')"
                ).fetchall()),
                tuple(connection.execute(
                    f"PRAGMA foreign_key_list('{quoted_table}')"
                ).fetchall()),
                tuple(sorted(indexes, key=lambda item: item[0][0])),
            ))
        return tuple(fingerprint)
    finally:
        connection.close()


def _normalize_schema_sql(sql: str | None) -> str | None:
    return "".join(sql.lower().split()) if isinstance(sql, str) else None


def _validate_reference_rows(database_path: Path) -> None:
    connection = sqlite3.connect(database_path)
    try:
        rows = connection.execute(
            """SELECT public_code, namespace, owner_scope, internal_id, created_at
               FROM public_references"""
        ).fetchall()
    except sqlite3.DatabaseError as exc:
        raise MigrationError("Backup public reference registry is invalid") from exc
    finally:
        connection.close()
    global_namespaces = {
        ReferenceNamespace.PROJECT,
        ReferenceNamespace.PROMPT_BUNDLE,
        ReferenceNamespace.SKILL,
    }
    for public_code, namespace_value, owner_scope, internal_id, created_at in rows:
        try:
            namespace = ReferenceNamespace(namespace_value)
            parsed = parse_reference_code(public_code, expected_namespace=namespace)
        except (TypeError, ValueError, ReferenceCodeError) as exc:
            raise MigrationError("Backup public reference row is invalid") from exc
        if (
            not isinstance(public_code, str)
            or parsed.code != public_code
            or not isinstance(owner_scope, str)
            or not isinstance(internal_id, str)
            or not internal_id
            or internal_id != internal_id.strip(_PUBLIC_REFERENCE_EDGE_WHITESPACE)
            or owner_scope != owner_scope.strip(_PUBLIC_REFERENCE_EDGE_WHITESPACE)
            or (namespace in global_namespaces) != (owner_scope == "")
            or type(created_at) is not int
            or created_at < 0
        ):
            raise MigrationError("Backup public reference row is invalid")


def _validate_assets_path(assets_path: Path) -> None:
    if assets_path.is_symlink() or (
        assets_path.exists() and not assets_path.is_dir()
    ):
        raise MigrationError("Backup assets entry must be a directory")


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
        recovery_failures: list[str] = []
        if database_moved:
            database_error = _restore_file_with_fallback(
                rollback_database, target_database
            )
            if database_error is not None:
                recovery_failures.append(f"database: {database_error}")
        elif database_installed:
            try:
                _remove_path(target_database)
            except OSError as recovery_error:
                recovery_failures.append(f"database cleanup: {recovery_error}")
        if assets_moved:
            assets_error = _restore_tree_with_fallback(
                rollback_assets, target_assets
            )
            if assets_error is not None:
                recovery_failures.append(f"assets: {assets_error}")
        elif assets_installed:
            try:
                _remove_path(target_assets)
            except OSError as recovery_error:
                recovery_failures.append(f"assets cleanup: {recovery_error}")
        if recovery_failures:
            rescue_paths = [
                str(path) for path in (rollback_database, rollback_assets)
                if path.exists()
            ]
            raise MigrationError(
                "Backup restore recovery failed; rollback retained for manual "
                f"recovery at {rescue_paths}: {'; '.join(recovery_failures)}"
            ) from exc
        raise MigrationError("Backup restore commit failed") from exc
    else:
        _remove_path_best_effort(rollback_database)
        _remove_path_best_effort(rollback_assets)


def _restore_file_with_fallback(rollback_path: Path, target_path: Path) -> str | None:
    try:
        os.replace(rollback_path, target_path)
        return None
    except OSError as replace_error:
        try:
            if not rollback_path.is_file():
                raise OSError("database rollback rescue file is missing")
            expected_digest = _file_digest(rollback_path)
            _remove_path(target_path)
            shutil.copy2(rollback_path, target_path)
            if not target_path.is_file() or _file_digest(target_path) != expected_digest:
                raise OSError("database fallback verification failed")
            _remove_path_best_effort(rollback_path)
            return None
        except OSError as fallback_error:
            return f"replace failed ({replace_error}); fallback failed ({fallback_error})"


def _restore_tree_with_fallback(rollback_path: Path, target_path: Path) -> str | None:
    try:
        os.replace(rollback_path, target_path)
        return None
    except OSError as replace_error:
        try:
            if not rollback_path.is_dir():
                raise OSError("assets rollback rescue directory is missing")
            expected_fingerprint = _tree_fingerprint(rollback_path)
            _remove_path(target_path)
            shutil.copytree(rollback_path, target_path)
            if (
                not target_path.is_dir()
                or _tree_fingerprint(target_path) != expected_fingerprint
            ):
                raise OSError("assets fallback verification failed")
            _remove_path_best_effort(rollback_path)
            return None
        except OSError as fallback_error:
            return f"replace failed ({replace_error}); fallback failed ({fallback_error})"


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _tree_fingerprint(root: Path) -> tuple[tuple[str, str], ...]:
    return tuple(
        (str(path.relative_to(root)), _file_digest(path))
        for path in sorted(root.rglob("*"))
        if path.is_file()
    )


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


def _remove_path_best_effort(path: Path) -> None:
    try:
        _remove_path(path)
    except OSError:
        pass


if __name__ == "__main__":
    main()
