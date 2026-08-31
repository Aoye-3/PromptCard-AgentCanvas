from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.auth_middleware import AuthMiddleware
from app.gateway.csrf_middleware import CSRFMiddleware
from app.gateway.routers import bridge, promptcard_runtime

TOKEN = "bridge-environment-token-that-is-longer-than-thirty-two-characters"
PRJ = "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV"
CVC = "CVC-01ARZ3NDEKTSV4RRFFQ69G5FAV"
DIGEST = "sha256:" + "a" * 64


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv(
        "PROMPTCARD_BRIDGE_PROFILES_JSON",
        json.dumps(
            {
                "codex-local": {
                    "token": TOKEN,
                    "repositoryScope": "F:/private/repository/path",
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
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.add_middleware(CSRFMiddleware)
    app.include_router(promptcard_runtime.router)
    app.include_router(bridge.router)
    browser = TestClient(app)
    assert browser.post("/api/promptcard/runtime/bootstrap", json={}).status_code == 200
    return browser


def test_local_environment_lists_redacted_profiles_and_real_recent_activity(client):
    initial = client.get("/api/promptcard/runtime/bridge-environment")

    assert initial.status_code == 200
    body = initial.json()
    assert body["bridge"]["configured"] is True
    assert body["bridge"]["selectedProfileId"] == "codex-local"
    assert body["bridge"]["profiles"] == [
        {
            "profileId": "codex-local",
            "scopes": [
                "bridge:deliver:document",
                "bridge:deliver:image",
                "bridge:deliver:prompt",
                "bridge:deliver:storyboard",
                "bridge:read",
                "bridge:status",
            ],
            "clientInfo": {"name": "codex", "version": "1.0.0"},
            "repositoryScoped": True,
            "lastSeenAt": None,
            "connectionState": "configured",
        }
    ]
    serialized = json.dumps(body)
    assert TOKEN not in serialized
    assert "private/repository/path" not in serialized
    assert body["workspace"] == {
        "state": "context_required",
        "errorCode": "explicit_context_required",
    }

    bridge_response = client.get(
        "/api/promptcard/bridge/v3/runtime",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert bridge_response.status_code == 200

    active = client.get("/api/promptcard/runtime/bridge-environment").json()
    profile = active["bridge"]["profiles"][0]
    assert profile["connectionState"] == "recently_active"
    assert isinstance(profile["lastSeenAt"], int)


def test_local_environment_describes_exact_workspace_without_making_ui_authority(
    client,
    monkeypatch,
):
    calls = []

    async def fake_workspace(principal, project_code, cvc_code):
        calls.append((principal, project_code, cvc_code))
        return {
            "projectCode": PRJ,
            "cvcCode": CVC,
            "contextRevision": 7,
            "contextDigest": DIGEST,
            "revoked": False,
            "skills": [
                {
                    "skillCode": "SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV",
                    "revision": 3,
                    "digest": DIGEST,
                    "projectionHealth": "healthy",
                }
            ],
            "objects": [
                {
                    "reference": {
                        "namespace": "canvasDocument",
                        "code": "CVD-01ARZ3NDEKTSV4RRFFQ69G5FAV",
                    },
                    "title": "Episode 1",
                    "revision": 2,
                    "digest": DIGEST,
                }
            ],
            "objectCodes": ["CVD-01ARZ3NDEKTSV4RRFFQ69G5FAV"],
            "pendingDeliveries": 1,
        }

    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.workspace_description",
        fake_workspace,
    )
    response = client.get(
        "/api/promptcard/runtime/bridge-environment",
        params={
            "projectCode": PRJ.lower(),
            "cvcCode": CVC.lower(),
            "profileId": "codex-local",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["workspace"]["state"] == "ready"
    assert body["workspace"]["projectCode"] == PRJ
    assert body["workspace"]["cvcCode"] == CVC
    assert body["workspace"]["skills"][0]["revision"] == 3
    assert body["workspace"]["pendingDeliveries"] == 1
    assert calls[0][0].profile_id == "codex-local"
    assert calls[0][1:] == (PRJ.lower(), CVC.lower())


def test_local_environment_reports_safe_workspace_failure(client, monkeypatch):
    async def unavailable(*_args, **_kwargs):
        from fastapi import HTTPException

        raise HTTPException(
            status_code=410,
            detail={"code": "context_revoked", "path": "F:/must-not-leak"},
        )

    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.workspace_description",
        unavailable,
    )
    response = client.get(
        "/api/promptcard/runtime/bridge-environment",
        params={"projectCode": PRJ, "cvcCode": CVC},
    )

    assert response.status_code == 200
    assert response.json()["workspace"] == {
        "state": "unavailable",
        "errorCode": "context_revoked",
    }
    assert "must-not-leak" not in response.text
