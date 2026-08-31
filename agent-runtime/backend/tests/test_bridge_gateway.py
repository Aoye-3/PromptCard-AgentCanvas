from __future__ import annotations

import hashlib
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.auth_middleware import AuthMiddleware
from app.gateway.bridge import _storage_asset_request, _storage_request
from app.gateway.csrf_middleware import CSRFMiddleware
from app.gateway.routers import bridge

TOKEN = "bridge-test-token-that-is-longer-than-thirty-two-characters"
PRJ = "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV"
CVC = "CVC-01ARZ3NDEKTSV4RRFFQ69G5FAV"
DIGEST = "sha256:" + "a" * 64
CVD = "CVD-01ARZ3NDEKTSV4RRFFQ69G5FAV"
CVS = "CVS-01ARZ3NDEKTSV4RRFFQ69G5FAV"


@pytest.fixture
def bridge_profiles(monkeypatch):
    monkeypatch.setenv(
        "PROMPTCARD_BRIDGE_PROFILES_JSON",
        json.dumps(
            {
                "codex-local": {
                    "token": TOKEN,
                    "repositoryScope": "repo-one",
                    "scopes": [
                        "bridge:read",
                        "bridge:deliver:document",
                        "bridge:deliver:storyboard",
                        "bridge:deliver:prompt",
                        "bridge:deliver:image",
                        "bridge:status",
                    ],
                    "clientInfo": {"name": "codex", "version": "1.0.0"},
                }
            }
        ),
    )


@pytest.fixture
def client(bridge_profiles):
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.add_middleware(CSRFMiddleware)
    app.include_router(bridge.router)

    @app.get("/api/promptcard/runtime/private-test")
    async def private_test():
        return {"ok": True}

    return TestClient(app)


def auth_headers(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_bridge_runtime_describe_requires_a_separate_trusted_profile(client):
    assert client.get("/api/promptcard/bridge/v3/runtime").status_code == 401
    assert (
        client.get(
            "/api/promptcard/bridge/v3/runtime",
            headers=auth_headers("wrong-token-that-is-also-long-enough-to-parse"),
        ).status_code
        == 401
    )

    response = client.get(
        "/api/promptcard/bridge/v3/runtime", headers=auth_headers()
    )
    assert response.status_code == 200
    body = response.json()
    assert body["contractVersion"] == "3.0.0"
    assert body["bootstrapSkill"]["name"] == "promptcard-bootstrap"
    assert {tool["name"] for tool in body["tools"]} == {
        "promptcard_runtime_describe",
        "promptcard_workspace_describe",
        "promptcard_skill_read",
        "promptcard_reference_resolve",
        "promptcard_prompt_search",
        "promptcard_asset_read",
        "promptcard_delivery_preview",
        "promptcard_delivery_commit",
        "promptcard_delivery_status",
        "promptcard_asset_stage",
    }
    assert body["constraints"] == {
        "explicitContextRequired": True,
        "userApprovalRequired": True,
        "promptCreateOnly": True,
        "arbitraryPathsAccepted": False,
    }


def test_bridge_mutation_skips_cookie_csrf_but_never_skips_bearer_auth(client):
    denied = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json={},
    )
    authenticated = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json={},
        headers=auth_headers(),
    )

    assert denied.status_code == 401
    assert authenticated.status_code == 422


def test_bridge_credential_cannot_call_existing_runtime_routes(client):
    response = client.get(
        "/api/promptcard/runtime/private-test", headers=auth_headers()
    )
    assert response.status_code == 401


def test_workspace_describe_resolves_explicit_project_context_and_skill_pins(
    client, monkeypatch
):
    calls = []

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == f"/api/context-packs/{CVC}/resolve":
            return {
                "projectCode": PRJ,
                "cvcCode": CVC,
                "entries": [],
                "sourceCodes": [],
            }
        if path == f"/api/context-packs/{CVC}":
            return {
                "projectCode": PRJ,
                "cvcCode": CVC,
                "projectRevision": 4,
                "snapshotDigest": DIGEST,
                "revokedAt": None,
            }
        if path == f"/api/projects/references/{PRJ}":
            return {
                "reference": {"namespace": "project", "code": PRJ},
                "project": {
                    "referenceCode": PRJ,
                    "revision": 4,
                    "type": "free-canvas",
                    "title": "Episode 1",
                },
            }
        if path == "/api/skills":
            return {"skills": []}
        if path == f"/api/internal/context-packs/{CVC}/bridge-deliveries":
            assert kwargs["params"] == {
                "profileId": "codex-local", "state": "pending_review"
            }
            return {"deliveries": []}
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    response = client.get(
        "/api/promptcard/bridge/v3/workspace",
        params={"projectCode": PRJ.lower(), "cvcCode": CVC.lower()},
        headers=auth_headers(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "projectCode": PRJ,
        "cvcCode": CVC,
        "contextRevision": 4,
        "contextDigest": DIGEST,
        "revoked": False,
        "skills": [],
        "objects": [],
        "pendingDeliveries": 0,
    }
    assert all(call[0] == "GET" for call in calls)


def test_workspace_describe_rejects_project_context_mismatch(client, monkeypatch):
    other_project = "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAA"

    async def fake_storage(method, path, **kwargs):
        assert method == "GET"
        if path.endswith("/resolve"):
            return {"projectCode": other_project, "cvcCode": CVC, "entries": [], "sourceCodes": []}
        raise AssertionError(path)

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    response = client.get(
        "/api/promptcard/bridge/v3/workspace",
        params={"projectCode": PRJ, "cvcCode": CVC},
        headers=auth_headers(),
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "context_project_mismatch"


def test_workspace_describe_lists_only_typed_creative_objects(client, monkeypatch):
    document_code = "CVD-01ARZ3NDEKTSV4RRFFQ69G5FAV"

    async def fake_storage(method, path, **kwargs):
        if path == f"/api/context-packs/{CVC}/resolve":
            return {
                "projectCode": PRJ,
                "cvcCode": CVC,
                "entries": [
                    {
                        "reference": {"namespace": "canvasDocument", "code": document_code},
                        "content": json.dumps(
                            {
                                "kind": "document",
                                "title": "Script",
                                "revision": 2,
                                "digest": DIGEST,
                            }
                        ),
                        "contentDigest": DIGEST,
                    },
                    {
                        "reference": {
                            "namespace": "canvasTemplate",
                            "code": "CVT-01ARZ3NDEKTSV4RRFFQ69G5FAV",
                        },
                        "content": "{}",
                        "contentDigest": DIGEST,
                    },
                ],
                "sourceCodes": [],
            }
        if path == f"/api/context-packs/{CVC}":
            return {
                "projectCode": PRJ,
                "cvcCode": CVC,
                "projectRevision": 4,
                "snapshotDigest": DIGEST,
                "revokedAt": None,
            }
        if path == f"/api/projects/references/{PRJ}":
            return {
                "project": {
                    "referenceCode": PRJ,
                    "revision": 4,
                    "title": "Episode 1",
                }
            }
        if path == "/api/skills":
            return {"skills": []}
        if path == f"/api/internal/context-packs/{CVC}/bridge-deliveries":
            return {"deliveries": []}
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    response = client.get(
        "/api/promptcard/bridge/v3/workspace",
        params={"projectCode": PRJ, "cvcCode": CVC},
        headers=auth_headers(),
    )
    assert response.status_code == 200
    assert response.json()["objects"] == [
        {
            "reference": {"namespace": "canvasDocument", "code": document_code},
            "revision": 2,
            "digest": DIGEST,
            "title": "Script",
        }
    ]


def test_request_cannot_submit_or_expand_profile_scope(client):
    response = client.get(
        "/api/promptcard/bridge/v3/runtime",
        params={"profileId": "forged-admin", "scopes": "bridge:deliver:image"},
        headers=auth_headers(),
    )
    assert response.status_code == 422


def test_reference_resolve_requires_the_code_to_be_inside_the_explicit_context(
    client, monkeypatch
):
    prompt_code = "PLP-01ARZ3NDEKTSV4RRFFQ69G5FAV"

    async def fake_storage(method, path, **kwargs):
        assert method == "GET"
        if path == f"/api/context-packs/{CVC}/resolve":
            return {
                "projectCode": PRJ,
                "cvcCode": CVC,
                "entries": [],
                "sourceCodes": [prompt_code],
            }
        if path == f"/api/prompt-library/references/{prompt_code}":
            return {
                "reference": {"namespace": "promptBundle", "code": prompt_code},
                "prompt": {
                    "referenceCode": prompt_code,
                    "revision": 2,
                    "type": "free-canvas",
                    "category": "shot",
                    "label": "Opening",
                    "content": "A bounded prompt",
                },
                "media": [],
            }
        raise AssertionError((path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    allowed = client.get(
        "/api/promptcard/bridge/v3/reference",
        params={"cvcCode": CVC, "code": prompt_code.lower()},
        headers=auth_headers(),
    )
    denied = client.get(
        "/api/promptcard/bridge/v3/reference",
        params={
            "cvcCode": CVC,
            "code": "PLP-01ARZ3NDEKTSV4RRFFQ69G5FAA",
        },
        headers=auth_headers(),
    )

    assert allowed.status_code == 200
    assert allowed.json()["reference"]["code"] == prompt_code
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "reference_outside_context"


def test_prompt_search_requires_explicit_context_and_supplies_trusted_profile(client, monkeypatch):
    async def fake_storage(method, path, **kwargs):
        if path == f"/api/context-packs/{CVC}/resolve":
            assert method == "GET"
            return {"projectCode": PRJ, "cvcCode": CVC, "entries": [], "sourceCodes": []}
        if path == "/api/prompt-retrieval/search":
            assert method == "POST"
            assert kwargs["json"] == {
                "query": "neon city",
                "types": ["storyboard"],
                "categories": [],
                "limit": 5,
                "callerKind": "bridge",
                "callerId": "codex-local",
            }
            return {"queryDigest": DIGEST, "results": [], "auditId": "audit", "degraded": False, "staleRejectedCount": 0}
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    accepted = client.post(
        "/api/promptcard/bridge/v3/prompt-search",
        json={
            "cvcCode": CVC.lower(),
            "query": "neon city",
            "types": ["storyboard"],
            "categories": [],
            "limit": 5,
        },
        headers=auth_headers(),
    )
    forged = client.post(
        "/api/promptcard/bridge/v3/prompt-search",
        json={"cvcCode": CVC, "query": "neon", "callerId": "forged"},
        headers=auth_headers(),
    )

    assert accepted.status_code == 200
    assert accepted.json()["results"] == []
    assert forged.status_code == 422


def test_asset_read_returns_bounded_encoded_bytes_for_an_explicit_context_reference(
    client, monkeypatch
):
    media_code = "CVM-01ARZ3NDEKTSV4RRFFQ69G5FAV"
    payload = b"\x89PNG\r\n\x1a\nasset"

    async def fake_asset_request(cvc_code, reference_code):
        assert cvc_code == CVC
        assert reference_code == media_code
        return {
            "reference": {"namespace": "canvasMedia", "code": media_code},
            "filename": "shot.png",
            "contentType": "image/png",
            "size": len(payload),
            "digest": "sha256:"
            + __import__("hashlib").sha256(payload).hexdigest(),
            "dataBase64": __import__("base64").b64encode(payload).decode("ascii"),
        }

    monkeypatch.setattr(
        "app.gateway.bridge._storage_asset_request", fake_asset_request
    )
    response = client.get(
        "/api/promptcard/bridge/v3/asset",
        params={"cvcCode": CVC.lower(), "code": media_code.lower()},
        headers=auth_headers(),
    )

    assert response.status_code == 200
    assert response.json()["reference"] == {
        "namespace": "canvasMedia",
        "code": media_code,
    }
    assert response.json()["dataBase64"] == "iVBORw0KGgphc3NldA=="


def test_asset_read_rejects_non_media_references_before_storage(client, monkeypatch):
    called = False

    async def fake_asset_request(*_args):
        nonlocal called
        called = True
        raise AssertionError("must not read storage")

    monkeypatch.setattr(
        "app.gateway.bridge._storage_asset_request", fake_asset_request
    )
    response = client.get(
        "/api/promptcard/bridge/v3/asset",
        params={"cvcCode": CVC, "code": PRJ},
        headers=auth_headers(),
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "asset_reference_invalid"
    assert called is False


def test_skill_read_requires_the_exact_enabled_codex_pin(client, monkeypatch):
    skill_code = "SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV"
    skill_digest = "sha256:" + "b" * 64

    async def fake_storage(method, path, **kwargs):
        assert method == "GET"
        if path == "/api/skills":
            return {
                "skills": [
                    {
                        "referenceCode": skill_code,
                        "lifecycleStatus": "active",
                        "trustState": "trusted",
                    }
                ]
            }
        if path == f"/api/skills/{skill_code}/host-pins/codex":
            assert kwargs == {"params": {"repositoryScope": "repo-one"}}
            return {
                "enabled": True,
                "revision": 3,
                "digest": skill_digest,
                "projection": {"status": "healthy"},
                "projectionHealth": {"state": "healthy"},
            }
        if path == f"/api/skills/{skill_code}":
            return {
                "id": "internal-skill-id-must-not-leak",
                "referenceCode": skill_code,
                "name": "Storyboard master",
                "description": "Creates bounded storyboards",
                "source": "external",
                "trustState": "trusted",
                "lifecycleStatus": "active",
                "currentRevision": 3,
                "revisions": [
                    {
                        "revision": 3,
                        "digest": skill_digest,
                        "instructions": "Use exact source references.",
                        "references": [{"name": "format", "content": "Shot format"}],
                        "declaredCapabilities": {
                            "tools": ["promptcard_delivery_preview"],
                            "network": [],
                            "executables": [],
                            "models": [],
                            "other": [],
                        },
                        "entries": [{"path": "private-path", "content": "must not leak"}],
                    }
                ],
            }
        raise AssertionError((path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    accepted = client.get(
        "/api/promptcard/bridge/v3/skill",
        params={"skillCode": skill_code, "revision": 3, "digest": skill_digest},
        headers=auth_headers(),
    )
    stale = client.get(
        "/api/promptcard/bridge/v3/skill",
        params={"skillCode": skill_code, "revision": 2, "digest": skill_digest},
        headers=auth_headers(),
    )

    assert accepted.status_code == 200
    assert accepted.json() == {
        "skillCode": skill_code,
        "revision": 3,
        "digest": skill_digest,
        "name": "Storyboard master",
        "description": "Creates bounded storyboards",
        "instructions": "Use exact source references.",
        "references": [{"name": "format", "content": "Shot format"}],
        "declaredCapabilities": {
            "tools": ["promptcard_delivery_preview"],
            "network": [],
            "executables": [],
            "models": [],
            "other": [],
        },
    }
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "skill_pin_stale"


def test_skill_read_rejects_an_unhealthy_codex_projection(client, monkeypatch):
    skill_code = "SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV"
    skill_digest = "sha256:" + "c" * 64

    async def fake_storage(method, path, **kwargs):
        assert method == "GET"
        if path == "/api/skills":
            return {
                "skills": [
                    {
                        "referenceCode": skill_code,
                        "lifecycleStatus": "active",
                        "trustState": "trusted",
                    }
                ]
            }
        if path == f"/api/skills/{skill_code}/host-pins/codex":
            return {
                "enabled": True,
                "revision": 3,
                "digest": skill_digest,
                "projection": {"status": "drifted"},
                "projectionHealth": {"state": "drifted"},
            }
        raise AssertionError((path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    response = client.get(
        "/api/promptcard/bridge/v3/skill",
        params={"skillCode": skill_code, "revision": 3, "digest": skill_digest},
        headers=auth_headers(),
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "skill_projection_unhealthy"


def test_prompt_delivery_preview_commit_and_status_use_trusted_profile(client, monkeypatch):
    proposal_id = "DVP-01ARZ3NDEKTSV4RRFFQ69G5FAV"
    preview_request = {
        "clientRequestId": "preview-1",
        "normalizedRequestDigest": DIGEST,
        "kind": "prompt.create",
        "target": {"cvcCode": CVC},
        "sourceCodes": [],
        "skillPins": [],
        "rationale": "Create a prompt.",
        "provenance": "promptcard-bridge",
        "payload": {"title": "Opening", "userText": "Wide shot"},
    }
    calls = []

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path.endswith("/preview"):
            assert kwargs["json"]["operationContext"]["profileId"] == "codex-local"
            assert "profileId" not in kwargs["json"]["deliveryRequest"]
            return _delivery_record(preview_request, proposal_id, "previewed")
        if path.endswith(proposal_id):
            assert kwargs["params"] == {"profileId": "codex-local"}
            return {"proposalId": proposal_id, "kind": "prompt.create", "state": "previewed"}
        if path.endswith("/commit"):
            assert kwargs["json"]["deliveryRequest"] == {
                "clientRequestId": "commit-1",
                "normalizedRequestDigest": "sha256:" + "b" * 64,
                "proposalId": proposal_id,
            }
            return _delivery_record(preview_request, proposal_id, "pending_review")
        if path.endswith("/commit-1"):
            assert kwargs["params"] == {"profileId": "codex-local"}
            return _delivery_record(preview_request, proposal_id, "pending_review")
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    preview = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json=preview_request,
        headers=auth_headers(),
    )
    commit = client.post(
        "/api/promptcard/bridge/v3/delivery/commit",
        json={
            "clientRequestId": "commit-1",
            "normalizedRequestDigest": "sha256:" + "b" * 64,
            "proposalId": proposal_id,
        },
        headers=auth_headers(),
    )
    status = client.get(
        "/api/promptcard/bridge/v3/delivery/status",
        params={"clientRequestId": "commit-1"},
        headers=auth_headers(),
    )

    assert preview.status_code == 200
    assert commit.status_code == 200
    assert status.status_code == 200
    assert status.json()["state"] == "pending_review"
    assert len(calls) == 4


@pytest.mark.parametrize(
    ("kind", "target", "payload"),
    [
        (
            "document.create",
            {"cvcCode": CVC.lower()},
            {
                "title": "Script analysis",
                "blocks": [{
                    "id": "opening",
                    "type": "paragraph",
                    "content": [{"text": "Opening image"}],
                }],
            },
        ),
        (
            "document.change",
            {
                "cvcCode": CVC.lower(),
                "documentCode": CVD.lower(),
                "baseRevision": 2,
                "baseDigest": DIGEST,
            },
            {
                "operations": [{
                    "kind": "replace",
                    "blockId": "opening",
                    "utf8Start": 0,
                    "utf8End": 7,
                    "text": "First",
                    "expectedTextDigest": DIGEST,
                }],
            },
        ),
    ],
)
def test_document_delivery_preview_and_commit_route_through_document_storage(
    client, monkeypatch, kind, target, payload
):
    proposal_id = "DVP-01ARZ3NDEKTSV4RRFFQ69G5FAV"
    preview_request = {
        "clientRequestId": f"{kind}-preview",
        "normalizedRequestDigest": DIGEST,
        "kind": kind,
        "target": target,
        "sourceCodes": [CVD.lower()],
        "skillPins": [],
        "rationale": "Create a reviewable Document proposal.",
        "provenance": "promptcard-bridge",
        "payload": payload,
    }
    calls = []

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == f"/api/context-packs/{CVC}/resolve":
            return {
                "projectCode": PRJ,
                "cvcCode": CVC,
                "entries": [{
                    "reference": {"namespace": "canvasDocument", "code": CVD},
                    "content": "{}",
                }],
                "sourceCodes": [],
            }
        if path == "/api/internal/bridge-document-deliveries/preview":
            forwarded = kwargs["json"]
            assert forwarded["operationContext"]["profileId"] == "codex-local"
            assert forwarded["deliveryRequest"]["target"]["cvcCode"] == CVC
            if kind == "document.change":
                assert forwarded["deliveryRequest"]["target"]["documentCode"] == CVD
            assert forwarded["deliveryRequest"]["sourceCodes"] == [CVD]
            assert forwarded["deliveryRequest"]["payload"] == payload
            return _delivery_record(
                forwarded["deliveryRequest"], proposal_id, "previewed"
            )
        if path.endswith(proposal_id):
            return {"proposalId": proposal_id, "kind": kind, "state": "previewed"}
        if path == "/api/internal/bridge-document-deliveries/commit":
            return _delivery_record(preview_request, proposal_id, "pending_review")
        if path.endswith(f"/{kind}-commit"):
            assert kwargs["params"] == {"profileId": "codex-local"}
            return _delivery_record(preview_request, proposal_id, "pending_review")
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    preview = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json=preview_request,
        headers=auth_headers(),
    )
    commit = client.post(
        "/api/promptcard/bridge/v3/delivery/commit",
        json={
            "clientRequestId": f"{kind}-commit",
            "normalizedRequestDigest": "sha256:" + "b" * 64,
            "proposalId": proposal_id,
        },
        headers=auth_headers(),
    )
    status = client.get(
        "/api/promptcard/bridge/v3/delivery/status",
        params={"clientRequestId": f"{kind}-commit"},
        headers=auth_headers(),
    )

    assert preview.status_code == 200
    assert commit.status_code == 200
    assert status.status_code == 200
    assert status.json()["request"]["kind"] == kind
    assert [path for _, path, _ in calls] == [
        f"/api/context-packs/{CVC}/resolve",
        "/api/internal/bridge-document-deliveries/preview",
        f"/api/internal/bridge-delivery-proposals/{proposal_id}",
        "/api/internal/bridge-document-deliveries/commit",
        f"/api/internal/bridge-prompt-deliveries/{kind}-commit",
    ]


@pytest.mark.parametrize(
    ("kind", "target", "payload"),
    [
        (
            "storyboard.create",
            {"cvcCode": CVC.lower()},
            {
                "title": "Opening sequence",
                "sourceDocumentCode": CVD.lower(),
                "sourceDocumentRevision": 2,
                "sourceDocumentDigest": DIGEST,
                "sequence": {
                    "name": "Opening",
                    "description": "A quiet reveal.",
                    "style": "Naturalistic",
                    "constraints": "No dialogue",
                    "rows": [{
                        "cutLabel": "1",
                        "timeRange": "00:00-00:04",
                        "subject": "Empty street",
                        "action": "Rain falls",
                        "scene": "Night exterior",
                        "camera": "Slow push",
                        "lighting": "Neon reflections",
                        "audio": "Rain",
                        "duration": "4s",
                    }],
                },
            },
        ),
        (
            "storyboard.change",
            {
                "cvcCode": CVC.lower(),
                "storyboardCode": CVS.lower(),
                "baseRevision": 1,
                "baseDigest": DIGEST,
            },
            {"changes": [{
                "scope": "row",
                "rowOrdinal": 0,
                "field": "duration",
                "value": "3s",
            }]},
        ),
    ],
)
def test_storyboard_delivery_uses_storyboard_scope_and_storage_routes(
    client, monkeypatch, kind, target, payload
):
    proposal_id = "DVP-01ARZ3NDEKTSV4RRFFQ69G5FAV"
    preview_request = {
        "clientRequestId": f"{kind}-preview",
        "normalizedRequestDigest": DIGEST,
        "kind": kind,
        "target": target,
        "sourceCodes": [
            CVD.lower() if kind == "storyboard.create" else CVS.lower()
        ],
        "skillPins": [],
        "rationale": "Create a reviewable Storyboard proposal.",
        "provenance": "promptcard-bridge",
        "payload": payload,
    }
    calls = []

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == f"/api/context-packs/{CVC}/resolve":
            return {
                "projectCode": PRJ,
                "cvcCode": CVC,
                "entries": [{
                    "reference": {
                        "namespace": "canvasDocument"
                        if kind == "storyboard.create"
                        else "canvasStoryboard",
                        "code": CVD if kind == "storyboard.create" else CVS,
                    },
                    "content": "{}",
                }],
                "sourceCodes": [],
            }
        if path == "/api/internal/bridge-storyboard-deliveries/preview":
            forwarded = kwargs["json"]
            delivery = forwarded["deliveryRequest"]
            assert forwarded["operationContext"]["profileId"] == "codex-local"
            assert delivery["target"]["cvcCode"] == CVC
            assert delivery["sourceCodes"] == [
                CVD if kind == "storyboard.create" else CVS
            ]
            if kind == "storyboard.create":
                assert delivery["payload"]["sourceDocumentCode"] == CVD
            else:
                assert delivery["target"]["storyboardCode"] == CVS
            return _delivery_record(delivery, proposal_id, "previewed")
        if path.endswith(proposal_id):
            return {"proposalId": proposal_id, "kind": kind, "state": "previewed"}
        if path == "/api/internal/bridge-storyboard-deliveries/commit":
            return _delivery_record(preview_request, proposal_id, "pending_review")
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    preview = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json=preview_request,
        headers=auth_headers(),
    )
    commit = client.post(
        "/api/promptcard/bridge/v3/delivery/commit",
        json={
            "clientRequestId": f"{kind}-commit",
            "normalizedRequestDigest": "sha256:" + "b" * 64,
            "proposalId": proposal_id,
        },
        headers=auth_headers(),
    )

    assert preview.status_code == 200
    assert commit.status_code == 200
    assert [path for _, path, _ in calls] == [
        f"/api/context-packs/{CVC}/resolve",
        "/api/internal/bridge-storyboard-deliveries/preview",
        f"/api/internal/bridge-delivery-proposals/{proposal_id}",
        "/api/internal/bridge-storyboard-deliveries/commit",
    ]


def test_document_delivery_requires_document_scope_and_rejects_internal_node_targets(
    client, monkeypatch
):
    prompt_only_token = "prompt-only-token-that-is-longer-than-thirty-two-chars"
    monkeypatch.setenv(
        "PROMPTCARD_BRIDGE_PROFILES_JSON",
        json.dumps({
            "prompt-only": {
                "token": prompt_only_token,
                "scopes": ["bridge:deliver:prompt"],
            }
        }),
    )
    called = False

    async def fake_storage(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("rejected Document request must not reach Storage")

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    request = {
        "clientRequestId": "document-scope-preview",
        "normalizedRequestDigest": DIGEST,
        "kind": "document.create",
        "target": {"cvcCode": CVC},
        "sourceCodes": [],
        "skillPins": [],
        "rationale": "Create a reviewable Document proposal.",
        "provenance": "promptcard-bridge",
        "payload": {
            "title": "Script analysis",
            "blocks": [{
                "id": "opening",
                "type": "paragraph",
                "content": [{"text": "Opening image"}],
            }],
        },
    }
    missing_scope = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json=request,
        headers=auth_headers(prompt_only_token),
    )
    internal_target = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json={**request, "target": {"cvcCode": CVC, "nodeId": "document-1"}},
        headers=auth_headers(prompt_only_token),
    )

    assert missing_scope.status_code == 403
    assert missing_scope.json()["detail"] == {
        "code": "bridge_scope_required",
        "requiredScope": "bridge:deliver:document",
    }
    assert internal_target.status_code == 422
    assert called is False


def test_image_stage_validates_multipart_and_hides_internal_asset_id(client, monkeypatch):
    content = b"\x89PNG\r\n\x1a\nbridge-image"
    metadata = {
        "clientRequestId": "stage-1",
        "cvcCode": CVC.lower(),
        "workspaceRelativePath": "outputs/opening.png",
        "contentDigest": "sha256:" + hashlib.sha256(content).hexdigest(),
        "mediaType": "image/png",
        "byteLength": len(content),
    }
    calls = []

    async def fake_stage(operation_context, stage_request, uploaded):
        calls.append((operation_context, stage_request, uploaded))
        assert operation_context["profileId"] == "codex-local"
        assert stage_request["cvcCode"] == CVC
        assert uploaded == content
        return {
            "operationContext": operation_context,
            "request": stage_request,
            "state": "accepted",
            "disposition": "original",
            "stagedAssetHandle": "AST-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "assetId": "internal-asset-id",
            "contentType": "image/png",
            "size": len(content),
            "width": 640,
            "height": 360,
            "contentDigest": metadata["contentDigest"],
            "preparedDigest": metadata["contentDigest"],
            "createdAt": "2026-08-30T00:00:00.000Z",
            "updatedAt": "2026-08-30T00:00:00.000Z",
        }

    monkeypatch.setattr("app.gateway.bridge._storage_stage_request", fake_stage)
    response = client.post(
        "/api/promptcard/bridge/v3/assets/stage",
        data={"metadata": json.dumps(metadata)},
        files={"file": ("opening.png", content, "image/png")},
        headers=auth_headers(),
    )

    assert response.status_code == 200
    assert response.json()["stagedAssetHandle"].startswith("AST-")
    assert "assetId" not in response.json()
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("metadata_update", "filename", "content_type", "expected_code"),
    [
        ({"workspaceRelativePath": "../secret.png"}, "secret.png", "image/png", "workspace_path_invalid"),
        ({"contentDigest": DIGEST}, "opening.png", "image/png", "asset_digest_mismatch"),
        ({"byteLength": 999}, "opening.png", "image/png", "asset_size_mismatch"),
        ({}, "opening.png", "image/jpeg", "asset_media_type_mismatch"),
        ({}, "other.png", "image/png", "asset_filename_mismatch"),
    ],
)
def test_image_stage_rejects_untrusted_bytes_before_storage(
    client, monkeypatch, metadata_update, filename, content_type, expected_code
):
    content = b"\x89PNG\r\n\x1a\nbridge-image"
    metadata = {
        "clientRequestId": "stage-invalid",
        "cvcCode": CVC,
        "workspaceRelativePath": "outputs/opening.png",
        "contentDigest": "sha256:" + hashlib.sha256(content).hexdigest(),
        "mediaType": "image/png",
        "byteLength": len(content),
        **metadata_update,
    }
    called = False

    async def fake_stage(*_args):
        nonlocal called
        called = True
        raise AssertionError("invalid upload must not reach Storage")

    monkeypatch.setattr("app.gateway.bridge._storage_stage_request", fake_stage)
    response = client.post(
        "/api/promptcard/bridge/v3/assets/stage",
        data={"metadata": json.dumps(metadata)},
        files={"file": (filename, content, content_type)},
        headers=auth_headers(),
    )

    assert response.status_code in {413, 422}
    assert response.json()["detail"]["code"] == expected_code
    assert called is False


def test_image_preview_and_commit_route_by_proposal_kind(client, monkeypatch):
    proposal_id = "DVP-01ARZ3NDEKTSV4RRFFQ69G5FAV"
    request = {
        "clientRequestId": "image-preview-1",
        "normalizedRequestDigest": DIGEST,
        "kind": "image.place",
        "target": {"cvcCode": CVC},
        "sourceCodes": [],
        "skillPins": [],
        "rationale": "Place the staged image.",
        "provenance": "promptcard-bridge",
        "payload": {
            "stagedAssetHandle": "AST-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "altText": "Opening frame",
        },
    }
    paths = []

    async def fake_storage(method, path, **kwargs):
        paths.append(path)
        if path.endswith("/preview"):
            assert path == "/api/internal/bridge-image-deliveries/preview"
            return _delivery_record(request, proposal_id, "previewed")
        if path.endswith(proposal_id):
            return {"proposalId": proposal_id, "kind": "image.place", "state": "previewed"}
        if path.endswith("/commit"):
            assert path == "/api/internal/bridge-image-deliveries/commit"
            return _delivery_record(request, proposal_id, "pending_review")
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    preview = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json=request,
        headers=auth_headers(),
    )
    commit = client.post(
        "/api/promptcard/bridge/v3/delivery/commit",
        json={
            "clientRequestId": "image-commit-1",
            "normalizedRequestDigest": "sha256:" + "b" * 64,
            "proposalId": proposal_id,
        },
        headers=auth_headers(),
    )

    assert preview.status_code == 200
    assert commit.status_code == 200
    assert paths == [
        "/api/internal/bridge-image-deliveries/preview",
        f"/api/internal/bridge-delivery-proposals/{proposal_id}",
        "/api/internal/bridge-image-deliveries/commit",
    ]


def test_prompt_delivery_rejects_forged_authority_and_missing_scope(client, monkeypatch):
    called = False

    async def fake_storage(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("must reject before Storage")

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    forged = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json={
            "clientRequestId": "preview-1",
            "normalizedRequestDigest": DIGEST,
            "kind": "prompt.create",
            "target": {"cvcCode": CVC},
            "sourceCodes": [],
            "skillPins": [],
            "rationale": "Create a prompt.",
            "provenance": "promptcard-bridge",
            "payload": {"title": "Opening", "userText": "Wide shot"},
            "profileId": "forged-admin",
        },
        headers=auth_headers(),
    )
    assert forged.status_code == 422
    assert called is False


def test_prompt_delivery_rejects_sources_outside_context(client, monkeypatch):
    outside = "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAW"
    calls = []

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path.endswith("/resolve"):
            return {
                "projectCode": PRJ,
                "cvcCode": CVC,
                "entries": [],
                "sourceCodes": [],
            }
        raise AssertionError("delivery must not reach Storage")

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    response = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json={
            "clientRequestId": "preview-outside",
            "normalizedRequestDigest": DIGEST,
            "kind": "prompt.create",
            "target": {"cvcCode": CVC},
            "sourceCodes": [outside],
            "skillPins": [],
            "rationale": "Create a prompt.",
            "provenance": "promptcard-bridge",
            "payload": {"title": "Opening", "userText": "Wide shot"},
        },
        headers=auth_headers(),
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "reference_outside_context"
    assert len(calls) == 1


def test_prompt_delivery_rejects_unapproved_skill_pin(client, monkeypatch):
    skill_code = "SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV"
    called = False

    async def fake_storage(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("delivery must not reach Storage")

    async def no_workspace_skills(_principal):
        return []

    monkeypatch.setattr("app.gateway.bridge._storage_request", fake_storage)
    monkeypatch.setattr("app.gateway.bridge._workspace_skills", no_workspace_skills)
    response = client.post(
        "/api/promptcard/bridge/v3/delivery/preview",
        json={
            "clientRequestId": "preview-unapproved-skill",
            "normalizedRequestDigest": DIGEST,
            "kind": "prompt.create",
            "target": {"cvcCode": CVC},
            "sourceCodes": [],
            "skillPins": [{
                "skillCode": skill_code,
                "revision": 3,
                "digest": DIGEST,
            }],
            "rationale": "Create a prompt.",
            "provenance": "promptcard-bridge",
            "payload": {"title": "Opening", "userText": "Wide shot"},
        },
        headers=auth_headers(),
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "skill_not_enabled"
    assert called is False


def _delivery_record(request, proposal_id, state):
    return {
        "operationContext": {
            "profileId": "codex-local",
            "scopes": ["bridge:deliver:prompt"],
            "provenance": "promptcard-bridge",
            "clientInfo": {"name": "codex", "version": "1.0.0"},
        },
        "request": request,
        "proposalId": proposal_id,
        "state": state,
        "disposition": "original",
        "resultCodes": [],
        "message": "ready",
        "createdAt": "2026-08-30T00:00:00.000Z",
        "updatedAt": "2026-08-30T00:00:00.000Z",
    }


@pytest.mark.anyio
async def test_bridge_storage_errors_preserve_codes_but_redact_internal_details(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            410,
            json={
                "detail": {
                    "code": "context_revoked",
                    "message": "revoked",
                    "reference": {"namespace": "canvasContext", "code": CVC},
                    "path": "F:/private/project.json",
                    "internalId": "node-secret",
                }
            },
        )

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "app.gateway.bridge.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    with pytest.raises(Exception) as caught:
        await _storage_request("GET", f"/api/context-packs/{CVC}/resolve")
    assert caught.value.status_code == 410
    assert caught.value.detail == {
        "code": "context_revoked",
        "reference": {"namespace": "canvasContext", "code": CVC},
    }


@pytest.mark.anyio
async def test_bridge_asset_storage_reader_validates_metadata_digest_and_budget(monkeypatch):
    media_code = "CVM-01ARZ3NDEKTSV4RRFFQ69G5FAV"
    content = b"\x89PNG\r\n\x1a\nasset"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith(f"/{media_code}")
        return httpx.Response(
            200,
            content=content,
            headers={
                "Content-Type": "image/png",
                "X-File-Name": "shot.png",
                "X-PromptCard-Reference-Namespace": "canvasMedia",
                "X-PromptCard-Reference-Code": media_code,
                "X-PromptCard-Asset-Size": str(len(content)),
            },
        )

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "app.gateway.bridge.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    result = await _storage_asset_request(CVC, media_code)

    assert result["contentType"] == "image/png"
    assert result["size"] == len(content)
    assert result["digest"] == "sha256:" + __import__("hashlib").sha256(content).hexdigest()
    assert __import__("base64").b64decode(result["dataBase64"]) == content


@pytest.mark.anyio
async def test_bridge_asset_storage_reader_rejects_oversize_before_read(monkeypatch):
    media_code = "PLM-01ARZ3NDEKTSV4RRFFQ69G5FAV"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"x",
            headers={
                "Content-Type": "image/png",
                "Content-Length": str(5 * 1024 * 1024 + 1),
            },
        )

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "app.gateway.bridge.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    with pytest.raises(Exception) as caught:
        await _storage_asset_request(CVC, media_code)
    assert caught.value.status_code == 413
    assert caught.value.detail == {"code": "asset_read_too_large"}
