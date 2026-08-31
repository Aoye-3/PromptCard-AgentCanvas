from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .backup import BackupManager
from .document_resources import DocumentValidationError, validate_document
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


_RESTORE_LOCKS_GUARD = threading.Lock()
_RESTORE_LOCKS: dict[str, threading.RLock] = {}


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
    with _restore_target_lock(data_dir) as resolved_data_dir:
        _restore_backup_locked(resolved_data_dir, source)


def _restore_backup_locked(data_dir: Path, source: Path) -> None:
    if not (source / "manifest.json").is_file() or not (source / DATABASE_NAME).is_file():
        raise MigrationError("Backup is missing manifest.json or promptcard.sqlite3")
    _validate_assets_path(source / "assets")
    _validate_documents_path(source / "documents")
    data_dir.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    staging_dir = data_dir.parent / f".{data_dir.name}.restore-{token}"
    validation_dir = data_dir.parent / f".{data_dir.name}.validation-{token}"
    try:
        shutil.copytree(source, staging_dir)
        _validate_assets_path(staging_dir / "assets")
        _validate_documents_path(staging_dir / "documents")
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
        (staging_dir / "documents").mkdir(exist_ok=True)
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
        _validate_document_resources(
            staging_dir / DATABASE_NAME,
            staging_dir / "documents",
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
        object_rows = connection.execute(
            """SELECT type, name, tbl_name, sql FROM sqlite_master
               WHERE type IN ('table', 'index', 'view', 'trigger')
                 AND name NOT GLOB 'sqlite_*'
               ORDER BY type, name"""
        ).fetchall()
        fingerprint: list[object] = []
        for object_type, object_name, table_name, object_sql in object_rows:
            details: tuple[object, ...] = ()
            if object_type == "table":
                quoted_table = object_name.replace("'", "''")
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
                details = (
                    tuple(connection.execute(
                        f"PRAGMA table_info('{quoted_table}')"
                    ).fetchall()),
                    tuple(connection.execute(
                        f"PRAGMA foreign_key_list('{quoted_table}')"
                    ).fetchall()),
                    tuple(sorted(indexes, key=lambda item: item[0][0])),
                )
            elif object_type == "index":
                quoted_index = object_name.replace("'", "''")
                details = (tuple(connection.execute(
                    f"PRAGMA index_xinfo('{quoted_index}')"
                ).fetchall()),)
            fingerprint.append((
                object_type,
                object_name,
                table_name,
                _normalize_schema_sql(object_sql),
                details,
            ))
        return tuple(fingerprint)
    finally:
        connection.close()


def _normalize_schema_sql(sql: str | None) -> str | None:
    if not isinstance(sql, str):
        return None
    normalized: list[str] = []
    quote_end: str | None = None
    index = 0
    while index < len(sql):
        character = sql[index]
        if quote_end is None:
            if character.isspace():
                index += 1
                continue
            if character in {"'", '"', "`", "["}:
                quote_end = "]" if character == "[" else character
                normalized.append(character)
            else:
                normalized.append(character.lower())
            index += 1
            continue
        normalized.append(character)
        if character == quote_end:
            if index + 1 < len(sql) and sql[index + 1] == quote_end:
                normalized.append(sql[index + 1])
                index += 2
                continue
            quote_end = None
        index += 1
    return "".join(normalized)


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
    _validate_regular_tree(assets_path, "assets")


def _validate_documents_path(documents_path: Path) -> None:
    _validate_regular_tree(documents_path, "documents")


def _validate_regular_tree(tree_path: Path, label: str) -> None:
    try:
        root_metadata = os.lstat(tree_path)
    except FileNotFoundError:
        return
    except OSError as exc:
        raise MigrationError(f"Backup {label} tree cannot be inspected") from exc
    if _is_reparse_point(root_metadata) or not stat.S_ISDIR(root_metadata.st_mode):
        raise MigrationError(f"Backup {label} entry must be a regular directory")

    pending = [tree_path]
    try:
        while pending:
            directory = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    path = Path(entry.path)
                    metadata = os.lstat(path)
                    if _is_reparse_point(metadata):
                        raise MigrationError(
                            f"Backup {label} tree contains a link or reparse point"
                        )
                    if stat.S_ISDIR(metadata.st_mode):
                        pending.append(path)
                    elif not stat.S_ISREG(metadata.st_mode):
                        raise MigrationError(
                            f"Backup {label} tree contains a special file"
                        )
    except MigrationError:
        raise
    except OSError as exc:
        raise MigrationError(f"Backup {label} tree cannot be inspected") from exc


def _validate_document_resources(database_path: Path, documents_dir: Path) -> None:
    connection = sqlite3.connect(database_path)
    try:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_document_resources'"
        ).fetchone()
        if table is None:
            return
        rows = connection.execute(
            """SELECT relative_path, original_filename, content_type, size, sha256,
                      normalized_text_digest
               FROM project_document_resources"""
        ).fetchall()
    finally:
        connection.close()

    expected_paths: set[str] = set()
    try:
        for relative_path, filename, content_type, size, sha256, text_digest in rows:
            path_parts = Path(relative_path).parts
            if len(path_parts) != 2 or path_parts[0] != "documents":
                raise MigrationError("Backup document resource path is invalid")
            document_path = documents_dir / path_parts[1]
            expected_paths.add(path_parts[1])
            metadata = os.lstat(document_path)
            if _is_reparse_point(metadata) or not stat.S_ISREG(metadata.st_mode):
                raise MigrationError("Backup document resource is not a regular file")
            validated = validate_document(filename, content_type, document_path.read_bytes())
            if (
                validated.size != size
                or validated.sha256 != sha256
                or validated.normalized_text_digest != text_digest
            ):
                raise MigrationError("Backup document resource integrity check failed")
        on_disk = {
            path.relative_to(documents_dir).as_posix()
            for path in documents_dir.rglob("*")
            if path.is_file()
        } if documents_dir.exists() else set()
        if on_disk != expected_paths:
            raise MigrationError("Backup documents do not match registered resources")
    except MigrationError:
        raise
    except (OSError, DocumentValidationError) as exc:
        raise MigrationError("Backup document resource validation failed") from exc


def _is_reparse_point(metadata: object) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & reparse_flag)


@contextmanager
def _restore_target_lock(data_dir: Path) -> Iterator[Path]:
    resolved_data_dir = data_dir.resolve(strict=False)
    lock_key = os.path.normcase(str(resolved_data_dir))
    with _RESTORE_LOCKS_GUARD:
        process_lock = _RESTORE_LOCKS.setdefault(lock_key, threading.RLock())
    with process_lock:
        resolved_data_dir.parent.mkdir(parents=True, exist_ok=True)
        lock_path = resolved_data_dir.parent / f".{resolved_data_dir.name}.restore.lock"
        with lock_path.open("a+b") as lock_file:
            _lock_restore_file(lock_file)
            try:
                yield resolved_data_dir
            finally:
                _unlock_restore_file(lock_file)


def _lock_restore_file(lock_file: object) -> None:
    if os.name == "nt":
        import msvcrt

        try:
            lock_file.seek(0, os.SEEK_END)
            if lock_file.tell() == 0:
                lock_file.write(b"\0")
                lock_file.flush()
        except OSError as exc:
            raise MigrationError("Failed preparing restore lock") from exc
        retry_delay = 0.05
        while True:
            try:
                lock_file.seek(0)
            except OSError as exc:
                raise MigrationError("Failed acquiring restore lock") from exc
            try:
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError as exc:
                if not _is_windows_lock_contention(exc):
                    raise MigrationError("Failed acquiring restore lock") from exc
            time.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 0.25)
    try:
        import fcntl
    except ImportError:
        return
    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)


def _is_windows_lock_contention(error: OSError) -> bool:
    return (
        error.errno in {errno.EACCES, errno.EAGAIN}
        or getattr(error, "winerror", None) in {32, 33}
    )


def _unlock_restore_file(lock_file: object) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            return
        try:
            import fcntl
        except ImportError:
            return
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    except OSError:
        # Closing the file descriptor also releases the platform lock.
        pass


def _checkpoint_database(database_path: Path) -> None:
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        connection.close()


def _commit_staged_restore(data_dir: Path, staging_dir: Path, token: str) -> None:
    target_database = data_dir / DATABASE_NAME
    target_assets = data_dir / "assets"
    target_documents = data_dir / "documents"
    staged_database = staging_dir / DATABASE_NAME
    staged_assets = staging_dir / "assets"
    staged_documents = staging_dir / "documents"
    rollback_database = data_dir / f".{DATABASE_NAME}.rollback-{token}"
    rollback_assets = data_dir / f".assets.rollback-{token}"
    rollback_documents = data_dir / f".documents.rollback-{token}"
    had_database = target_database.exists()
    replace_assets = staged_assets.exists()
    had_assets = replace_assets and target_assets.exists()
    replace_documents = staged_documents.exists()
    had_documents = replace_documents and target_documents.exists()
    database_moved = False
    assets_moved = False
    documents_moved = False
    database_installed = False
    assets_installed = False
    documents_installed = False
    try:
        if had_database:
            os.replace(target_database, rollback_database)
            database_moved = True
        if had_assets:
            os.replace(target_assets, rollback_assets)
            assets_moved = True
        if had_documents:
            os.replace(target_documents, rollback_documents)
            documents_moved = True
        if had_database:
            _backup_rollback_copy(
                rollback_database,
                rollback_assets if assets_moved else target_assets,
                rollback_documents if documents_moved else target_documents,
                data_dir,
            )
        os.replace(staged_database, target_database)
        database_installed = True
        if replace_assets:
            os.replace(staged_assets, target_assets)
            assets_installed = True
        if replace_documents:
            os.replace(staged_documents, target_documents)
            documents_installed = True
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
        if documents_moved:
            documents_error = _restore_tree_with_fallback(
                rollback_documents, target_documents
            )
            if documents_error is not None:
                recovery_failures.append(f"documents: {documents_error}")
        elif documents_installed:
            try:
                _remove_path(target_documents)
            except OSError as recovery_error:
                recovery_failures.append(f"documents cleanup: {recovery_error}")
        if recovery_failures:
            rescue_paths = [
                str(path)
                for path in (rollback_database, rollback_assets, rollback_documents)
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
        _remove_path_best_effort(rollback_documents)


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
    current_documents: Path,
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
        current_documents,
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
