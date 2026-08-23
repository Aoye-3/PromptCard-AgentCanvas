from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import HTTPException

StorageRequest = Callable[..., Awaitable[dict[str, Any]]]
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_ALLOWED_KEYS = frozenset({
    "skillId", "skillReferenceCode", "revision", "digest", "instructions", "references",
    "declaredCapabilities",
})
_CAPABILITY_KEYS = frozenset({"tools", "network", "executables", "models", "other"})
_SKILL_CODE = re.compile(r"^SKL-[0-7][0-9A-HJKMNP-TV-Z]{25}$")
_TEXT_TYPES = frozenset({"text/plain", "text/markdown", "application/json"})
_MAX_TOTAL_BYTES = 512 * 1024
_MAX_INSTRUCTION_BYTES = 256 * 1024
_MAX_REFERENCE_BYTES = 128 * 1024
_MAX_REFERENCE_PATH_BYTES = 220
_MAX_REFERENCES = 64
_MAX_CAPABILITY_ITEMS = 64
_MAX_CAPABILITY_ITEM_BYTES = 128


async def resolve_local_agent_skill_snapshot(
    storage_request: StorageRequest,
    *,
    skill_id: str,
    allowed_tools: set[str],
) -> dict[str, Any]:
    payload = await storage_request(
        "GET",
        "/api/skill-host-snapshots/local-agent",
        params={"skillId": skill_id},
    )
    if set(payload) - _ALLOWED_KEYS:
        raise HTTPException(status_code=403, detail="skill_snapshot_scope_escalation")
    reference = payload.get("skillReferenceCode")
    revision = payload.get("revision")
    digest = payload.get("digest")
    instructions = payload.get("instructions")
    references = payload.get("references")
    capabilities = payload.get("declaredCapabilities", {})
    if (
        not isinstance(reference, str)
        or _SKILL_CODE.fullmatch(reference) is None
        or reference.casefold() != skill_id.casefold()
        or type(revision) is not int
        or revision < 1
        or not isinstance(digest, str)
        or _DIGEST.fullmatch(digest) is None
        or not isinstance(payload.get("skillId"), str)
        or not isinstance(instructions, str)
        or not isinstance(references, list)
        or any(not _valid_reference(item) for item in references)
        or not _valid_capabilities(capabilities)
        or not _within_snapshot_budget(instructions, references)
    ):
        raise HTTPException(status_code=502, detail="skill_snapshot_invalid")
    tools = set(capabilities.get("tools", []))
    if not tools.issubset(allowed_tools):
        raise HTTPException(status_code=403, detail="skill_tool_dependency_not_allowed")
    if any(capabilities.get(key) for key in _CAPABILITY_KEYS - {"tools"}):
        raise HTTPException(status_code=403, detail="skill_snapshot_scope_escalation")
    return {key: value for key, value in payload.items() if key != "declaredCapabilities"}


def _valid_reference(item: object) -> bool:
    if not isinstance(item, dict) or set(item) != {"path", "contentType", "content"}:
        return False
    content_size = _utf8_size(item["content"])
    return (
        isinstance(item["path"], str)
        and _valid_reference_path(item["path"])
        and isinstance(item["contentType"], str)
        and item["contentType"] in _TEXT_TYPES
        and content_size is not None
        and content_size <= _MAX_REFERENCE_BYTES
    )


def _valid_capabilities(value: object) -> bool:
    if not isinstance(value, dict) or not set(value).issubset(_CAPABILITY_KEYS):
        return False
    if any(not isinstance(items, list) for items in value.values()):
        return False
    if sum(len(items) for items in value.values()) > _MAX_CAPABILITY_ITEMS:
        return False
    return all(
        isinstance(item, str)
        and bool(item)
        and (size := _utf8_size(item)) is not None
        and size <= _MAX_CAPABILITY_ITEM_BYTES
        for items in value.values()
        for item in items
    )


def _valid_reference_path(value: str) -> bool:
    parts = value.split("/")
    size = _utf8_size(value)
    return (
        size is not None
        and size <= _MAX_REFERENCE_PATH_BYTES
        and len(parts) > 1
        and parts[0] == "references"
        and all(part not in {"", ".", ".."} and "\\" not in part and "\x00" not in part for part in parts)
    )


def _within_snapshot_budget(instructions: str, references: list[dict[str, Any]]) -> bool:
    if len(references) > _MAX_REFERENCES:
        return False
    instruction_bytes = _utf8_size(instructions)
    if instruction_bytes is None or instruction_bytes > _MAX_INSTRUCTION_BYTES:
        return False
    reference_sizes = [
        (_utf8_size(item["path"]), _utf8_size(item["contentType"]), _utf8_size(item["content"]))
        for item in references
    ]
    if any(size is None for sizes in reference_sizes for size in sizes):
        return False
    total = instruction_bytes + sum(
        size for sizes in reference_sizes for size in sizes if size is not None
    )
    return total <= _MAX_TOTAL_BYTES


def _utf8_size(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError:
        return None
