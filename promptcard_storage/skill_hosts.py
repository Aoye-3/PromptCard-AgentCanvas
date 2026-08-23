from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from .skill_packages import normalize_package_path
from .store import MissingItem, SqliteStore


MANIFEST_NAME = ".promptcard-skill.json"
MANIFEST_FORMAT = "promptcard-codex-projection-v1"
MAX_LOCAL_SNAPSHOT_BYTES = 512 * 1024
MAX_LOCAL_REFERENCES = 64
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
_HOSTS = frozenset({"codex", "local-agent"})
_TEXT_TYPES = frozenset({"text/plain", "text/markdown", "application/json"})


class SkillHostConflict(Exception):
    def __init__(self, code: str, message: str, *, status_code: int = 409) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(code)


class CodexProjectionChange:
    def __init__(self, target: Path, backup: Path | None) -> None:
        self.target = target
        self.backup = backup
        self._finished = False

    def finalize(self) -> None:
        if self._finished:
            return
        if self.backup is not None and self.backup.exists():
            try:
                shutil.rmtree(self.backup)
            except OSError:
                # The backup is outside the host discovery tree and can be
                # reclaimed by a later maintenance pass without changing the pin.
                pass
        self._finished = True

    def rollback(self) -> None:
        if self._finished:
            return
        try:
            if self.target.exists():
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
            current = self._read_owned_manifest(target, manifest)
            self._verify_projection(target, current)
            if current == manifest:
                return manifest, None

        projection_root.mkdir(parents=True, exist_ok=True)
        staging_root.mkdir(parents=True, exist_ok=True)
        backup_root.mkdir(parents=True, exist_ok=True)
        staging = staging_root / f"{publication_name}-{uuid.uuid4().hex}"
        backup = backup_root / f"{publication_name}-{uuid.uuid4().hex}"
        moved_old = False
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
            try:
                os.replace(staging, target)
            except Exception:
                if moved_old and backup.exists() and not target.exists():
                    os.replace(backup, target)
                raise
        except SkillHostConflict:
            raise
        except (OSError, ValueError) as exc:
            raise SkillHostConflict("codex_projection_failed", "Codex projection failed") from exc
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
        return manifest, CodexProjectionChange(target, backup if moved_old else None)

    def unpublish(
        self,
        scope: str,
        publication_name: str,
        ownership: dict[str, Any],
    ) -> CodexProjectionChange | None:
        repository = self._repository(_repository_scope(scope))
        target = repository / ".agents" / "skills" / _publication_name(publication_name)
        backup_root = repository / ".agents" / ".promptcard-projection-backups"
        self._reject_reparse_ancestors(repository, backup_root)
        self._reject_reparse_path(target)
        if not target.exists():
            raise SkillHostConflict("codex_projection_drift", "The published Codex projection is missing")
        current = self._read_owned_manifest(target, ownership)
        self._verify_projection(target, current)
        backup_root.mkdir(parents=True, exist_ok=True)
        backup = backup_root / f"{publication_name}-{uuid.uuid4().hex}"
        try:
            os.replace(target, backup)
        except OSError as exc:
            raise SkillHostConflict("codex_projection_failed", "Codex unpublish failed") from exc
        return CodexProjectionChange(target, backup)

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
        paths = {MANIFEST_NAME.casefold()}
        for entry in entries:
            normalized = normalize_package_path(entry.get("path"))
            _validate_windows_path(normalized)
            folded = normalized.casefold()
            if folded in paths:
                raise SkillHostConflict(
                    "codex_projection_path_invalid",
                    "The Skill package contains a projection path collision",
                )
            paths.add(folded)

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
    def _read_owned_manifest(target: Path, expected: dict[str, Any]) -> dict[str, Any]:
        try:
            current = json.loads((target / MANIFEST_NAME).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise SkillHostConflict(
                "codex_projection_collision",
                "The Codex projection path is not owned by PromptCard",
            ) from None
        ownership = (
            "format", "repositoryScope", "owner", "promptCardSource", "skillReferenceCode",
        )
        if not isinstance(current, dict) or any(current.get(key) != expected.get(key) for key in ownership):
            raise SkillHostConflict(
                "codex_projection_collision",
                "The Codex projection path belongs to another owner or repository",
            )
        return current

    @staticmethod
    def _verify_projection(target: Path, manifest: dict[str, Any]) -> None:
        files = manifest.get("files")
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
            try:
                actual = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError:
                raise SkillHostConflict("codex_projection_drift", "A projected file is missing") from None
            if actual != digest:
                raise SkillHostConflict("codex_projection_drift", "A projected file has changed")
        actual_files = {
            path.relative_to(target).as_posix().casefold()
            for path in target.rglob("*")
            if path.is_file()
        }
        if actual_files != expected:
            raise SkillHostConflict("codex_projection_drift", "The Codex projection contains unexpected files")

    @staticmethod
    def _reject_reparse_ancestors(repository: Path, projection_root: Path) -> None:
        current = repository
        for part in projection_root.relative_to(repository).parts:
            current /= part
            CodexProjectionAdapter._reject_reparse_path(current)

    @staticmethod
    def _reject_reparse_path(path: Path) -> None:
        if not path.exists():
            return
        stat = path.lstat()
        if path.is_symlink() or bool(getattr(stat, "st_file_attributes", 0) & 0x400):
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
        changes: list[CodexProjectionChange] = []
        projection: dict[str, Any] | None = None
        try:
            if host == "codex":
                name = publication_name or str(skill["slug"])
                if enabled:
                    try:
                        current = self.store.get_skill_host_pin(skill["id"], host, scope)
                    except MissingItem:
                        current = None
                    prior = (current or {}).get("projection") or {}
                    prior_name = prior.get("publicationName")
                    if (
                        current is not None
                        and current["enabled"]
                        and isinstance(prior_name, str)
                        and prior_name != name
                    ):
                        removed = self.codex.unpublish(scope, prior_name, prior)
                        if removed is not None:
                            changes.append(removed)
                    projection, projected = self.codex.project(scope, name, skill, canonical)
                    if projected is not None:
                        changes.append(projected)
                    projection = {**projection, "publicationName": name}
                else:
                    current = self.store.get_skill_host_pin(skill["id"], host, scope)
                    prior = current.get("projection") or {}
                    prior_name = prior.get("publicationName")
                    if current["enabled"] and isinstance(prior_name, str):
                        removed = self.codex.unpublish(scope, prior_name, prior)
                        if removed is not None:
                            changes.append(removed)
                    projection = prior or None
            result = self.store.set_skill_host_pin(
                skill["id"], host, scope, enabled, revision, projection=projection
            )
        except Exception:
            for change in reversed(changes):
                change.rollback()
            raise
        for change in changes:
            change.finalize()
        return result

    def get_pin(
        self, skill_id: str, host: str, repository_scope: str | None
    ) -> dict[str, Any]:
        host = _host(host)
        if host == "local-agent" and repository_scope is not None:
            raise ValueError("local-Agent host state is global")
        scope = "" if host == "local-agent" else _repository_scope(repository_scope)
        return self.store.get_skill_host_pin(skill_id, host, scope)

    def local_agent_snapshot(self, skill_id: str) -> dict[str, Any]:
        pin = self.store.get_skill_host_pin(skill_id, "local-agent", "")
        if not pin["enabled"]:
            raise MissingItem(skill_id)
        skill, revision = self.store.get_skill_revision(skill_id, pin["revision"])
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
        return {
            "skillId": skill["id"],
            "skillReferenceCode": skill["referenceCode"],
            "revision": revision["revision"],
            "digest": revision["digest"],
            "instructions": instructions,
            "references": references,
            "declaredCapabilities": revision["declaredCapabilities"],
        }


def _projected_path(root: Path, value: str) -> Path:
    normalized = normalize_package_path(value)
    _validate_windows_path(normalized)
    return root.joinpath(*normalized.split("/"))


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
