from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import unicodedata
from typing import Any


DIGEST_VERSION = "skill-package-v1"
ENTRY_TYPES = frozenset({"instruction", "reference", "script", "asset"})
CAPABILITY_KEYS = frozenset({"tools", "network", "executables", "models", "other"})
_ENTRY_KEYS = frozenset({"type", "path", "contentType", "contentBase64", "size", "digest"})


def normalize_package_entries(entries: object) -> list[dict[str, Any]]:
    if not isinstance(entries, list) or not entries:
        raise ValueError("Skill package entries are required")
    normalized: list[dict[str, Any]] = []
    paths: set[str] = set()
    for value in entries:
        if not isinstance(value, dict) or not set(value).issubset(_ENTRY_KEYS):
            raise ValueError("Skill package entry fields are invalid")
        entry_type = value.get("type")
        if entry_type not in ENTRY_TYPES:
            raise ValueError("Skill package entry type is invalid")
        path = normalize_package_path(value.get("path"))
        if path in paths:
            raise ValueError(f"Duplicate canonical path: {path}")
        paths.add(path)
        content_type = value.get("contentType")
        if not isinstance(content_type, str) or not content_type.strip():
            raise ValueError("Skill package entry contentType is required")
        encoded = value.get("contentBase64")
        if not isinstance(encoded, str):
            raise ValueError("Skill package entry contentBase64 is required")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("Skill package entry contentBase64 is invalid") from exc
        if base64.b64encode(content).decode("ascii") != encoded:
            raise ValueError("Skill package entry contentBase64 is not canonical")
        digest = "sha256:" + hashlib.sha256(content).hexdigest()
        if "size" in value and value["size"] != len(content):
            raise ValueError("Skill package entry size does not match content")
        if "digest" in value and value["digest"] != digest:
            raise ValueError("Skill package entry digest does not match content")
        normalized.append({
            "type": entry_type,
            "path": path,
            "contentType": content_type.strip().lower(),
            "content": content,
            "size": len(content),
            "digest": digest,
        })
    return sorted(normalized, key=lambda entry: entry["path"])


def normalize_package_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("Skill package path is invalid")
    path = unicodedata.normalize("NFC", value.replace("\\", "/"))
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        raise ValueError("Skill package path must be relative")
    parts = path.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("Skill package path contains an invalid segment")
    return "/".join(parts)


def canonical_package_digest(entries: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    _add_length_prefixed(digest, DIGEST_VERSION.encode("ascii"))
    _add_length_prefixed(digest, len(entries).to_bytes(8, "big"))
    for entry in entries:
        _add_length_prefixed(digest, entry["type"].encode("utf-8"))
        _add_length_prefixed(digest, entry["path"].encode("utf-8"))
        _add_length_prefixed(digest, entry["content"])
    return "sha256:" + digest.hexdigest()


def legacy_package_entries(instructions: str, references: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = [{
        "type": "instruction",
        "path": "SKILL.md",
        "contentType": "text/markdown",
        "contentBase64": base64.b64encode(instructions.encode("utf-8")).decode("ascii"),
    }]
    for index, reference in enumerate(references, start=1):
        content = json.dumps(
            reference,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        entries.append({
            "type": "reference",
            "path": f"references/reference-{index:04d}.json",
            "contentType": "application/json",
            "contentBase64": base64.b64encode(content).decode("ascii"),
        })
    return normalize_package_entries(entries)


def normalize_declared_capabilities(value: object, legacy_tools: object = None) -> dict[str, list[str]]:
    if value is None:
        value = {"tools": legacy_tools or []}
    if not isinstance(value, dict) or not set(value).issubset(CAPABILITY_KEYS):
        raise ValueError("Skill declaredCapabilities fields are invalid")
    normalized: dict[str, list[str]] = {}
    for key in sorted(CAPABILITY_KEYS):
        items = value.get(key, [])
        if not isinstance(items, list) or any(not isinstance(item, str) or not item.strip() for item in items):
            raise ValueError(f"Skill declaredCapabilities.{key} must be an array of strings")
        normalized[key] = sorted({item.strip() for item in items})
    return normalized


def normalize_provenance(
    value: object,
    source: str,
    default_origin: str,
    *,
    legacy_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if value is None:
        value = {}
    if not isinstance(value, dict) or not set(value).issubset({"originLabel"}):
        raise ValueError("Skill provenance fields are invalid")
    origin = value.get("originLabel", default_origin)
    if (
        not isinstance(origin, str)
        or not origin.strip()
        or len(origin.strip()) > 120
        or "\x00" in origin
        or origin.startswith(("/", "\\"))
        or re.match(r"^[A-Za-z]:[\\/]", origin)
        or re.search(r"(?i)(password|secret|token|credential)\s*[:=]", origin)
    ):
        raise ValueError("Skill provenance originLabel is invalid")
    provenance: dict[str, Any] = {"source": source, "originLabel": origin.strip()}
    if legacy_metadata is not None:
        if set(legacy_metadata) != {"revision", "digest"}:
            raise ValueError("Skill provenance legacyMetadata fields are invalid")
        revision = legacy_metadata["revision"]
        digest = legacy_metadata["digest"]
        if type(revision) is not int or revision < 1 or not isinstance(digest, str):
            raise ValueError("Skill provenance legacyMetadata is invalid")
        provenance["legacyMetadata"] = {"revision": revision, "digest": digest}
    return provenance


def entry_dto(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": entry["type"],
        "path": entry["path"],
        "contentType": entry["contentType"],
        "size": entry["size"],
        "digest": entry["digest"],
        "contentBase64": base64.b64encode(entry["content"]).decode("ascii"),
    }


def compatibility_instruction(entries: list[dict[str, Any]]) -> str:
    for entry in entries:
        if entry["type"] == "instruction":
            return entry["content"].decode("utf-8", errors="replace")
    return ""


def _add_length_prefixed(digest: Any, value: bytes) -> None:
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)
