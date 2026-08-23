from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import os
import re
import secrets
import stat
import tarfile
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Callable, Mapping

from .skill_packages import canonical_package_digest, normalize_package_path
from .store import DuplicateItem, MissingItem


@dataclass(frozen=True)
class InspectionLimits:
    max_archive_bytes: int = 16 * 1024 * 1024
    max_members: int = 256
    max_file_bytes: int = 2 * 1024 * 1024
    max_total_bytes: int = 8 * 1024 * 1024
    max_compression_ratio: int = 100
    max_path_chars: int = 240
    max_path_segment_chars: int = 120
    max_directory_depth: int = 16
    max_skill_md_bytes: int = 256 * 1024
    max_frontmatter_bytes: int = 64 * 1024
    max_frontmatter_fields: int = 6
    max_metadata_fields: int = 32
    max_frontmatter_scalar_chars: int = 4096
    max_allowed_tools: int = 32
    max_tool_chars: int = 120
    max_findings: int = 256
    max_control_request_bytes: int = 16 * 1024
    max_json_overhead_bytes: int = 4 * 1024
    inspection_ttl_seconds: int = 15 * 60
    max_inspection_sessions: int = 16
    max_cached_snapshot_bytes: int = 8 * 1024 * 1024
    max_total_cached_snapshot_bytes: int = 32 * 1024 * 1024
    max_inspection_id_attempts: int = 8


DEFAULT_INSPECTION_LIMITS = InspectionLimits()

_EXCLUDED_DIRECTORIES = frozenset({
    ".git", ".cache", "cache", "node_modules", "__pycache__", ".pytest_cache",
})
_PACKAGE_MANIFESTS = frozenset({
    "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "requirements.txt", "pyproject.toml", "poetry.lock",
})
_ROOT_INERT_SCRIPTS = frozenset({
    "setup.py", "install.py", "install.sh", "postinstall.sh", "makefile",
})
_NESTED_ARCHIVE_SUFFIXES = (
    ".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz",
)
_WINDOWS_RESERVED = frozenset({"con", "prn", "aux", "nul"}) | frozenset(
    f"{prefix}{index}" for prefix in ("com", "lpt") for index in range(1, 10)
)
_FRONTMATTER_FIELDS = frozenset({
    "name", "description", "license", "compatibility", "metadata", "allowed-tools",
})
_PLAIN_YAML_TYPES = frozenset({
    "null", "~", "true", "false", "yes", "no", "on", "off", ".nan", ".inf", "-.inf",
})
_CONTENT_TYPES = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".sh": "text/x-shellscript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
}
_IMPORT_IDENTIFIER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}")

_FIXED_MESSAGES = {
    "archive.encrypted_member": "Encrypted archive members are not supported",
    "archive.invalid": "The archive format is invalid or unsupported",
    "archive.member_count_exceeded": "The package contains too many archive members",
    "archive.metadata_inconsistent": "Archive member metadata is inconsistent",
    "archive.nested_unsupported": "Nested archives are not supported",
    "archive.ratio_exceeded": "Archive compression ratio exceeds the safety limit",
    "archive.unsafe_member": "The archive contains an unsafe member type",
    "credential.detected": "Potential credential material was detected",
    "folder.file_changed": "A package file changed while it was being inspected",
    "folder.invalid_root": "The selected folder is not a safe regular directory",
    "inspection.file_too_large": "A package file exceeds the safety limit",
    "inspection.findings_truncated": "Additional findings were omitted at the safety limit",
    "inspection.member_count_exceeded": "The package contains too many entries",
    "inspection.total_too_large": "The package exceeds the total uncompressed size limit",
    "frontmatter.dangerous_yaml": "Skill frontmatter contains an unsupported YAML feature",
    "frontmatter.duplicate_key": "Skill frontmatter contains a duplicate key",
    "frontmatter.invalid": "Skill frontmatter is malformed",
    "frontmatter.invalid_type": "Skill frontmatter contains an unsupported value type",
    "frontmatter.invalid_utf8": "SKILL.md must be valid UTF-8",
    "frontmatter.limit_exceeded": "Skill frontmatter exceeds a safety limit",
    "frontmatter.missing": "SKILL.md must begin with closed frontmatter",
    "frontmatter.required_field": "Skill frontmatter is missing a required field",
    "frontmatter.unknown_field": "Skill frontmatter contains an unsupported field",
    "package.inert_manifest": "Package metadata is retained as inert content",
    "package.inert_script": "Installer or hook content is retained as an inert script",
    "package.unsupported_entry": "The package contains an unsupported entry location",
    "path.collision": "Package paths collide after safe normalization",
    "path.invalid": "A package path is unsafe or invalid",
    "path.limit_exceeded": "A package path exceeds a safety limit",
    "path.unsafe_link": "Symbolic links and reparse points are not supported",
    "path.windows_ambiguous": "A package path is ambiguous on Windows filesystems",
    "skill.root_instruction_missing": "The package must contain root SKILL.md",
}


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    blocking: bool
    path: str
    message: str
    rule: str | None = None
    line: int | None = None

    def public_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "code": self.code,
            "severity": self.severity,
            "blocking": self.blocking,
            "path": self.path,
            "message": self.message,
        }
        if self.rule is not None:
            value["rule"] = self.rule
        if self.line is not None:
            value["line"] = self.line
        return value


@dataclass(frozen=True)
class SnapshotEntry:
    entry_type: str
    path: str
    content_type: str
    content: bytes
    size: int
    digest: str


@dataclass(frozen=True)
class InspectionSnapshot:
    entries: tuple[SnapshotEntry, ...]
    metadata: Mapping[str, Any]
    digest: str
    total_bytes: int

    def entry_bytes(self, path: str) -> bytes:
        for entry in self.entries:
            if entry.path == path:
                return entry.content
        raise KeyError(path)


@dataclass(frozen=True)
class InspectionResult:
    clean: bool
    findings: tuple[Finding, ...]
    manifest: Mapping[str, Any]
    snapshot: InspectionSnapshot

    def public_dict(self) -> dict[str, Any]:
        return {
            "clean": self.clean,
            "manifest": {
                "digest": self.manifest["digest"],
                "entryCount": self.manifest["entryCount"],
                "totalBytes": self.manifest["totalBytes"],
                "entries": [dict(entry) for entry in self.manifest["entries"]],
            },
            "findings": [finding.public_dict() for finding in self.findings],
        }


class SkillPackageImportError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.message = message


class _FindingCollector:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.values: list[Finding] = []
        self.truncated = False

    def add(
        self,
        code: str,
        *,
        path: str = "",
        blocking: bool = True,
        severity: str | None = None,
        rule: str | None = None,
        line: int | None = None,
    ) -> None:
        finding = Finding(
            code=code,
            severity=severity or ("error" if blocking else "warning"),
            blocking=blocking,
            path=path,
            message=_FIXED_MESSAGES[code],
            rule=rule,
            line=line,
        )
        if finding in self.values:
            return
        if len(self.values) < self.limit - 1:
            self.values.append(finding)
        else:
            self.truncated = True

    def finish(self) -> tuple[Finding, ...]:
        values = list(self.values)
        if self.truncated:
            values.append(Finding(
                code="inspection.findings_truncated",
                severity="error",
                blocking=True,
                path="",
                message=_FIXED_MESSAGES["inspection.findings_truncated"],
            ))
        return tuple(sorted(values, key=lambda item: (
            item.path.casefold(), item.path, item.line or 0, item.code, item.rule or ""
        )))


def is_windows_reparse_point(value: os.stat_result | Any) -> bool:
    attribute = getattr(value, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attribute & reparse_flag)


def inspect_folder(
    root: str | os.PathLike[str],
    limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS,
) -> InspectionResult:
    collector = _FindingCollector(limits.max_findings)
    entries: list[SnapshotEntry] = []
    seen: dict[str, str] = {}
    member_count = 0
    total_bytes = 0
    root_path = Path(root)
    try:
        root_stat = os.lstat(root_path)
        if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode) or is_windows_reparse_point(root_stat):
            raise OSError("unsafe root")
        absolute_root = Path(os.path.abspath(root_path))
    except (OSError, ValueError, TypeError):
        collector.add("folder.invalid_root")
        return _finalize(entries, collector, limits)

    pending: list[tuple[Path, int]] = [(absolute_root, 0)]
    while pending:
        directory, depth = pending.pop()
        if depth > limits.max_directory_depth:
            collector.add("path.limit_exceeded")
            continue
        try:
            scanned = sorted(os.scandir(directory), key=lambda item: (item.name.casefold(), item.name))
        except OSError:
            collector.add("folder.file_changed")
            continue
        for directory_entry in scanned:
            member_count += 1
            if member_count > limits.max_members:
                collector.add("inspection.member_count_exceeded")
                pending.clear()
                break
            try:
                item_stat = os.lstat(directory_entry.path)
            except OSError:
                collector.add("folder.file_changed")
                continue
            try:
                relative_raw = os.path.relpath(directory_entry.path, absolute_root)
            except ValueError:
                collector.add("path.invalid")
                continue
            canonical, error = _safe_package_path(relative_raw, limits)
            if error:
                collector.add(error, path=canonical or "")
                continue
            if _outside_root(absolute_root, Path(os.path.abspath(directory_entry.path))):
                collector.add("path.invalid")
                continue
            if stat.S_ISLNK(item_stat.st_mode) or is_windows_reparse_point(item_stat):
                collector.add("path.unsafe_link", path=canonical)
                continue
            if stat.S_ISDIR(item_stat.st_mode):
                if directory_entry.name.casefold() in _EXCLUDED_DIRECTORIES:
                    continue
                if depth >= limits.max_directory_depth:
                    collector.add("path.limit_exceeded", path=canonical)
                    continue
                pending.append((Path(directory_entry.path), depth + 1))
                continue
            if not stat.S_ISREG(item_stat.st_mode):
                collector.add("path.unsafe_link", path=canonical)
                continue
            if not _reserve_path(canonical, seen, collector):
                continue
            if item_stat.st_size > limits.max_file_bytes or (
                canonical == "SKILL.md" and item_stat.st_size > limits.max_skill_md_bytes
            ):
                collector.add("inspection.file_too_large", path=canonical)
                continue
            if total_bytes + item_stat.st_size > limits.max_total_bytes:
                collector.add("inspection.total_too_large", path=canonical)
                continue
            try:
                content = _read_folder_file(Path(directory_entry.path), item_stat, limits.max_file_bytes)
            except _FileChanged:
                collector.add("folder.file_changed", path=canonical)
                continue
            except OSError:
                collector.add("folder.file_changed", path=canonical)
                continue
            total_bytes += len(content)
            entry = _snapshot_entry(canonical, content, collector)
            if entry is not None:
                entries.append(entry)
    return _validate_and_finalize(entries, collector, limits)


def inspect_archive(
    content: bytes,
    filename: str,
    limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS,
) -> InspectionResult:
    collector = _FindingCollector(limits.max_findings)
    if not isinstance(content, bytes) or len(content) > limits.max_archive_bytes:
        collector.add("archive.invalid")
        return _finalize([], collector, limits)
    if not isinstance(filename, str) or not filename or "\x00" in filename:
        collector.add("archive.invalid")
        return _finalize([], collector, limits)
    stream = io.BytesIO(content)
    try:
        if zipfile.is_zipfile(stream):
            entries = _inspect_zip(content, collector, limits)
        else:
            entries = _inspect_tar(content, collector, limits)
    except (OSError, EOFError, tarfile.TarError, zipfile.BadZipFile, RuntimeError):
        collector.add("archive.invalid")
        entries = []
    return _validate_and_finalize(entries, collector, limits)


def _inspect_zip(
    content: bytes, collector: _FindingCollector, limits: InspectionLimits
) -> list[SnapshotEntry]:
    entries: list[SnapshotEntry] = []
    seen: dict[str, str] = {}
    declared_total = 0
    actual_total = 0
    with zipfile.ZipFile(io.BytesIO(content), "r") as archive:
        for index, member in enumerate(archive.infolist(), start=1):
            if index > limits.max_members:
                collector.add("archive.member_count_exceeded")
                break
            canonical, error = _safe_package_path(member.filename.rstrip("/") if member.is_dir() else member.filename, limits)
            if error:
                collector.add(error, path=canonical or "")
                continue
            if not _reserve_path(canonical, seen, collector):
                continue
            if member.flag_bits & 0x1:
                collector.add("archive.encrypted_member", path=canonical)
                continue
            mode = member.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if member.is_dir():
                continue
            if file_type not in {0, stat.S_IFREG}:
                collector.add("archive.unsafe_member", path=canonical)
                continue
            if member.file_size < 0 or member.compress_size < 0:
                collector.add("archive.metadata_inconsistent", path=canonical)
                continue
            declared_total += member.file_size
            if member.file_size > limits.max_file_bytes or (
                canonical == "SKILL.md" and member.file_size > limits.max_skill_md_bytes
            ):
                collector.add("inspection.file_too_large", path=canonical)
                continue
            if declared_total > limits.max_total_bytes:
                collector.add("inspection.total_too_large", path=canonical)
                continue
            ratio = member.file_size / max(member.compress_size, 1)
            if ratio > limits.max_compression_ratio:
                collector.add("archive.ratio_exceeded", path=canonical)
                continue
            try:
                with archive.open(member, "r") as source:
                    member_content = _read_stream_bounded(source, limits.max_file_bytes)
            except (OSError, RuntimeError, zipfile.BadZipFile):
                collector.add("archive.metadata_inconsistent", path=canonical)
                continue
            if len(member_content) != member.file_size:
                collector.add("archive.metadata_inconsistent", path=canonical)
                continue
            actual_total += len(member_content)
            if actual_total > limits.max_total_bytes:
                collector.add("inspection.total_too_large", path=canonical)
                continue
            entry = _snapshot_entry(canonical, member_content, collector)
            if entry is not None:
                entries.append(entry)
    return entries


def _inspect_tar(
    content: bytes, collector: _FindingCollector, limits: InspectionLimits
) -> list[SnapshotEntry]:
    entries: list[SnapshotEntry] = []
    seen: dict[str, str] = {}
    declared_total = 0
    actual_total = 0
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as archive:
        for index, member in enumerate(archive, start=1):
            if index > limits.max_members:
                collector.add("archive.member_count_exceeded")
                break
            canonical, error = _safe_package_path(member.name.rstrip("/") if member.isdir() else member.name, limits)
            if error:
                collector.add(error, path=canonical or "")
                continue
            if not _reserve_path(canonical, seen, collector):
                continue
            if member.isdir():
                continue
            if not member.isreg() or getattr(member, "sparse", None):
                collector.add("archive.unsafe_member", path=canonical)
                continue
            declared_total += member.size
            if member.size > limits.max_file_bytes or (
                canonical == "SKILL.md" and member.size > limits.max_skill_md_bytes
            ):
                collector.add("inspection.file_too_large", path=canonical)
                continue
            if declared_total > limits.max_total_bytes:
                collector.add("inspection.total_too_large", path=canonical)
                continue
            if declared_total / max(len(content), 1) > limits.max_compression_ratio:
                collector.add("archive.ratio_exceeded", path=canonical)
                continue
            source = archive.extractfile(member)
            if source is None:
                collector.add("archive.metadata_inconsistent", path=canonical)
                continue
            with source:
                member_content = _read_stream_bounded(source, limits.max_file_bytes)
            if len(member_content) != member.size:
                collector.add("archive.metadata_inconsistent", path=canonical)
                continue
            actual_total += len(member_content)
            if actual_total > limits.max_total_bytes:
                collector.add("inspection.total_too_large", path=canonical)
                continue
            entry = _snapshot_entry(canonical, member_content, collector)
            if entry is not None:
                entries.append(entry)
    return entries


class _FileChanged(Exception):
    pass


def _read_folder_file(path: Path, expected: os.stat_result, limit: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if _file_identity(before) != _file_identity(expected) or not stat.S_ISREG(before.st_mode):
            raise _FileChanged
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = os.read(descriptor, min(64 * 1024, limit - size + 1))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                raise _FileChanged
        after_handle = os.fstat(descriptor)
        after_path = os.stat(path, follow_symlinks=False)
        if _file_identity(before) != _file_identity(after_handle) or _file_identity(before) != _file_identity(after_path):
            raise _FileChanged
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _file_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        stat.S_IFMT(value.st_mode),
        value.st_size,
        getattr(value, "st_mtime_ns", int(value.st_mtime * 1_000_000_000)),
    )


def _read_stream_bounded(source: Any, limit: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = source.read(min(64 * 1024, limit - size + 1))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if size > limit:
            break
    return b"".join(chunks)


def _safe_package_path(value: object, limits: InspectionLimits) -> tuple[str, str | None]:
    try:
        canonical = normalize_package_path(value)
    except ValueError:
        return "", "path.invalid"
    parts = canonical.split("/")
    if any(ord(character) < 32 or ord(character) == 127 for character in canonical):
        return "", "path.invalid"
    if len(parts) - 1 > limits.max_directory_depth:
        return canonical, "path.limit_exceeded"
    if len(canonical) > limits.max_path_chars or any(
        len(part) > limits.max_path_segment_chars for part in parts
    ):
        return canonical, "path.limit_exceeded"
    for part in parts:
        if ":" in part or part.endswith((".", " ")):
            return canonical, "path.windows_ambiguous"
        reserved_stem = part.rstrip(". ").split(".", 1)[0].casefold()
        if reserved_stem in _WINDOWS_RESERVED:
            return canonical, "path.windows_ambiguous"
    return canonical, None


def _reserve_path(canonical: str, seen: dict[str, str], collector: _FindingCollector) -> bool:
    key = canonical.casefold()
    if key in seen:
        collector.add("path.collision", path=canonical)
        return False
    seen[key] = canonical
    return True


def _outside_root(root: Path, child: Path) -> bool:
    try:
        return os.path.commonpath((str(root), str(child))) != str(root)
    except ValueError:
        return True


def _snapshot_entry(
    path: str, content: bytes, collector: _FindingCollector
) -> SnapshotEntry | None:
    entry_type: str
    if path == "SKILL.md":
        entry_type = "instruction"
    elif path.startswith("references/"):
        entry_type = "reference"
    elif path.startswith(("scripts/", "hooks/")) or path.casefold() in _ROOT_INERT_SCRIPTS:
        entry_type = "script"
        if path.startswith("hooks/") or path.casefold() in _ROOT_INERT_SCRIPTS:
            collector.add("package.inert_script", path=path, blocking=False)
    elif path.startswith("assets/"):
        entry_type = "asset"
    elif path.casefold() in _PACKAGE_MANIFESTS:
        entry_type = "asset"
        collector.add("package.inert_manifest", path=path, blocking=False)
    else:
        collector.add("package.unsupported_entry", path=path)
        return None
    if path.casefold().endswith(_NESTED_ARCHIVE_SUFFIXES):
        collector.add("archive.nested_unsupported", path=path)
        return None
    suffix = Path(path).suffix.casefold()
    content_type = _CONTENT_TYPES.get(suffix, "application/octet-stream")
    return SnapshotEntry(
        entry_type=entry_type,
        path=path,
        content_type=content_type,
        content=content,
        size=len(content),
        digest="sha256:" + hashlib.sha256(content).hexdigest(),
    )


def _validate_and_finalize(
    entries: list[SnapshotEntry], collector: _FindingCollector, limits: InspectionLimits
) -> InspectionResult:
    by_path = {entry.path: entry for entry in entries}
    instruction = by_path.get("SKILL.md")
    metadata: Mapping[str, Any] = MappingProxyType({})
    if instruction is None:
        collector.add("skill.root_instruction_missing")
    else:
        parsed = _parse_frontmatter(instruction.content, collector, limits)
        if parsed is not None and isinstance(parsed.get("name"), str) and isinstance(
            parsed.get("description"), str
        ):
            metadata = MappingProxyType({
                "name": parsed["name"],
                "description": parsed["description"],
                "allowedTools": tuple(parsed.get("allowed-tools", ())),
            })
    for entry in entries:
        _scan_credentials(entry, collector)
    return _finalize(entries, collector, limits, metadata)


def _finalize(
    entries: list[SnapshotEntry],
    collector: _FindingCollector,
    limits: InspectionLimits,
    metadata: Mapping[str, Any] | None = None,
) -> InspectionResult:
    ordered = tuple(sorted(entries, key=lambda entry: entry.path))
    canonical = [
        {"type": entry.entry_type, "path": entry.path, "content": entry.content}
        for entry in ordered
    ]
    digest = canonical_package_digest(canonical)
    total = sum(entry.size for entry in ordered)
    snapshot = InspectionSnapshot(
        entries=ordered,
        metadata=metadata or MappingProxyType({}),
        digest=digest,
        total_bytes=total,
    )
    findings = collector.finish()
    clean = not any(finding.blocking for finding in findings)
    manifest = MappingProxyType({
        "digest": digest,
        "entryCount": len(ordered),
        "totalBytes": total,
        "entries": tuple(MappingProxyType({
            "type": entry.entry_type,
            "path": entry.path,
            "contentType": entry.content_type,
            "size": entry.size,
            "digest": entry.digest,
        }) for entry in ordered),
    })
    return InspectionResult(clean=clean, findings=findings, manifest=manifest, snapshot=snapshot)


def _parse_frontmatter(
    content: bytes, collector: _FindingCollector, limits: InspectionLimits
) -> dict[str, Any] | None:
    if len(content) > limits.max_skill_md_bytes:
        collector.add("inspection.file_too_large", path="SKILL.md")
        return None
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        collector.add("frontmatter.invalid_utf8", path="SKILL.md")
        return None
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        collector.add("frontmatter.missing", path="SKILL.md")
        return None
    closing = None
    consumed = len(lines[0].encode("utf-8"))
    for index, line in enumerate(lines[1:], start=1):
        consumed += len(line.encode("utf-8"))
        if consumed > limits.max_frontmatter_bytes:
            collector.add("frontmatter.limit_exceeded", path="SKILL.md")
            return None
        if line.rstrip("\r\n") == "---":
            closing = index
            break
    if closing is None:
        collector.add("frontmatter.invalid", path="SKILL.md")
        return None
    values: dict[str, Any] = {}
    metadata: dict[str, str] = {}
    current_section: str | None = None
    for line_number, raw_line in enumerate(lines[1:closing], start=2):
        line = raw_line.rstrip("\r\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith((" ", "\t")):
            if current_section != "metadata" or not line.startswith("  ") or line.startswith("   "):
                collector.add("frontmatter.invalid", path="SKILL.md", line=line_number)
                continue
            parsed = _frontmatter_pair(line[2:], collector, line_number, limits)
            if parsed is None:
                continue
            key, scalar = parsed
            if key in metadata:
                collector.add("frontmatter.duplicate_key", path="SKILL.md", line=line_number)
            elif len(metadata) >= limits.max_metadata_fields:
                collector.add("frontmatter.limit_exceeded", path="SKILL.md", line=line_number)
            else:
                metadata[key] = scalar
            continue
        current_section = None
        parsed = _frontmatter_pair(line, collector, line_number, limits)
        if parsed is None:
            continue
        key, scalar = parsed
        if key not in _FRONTMATTER_FIELDS:
            collector.add("frontmatter.unknown_field", path="SKILL.md", line=line_number)
            continue
        if key in values:
            collector.add("frontmatter.duplicate_key", path="SKILL.md", line=line_number)
            continue
        if len(values) >= limits.max_frontmatter_fields:
            collector.add("frontmatter.limit_exceeded", path="SKILL.md", line=line_number)
            continue
        if key == "metadata":
            if scalar:
                collector.add("frontmatter.invalid_type", path="SKILL.md", line=line_number)
            values[key] = metadata
            current_section = "metadata"
        elif key == "allowed-tools":
            tools = scalar.replace(",", " ").split()
            if len(tools) > limits.max_allowed_tools or any(
                len(tool) > limits.max_tool_chars for tool in tools
            ):
                collector.add("frontmatter.limit_exceeded", path="SKILL.md", line=line_number)
            else:
                values[key] = sorted(set(tools))
        else:
            values[key] = scalar
    for required in ("name", "description"):
        if not isinstance(values.get(required), str) or not values[required].strip():
            collector.add("frontmatter.required_field", path="SKILL.md")
    name = values.get("name")
    if isinstance(name, str) and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        collector.add("frontmatter.invalid", path="SKILL.md")
    return values


def _frontmatter_pair(
    line: str, collector: _FindingCollector, line_number: int, limits: InspectionLimits
) -> tuple[str, str] | None:
    match = re.fullmatch(r"([A-Za-z][A-Za-z0-9_-]*):(?:[ ](.*))?", line)
    if match is None:
        collector.add("frontmatter.invalid", path="SKILL.md", line=line_number)
        return None
    key = match.group(1)
    raw = match.group(2) or ""
    stripped = raw.strip()
    if stripped.startswith(("&", "*", "!", "|", ">", "[", "{")):
        collector.add("frontmatter.dangerous_yaml", path="SKILL.md", line=line_number)
        return None
    scalar = _closed_scalar(stripped)
    if scalar is None:
        collector.add("frontmatter.invalid_type", path="SKILL.md", line=line_number)
        return None
    if len(scalar) > limits.max_frontmatter_scalar_chars:
        collector.add("frontmatter.limit_exceeded", path="SKILL.md", line=line_number)
        return None
    return key, scalar


def _closed_scalar(value: str) -> str | None:
    if not value:
        return ""
    if value.startswith('"'):
        try:
            decoded = json.loads(value)
        except (ValueError, json.JSONDecodeError):
            return None
        return decoded if isinstance(decoded, str) else None
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            return None
        return value[1:-1].replace("''", "'")
    folded = value.casefold()
    if folded in _PLAIN_YAML_TYPES or re.fullmatch(
        r"[-+]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:e[-+]?\d+)?", value, re.IGNORECASE
    ):
        return None
    return value


_PRIVATE_KEY_RE = re.compile(rb"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")
_KNOWN_TOKEN_RES = (
    re.compile(rb"\bghp_[A-Za-z0-9]{30,}\b"),
    re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(rb"\bAKIA[A-Z0-9]{16}\b"),
    re.compile(rb"\bAIza[0-9A-Za-z_-]{30,}\b"),
    re.compile(rb"\bxox[baprs]-[0-9A-Za-z-]{20,}\b"),
)
_ASSIGNMENT_RE = re.compile(
    rb"(?i)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|token)\b"
    rb"\s*[:=]\s*[\"']?([^\s\"',;#]{4,})"
)
_PLACEHOLDERS = frozenset({
    "password", "secret", "token", "api_key", "apikey", "changeme", "change_me",
    "your_api_key", "your_token", "your_password", "placeholder", "redacted",
    "example", "dummy", "test", "xxxx", "xxxxx",
})


def _scan_credentials(entry: SnapshotEntry, collector: _FindingCollector) -> None:
    for line_number, line in enumerate(entry.content.splitlines() or [entry.content], start=1):
        if _PRIVATE_KEY_RE.search(line):
            collector.add(
                "credential.detected", path=entry.path, rule="private-key", line=line_number
            )
        if any(pattern.search(line) for pattern in _KNOWN_TOKEN_RES):
            collector.add(
                "credential.detected", path=entry.path, rule="known-token-prefix", line=line_number
            )
        for match in _ASSIGNMENT_RE.finditer(line):
            value = match.group(2).decode("ascii", errors="ignore")
            normalized = value.strip("<>[]{}()$%_-'\"").casefold()
            if normalized not in _PLACEHOLDERS and not normalized.startswith(("your_", "example_", "dummy_")):
                collector.add(
                    "credential.detected", path=entry.path, rule="credential-assignment", line=line_number
                )


@dataclass
class _InspectionSession:
    created_at: float
    public_result: dict[str, Any]
    snapshot: InspectionSnapshot | None
    cached_bytes: int
    consumed: bool = False


class SkillPackageImportService:
    def __init__(
        self,
        store: Any,
        *,
        limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS,
        clock: Callable[[], float] = time.monotonic,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._store = store
        self._limits = limits
        self._clock = clock
        self._id_factory = id_factory or (lambda: secrets.token_urlsafe(24))
        self._sessions: dict[str, _InspectionSession] = {}
        self._lock = threading.RLock()

    @property
    def control_request_body_limit(self) -> int:
        return self._limits.max_control_request_bytes

    @property
    def archive_request_body_limit(self) -> int:
        encoded_limit = ((self._limits.max_archive_bytes + 2) // 3) * 4
        return encoded_limit + self._limits.max_json_overhead_bytes

    def inspect_folder_request(self, payload: object) -> dict[str, Any]:
        if not isinstance(payload, dict) or set(payload) != {"path"}:
            self._raise(400, "invalid_inspection_request", "Folder inspection request is invalid")
        path = payload.get("path")
        if not isinstance(path, str) or not path or "\x00" in path:
            self._raise(400, "invalid_inspection_request", "Folder inspection request is invalid")
        return self._register(inspect_folder(path, self._limits))

    def inspect_archive_request(self, payload: object) -> dict[str, Any]:
        if not isinstance(payload, dict) or set(payload) != {"filename", "contentBase64"}:
            self._raise(400, "invalid_inspection_request", "Archive inspection request is invalid")
        filename = payload.get("filename")
        encoded = payload.get("contentBase64")
        if not isinstance(filename, str) or not filename or not isinstance(encoded, str):
            self._raise(400, "invalid_inspection_request", "Archive inspection request is invalid")
        encoded_limit = ((self._limits.max_archive_bytes + 2) // 3) * 4
        if len(encoded) > encoded_limit:
            self._raise(413, "archive_too_large", "Archive input exceeds the safety limit")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            self._raise(400, "archive_encoding_invalid", "Archive encoding is invalid")
        if base64.b64encode(content).decode("ascii") != encoded:
            self._raise(400, "archive_encoding_invalid", "Archive encoding is invalid")
        if len(content) > self._limits.max_archive_bytes:
            self._raise(413, "archive_too_large", "Archive input exceeds the safety limit")
        return self._register(inspect_archive(content, filename, self._limits))

    def import_request(self, payload: object) -> dict[str, Any]:
        if not isinstance(payload, dict) or set(payload) != {"inspectionId", "operation", "skill"}:
            self._raise(400, "invalid_import_request", "Skill import request is invalid")
        inspection_id = payload.get("inspectionId")
        operation = payload.get("operation")
        skill = payload.get("skill")
        if not isinstance(inspection_id, str) or not inspection_id or operation not in {"create", "revise"} or not isinstance(skill, dict):
            self._raise(400, "invalid_import_request", "Skill import request is invalid")
        with self._lock:
            session = self._sessions.get(inspection_id)
            if session is None:
                self._raise(404, "inspection_unavailable", "Skill inspection is unavailable")
            if self._clock() - session.created_at > self._limits.inspection_ttl_seconds:
                del self._sessions[inspection_id]
                self._raise(410, "inspection_expired", "Skill inspection has expired")
            if session.consumed:
                self._raise(409, "inspection_consumed", "Skill inspection was already imported")
            if session.snapshot is None:
                self._raise(422, "inspection_not_clean", "Skill inspection contains blocking findings")
            item, target = self._storage_item(operation, skill, session.snapshot)
            try:
                if operation == "create":
                    stored = self._store.create_skill(item)
                else:
                    stored = self._store.add_skill_revision(target, item)
            except DuplicateItem:
                self._raise(409, "skill_import_conflict", "Skill import conflicts with existing Storage data")
            except MissingItem:
                self._raise(404, "skill_target_unavailable", "Skill revision target is unavailable")
            except ValueError:
                self._raise(400, "invalid_import_metadata", "Skill import metadata is invalid")
            except SkillPackageImportError:
                raise
            except Exception:
                self._raise(500, "skill_import_failed", "Skill import could not be persisted")
            current = next(
                revision for revision in stored["revisions"]
                if revision["revision"] == stored["currentRevision"]
            )
            session.snapshot = None
            session.cached_bytes = 0
            session.consumed = True
            return {
                "inspectionId": inspection_id,
                "skill": {
                    "id": stored["id"],
                    "referenceCode": stored["referenceCode"],
                    "revision": current["revision"],
                    "digest": current["digest"],
                    "lifecycleStatus": stored["lifecycleStatus"],
                },
            }

    def _register(self, result: InspectionResult) -> dict[str, Any]:
        now = self._clock()
        with self._lock:
            self._purge_expired(now)
            if len(self._sessions) >= self._limits.max_inspection_sessions:
                self._raise(429, "inspection_capacity_exceeded", "Skill inspection capacity is full")
            cached_bytes = result.snapshot.total_bytes if result.clean else 0
            if cached_bytes > self._limits.max_cached_snapshot_bytes or (
                sum(session.cached_bytes for session in self._sessions.values()) + cached_bytes
                > self._limits.max_total_cached_snapshot_bytes
            ):
                self._raise(429, "inspection_capacity_exceeded", "Skill inspection capacity is full")
            inspection_id = self._new_id()
            public = {"inspectionId": inspection_id, **result.public_dict()}
            self._sessions[inspection_id] = _InspectionSession(
                created_at=now,
                public_result=public,
                snapshot=result.snapshot if result.clean else None,
                cached_bytes=cached_bytes,
            )
            return public

    def _new_id(self) -> str:
        for _ in range(self._limits.max_inspection_id_attempts):
            value = self._id_factory()
            if isinstance(value, str) and value and value not in self._sessions:
                return value
        self._raise(503, "inspection_id_unavailable", "Skill inspection could not be created")

    def _purge_expired(self, now: float) -> None:
        expired = [
            key for key, session in self._sessions.items()
            if now - session.created_at > self._limits.inspection_ttl_seconds
        ]
        for key in expired:
            del self._sessions[key]

    def _storage_item(
        self, operation: str, metadata: dict[str, Any], snapshot: InspectionSnapshot
    ) -> tuple[dict[str, Any], str]:
        common_allowed = {"originLabel"}
        if operation == "create":
            allowed = common_allowed | {"id", "slug", "name", "description"}
        else:
            allowed = common_allowed | {"skillId"}
        if not set(metadata).issubset(allowed):
            self._raise(400, "invalid_import_metadata", "Skill import metadata is invalid")
        if any(not isinstance(value, str) or not value.strip() for value in metadata.values()):
            self._raise(400, "invalid_import_metadata", "Skill import metadata is invalid")
        if any(
            key in metadata and not _IMPORT_IDENTIFIER_RE.fullmatch(metadata[key].strip())
            for key in ("id", "slug", "skillId")
        ):
            self._raise(400, "invalid_import_metadata", "Skill import metadata is invalid")
        entries = [{
            "type": entry.entry_type,
            "path": entry.path,
            "contentType": entry.content_type,
            "contentBase64": base64.b64encode(entry.content).decode("ascii"),
            "size": entry.size,
            "digest": entry.digest,
        } for entry in snapshot.entries]
        tools = list(snapshot.metadata.get("allowedTools", ()))
        item: dict[str, Any] = {
            "entries": entries,
            "provenance": {"originLabel": metadata.get("originLabel", "inspected-package")},
            "declaredCapabilities": {"tools": tools},
            "toolDependencies": tools,
        }
        target = ""
        if operation == "create":
            for key in ("id", "slug", "name", "description"):
                if key in metadata:
                    item[key] = metadata[key].strip()
            item.setdefault("slug", snapshot.metadata["name"])
            item.setdefault("name", snapshot.metadata["name"])
            item.setdefault("description", snapshot.metadata["description"])
            item.update({"source": "external", "trustState": "untrusted"})
        else:
            target = metadata.get("skillId", "").strip()
            if not target:
                self._raise(400, "invalid_import_metadata", "Skill import metadata is invalid")
        return item, target

    @staticmethod
    def _raise(status: int, code: str, message: str) -> None:
        raise SkillPackageImportError(status, code, message)
