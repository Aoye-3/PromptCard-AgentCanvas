from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any

import httpx
from fastapi import HTTPException

from app.gateway.bridge_auth import BridgePrincipal, require_bridge_scope
from app.gateway.internal_auth import create_internal_auth_headers

_REFERENCE_PATTERN = re.compile(
    r"^(?P<prefix>PRJ|PLP|PLM|CVT|CVM|CVC|SKL|CVD|CVS)-[0-7][0-9A-HJKMNP-TV-Z]{25}$",
    re.IGNORECASE,
)
_BOOTSTRAP_TEXT = """# PromptCard Bootstrap

PromptCard is a portable creative-context environment. Start with
`promptcard_runtime_describe`, then call `promptcard_workspace_describe` with
the exact PRJ and CVC selected by the user. Read only approved Skill revisions
and exact references. All writes are proposals and require user review.
"""


def runtime_description(principal: BridgePrincipal) -> dict[str, Any]:
    require_bridge_scope(principal, "bridge:read")
    delivery_scopes = [
        "bridge:deliver:document",
        "bridge:deliver:storyboard",
        "bridge:deliver:prompt",
        "bridge:deliver:image",
    ]
    tools = [
        _tool("promptcard_runtime_describe", "read", ["bridge:read"], "Describe the Bridge contract, Tools, limits, and next discovery step."),
        _tool("promptcard_workspace_describe", "read", ["bridge:read"], "Describe one explicit PRJ/CVC workspace, Skill pins, objects, and pending proposals."),
        _tool("promptcard_skill_read", "read", ["bridge:read"], "Read one user-approved exact Skill revision."),
        _tool("promptcard_reference_resolve", "read", ["bridge:read"], "Resolve an exact typed public reference inside its project scope."),
        _tool("promptcard_prompt_search", "read", ["bridge:read"], "Search bounded Prompt evidence; results are discovery-only."),
        _tool("promptcard_asset_read", "read", ["bridge:read"], "Read one explicitly authorized bounded asset."),
        _tool("promptcard_delivery_preview", "proposal", delivery_scopes, "Validate a typed creative writeback and create or replay its preview."),
        _tool("promptcard_delivery_commit", "proposal", delivery_scopes, "Commit a preview to the visual review queue; never auto-apply it."),
        _tool("promptcard_delivery_status", "status", ["bridge:status"], "Read delivery state without repeating its mutation."),
        _tool("promptcard_asset_stage", "proposal", ["bridge:deliver:image"], "Stage one validated workspace image and return an opaque handle."),
    ]
    return {
        "contractVersion": "3.0.0",
        "serverName": "promptcard-bridge",
        "bootstrapSkill": {
            "name": "promptcard-bootstrap",
            "revision": 1,
            "digest": "sha256:" + hashlib.sha256(_BOOTSTRAP_TEXT.encode("utf-8")).hexdigest(),
        },
        "tools": tools,
        "writebackKinds": [
            "document.create",
            "document.change",
            "storyboard.create",
            "storyboard.change",
            "prompt.create",
            "image.place",
        ],
        "constraints": {
            "explicitContextRequired": True,
            "userApprovalRequired": True,
            "promptCreateOnly": True,
            "arbitraryPathsAccepted": False,
        },
        "next": "Ask the user to select a project and create or choose a CVC, then call promptcard_workspace_describe.",
    }


async def workspace_description(
    principal: BridgePrincipal,
    project_code: str,
    cvc_code: str,
) -> dict[str, Any]:
    require_bridge_scope(principal, "bridge:read")
    project = _canonical_reference(project_code, "PRJ")
    context = _canonical_reference(cvc_code, "CVC")
    resolved = await _storage_request("GET", f"/api/context-packs/{context}/resolve")
    if resolved.get("projectCode") != project or resolved.get("cvcCode") != context:
        raise HTTPException(
            status_code=409,
            detail={"code": "context_project_mismatch"},
        )
    inspection = await _storage_request("GET", f"/api/context-packs/{context}")
    project_result = await _storage_request("GET", f"/api/projects/references/{project}")
    project_summary = project_result.get("project") or {}
    if project_summary.get("referenceCode") != project:
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    snapshot_digest = inspection.get("snapshotDigest")
    if not isinstance(snapshot_digest, str):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    return {
        "projectCode": project,
        "cvcCode": context,
        "contextRevision": inspection.get("projectRevision", project_summary.get("revision", 0)),
        "contextDigest": snapshot_digest,
        "revoked": inspection.get("revokedAt") is not None,
        "skills": await _workspace_skills(principal),
        "objects": _workspace_objects(resolved.get("entries")),
        "pendingDeliveries": 0,
    }


def _workspace_objects(entries: Any) -> list[dict[str, Any]]:
    if not isinstance(entries, list):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    result = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("reference"), dict):
            continue
        reference = entry["reference"]
        if reference.get("namespace") not in {"canvasDocument", "canvasStoryboard"}:
            continue
        try:
            content = json.loads(entry.get("content", ""))
        except (TypeError, json.JSONDecodeError):
            raise HTTPException(
                status_code=502, detail={"code": "storage_response_invalid"}
            ) from None
        if not isinstance(content, dict):
            raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
        digest = content.get("digest")
        revision = content.get("revision")
        title = content.get("title")
        if (
            not isinstance(reference.get("code"), str)
            or not isinstance(digest, str)
            or not isinstance(revision, int)
            or not isinstance(title, str)
        ):
            raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
        result.append(
            {
                "reference": {
                    "namespace": reference["namespace"],
                    "code": reference["code"],
                },
                "revision": revision,
                "digest": digest,
                "title": title[:500],
            }
        )
        if len(result) == 256:
            break
    return result


async def reference_resolve(
    principal: BridgePrincipal,
    cvc_code: str,
    reference_code: str,
) -> dict[str, Any]:
    require_bridge_scope(principal, "bridge:read")
    context = _canonical_reference(cvc_code, "CVC")
    reference = _canonical_reference(reference_code)
    resolved_context = await _storage_request(
        "GET", f"/api/context-packs/{context}/resolve"
    )
    project_code = resolved_context.get("projectCode")
    if not isinstance(project_code, str):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    allowed_codes = {
        context,
        project_code,
        *(
            entry.get("reference", {}).get("code")
            for entry in resolved_context.get("entries", [])
            if isinstance(entry, dict)
        ),
        *resolved_context.get("sourceCodes", []),
    }
    if reference not in allowed_codes:
        raise HTTPException(
            status_code=403,
            detail={"code": "reference_outside_context"},
        )
    prefix = reference[:3]
    if prefix == "PRJ":
        return await _storage_request(
            "GET", f"/api/projects/references/{reference}"
        )
    if prefix == "CVC":
        return resolved_context
    if prefix in {"PLP", "PLM"}:
        return await _storage_request(
            "GET", f"/api/prompt-library/references/{reference}"
        )
    if prefix in {"CVT", "CVM"}:
        return await _storage_request(
            "GET", f"/api/projects/references/{project_code}/nodes/{reference}"
        )
    if prefix == "SKL":
        raise HTTPException(
            status_code=422,
            detail={"code": "use_promptcard_skill_read"},
        )
    if prefix in {"CVD", "CVS"}:
        return await _storage_request(
            "GET", f"/api/projects/references/{project_code}/creative/{reference}"
        )
    raise HTTPException(status_code=422, detail={"code": "reference_invalid"})


async def skill_read(
    principal: BridgePrincipal,
    skill_code: str,
    revision: int,
    digest: str,
) -> dict[str, Any]:
    require_bridge_scope(principal, "bridge:read")
    code = _canonical_reference(skill_code, "SKL")
    pins = await _workspace_skills(principal)
    pin = next((item for item in pins if item["skillCode"] == code), None)
    if pin is None:
        raise HTTPException(status_code=403, detail={"code": "skill_not_enabled"})
    if pin["projectionHealth"] != "healthy":
        raise HTTPException(
            status_code=409, detail={"code": "skill_projection_unhealthy"}
        )
    if pin["revision"] != revision or pin["digest"] != digest:
        raise HTTPException(status_code=409, detail={"code": "skill_pin_stale"})
    skill = await _storage_request("GET", f"/api/skills/{code}")
    if skill.get("lifecycleStatus") != "active":
        raise HTTPException(status_code=410, detail={"code": "skill_archived"})
    if skill.get("trustState") != "trusted":
        raise HTTPException(status_code=403, detail={"code": "skill_untrusted"})
    selected = next(
        (
            item
            for item in skill.get("revisions", [])
            if item.get("revision") == revision and item.get("digest") == digest
        ),
        None,
    )
    if not isinstance(selected, dict):
        raise HTTPException(status_code=409, detail={"code": "skill_pin_stale"})
    return {
        "skillCode": code,
        "revision": revision,
        "digest": digest,
        "name": str(skill.get("name") or "")[:500],
        "description": str(skill.get("description") or "")[:2000],
        "instructions": str(selected.get("instructions") or "")[:100_000],
        "references": list(selected.get("references") or [])[:32],
        "declaredCapabilities": dict(selected.get("declaredCapabilities") or {}),
    }


async def _workspace_skills(principal: BridgePrincipal) -> list[dict[str, Any]]:
    if principal.repository_scope is None:
        return []
    catalog = await _storage_request("GET", "/api/skills")
    skills = catalog.get("skills")
    if not isinstance(skills, list):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    result = []
    for skill in skills:
        if not isinstance(skill, dict) or skill.get("lifecycleStatus") != "active":
            continue
        if skill.get("trustState") != "trusted" or not isinstance(skill.get("referenceCode"), str):
            continue
        try:
            pin = await _storage_request(
                "GET",
                f'/api/skills/{skill["referenceCode"]}/host-pins/codex',
                params={"repositoryScope": principal.repository_scope},
            )
        except HTTPException as exc:
            if exc.status_code == 404:
                continue
            raise
        if not pin.get("enabled"):
            continue
        projection_health = pin.get("projectionHealth")
        projection_state = (
            projection_health.get("state")
            if isinstance(projection_health, dict)
            else None
        )
        result.append(
            {
                "skillCode": skill["referenceCode"],
                "revision": pin["revision"],
                "digest": pin["digest"],
                "projectionHealth": (
                    "healthy"
                    if projection_state == "healthy"
                    else "missing"
                    if not pin.get("projection")
                    else "stale"
                ),
            }
        )
        if len(result) == 8:
            break
    return result


def _canonical_reference(value: str, expected_prefix: str | None = None) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail={"code": "reference_invalid"})
    match = _REFERENCE_PATTERN.fullmatch(value)
    if match is None or (
        expected_prefix is not None
        and match.group("prefix").upper() != expected_prefix
    ):
        raise HTTPException(status_code=422, detail={"code": "reference_invalid"})
    return value.upper()


def _tool(name: str, mode: str, scopes: list[str], description: str) -> dict[str, Any]:
    return {
        "name": name,
        "mode": mode,
        "requiredScopes": scopes,
        "description": description,
    }


async def _storage_request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base_url = os.getenv("PROMPTCARD_STORAGE_URL", "http://127.0.0.1:8002").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.request(
                method,
                f"{base_url}{path}",
                params=params,
                headers=create_internal_auth_headers(),
            )
    except httpx.HTTPError:
        raise HTTPException(
            status_code=503, detail={"code": "storage_unavailable"}
        ) from None
    try:
        payload = response.json()
    except ValueError:
        raise HTTPException(
            status_code=502, detail={"code": "storage_response_invalid"}
        ) from None
    if response.status_code >= 400:
        detail = payload.get("detail") if isinstance(payload, dict) else None
        code = detail.get("code") if isinstance(detail, dict) else None
        sanitized: dict[str, Any] = {
            "code": code if isinstance(code, str) else "storage_request_failed"
        }
        reference = detail.get("reference") if isinstance(detail, dict) else None
        if (
            isinstance(reference, dict)
            and isinstance(reference.get("namespace"), str)
            and isinstance(reference.get("code"), str)
            and _REFERENCE_PATTERN.fullmatch(reference["code"])
        ):
            sanitized["reference"] = {
                "namespace": reference["namespace"],
                "code": reference["code"].upper(),
            }
        status_code = response.status_code if response.status_code in {400, 404, 409, 410, 422} else 502
        raise HTTPException(status_code=status_code, detail=sanitized)
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502, detail={"code": "storage_response_invalid"}
        )
    return payload
