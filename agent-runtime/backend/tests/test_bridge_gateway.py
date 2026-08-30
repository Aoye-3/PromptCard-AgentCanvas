from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.auth_middleware import AuthMiddleware
from app.gateway.bridge import _storage_request
from app.gateway.routers import bridge

TOKEN = "bridge-test-token-that-is-longer-than-thirty-two-characters"
PRJ = "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV"
CVC = "CVC-01ARZ3NDEKTSV4RRFFQ69G5FAV"
DIGEST = "sha256:" + "a" * 64


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
        if path == "/api/context-packs/pending-deliveries":
            return {"count": 0}
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
