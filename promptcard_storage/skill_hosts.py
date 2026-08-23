from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import stat as stat_module
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .skill_packages import normalize_package_path
from .store import MissingItem, SqliteStore


MANIFEST_NAME = ".promptcard-skill.json"
MANIFEST_FORMAT = "promptcard-codex-projection-v1"
MAX_LOCAL_SNAPSHOT_BYTES = 512 * 1024
MAX_LOCAL_REFERENCES = 64
MAX_LOCAL_CAPABILITY_ITEMS = 64
MAX_LOCAL_CAPABILITY_ITEM_BYTES = 128
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
_OPERATION_ID = re.compile(r"^[0-9a-f]{32}$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_HOSTS = frozenset({"codex", "local-agent"})
_TEXT_TYPES = frozenset({"text/plain", "text/markdown", "application/json"})
_CAPABILITY_KEYS = frozenset({"tools", "network", "executables", "models", "other"})
_JOURNAL_FORMAT = "promptcard-codex-operation-v1"
_MAX_PROJECTION_FILES = 512
_THREAD_LOCKS: dict[str, threading.RLock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


class SkillHostConflict(Exception):
    def __init__(self, code: str, message: str, *, status_code: int = 409) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(code)


class CodexProjectionChange:
    def __init__(
        self,
        target: Path,
        backup: Path | None,
        *,
        installed_manifest: dict[str, Any] | None,
        backup_manifest: dict[str, Any] | None,
    ) -> None:
        self.target = target
        self.backup = backup
        self.installed_manifest = installed_manifest
        self.backup_manifest = backup_manifest
        self._finished = False

    def finalize(self) -> None:
        if self._finished:
            return
        if self.backup is not None and self.backup.exists():
            if self.backup_manifest is None:
                raise SkillHostConflict(
                    "codex_projection_recovery_required",
                    "The projection backup has no durable ownership manifest",
                )
            CodexProjectionAdapter._verify_exact_projection(
                self.backup, self.backup_manifest
            )
            shutil.rmtree(self.backup)
        self._finished = True

    def rollback(self) -> None:
        if self._finished:
            return
        try:
            if self.backup is not None and self.backup.exists():
                if self.backup_manifest is None:
                    raise SkillHostConflict(
                        "codex_projection_recovery_required",
                        "The projection backup has no durable ownership manifest",
                    )
                CodexProjectionAdapter._verify_exact_projection(
                    self.backup, self.backup_manifest
                )
            if self.target.exists():
                if self.installed_manifest is None:
                    raise SkillHostConflict(
                        "codex_projection_recovery_required",
                        "The projection target was recreated during rollback",
                    )
                CodexProjectionAdapter._verify_exact_projection(
                    self.target, self.installed_manifest
                )
                shutil.rmtree(self.target)
            if self.backup is not None and self.backup.exists():
                os.replace(self.backup, self.target)
        finally:
            self._finished = True


class CodexProjectionAdapter:
    def __init__(self, repositories: dict[str, Path]) -> None:
        self._repositories = {
            _repository_scope(scope): Path(path).resolve(strict=True)
            for scope, path in repositories.items()
        }

    def project(
        self,
        scope: str,
        publication_name: str,
        skill: dict[str, Any],
        revision: dict[str, Any],
        *,
        operation_id: str | None = None,
        expected_current: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], CodexProjectionChange | None]:
        scope = _repository_scope(scope)
        publication_name = _publication_name(publication_name)
        repository = self._repository(scope)
        projection_root = repository / ".agents" / "skills"
        staging_root = repository / ".agents" / ".promptcard-projection-staging"
        backup_root = repository / ".agents" / ".promptcard-projection-backups"
        for controlled_root in (projection_root, staging_root, backup_root):
            self._reject_reparse_ancestors(repository, controlled_root)
        target = projection_root / publication_name
        self._reject_reparse_path(target)
        self._validate_projection_entries(revision["entries"])
        manifest = self._manifest(scope, skill, revision)
        if target.exists():
            current = self._read_manifest(target)
            if current == manifest:
                self._verify_exact_projection(target, manifest)
                return manifest, None
            if expected_current is None or current != _disk_manifest(expected_current):
                if _same_projection_owner(current, manifest):
                    raise SkillHostConflict(
                        "codex_projection_drift",
                        "The Codex projection no longer matches its pinned manifest",
                    )
                raise SkillHostConflict(
                    "codex_projection_collision",
                    "The Codex projection path belongs to another owner or repository",
                )
            self._verify_exact_projection(target, _disk_manifest(expected_current))

        projection_root.mkdir(parents=True, exist_ok=True)
        staging_root.mkdir(parents=True, exist_ok=True)
        backup_root.mkdir(parents=True, exist_ok=True)
        for controlled_root in (projection_root, staging_root, backup_root):
            self._reject_reparse_path(controlled_root)
        token = operation_id or uuid.uuid4().hex
        staging = staging_root / f"{token}-new"
        backup = backup_root / f"{token}-new"
        moved_old = False
        prior_manifest = (
            _disk_manifest(expected_current) if expected_current is not None else None
        )
        try:
            staging.mkdir()
            for entry in revision["entries"]:
                path = _projected_path(staging, str(entry["path"]))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(entry["contentBase64"], validate=True))
            (staging / MANIFEST_NAME).write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            if target.exists():
                os.replace(target, backup)
                moved_old = True
                if prior_manifest is None:
                    raise SkillHostConflict(
                        "codex_projection_recovery_required",
                        "The prior projection manifest is unavailable after the swap",
                    )
                try:
                    self._verify_exact_projection(backup, prior_manifest)
                except SkillHostConflict:
                    os.replace(backup, target)
                    moved_old = False
                    raise
            try:
                os.replace(staging, target)
                self._verify_exact_projection(target, manifest)
            except Exception:
                if target.exists():
                    try:
                        self._verify_exact_projection(target, manifest)
                    except SkillHostConflict:
                        raise SkillHostConflict(
                            "codex_projection_recovery_required",
                            "The projection target changed during publication",
                        ) from None
                    shutil.rmtree(target)
                if moved_old and backup.exists():
                    os.replace(backup, target)
                    moved_old = False
                raise
        except SkillHostConflict:
            raise
        except (OSError, ValueError) as exc:
            raise SkillHostConflict("codex_projection_failed", "Codex projection failed") from exc
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
        return manifest, CodexProjectionChange(
            target,
            backup if moved_old else None,
            installed_manifest=manifest,
            backup_manifest=prior_manifest if moved_old else None,
        )

    def unpublish(
        self,
        scope: str,
        publication_name: str,
        ownership: dict[str, Any],
        *,
        operation_id: str | None = None,
    ) -> CodexProjectionChange | None:
        repository = self._repository(_repository_scope(scope))
        target = repository / ".agents" / "skills" / _publication_name(publication_name)
        backup_root = repository / ".agents" / ".promptcard-projection-backups"
        self._reject_reparse_ancestors(repository, backup_root)
        self._reject_reparse_path(target)
        if not target.exists():
            raise SkillHostConflict("codex_projection_drift", "The published Codex projection is missing")
        self._verify_exact_projection(target, _disk_manifest(ownership))
        backup_root.mkdir(parents=True, exist_ok=True)
        self._reject_reparse_path(backup_root)
        backup = backup_root / f"{operation_id or uuid.uuid4().hex}-old"
        try:
            os.replace(target, backup)
            try:
                self._verify_exact_projection(backup, _disk_manifest(ownership))
            except SkillHostConflict:
                os.replace(backup, target)
                raise
        except OSError as exc:
            raise SkillHostConflict("codex_projection_failed", "Codex unpublish failed") from exc
        return CodexProjectionChange(
            target,
            backup,
            installed_manifest=None,
            backup_manifest=_disk_manifest(ownership),
        )

    def _repository(self, scope: str) -> Path:
        repository = self._repositories.get(scope)
        if repository is None:
            raise SkillHostConflict(
                "codex_repository_scope_unavailable",
                "The repository scope is not configured",
                status_code=404,
            )
        return repository

    @staticmethod
    def _validate_projection_entries(entries: list[dict[str, Any]]) -> None:
        paths: list[str] = []
        for entry in entries:
            normalized = normalize_package_path(entry.get("path"))
            _validate_windows_path(normalized)
            paths.append(normalized)
        _validate_projection_path_collisions(paths)

    @staticmethod
    def _manifest(scope: str, skill: dict[str, Any], revision: dict[str, Any]) -> dict[str, Any]:
        return {
            "format": MANIFEST_FORMAT,
            "repositoryScope": scope,
            "owner": str(skill["id"]),
            "promptCardSource": str(skill["source"]),
            "skillReferenceCode": str(skill["referenceCode"]),
            "revision": int(revision["revision"]),
            "digest": str(revision["digest"]),
            "files": [
                {"path": str(entry["path"]), "digest": str(entry["digest"])}
                for entry in revision["entries"]
            ],
        }

    @staticmethod
    def _read_manifest(target: Path) -> dict[str, Any]:
        try:
            raw = _read_stable_file(target / MANIFEST_NAME)
            current = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            raise SkillHostConflict(
                "codex_projection_collision",
                "The Codex projection path is not owned by PromptCard",
            ) from None
        if not isinstance(current, dict):
            raise SkillHostConflict("codex_projection_drift", "The Codex projection manifest is invalid")
        return current

    @classmethod
    def _verify_exact_projection(cls, target: Path, expected_manifest: dict[str, Any]) -> None:
        cls._reject_reparse_path(target)
        try:
            manifest = cls._read_manifest(target)
        except SkillHostConflict:
            raise SkillHostConflict(
                "codex_projection_drift",
                "The pinned Codex projection manifest is unreadable",
            ) from None
        if manifest != expected_manifest:
            raise SkillHostConflict(
                "codex_projection_drift",
                "The Codex projection manifest differs from the pinned manifest",
            )
        files = expected_manifest.get("files")
        if not isinstance(files, list):
            raise SkillHostConflict("codex_projection_drift", "The Codex projection manifest is invalid")
        expected = {MANIFEST_NAME.casefold()}
        for item in files:
            if not isinstance(item, dict) or set(item) != {"path", "digest"}:
                raise SkillHostConflict("codex_projection_drift", "The Codex projection manifest is invalid")
            path_value = item.get("path")
            digest = item.get("digest")
            if not isinstance(path_value, str) or not isinstance(digest, str):
                raise SkillHostConflict("codex_projection_drift", "The Codex projection manifest is invalid")
            try:
                path = _projected_path(target, path_value)
            except ValueError:
                raise SkillHostConflict("codex_projection_drift", "The Codex projection manifest path is unsafe") from None
            folded = path_value.casefold()
            if folded in expected:
                raise SkillHostConflict("codex_projection_drift", "The Codex projection manifest has colliding paths")
            expected.add(folded)
            parts = path_value.split("/")
            for index in range(1, len(parts)):
                expected.add("/".join(parts[:index]).casefold() + "/")
            try:
                actual = "sha256:" + hashlib.sha256(_read_stable_file(path)).hexdigest()
            except OSError:
                raise SkillHostConflict("codex_projection_drift", "A projected file is missing") from None
            if actual != digest:
                raise SkillHostConflict("codex_projection_drift", "A projected file has changed")
        actual_members = _scan_projection_files(target)
        if actual_members != expected:
            raise SkillHostConflict("codex_projection_drift", "The Codex projection contains unexpected files")

    @contextmanager
    def operation_lock(
        self,
        scope: str,
        skill_id: str,
        publication_names: list[str],
    ) -> Iterator[None]:
        repository = self._repository(_repository_scope(scope))
        lock_root = repository / ".agents" / ".promptcard-projection-locks"
        self._reject_reparse_ancestors(repository, lock_root)
        lock_root.mkdir(parents=True, exist_ok=True)
        self._reject_reparse_path(lock_root)
        keys = [f"repository\x00{scope}", f"pin\x00{scope}\x00{skill_id}"]
        keys.extend(f"path\x00{scope}\x00{name.casefold()}" for name in publication_names)
        paths = [
            lock_root / (hashlib.sha256(key.encode("utf-8")).hexdigest() + ".lock")
            for key in sorted(set(keys))
        ]
        with _exclusive_file_locks(paths):
            yield

    def write_journal(self, scope: str, record: dict[str, Any]) -> Path:
        repository = self._repository(_repository_scope(scope))
        journal_root = repository / ".agents" / ".promptcard-projection-journal"
        self._reject_reparse_ancestors(repository, journal_root)
        journal_root.mkdir(parents=True, exist_ok=True)
        self._reject_reparse_path(journal_root)
        operation_id = str(record["operationId"])
        path = journal_root / f"{operation_id}.json"
        _validate_journal_record(record, scope, str(record.get("skillId")), path.name)
        temporary = journal_root / f".{operation_id}.tmp"
        payload = json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise SkillHostConflict(
                "codex_projection_journal_failed",
                "The Codex projection journal could not be persisted",
            ) from exc
        return path

    def pending_journals(self, scope: str, skill_id: str) -> list[tuple[Path, dict[str, Any]]]:
        repository = self._repository(_repository_scope(scope))
        root = repository / ".agents" / ".promptcard-projection-journal"
        try:
            root.lstat()
        except FileNotFoundError:
            return []
        except OSError:
            raise SkillHostConflict(
                "codex_projection_recovery_required",
                "The Codex projection journal directory is unreadable",
            ) from None
        self._reject_reparse_path(root)
        if not root.is_dir():
            raise SkillHostConflict(
                "codex_projection_recovery_required",
                "The Codex projection journal path is not a directory",
            )
        pending: list[tuple[Path, dict[str, Any]]] = []
        candidates: list[Path] = []
        try:
            with os.scandir(root) as entries:
                for item in entries:
                    if not item.name.endswith(".json"):
                        continue
                    candidates.append(Path(item.path))
                    if len(candidates) > 64:
                        raise SkillHostConflict(
                            "codex_projection_recovery_required",
                            "Too many Codex projection journals require recovery",
                        )
        except OSError:
            raise SkillHostConflict(
                "codex_projection_recovery_required",
                "The Codex projection journal directory is unreadable",
            ) from None
        for path in sorted(candidates):
            try:
                record = json.loads(_read_stable_file(path).decode("utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                raise SkillHostConflict(
                    "codex_projection_recovery_required",
                    "A Codex projection journal is unreadable",
                ) from None
            try:
                _validate_journal_record(record, scope, None, path.name)
            except (SkillHostConflict, ValueError):
                raise SkillHostConflict(
                    "codex_projection_recovery_required",
                    "A Codex projection journal is invalid",
                ) from None
            if record.get("skillId") == skill_id and record.get("repositoryScope") == scope:
                pending.append((path, record))
        if len(pending) > 1:
            raise SkillHostConflict(
                "codex_projection_recovery_required",
                "Multiple Codex projection journals require recovery",
            )
        return pending

    def projection_health(self, scope: str, pin: dict[str, Any]) -> dict[str, str]:
        projection = pin.get("projection") or {}
        publication_name = projection.get("publicationName")
        if not isinstance(publication_name, str):
            return {"state": "unhealthy", "code": "codex_projection_manifest_missing"}
        target = self._repository(scope) / ".agents" / "skills" / publication_name
        try:
            if pin["enabled"]:
                self._verify_exact_projection(target, _disk_manifest(projection))
            elif target.exists():
                raise SkillHostConflict(
                    "codex_projection_drift",
                    "A disabled Codex projection remains discoverable",
                )
        except (OSError, ValueError, SkillHostConflict) as exc:
            return {
                "state": "drifted",
                "code": getattr(exc, "code", "codex_projection_drift"),
            }
        return {"state": "healthy"}

    def recovery_paths(self, scope: str, record: dict[str, Any]) -> dict[str, Path | None]:
        repository = self._repository(scope)
        operation_id = str(record["operationId"])
        old_name = record.get("oldPublicationName")
        new_name = record.get("newPublicationName")
        return {
            "oldTarget": (
                repository / ".agents" / "skills" / _publication_name(old_name)
                if isinstance(old_name, str) else None
            ),
            "newTarget": (
                repository / ".agents" / "skills" / _publication_name(new_name)
                if isinstance(new_name, str) else None
            ),
            "oldBackup": repository / ".agents" / ".promptcard-projection-backups" / f"{operation_id}-old",
            "newBackup": repository / ".agents" / ".promptcard-projection-backups" / f"{operation_id}-new",
            "staging": repository / ".agents" / ".promptcard-projection-staging" / f"{operation_id}-new",
        }

    @staticmethod
    def _reject_reparse_ancestors(repository: Path, projection_root: Path) -> None:
        current = repository
        for part in projection_root.relative_to(repository).parts:
            current /= part
            CodexProjectionAdapter._reject_reparse_path(current)

    @staticmethod
    def _reject_reparse_path(path: Path) -> None:
        try:
            stat = path.lstat()
        except FileNotFoundError:
            return
        except OSError:
            raise SkillHostConflict(
                "codex_projection_path_invalid",
                "The Codex projection path cannot be inspected safely",
            ) from None
        if stat_module.S_ISLNK(stat.st_mode) or _is_reparse(stat):
            raise SkillHostConflict(
                "codex_projection_path_invalid",
                "The Codex projection path cannot traverse a link or reparse point",
            )


class SkillHostService:
    def __init__(self, store: SqliteStore, codex: CodexProjectionAdapter) -> None:
        self.store = store
        self.codex = codex

    def update_pin(
        self,
        skill_id: str,
        host: str,
        repository_scope: str | None,
        enabled: bool,
        revision: int,
        *,
        publication_name: str | None = None,
    ) -> dict[str, Any]:
        host = _host(host)
        scope = "" if host == "local-agent" else _repository_scope(repository_scope)
        if host == "local-agent" and (repository_scope is not None or publication_name is not None):
            raise ValueError("local-Agent host state is global")
        skill, canonical = self.store.get_skill_revision(skill_id, revision)
        if skill["trustState"] == "untrusted":
            raise SkillHostConflict("skill_review_required", "The Skill must be reviewed before host enablement")
        if host == "local-agent":
            return self.store.set_skill_host_pin(
                skill["id"], host, scope, enabled, revision, projection=None
            )
        name = publication_name or str(skill["slug"])
        try:
            unlocked_current = self.store.get_skill_host_pin(skill["id"], host, scope)
        except MissingItem:
            unlocked_current = None
        unlocked_prior = (unlocked_current or {}).get("projection") or {}
        unlocked_prior_name = unlocked_prior.get("publicationName")
        names = [name]
        if isinstance(unlocked_prior_name, str):
            names.append(unlocked_prior_name)
        with self.codex.operation_lock(scope, skill["id"], names):
            self._recover_pending(scope, skill["id"], strict=True)
            return self._update_codex_pin_locked(
                skill, canonical, scope, enabled, name
            )

    def _update_codex_pin_locked(
        self,
        skill: dict[str, Any],
        canonical: dict[str, Any],
        scope: str,
        enabled: bool,
        name: str,
    ) -> dict[str, Any]:
        try:
            current = self.store.get_skill_host_pin(skill["id"], "codex", scope)
        except MissingItem:
            current = None
        prior = (current or {}).get("projection") or {}
        prior_name = prior.get("publicationName")
        if current is not None and current["enabled"]:
            health = self.codex.projection_health(scope, current)
            if health["state"] != "healthy":
                raise SkillHostConflict(
                    health.get("code", "codex_projection_drift"),
                    "The current Codex projection has drifted",
                )
        operation_id = uuid.uuid4().hex
        desired_projection = (
            {
                **self.codex._manifest(scope, skill, canonical),
                "publicationName": name,
            }
            if enabled
            else (prior or None)
        )
        desired_pin = {
            "enabled": enabled,
            "revision": canonical["revision"],
            "digest": canonical["digest"],
            "projection": desired_projection,
        }
        record = {
            "format": _JOURNAL_FORMAT,
            "operationId": operation_id,
            "skillId": skill["id"],
            "repositoryScope": scope,
            "oldPublicationName": prior_name if isinstance(prior_name, str) else None,
            "newPublicationName": name if enabled else None,
            "priorPin": _journal_pin(current),
            "desiredPin": desired_pin,
        }
        journal = self.codex.write_journal(scope, record)
        changes: list[CodexProjectionChange] = []
        try:
            if enabled:
                if (
                    current is not None
                    and current["enabled"]
                    and isinstance(prior_name, str)
                    and prior_name != name
                ):
                    removed = self.codex.unpublish(
                        scope, prior_name, prior, operation_id=operation_id
                    )
                    if removed is not None:
                        changes.append(removed)
                projection, projected = self.codex.project(
                    scope,
                    name,
                    skill,
                    canonical,
                    operation_id=operation_id,
                    expected_current=(
                        prior if isinstance(prior_name, str) and prior_name == name else None
                    ),
                )
                if projected is not None:
                    changes.append(projected)
                desired_projection = {**projection, "publicationName": name}
            else:
                if current is None:
                    raise MissingItem(skill["id"])
                if current["enabled"] and isinstance(prior_name, str):
                    removed = self.codex.unpublish(
                        scope, prior_name, prior, operation_id=operation_id
                    )
                    if removed is not None:
                        changes.append(removed)
                desired_projection = prior or None
            result = self.store.set_skill_host_pin(
                skill["id"], "codex", scope, enabled, canonical["revision"],
                projection=desired_projection,
            )
        except Exception as operation_error:
            recovery_paths = self.codex.recovery_paths(scope, record)
            try:
                self._rollback_recovered(record, recovery_paths)
                journal.unlink(missing_ok=True)
            except Exception as recovery_error:
                operation_artifacts = (
                    recovery_paths["oldBackup"],
                    recovery_paths["newBackup"],
                    recovery_paths["staging"],
                )
                if (
                    isinstance(operation_error, SkillHostConflict)
                    and operation_error.code
                    in {"codex_projection_collision", "codex_projection_drift"}
                    and not any(
                        path is not None and path.exists()
                        for path in operation_artifacts
                    )
                ):
                    try:
                        journal.unlink(missing_ok=True)
                    except OSError:
                        raise SkillHostConflict(
                            "codex_projection_recovery_required",
                            "The Codex projection journal could not be cleared",
                        ) from recovery_error
                    raise operation_error
                raise SkillHostConflict(
                    "codex_projection_recovery_required",
                    "The prior Codex projection could not be restored",
                ) from recovery_error
            raise operation_error
        for change in changes:
            change.finalize()
        journal.unlink(missing_ok=True)
        return result

    def get_pin(
        self, skill_id: str, host: str, repository_scope: str | None
    ) -> dict[str, Any]:
        host = _host(host)
        if host == "local-agent" and repository_scope is not None:
            raise ValueError("local-Agent host state is global")
        scope = "" if host == "local-agent" else _repository_scope(repository_scope)
        if host == "local-agent":
            return self.store.get_skill_host_pin(skill_id, host, scope)
        skill = self.store.get_skill(skill_id)
        try:
            unlocked = self.store.get_skill_host_pin(skill["id"], host, scope)
        except MissingItem:
            raise
        projection = unlocked.get("projection") or {}
        name = projection.get("publicationName")
        names = [name] if isinstance(name, str) else []
        recovery_error: str | None = None
        with self.codex.operation_lock(scope, skill["id"], names):
            recovery_error = self._recover_pending(scope, skill["id"], strict=False)
            pin = self.store.get_skill_host_pin(skill["id"], host, scope)
            health = self.codex.projection_health(scope, pin)
        if recovery_error is not None:
            health = {"state": "unhealthy", "code": recovery_error}
        return {**pin, "projectionHealth": health}

    def _recover_pending(
        self, scope: str, skill_id: str, *, strict: bool
    ) -> str | None:
        try:
            for journal, record in self.codex.pending_journals(scope, skill_id):
                self._recover_journal(scope, journal, record)
        except SkillHostConflict as exc:
            if strict:
                raise
            return exc.code
        return None

    def _recover_journal(
        self, scope: str, journal: Path, record: dict[str, Any]
    ) -> None:
        try:
            current = self.store.get_skill_host_pin(record["skillId"], "codex", scope)
        except MissingItem:
            current = None
        prior = record.get("priorPin")
        desired = record.get("desiredPin")
        paths = self.codex.recovery_paths(scope, record)
        if _pin_matches(current, desired):
            self._finalize_recovered(record, paths)
        elif _pin_matches(current, prior):
            self._rollback_recovered(record, paths)
        else:
            raise SkillHostConflict(
                "codex_projection_recovery_required",
                "The Codex projection journal does not match the durable pin",
            )
        journal.unlink(missing_ok=True)

    def _finalize_recovered(
        self, record: dict[str, Any], paths: dict[str, Path | None]
    ) -> None:
        desired = record["desiredPin"]
        prior = record.get("priorPin")
        self._verify_recovery_backup(paths["oldBackup"], prior)
        self._verify_recovery_backup(paths["newBackup"], prior)
        staging = paths["staging"]
        if staging is not None and staging.exists():
            raise SkillHostConflict(
                "codex_projection_recovery_required",
                "A committed projection still has staged files",
            )
        if desired["enabled"]:
            target = paths["newTarget"]
            if target is None:
                raise SkillHostConflict("codex_projection_recovery_required", "Projection target missing")
            self.codex._verify_exact_projection(
                target, _disk_manifest(desired["projection"])
            )
            old_target = paths["oldTarget"]
            if old_target is not None and old_target != target and old_target.exists():
                raise SkillHostConflict("codex_projection_recovery_required", "Old projection remains visible")
        else:
            old_target = paths["oldTarget"]
            if old_target is not None and old_target.exists():
                raise SkillHostConflict("codex_projection_recovery_required", "Disabled projection remains visible")
        _remove_control_paths(paths)

    def _rollback_recovered(
        self, record: dict[str, Any], paths: dict[str, Path | None]
    ) -> None:
        prior = record.get("priorPin")
        desired = record["desiredPin"]
        self._verify_recovery_backup(paths["oldBackup"], prior)
        self._verify_recovery_backup(paths["newBackup"], prior)
        new_target = paths["newTarget"]
        new_backup = paths["newBackup"]
        if new_target is not None:
            if new_backup is not None and new_backup.exists():
                if new_target.exists():
                    self.codex._verify_exact_projection(
                        new_target, _disk_manifest(desired["projection"])
                    )
                    shutil.rmtree(new_target)
                os.replace(new_backup, new_target)
            elif new_target.exists() and (
                prior is None
                or not prior["enabled"]
                or (prior.get("projection") or {}).get("publicationName")
                != record.get("newPublicationName")
            ):
                self.codex._verify_exact_projection(
                    new_target, _disk_manifest(desired["projection"])
                )
                shutil.rmtree(new_target)
                if new_target.exists():
                    raise SkillHostConflict(
                        "codex_projection_recovery_required",
                        "The rolled-back projection remains discoverable",
                    )
        old_target = paths["oldTarget"]
        old_backup = paths["oldBackup"]
        if old_backup is not None and old_backup.exists():
            if old_target is None or old_target.exists():
                raise SkillHostConflict("codex_projection_recovery_required", "Old projection cannot be restored")
            os.replace(old_backup, old_target)
        staging = paths["staging"]
        if staging is not None and staging.exists():
            shutil.rmtree(staging)
            if staging.exists():
                raise SkillHostConflict(
                    "codex_projection_recovery_required",
                    "Staged projection files could not be removed",
                )
        if prior is not None and prior["enabled"]:
            prior_target = self.codex._repository(record["repositoryScope"]) / ".agents" / "skills" / prior["projection"]["publicationName"]
            self.codex._verify_exact_projection(
                prior_target, _disk_manifest(prior["projection"])
            )
        elif prior is not None:
            prior_target = self.codex._repository(record["repositoryScope"]) / ".agents" / "skills" / prior["projection"]["publicationName"]
            if prior_target.exists():
                raise SkillHostConflict(
                    "codex_projection_recovery_required",
                    "A disabled projection remains discoverable after rollback",
                )

    def _verify_recovery_backup(
        self,
        backup: Path | None,
        prior: dict[str, Any] | None,
    ) -> None:
        if backup is None or not backup.exists():
            return
        projection = (prior or {}).get("projection")
        if not isinstance(projection, dict):
            raise SkillHostConflict(
                "codex_projection_recovery_required",
                "A projection backup has no matching durable pin",
            )
        try:
            self.codex._verify_exact_projection(backup, _disk_manifest(projection))
        except SkillHostConflict:
            raise SkillHostConflict(
                "codex_projection_recovery_required",
                "A projection backup changed before recovery",
            ) from None

    def local_agent_snapshot(self, skill_id: str) -> dict[str, Any]:
        pin = self.store.get_skill_host_pin(skill_id, "local-agent", "")
        if not pin["enabled"]:
            raise MissingItem(skill_id)
        skill, revision = self.store.get_skill_revision(skill_id, pin["revision"])
        if skill["trustState"] not in {"trusted", "first-party"}:
            raise SkillHostConflict(
                "skill_review_required",
                "The Skill must remain trusted for local-Agent resolution",
            )
        instructions: str | None = None
        references: list[dict[str, str]] = []
        total_bytes = 0
        for entry in revision["entries"]:
            if entry["type"] not in {"instruction", "reference"}:
                continue
            if entry["type"] == "instruction" and entry["path"] != "SKILL.md":
                continue
            if entry["type"] == "reference" and not entry["path"].startswith("references/"):
                continue
            if entry["contentType"] not in _TEXT_TYPES:
                continue
            raw = base64.b64decode(entry["contentBase64"], validate=True)
            total_bytes += len(raw)
            if total_bytes > MAX_LOCAL_SNAPSHOT_BYTES:
                raise SkillHostConflict("skill_snapshot_too_large", "The local-Agent Skill snapshot is too large")
            try:
                content = raw.decode("utf-8")
            except UnicodeDecodeError:
                raise SkillHostConflict("skill_snapshot_invalid", "The Skill snapshot contains invalid text") from None
            if entry["type"] == "instruction":
                if instructions is not None:
                    raise SkillHostConflict("skill_snapshot_invalid", "The Skill snapshot has multiple instructions")
                instructions = content
            else:
                references.append({
                    "path": entry["path"], "contentType": entry["contentType"], "content": content,
                })
                if len(references) > MAX_LOCAL_REFERENCES:
                    raise SkillHostConflict("skill_snapshot_too_large", "The local-Agent Skill has too many references")
        if instructions is None:
            raise SkillHostConflict("skill_snapshot_invalid", "The Skill snapshot has no approved instructions")
        capabilities = _validated_local_capabilities(
            revision["declaredCapabilities"]
        )
        return {
            "skillId": skill["id"],
            "skillReferenceCode": skill["referenceCode"],
            "revision": revision["revision"],
            "digest": revision["digest"],
            "instructions": instructions,
            "references": references,
            "declaredCapabilities": capabilities,
        }


def _projected_path(root: Path, value: str) -> Path:
    normalized = normalize_package_path(value)
    _validate_windows_path(normalized)
    return root.joinpath(*normalized.split("/"))


def _disk_manifest(projection: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in projection.items() if key != "publicationName"}


def _same_projection_owner(current: dict[str, Any], expected: dict[str, Any]) -> bool:
    keys = ("format", "repositoryScope", "owner", "promptCardSource", "skillReferenceCode")
    return all(current.get(key) == expected.get(key) for key in keys)


def _journal_pin(pin: dict[str, Any] | None) -> dict[str, Any] | None:
    if pin is None:
        return None
    return {
        "enabled": bool(pin["enabled"]),
        "revision": int(pin["revision"]),
        "digest": str(pin["digest"]),
        "projection": pin.get("projection"),
    }


def _pin_matches(pin: dict[str, Any] | None, expected: object) -> bool:
    if expected is None:
        return pin is None
    if pin is None or not isinstance(expected, dict):
        return False
    return _journal_pin(pin) == expected


def _validate_journal_record(
    record: object,
    scope: str,
    expected_skill_id: str | None,
    filename: str,
) -> None:
    keys = {
        "format", "operationId", "skillId", "repositoryScope",
        "oldPublicationName", "newPublicationName", "priorPin", "desiredPin",
    }
    if not isinstance(record, dict) or set(record) != keys:
        raise ValueError("Codex projection journal shape is invalid")
    operation_id = record.get("operationId")
    skill_id = record.get("skillId")
    if (
        record.get("format") != _JOURNAL_FORMAT
        or not isinstance(operation_id, str)
        or _OPERATION_ID.fullmatch(operation_id) is None
        or filename != f"{operation_id}.json"
        or not isinstance(skill_id, str)
        or not skill_id
        or (expected_skill_id is not None and skill_id != expected_skill_id)
        or record.get("repositoryScope") != scope
    ):
        raise ValueError("Codex projection journal identity is invalid")
    prior = _validate_journal_pin(record.get("priorPin"), scope, skill_id, optional=True)
    desired = _validate_journal_pin(record.get("desiredPin"), scope, skill_id, optional=False)
    old_name = record.get("oldPublicationName")
    new_name = record.get("newPublicationName")
    if old_name is not None:
        _publication_name(old_name)
    if new_name is not None:
        _publication_name(new_name)
    prior_projection = (prior or {}).get("projection") or {}
    desired_projection = (desired or {}).get("projection") or {}
    if old_name != prior_projection.get("publicationName"):
        raise ValueError("Codex projection journal prior publication is invalid")
    if new_name != (
        desired_projection.get("publicationName") if desired and desired["enabled"] else None
    ):
        raise ValueError("Codex projection journal desired publication is invalid")


def _validate_journal_pin(
    value: object,
    scope: str,
    skill_id: str,
    *,
    optional: bool,
) -> dict[str, Any] | None:
    if value is None and optional:
        return None
    if not isinstance(value, dict) or set(value) != {
        "enabled", "revision", "digest", "projection",
    }:
        raise ValueError("Codex projection journal pin is invalid")
    if (
        type(value["enabled"]) is not bool
        or type(value["revision"]) is not int
        or value["revision"] < 1
        or not isinstance(value["digest"], str)
        or _DIGEST.fullmatch(value["digest"]) is None
    ):
        raise ValueError("Codex projection journal pin identity is invalid")
    projection = value.get("projection")
    if projection is not None:
        _validate_journal_projection(projection, scope, skill_id)
    if value["enabled"] and (
        projection is None
        or projection["revision"] != value["revision"]
        or projection["digest"] != value["digest"]
    ):
        raise ValueError("Enabled Codex journal pin lacks an exact projection")
    return value


def _validate_journal_projection(value: object, scope: str, skill_id: str) -> None:
    keys = {
        "format", "repositoryScope", "owner", "promptCardSource",
        "skillReferenceCode", "revision", "digest", "files", "publicationName",
    }
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("Codex projection journal manifest is invalid")
    if (
        value.get("format") != MANIFEST_FORMAT
        or value.get("repositoryScope") != scope
        or value.get("owner") != skill_id
        or not isinstance(value.get("promptCardSource"), str)
        or not isinstance(value.get("skillReferenceCode"), str)
        or type(value.get("revision")) is not int
        or value["revision"] < 1
        or not isinstance(value.get("digest"), str)
        or _DIGEST.fullmatch(value["digest"]) is None
    ):
        raise ValueError("Codex projection journal manifest identity is invalid")
    _publication_name(value.get("publicationName"))
    files = value.get("files")
    if not isinstance(files, list) or len(files) > _MAX_PROJECTION_FILES:
        raise ValueError("Codex projection journal file list is invalid")
    paths: list[str] = []
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "digest"}:
            raise ValueError("Codex projection journal file entry is invalid")
        path = normalize_package_path(item.get("path"))
        if path != item.get("path"):
            raise ValueError("Codex projection journal path is not canonical")
        _validate_windows_path(path)
        digest = item.get("digest")
        if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
            raise ValueError("Codex projection journal file digest is invalid")
        paths.append(path)
    _validate_projection_path_collisions(paths)


def _validate_projection_path_collisions(paths: list[str]) -> None:
    folded_paths = {path.casefold() for path in paths}
    if len(folded_paths) != len(paths) or MANIFEST_NAME.casefold() in folded_paths:
        raise SkillHostConflict(
            "codex_projection_path_invalid",
            "The Skill package contains a projection path collision",
        )
    for path in folded_paths:
        parts = path.split("/")
        if any("/".join(parts[:index]) in folded_paths for index in range(1, len(parts))):
            raise SkillHostConflict(
                "codex_projection_path_invalid",
                "The Skill package contains a file-directory prefix collision",
            )


def _remove_control_paths(paths: dict[str, Path | None]) -> None:
    for key in ("oldBackup", "newBackup", "staging"):
        path = paths[key]
        if path is not None and path.exists():
            shutil.rmtree(path)


def _is_reparse(stat: os.stat_result) -> bool:
    return bool(getattr(stat, "st_file_attributes", 0) & 0x400)


def _same_file(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ) == (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    )


def _read_stable_file(path: Path) -> bytes:
    before = path.lstat()
    if path.is_symlink() or _is_reparse(before) or not path.is_file():
        raise OSError("projection file is not a regular no-follow file")
    content = path.read_bytes()
    after = path.lstat()
    if not _same_file(before, after):
        raise OSError("projection file changed while being read")
    return content


def _scan_projection_files(target: Path) -> set[str]:
    from .skill_importer import _FolderRootChanged, _WindowsDirectoryLeases

    root_stat = target.lstat()
    if target.is_symlink() or _is_reparse(root_stat) or not target.is_dir():
        raise SkillHostConflict("codex_projection_drift", "The projection root is unsafe")
    leases = _WindowsDirectoryLeases() if os.name == "nt" else None
    members: set[str] = set()
    member_count = 0
    pending: list[tuple[Path, os.stat_result]] = [(target, root_stat)]
    scan_failed = False
    try:
        if leases is not None:
            leases.__enter__()
        while pending:
            directory, expected = pending.pop()
            if leases is not None:
                leases.acquire(directory, expected)
            try:
                with os.scandir(directory) as entries:
                    for item in entries:
                        member_count += 1
                        if member_count > _MAX_PROJECTION_FILES:
                            raise SkillHostConflict(
                                "codex_projection_drift",
                                "The projection contains too many members",
                            )
                        path = Path(item.path)
                        try:
                            stat = path.lstat()
                        except OSError:
                            raise SkillHostConflict(
                                "codex_projection_drift", "The projection tree changed"
                            ) from None
                        if item.is_symlink() or _is_reparse(stat):
                            raise SkillHostConflict(
                                "codex_projection_drift",
                                "The projection contains a link or reparse point",
                            )
                        relative = path.relative_to(target).as_posix().casefold()
                        if item.is_dir(follow_symlinks=False):
                            relative += "/"
                            pending.append((path, stat))
                        elif not item.is_file(follow_symlinks=False):
                            raise SkillHostConflict(
                                "codex_projection_drift",
                                "The projection contains an unsafe member",
                            )
                        if relative in members:
                            raise SkillHostConflict(
                                "codex_projection_drift",
                                "The projection contains case-folding collisions",
                            )
                        members.add(relative)
            except OSError:
                raise SkillHostConflict("codex_projection_drift", "The projection tree changed") from None
    except _FolderRootChanged:
        scan_failed = True
        raise SkillHostConflict(
            "codex_projection_drift", "The projection directory lease changed"
        ) from None
    except BaseException:
        scan_failed = True
        raise
    finally:
        if leases is not None:
            try:
                leases.__exit__(None, None, None)
            except _FolderRootChanged:
                if not scan_failed:
                    raise SkillHostConflict(
                        "codex_projection_drift",
                        "The projection directory lease changed",
                    ) from None
    return members


def _validated_local_capabilities(value: object) -> dict[str, list[str]]:
    invalid = (
        not isinstance(value, dict)
        or not set(value).issubset(_CAPABILITY_KEYS)
        or any(not isinstance(items, list) for items in value.values())
    )
    if not invalid:
        items = [item for group in value.values() for item in group]
        invalid = len(items) > MAX_LOCAL_CAPABILITY_ITEMS or any(
            not isinstance(item, str)
            or not item
            or _utf8_size(item) is None
            or _utf8_size(item) > MAX_LOCAL_CAPABILITY_ITEM_BYTES
            for item in items
        )
    if invalid:
        raise SkillHostConflict(
            "skill_snapshot_invalid",
            "The Skill snapshot declares invalid capabilities",
        )
    return {str(key): list(items) for key, items in value.items()}


def _utf8_size(value: str) -> int | None:
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError:
        return None


@contextmanager
def _exclusive_file_locks(paths: list[Path]) -> Iterator[None]:
    thread_locks: list[threading.RLock] = []
    files: list[Any] = []
    try:
        for path in paths:
            key = str(path).casefold()
            with _THREAD_LOCKS_GUARD:
                lock = _THREAD_LOCKS.setdefault(key, threading.RLock())
            lock.acquire()
            thread_locks.append(lock)
        for path in paths:
            handle = None
            locked = False
            try:
                handle = path.open("a+b")
                _verify_lock_file(path, handle)
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b"\0")
                    handle.flush()
                    os.fsync(handle.fileno())
                handle.seek(0)
                _lock_file(handle)
                locked = True
                _verify_lock_file(path, handle)
                files.append(handle)
            except (OSError, ValueError):
                if handle is not None:
                    if locked:
                        _unlock_file(handle)
                    handle.close()
                raise SkillHostConflict(
                    "codex_projection_path_invalid",
                    "The Codex projection lock path is unsafe",
                ) from None
        yield
    finally:
        for handle in reversed(files):
            try:
                _unlock_file(handle)
            finally:
                handle.close()
        for lock in reversed(thread_locks):
            lock.release()


def _lock_file(handle: Any) -> None:
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)


def _verify_lock_file(path: Path, handle: Any) -> None:
    path_stat = path.lstat()
    handle_stat = os.fstat(handle.fileno())
    if (
        path.is_symlink()
        or _is_reparse(path_stat)
        or not stat_module.S_ISREG(path_stat.st_mode)
        or (path_stat.st_dev, path_stat.st_ino)
        != (handle_stat.st_dev, handle_stat.st_ino)
    ):
        raise OSError("projection lock is not an anchored regular file")


def _unlock_file(handle: Any) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _validate_windows_path(normalized: str) -> None:
    if normalized.casefold() == MANIFEST_NAME.casefold():
        raise ValueError("Skill package path collides with the projection manifest")
    reserved = {"con", "prn", "aux", "nul", "clock$"}
    reserved.update(f"com{index}" for index in range(1, 10))
    reserved.update(f"lpt{index}" for index in range(1, 10))
    for part in normalized.split("/"):
        device = part.rstrip(" .").split(".", 1)[0].casefold()
        if part.rstrip(" .") != part or device in reserved:
            raise ValueError("Skill package path is unsafe on Windows")


def _repository_scope(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 200 or "\x00" in value:
        raise ValueError("Codex repository scope is invalid")
    return value.strip()


def _publication_name(value: object) -> str:
    if not isinstance(value, str) or _SAFE_NAME.fullmatch(value) is None:
        raise ValueError("Codex publication name is invalid")
    return value


def _host(value: str) -> str:
    if value not in _HOSTS:
        raise ValueError("Skill host must be codex or local-agent")
    return value
