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
        reference != skill_id
        or type(revision) is not int
        or revision < 1
        or not isinstance(digest, str)
        or _DIGEST.fullmatch(digest) is None
        or not isinstance(payload.get("skillId"), str)
        or not isinstance(instructions, str)
        or not isinstance(references, list)
        or any(not _valid_reference(item) for item in references)
        or not _valid_capabilities(capabilities)
    ):
        raise HTTPException(status_code=502, detail="skill_snapshot_invalid")
    tools = set(capabilities.get("tools", []))
    if not tools.issubset(allowed_tools):
        raise HTTPException(status_code=403, detail="skill_tool_dependency_not_allowed")
    if any(capabilities.get(key) for key in _CAPABILITY_KEYS - {"tools"}):
        raise HTTPException(status_code=403, detail="skill_snapshot_scope_escalation")
    return {key: value for key, value in payload.items() if key != "declaredCapabilities"}


def _valid_reference(item: object) -> bool:
    return (
        isinstance(item, dict)
        and set(item) == {"path", "contentType", "content"}
        and all(isinstance(item[key], str) for key in item)
    )


def _valid_capabilities(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value).issubset(_CAPABILITY_KEYS)
        and all(
            isinstance(items, list)
            and all(isinstance(item, str) and item for item in items)
            for items in value.values()
        )
    )
