from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from typing import Any
from urllib.parse import quote, unquote

import httpx
from fastapi import HTTPException, UploadFile

from app.gateway.bridge_auth import BridgePrincipal, require_bridge_scope
from app.gateway.internal_auth import create_internal_auth_headers

_REFERENCE_PATTERN = re.compile(
    r"^(?P<prefix>PRJ|PLP|PLM|CVT|CVM|CVC|SKL|CVD|CVS)-[0-7][0-9A-HJKMNP-TV-Z]{25}$",
    re.IGNORECASE,
)
_BRIDGE_ASSET_CONTENT_TYPES = {
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
    "video/mp4",
    "video/webm",
}
MAX_BRIDGE_ASSET_READ_BYTES = 5 * 1024 * 1024
MAX_BRIDGE_ASSET_STAGE_BYTES = 30 * 1024 * 1024
_BOOTSTRAP_TEXT = """# PromptCard Bootstrap

PromptCard is a portable creative-context environment. Start with
`promptcard_runtime_describe`, then call `promptcard_workspace_describe` with
the exact PRJ and CVC selected by the user. Read only approved Skill revisions
and exact references. All writes are proposals and require user review.
"""


def bridge_contract_description() -> dict[str, Any]:
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


def runtime_description(principal: BridgePrincipal) -> dict[str, Any]:
    require_bridge_scope(principal, "bridge:read")
    return bridge_contract_description()


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
    pending = await _storage_request(
        "GET",
        f"/api/internal/context-packs/{context}/bridge-deliveries",
        params={"profileId": principal.profile_id, "state": "pending_review"},
    )
    pending_deliveries = pending.get("deliveries")
    if not isinstance(pending_deliveries, list):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    resolved_entries = resolved.get("entries")
    if (
        not isinstance(resolved_entries, list)
        or len(resolved_entries) > 256
        or any(
            not isinstance(entry, dict)
            or not isinstance(entry.get("reference"), dict)
            or not isinstance(entry["reference"].get("code"), str)
            or _REFERENCE_PATTERN.fullmatch(entry["reference"]["code"]) is None
            for entry in resolved_entries
        )
    ):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    object_codes = [entry["reference"]["code"].upper() for entry in resolved_entries]
    if len(object_codes) != len(set(object_codes)):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    return {
        "projectCode": project,
        "cvcCode": context,
        "contextRevision": inspection.get("projectRevision", project_summary.get("revision", 0)),
        "contextDigest": snapshot_digest,
        "revoked": inspection.get("revokedAt") is not None,
        "skills": await _workspace_skills(principal),
        "objects": _workspace_objects(resolved_entries),
        "objectCodes": object_codes,
        "pendingDeliveries": len(pending_deliveries),
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


async def prompt_search(
    principal: BridgePrincipal,
    cvc_code: str,
    query: str,
    types: list[str],
    categories: list[str],
    limit: int,
) -> dict[str, Any]:
    require_bridge_scope(principal, "bridge:read")
    context = _canonical_reference(cvc_code, "CVC")
    resolved_context = await _storage_request(
        "GET", f"/api/context-packs/{context}/resolve"
    )
    if resolved_context.get("cvcCode") != context:
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    return await _storage_request(
        "POST",
        "/api/prompt-retrieval/search",
        json={
            "query": query,
            "types": types,
            "categories": categories,
            "limit": limit,
            "callerKind": "bridge",
            "callerId": principal.profile_id,
        },
    )


async def delivery_preview(
    principal: BridgePrincipal,
    request: dict[str, Any],
) -> dict[str, Any]:
    kind = request.get("kind")
    kind_routes = {
        "document.create": (
            "bridge:deliver:document",
            "/api/internal/bridge-document-deliveries/preview",
        ),
        "document.change": (
            "bridge:deliver:document",
            "/api/internal/bridge-document-deliveries/preview",
        ),
        "storyboard.create": (
            "bridge:deliver:storyboard",
            "/api/internal/bridge-storyboard-deliveries/preview",
        ),
        "storyboard.change": (
            "bridge:deliver:storyboard",
            "/api/internal/bridge-storyboard-deliveries/preview",
        ),
        "prompt.create": (
            "bridge:deliver:prompt",
            "/api/internal/bridge-prompt-deliveries/preview",
        ),
        "image.place": (
            "bridge:deliver:image",
            "/api/internal/bridge-image-deliveries/preview",
        ),
    }
    route = kind_routes.get(kind)
    if route is None:
        raise HTTPException(status_code=422, detail={"code": "delivery_kind_unavailable"})
    scope, path = route
    require_bridge_scope(principal, scope)
    request = await _validate_delivery_sources_and_skills(principal, request)
    record = await _storage_request(
        "POST",
        path,
        json={
            "operationContext": principal.operation_context(),
            "deliveryRequest": request,
        },
    )
    return _delivery_contract_record(record)


async def _validate_delivery_sources_and_skills(
    principal: BridgePrincipal,
    request: dict[str, Any],
) -> dict[str, Any]:
    target = request.get("target")
    if not isinstance(target, dict):
        raise HTTPException(status_code=422, detail={"code": "delivery_target_invalid"})
    cvc_code = _canonical_reference(target.get("cvcCode"), "CVC")
    source_codes = request.get("sourceCodes")
    if not isinstance(source_codes, list):
        raise HTTPException(
            status_code=422, detail={"code": "delivery_source_manifest_invalid"}
        )
    canonical_sources = [_canonical_reference(code) for code in source_codes]
    if len(canonical_sources) != len(set(canonical_sources)):
        raise HTTPException(
            status_code=422, detail={"code": "delivery_source_manifest_invalid"}
        )
    if canonical_sources:
        resolved = await _storage_request(
            "GET", f"/api/context-packs/{cvc_code}/resolve"
        )
        resolved_sources = resolved.get("sourceCodes")
        resolved_entries = resolved.get("entries")
        if (
            resolved.get("cvcCode") != cvc_code
            or not isinstance(resolved.get("projectCode"), str)
            or not isinstance(resolved_sources, list)
            or not all(isinstance(code, str) for code in resolved_sources)
            or not isinstance(resolved_entries, list)
        ):
            raise HTTPException(
                status_code=502, detail={"code": "storage_response_invalid"}
            )
        allowed = {
            cvc_code,
            resolved.get("projectCode"),
            *resolved_sources,
            *(
                entry.get("reference", {}).get("code")
                for entry in resolved_entries
                if isinstance(entry, dict)
            ),
        }
        if any(code not in allowed for code in canonical_sources):
            raise HTTPException(
                status_code=403, detail={"code": "reference_outside_context"}
            )

    pins = request.get("skillPins")
    if not isinstance(pins, list):
        raise HTTPException(
            status_code=422, detail={"code": "delivery_source_manifest_invalid"}
        )
    if pins:
        enabled = {
            item["skillCode"]: item for item in await _workspace_skills(principal)
        }
        seen: set[str] = set()
        for pin in pins:
            code = _canonical_reference(pin.get("skillCode"), "SKL")
            if code in seen:
                raise HTTPException(
                    status_code=422,
                    detail={"code": "delivery_source_manifest_invalid"},
                )
            seen.add(code)
            approved = enabled.get(code)
            if approved is None:
                raise HTTPException(status_code=403, detail={"code": "skill_not_enabled"})
            if approved["projectionHealth"] != "healthy":
                raise HTTPException(
                    status_code=409, detail={"code": "skill_projection_unhealthy"}
                )
            if (
                approved["revision"] != pin.get("revision")
                or approved["digest"] != pin.get("digest")
            ):
                raise HTTPException(status_code=409, detail={"code": "skill_pin_stale"})
    normalized_target = dict(target)
    normalized_target["cvcCode"] = cvc_code
    if request.get("kind") == "document.change":
        normalized_target["documentCode"] = _canonical_reference(
            target.get("documentCode"), "CVD"
        )
    if request.get("kind") == "storyboard.change":
        normalized_target["storyboardCode"] = _canonical_reference(
            target.get("storyboardCode"), "CVS"
        )
    normalized_payload = dict(request.get("payload") or {})
    if request.get("kind") == "storyboard.create":
        normalized_payload["sourceDocumentCode"] = _canonical_reference(
            normalized_payload.get("sourceDocumentCode"), "CVD"
        )
    return {
        **request,
        "target": normalized_target,
        "sourceCodes": canonical_sources,
        "payload": normalized_payload,
    }


async def asset_stage(
    principal: BridgePrincipal,
    request: dict[str, Any],
    upload: UploadFile,
) -> dict[str, Any]:
    require_bridge_scope(principal, "bridge:deliver:image")
    normalized = dict(request)
    normalized["cvcCode"] = _canonical_reference(request.get("cvcCode"), "CVC")
    workspace_path = request.get("workspaceRelativePath")
    if not isinstance(workspace_path, str):
        raise HTTPException(status_code=422, detail={"code": "workspace_path_invalid"})
    workspace_path = workspace_path.replace("\\", "/")
    path_parts = workspace_path.split("/")
    if (
        workspace_path.startswith("/")
        or ":" in workspace_path
        or any(part in {"", ".", ".."} for part in path_parts)
    ):
        raise HTTPException(status_code=422, detail={"code": "workspace_path_invalid"})
    normalized["workspaceRelativePath"] = workspace_path
    if upload.content_type != normalized.get("mediaType"):
        raise HTTPException(status_code=422, detail={"code": "asset_media_type_mismatch"})
    uploaded_name = (upload.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if uploaded_name != path_parts[-1]:
        raise HTTPException(status_code=422, detail={"code": "asset_filename_mismatch"})
    content = bytearray()
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        content.extend(chunk)
        if len(content) > MAX_BRIDGE_ASSET_STAGE_BYTES:
            raise HTTPException(status_code=413, detail={"code": "asset_stage_too_large"})
    if len(content) != normalized.get("byteLength"):
        raise HTTPException(status_code=422, detail={"code": "asset_size_mismatch"})
    actual_digest = "sha256:" + hashlib.sha256(content).hexdigest()
    if actual_digest != normalized.get("contentDigest"):
        raise HTTPException(status_code=422, detail={"code": "asset_digest_mismatch"})
    record = await _storage_stage_request(
        principal.operation_context(), normalized, bytes(content)
    )
    required = (
        "operationContext", "request", "state", "disposition",
        "stagedAssetHandle", "contentType", "size", "width", "height",
        "contentDigest", "preparedDigest", "createdAt", "updatedAt",
    )
    if not isinstance(record, dict) or any(key not in record for key in required):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    # Internal asset identifiers never cross the external Bridge boundary.
    return {key: record[key] for key in required}


async def delivery_commit(
    principal: BridgePrincipal,
    request: dict[str, Any],
) -> dict[str, Any]:
    proposal = await _storage_request(
        "GET",
        f"/api/internal/bridge-delivery-proposals/{quote(request['proposalId'], safe='')}",
        params={"profileId": principal.profile_id},
    )
    kind = proposal.get("kind")
    routes = {
        "document.create": (
            "bridge:deliver:document",
            "/api/internal/bridge-document-deliveries/commit",
        ),
        "document.change": (
            "bridge:deliver:document",
            "/api/internal/bridge-document-deliveries/commit",
        ),
        "storyboard.create": (
            "bridge:deliver:storyboard",
            "/api/internal/bridge-storyboard-deliveries/commit",
        ),
        "storyboard.change": (
            "bridge:deliver:storyboard",
            "/api/internal/bridge-storyboard-deliveries/commit",
        ),
        "prompt.create": (
            "bridge:deliver:prompt",
            "/api/internal/bridge-prompt-deliveries/commit",
        ),
        "image.place": (
            "bridge:deliver:image",
            "/api/internal/bridge-image-deliveries/commit",
        ),
    }
    route = routes.get(kind)
    if route is None:
        raise HTTPException(status_code=422, detail={"code": "delivery_kind_unavailable"})
    scope, path = route
    require_bridge_scope(principal, scope)
    record = await _storage_request(
        "POST",
        path,
        json={
            "operationContext": principal.operation_context(),
            "deliveryRequest": request,
        },
    )
    return _delivery_contract_record(record)


async def delivery_status(
    principal: BridgePrincipal,
    client_request_id: str,
) -> dict[str, Any]:
    require_bridge_scope(principal, "bridge:status")
    record = await _storage_request(
        "GET",
        f"/api/internal/bridge-prompt-deliveries/{quote(client_request_id, safe='')}",
        params={"profileId": principal.profile_id},
    )
    return _delivery_contract_record(record)


def _delivery_contract_record(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    fields = (
        "operationContext", "request", "proposalId", "state", "disposition",
        "resultCodes", "message", "createdAt", "updatedAt",
    )
    if any(field not in value for field in fields):
        raise HTTPException(status_code=502, detail={"code": "storage_response_invalid"})
    return {field: value[field] for field in fields}


async def asset_read(
    principal: BridgePrincipal,
    cvc_code: str,
    reference_code: str,
) -> dict[str, Any]:
    require_bridge_scope(principal, "bridge:read")
    context = _canonical_reference(cvc_code, "CVC")
    reference = _canonical_reference(reference_code)
    if reference[:3] not in {"CVM", "PLM"}:
        raise HTTPException(
            status_code=422, detail={"code": "asset_reference_invalid"}
        )
    return await _storage_asset_request(context, reference)


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
    json: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base_url = os.getenv("PROMPTCARD_STORAGE_URL", "http://127.0.0.1:8002").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.request(
                method,
                f"{base_url}{path}",
                params=params,
                json=json,
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
        _raise_storage_error(response.status_code, payload)
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502, detail={"code": "storage_response_invalid"}
        )
    return payload


async def _storage_stage_request(
    operation_context: dict[str, Any],
    stage_request: dict[str, Any],
    content: bytes,
) -> dict[str, Any]:
    base_url = os.getenv("PROMPTCARD_STORAGE_URL", "http://127.0.0.1:8002").rstrip("/")
    metadata = json.dumps(
        {"operationContext": operation_context, "stageRequest": stage_request},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if len(metadata.encode("utf-8")) > 8192:
        raise HTTPException(status_code=422, detail={"code": "asset_stage_request_invalid"})
    headers = {
        **create_internal_auth_headers(),
        "Content-Type": "application/octet-stream",
        "X-PromptCard-Stage-Metadata": metadata,
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{base_url}/api/internal/bridge-image-assets/stage",
                content=content,
                headers=headers,
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
        _raise_storage_error(response.status_code, payload)
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502, detail={"code": "storage_response_invalid"}
        )
    return payload


async def _storage_asset_request(
    cvc_code: str,
    reference_code: str,
) -> dict[str, Any]:
    base_url = os.getenv("PROMPTCARD_STORAGE_URL", "http://127.0.0.1:8002").rstrip("/")
    path = (
        f"/api/internal/context-packs/{quote(cvc_code, safe='')}"
        f"/assets/{quote(reference_code, safe='')}"
    )
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            async with client.stream(
                "GET",
                f"{base_url}{path}",
                headers=create_internal_auth_headers(),
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                    try:
                        payload = response.json()
                    except ValueError:
                        payload = None
                    _raise_storage_error(response.status_code, payload)
                content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                if content_type not in _BRIDGE_ASSET_CONTENT_TYPES:
                    raise HTTPException(
                        status_code=502, detail={"code": "asset_content_type_invalid"}
                    )
                declared_length = response.headers.get("content-length")
                if declared_length is not None:
                    try:
                        declared_size = int(declared_length)
                    except ValueError:
                        raise HTTPException(
                            status_code=502,
                            detail={"code": "storage_response_invalid"},
                        ) from None
                    if declared_size > MAX_BRIDGE_ASSET_READ_BYTES:
                        raise HTTPException(
                            status_code=413, detail={"code": "asset_read_too_large"}
                        )
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_BRIDGE_ASSET_READ_BYTES:
                        raise HTTPException(
                            status_code=413, detail={"code": "asset_read_too_large"}
                        )
                headers = dict(response.headers)
    except HTTPException:
        raise
    except httpx.HTTPError:
        raise HTTPException(
            status_code=503, detail={"code": "storage_unavailable"}
        ) from None

    returned_code = headers.get("x-promptcard-reference-code")
    namespace = headers.get("x-promptcard-reference-namespace")
    declared_asset_size = headers.get("x-promptcard-asset-size")
    expected_namespace = "canvasMedia" if reference_code.startswith("CVM-") else "promptMedia"
    try:
        metadata_size = int(declared_asset_size or "")
    except ValueError:
        metadata_size = -1
    if (
        returned_code != reference_code
        or namespace != expected_namespace
        or metadata_size != len(content)
        or not content
    ):
        raise HTTPException(
            status_code=502, detail={"code": "storage_response_invalid"}
        )
    filename = unquote(headers.get("x-file-name", ""))
    if not filename or len(filename) > 500 or "\x00" in filename:
        raise HTTPException(
            status_code=502, detail={"code": "storage_response_invalid"}
        )
    encoded = base64.b64encode(bytes(content)).decode("ascii")
    return {
        "reference": {"namespace": namespace, "code": reference_code},
        "filename": filename,
        "contentType": content_type,
        "size": len(content),
        "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
        "dataBase64": encoded,
    }


def _raise_storage_error(status_code: int, payload: Any) -> None:
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
    public_status = status_code if status_code in {400, 403, 404, 409, 410, 413, 422} else 502
    raise HTTPException(status_code=public_status, detail=sanitized)
