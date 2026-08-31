from __future__ import annotations

import json
import os
import shutil
import sqlite3
import stat
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Callable, ContextManager


class BackupManager:
    def __init__(
        self,
        database_path: Path,
        assets_dir: Path,
        documents_dir: Path,
        database_name: str,
        service_version: str,
        schema_version: int,
        connect: Callable[[], ContextManager[Any]],
        iso_now: Callable[[], str],
        consistency_lock: ContextManager[Any] | None = None,
    ) -> None:
        self.database_path = database_path
        self.assets_dir = assets_dir
        self.documents_dir = documents_dir
        self.database_name = database_name
        self.service_version = service_version
        self.schema_version = schema_version
        self._connect = connect
        self._iso_now = iso_now
        self._consistency_lock = consistency_lock or nullcontext()

    def create(self, destination: Path) -> dict[str, Any]:
        destination.mkdir(parents=True, exist_ok=False)
        database_copy = destination / self.database_name
        with self._consistency_lock:
            target = sqlite3.connect(database_copy)
            try:
                with self._connect() as source:
                    source.backup(target)
                target.commit()
            finally:
                target.close()
            if self.documents_dir.exists():
                _copy_regular_tree(self.documents_dir, destination / "documents")
            else:
                (destination / "documents").mkdir()
        if self.assets_dir.exists():
            shutil.copytree(self.assets_dir, destination / "assets")
        manifest = {
            "createdAt": self._iso_now(),
            "serviceVersion": self.service_version,
            "schemaVersion": self.schema_version,
            "database": self.database_name,
            "assets": len(list((destination / "assets").iterdir())) if (destination / "assets").exists() else 0,
            "documents": sum(
                1 for path in (destination / "documents").rglob("*") if path.is_file()
            ),
        }
        (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return manifest


def _copy_regular_tree(source: Path, destination: Path) -> None:
    try:
        root_metadata = os.lstat(source)
    except OSError as exc:
        raise ValueError("Document storage tree cannot be inspected") from exc
    if _is_reparse_point(root_metadata) or not stat.S_ISDIR(root_metadata.st_mode):
        raise ValueError("Document storage entry must be a regular directory")
    pending = [source]
    try:
        while pending:
            directory = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    metadata = os.lstat(entry.path)
                    if _is_reparse_point(metadata):
                        raise ValueError(
                            "Document storage tree contains a link or reparse point"
                        )
                    if stat.S_ISDIR(metadata.st_mode):
                        pending.append(Path(entry.path))
                    elif not stat.S_ISREG(metadata.st_mode):
                        raise ValueError("Document storage tree contains a special file")
    except ValueError:
        raise
    except OSError as exc:
        raise ValueError("Document storage tree cannot be inspected") from exc
    shutil.copytree(source, destination)


def _is_reparse_point(metadata: object) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & reparse_flag)
