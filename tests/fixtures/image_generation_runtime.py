from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.gateway.deps import get_image_generation_service
from app.gateway.image_generation.contracts import (
    ImageGenerationRequest,
    ImageGenerationResult,
    ProviderError,
    ProviderImage,
)
from app.gateway.image_generation.result_fetcher import FetchedImage
from app.gateway.image_generation.service import (
    ConnectionMetadata,
    ImageGenerationService,
    PromptCardStorageClient,
)
from app.gateway.routers import image_generation

MODEL_ID = "doubao-seedream-5-0-pro-260628"
CONNECTION_ID = "e2e-ark-image"
GENERATED_IMAGE_BYTES = (Path(__file__).resolve().parents[2] / "public" / "app-icon.png").read_bytes()
PLAN_007_SESSION_PATTERN = re.compile(r"PLAN007_MULTI_VIEW:([A-Za-z0-9_-]{1,96})")
VIEW_INSTRUCTIONS = {
    "front": "从主体正面平视观察",
    "left": "从主体左侧平视观察",
    "top": "从主体正上方俯视观察",
}


class ProviderControlRequest(BaseModel):
    token: str = Field(min_length=1, max_length=96, pattern=r"^[A-Za-z0-9_-]+$")
    paused: bool = False
    fail_calls: list[int] = Field(default_factory=list, alias="failCalls")
    fail_views: list[str] = Field(default_factory=list, alias="failViews")


class ProviderSessionRequest(BaseModel):
    token: str = Field(min_length=1, max_length=96, pattern=r"^[A-Za-z0-9_-]+$")


class ProviderGateResetRequest(BaseModel):
    paused: bool = False


class TestProviderControl:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._release = threading.Event()
        self._release.set()
        self._requests: list[dict[str, Any]] = []
        self._call_count = 0
        self._fail_calls: set[int] = set()
        self._fail_views: set[str] = set()

    def reset(self, *, paused: bool, fail_calls: list[int], fail_views: list[str]) -> dict[str, Any]:
        with self._lock:
            self._release.set()
            self._release = threading.Event()
            if not paused:
                self._release.set()
            self._requests.clear()
            self._call_count = 0
            self._fail_calls = {call for call in fail_calls if call > 0}
            self._fail_views = {view for view in fail_views if view in VIEW_INSTRUCTIONS}
        return self.snapshot()

    def pause(self) -> dict[str, Any]:
        with self._lock:
            self._release.clear()
        return self.snapshot()

    def release(self) -> dict[str, Any]:
        with self._lock:
            self._release.set()
        return self.snapshot()

    def record(self, request: ImageGenerationRequest) -> tuple[int, str | None, bool, threading.Event]:
        view_spec = _request_view_spec(request)
        with self._lock:
            self._call_count += 1
            call = self._call_count
            should_fail = call in self._fail_calls or view_spec in self._fail_views
            self._requests.append(_sanitized_request(request, call=call, view_spec=view_spec))
            release = self._release
        return call, view_spec, should_fail, release

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            requests = [dict(request) for request in self._requests]
            fail_calls = sorted(self._fail_calls)
            fail_views = sorted(self._fail_views)
            paused = not self._release.is_set()
        return {
            "paused": paused,
            "failCalls": fail_calls,
            "failViews": fail_views,
            "requests": requests,
        }


class FakeConnections:
    def resolve_metadata(self, connection_id: str) -> ConnectionMetadata:
        if connection_id != CONNECTION_ID:
            raise LookupError("connection_not_found")
        return ConnectionMetadata(
            connection_id=connection_id,
            provider_id="volcengine-ark",
            api_base="https://ark.cn-beijing.volces.com/api/v3",
            enabled=True,
            last_test_ok=True,
        )

    def get_credential(self, connection_id: str) -> str | None:
        return "e2e-credential" if connection_id == CONNECTION_ID else None


class RecordingProvider:
    def __init__(self, requests: list[dict[str, Any]]) -> None:
        self._requests = requests

    def generate(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        plan_007_call: int | None = None
        plan_007_session = _plan_007_session(request)
        if plan_007_session is not None:
            control = _test_provider_control(plan_007_session)
            if control is None:
                raise ProviderError(
                    "test_provider_session_missing",
                    "Test provider session was not reset",
                    False,
                    "e2e-provider-session-missing",
                )
            call, _view_spec, should_fail, release = control.record(request)
            plan_007_call = call
            release.wait()
            if should_fail:
                raise ProviderError(
                    "test_provider_failure",
                    "Deterministic test provider failure",
                    True,
                    f"e2e-provider-{call}",
                )
        else:
            _call, _view_spec, should_fail, release = generic_provider_control.record(request)
            self._requests.append(_sanitized_request(request))
            release.wait()
            if should_fail:
                raise ProviderError(
                    "test_provider_failure",
                    "Deterministic test provider failure",
                    True,
                    "e2e-provider-generic",
                )
        time.sleep(1.2)
        return ImageGenerationResult(
            image=ProviderImage(url="https://e2e.invalid/generated.png"),
            request_id=(
                f"e2e-provider-plan007-{plan_007_session}-{plan_007_call}"
                if plan_007_call is not None
                else f"e2e-provider-{len(self._requests)}"
            ),
        )


class FakeResultFetcher:
    def fetch(self, _url: str) -> FetchedImage:
        return FetchedImage(
            content=GENERATED_IMAGE_BYTES,
            content_type="image/png",
            width=512,
            height=512,
            extension=".png",
        )

    def close(self) -> None:
        return None


class TestStorageClient(PromptCardStorageClient):
    def create_capture(self, payload: dict[str, Any]) -> dict[str, Any]:
        origin = payload.get("origin")
        run_id = origin.get("runId") if isinstance(origin, dict) else None
        if not isinstance(run_id, str) or not run_id:
            raise ValueError("Test image-generation capture requires a runId")
        return super().create_capture({**payload, "id": f"capture-{run_id}"})


provider_requests: list[dict[str, Any]] = []
generic_provider_control = TestProviderControl()
test_provider_controls: dict[str, TestProviderControl] = {}
test_provider_controls_lock = threading.Lock()
service = ImageGenerationService(
    storage=TestStorageClient(),
    connections=FakeConnections(),
    provider_factory=lambda _connection: RecordingProvider(provider_requests),
    result_fetcher=FakeResultFetcher(),
)

os.environ[image_generation.IMAGE_GENERATION_FEATURE_ENV] = "1"
app = FastAPI()
app.include_router(image_generation.router)
app.dependency_overrides[get_image_generation_service] = lambda: service


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "healthy", "service": "image-generation-e2e-runtime"}


@app.get("/api/promptcard/runtime/status")
def runtime_status() -> dict[str, Any]:
    return {
        "runtime": {"ok": True, "service": "image-generation-e2e-runtime", "orchestrator": "fake"},
        "auth": {"ok": True, "mode": "test-fixture"},
        "models": {"ok": False, "count": 0},
        "tools": {"ok": False, "count": 0},
        "storage": {"ok": True},
        "textAgent": {"ok": False},
    }


@app.get("/api/promptcard/runtime/bridge-environment")
def bridge_environment() -> dict[str, Any]:
    return {
        "gateway": {"ok": True, "service": "promptcard-runtime"},
        "bridge": {
            "configured": False,
            "configurationError": None,
            "selectedProfileId": None,
            "profiles": [],
            "contractVersion": "3.0.0",
            "bootstrapSkill": {
                "name": "promptcard-bootstrap",
                "revision": 1,
                "digest": f"sha256:{'0' * 64}",
                "instructions": "Call promptcard_runtime_describe before using an explicit project context.",
            },
            "tools": [],
            "writebackKinds": [],
            "constraints": {
                "explicitContextRequired": True,
                "userApprovalRequired": True,
                "promptCreateOnly": True,
                "arbitraryPathsAccepted": False,
            },
        },
        "workspace": {"state": "unavailable", "errorCode": "bridge_not_configured"},
    }


@app.post("/api/promptcard/runtime/bootstrap")
def runtime_bootstrap() -> dict[str, Any]:
    return {
        "user": {
            "id": "image-generation-e2e-user",
            "email": "e2e@promptcard.invalid",
            "name": "Image Generation E2E",
        },
        "expires_in": None,
    }


@app.get("/api/promptcard/runtime/catalog")
def runtime_catalog() -> dict[str, Any]:
    return {
        "models": [],
        "skills": [],
        "tools": [],
        "builtins": [],
        "subagentEnabled": False,
        "agents": [],
    }


@app.get("/api/promptcard/runtime/model-config")
def runtime_model_config() -> dict[str, Any]:
    return {
        "enabled": False,
        "apiBase": "",
        "apiKeyConfigured": False,
        "apiKeyPreview": None,
        "modelName": "",
        "temperature": 0.2,
        "maxTokens": 8192,
        "availableModels": [],
    }


@app.post(
    "/api/promptcard/runtime/projects/{project_id}/conversations/{conversation_id}/edits/reconcile"
)
def reconcile_document_edits() -> dict[str, Any]:
    return {"status": "idle", "canvasEdits": []}


@app.get("/api/promptcard/runtime/model-catalog")
def model_catalog() -> dict[str, Any]:
    return {
        "providers": [
            {
                "id": "volcengine-ark",
                "displayName": "火山方舟",
                "defaultApiBase": "https://ark.cn-beijing.volces.com/api/v3",
            }
        ],
        "models": [
            {
                "id": MODEL_ID,
                "providerId": "volcengine-ark",
                "displayName": "Seedream 5.0 Pro",
                "modality": "image",
                "capabilities": {
                    "modes": ["generate", "edit", "region-edit"],
                    "resolutions": ["1K", "2K"],
                    "aspectRatios": ["smart", "1:1", "16:9", "9:16"],
                    "customSize": None,
                    "outputFormats": ["png", "jpeg"],
                    "watermark": True,
                    "maxReferenceImages": 10,
                    "regionInputs": ["point", "bbox"],
                    "outputCount": 1,
                    "streaming": False,
                },
            }
        ],
    }


@app.get("/api/promptcard/runtime/model-connections")
def model_connections() -> dict[str, Any]:
    return {
        "connections": [
            {
                "id": CONNECTION_ID,
                "providerId": "volcengine-ark",
                "displayName": "E2E Ark",
                "apiBase": "https://ark.cn-beijing.volces.com/api/v3",
                "enabled": True,
                "credentialConfigured": True,
                "credentialMask": "••••••••",
                "createdAt": 1,
                "updatedAt": 1,
                "lastTest": {"ok": True, "checkedAt": 1, "message": "Connection ok."},
            }
        ]
    }


@app.get("/api/promptcard/runtime/model-assignments")
def model_assignments() -> dict[str, Any]:
    return {"assignments": [{"slot": "image.primary", "connectionId": CONNECTION_ID, "modelId": MODEL_ID}]}


@app.get("/api/promptcard/runtime/image-generation-status")
def image_generation_status() -> dict[str, Any]:
    return {
        "serverEnabled": True,
        "checkedAt": 1,
        "credentialStore": {"available": True},
        "providers": [
            {
                "providerId": "volcengine-ark",
                "status": "ready",
                "sdk": {
                    "packageName": "volcengine-python-sdk",
                    "installedVersion": "5.0.36",
                    "requiredVersion": "5.0.36",
                    "compatible": True,
                    "error": None,
                },
            }
        ],
    }


@app.get("/__test__/provider-requests")
def recorded_provider_requests() -> dict[str, Any]:
    return {"requests": provider_requests}


@app.get("/__test__/provider")
def provider_state() -> dict[str, Any]:
    return generic_provider_control.snapshot()


@app.post("/__test__/provider/reset")
def reset_provider(body: ProviderGateResetRequest) -> dict[str, Any]:
    provider_requests.clear()
    return generic_provider_control.reset(paused=body.paused, fail_calls=[], fail_views=[])


@app.post("/__test__/provider/pause")
def pause_provider() -> dict[str, Any]:
    return generic_provider_control.pause()


@app.post("/__test__/provider/release")
def release_provider() -> dict[str, Any]:
    return generic_provider_control.release()


@app.get("/__test__/multi-view-provider")
def multi_view_provider_state(token: str) -> dict[str, Any]:
    control = _test_provider_control(token)
    return control.snapshot() if control is not None else {"paused": False, "failCalls": [], "failViews": [], "requests": []}


@app.post("/__test__/multi-view-provider/reset")
def reset_multi_view_provider(body: ProviderControlRequest) -> dict[str, Any]:
    with test_provider_controls_lock:
        control = test_provider_controls.setdefault(body.token, TestProviderControl())
    return control.reset(
        paused=body.paused,
        fail_calls=body.fail_calls,
        fail_views=body.fail_views,
    )


@app.post("/__test__/multi-view-provider/pause")
def pause_multi_view_provider(body: ProviderSessionRequest) -> dict[str, Any]:
    control = _test_provider_control(body.token)
    return control.pause() if control is not None else {"paused": False, "failCalls": [], "failViews": [], "requests": []}


@app.post("/__test__/multi-view-provider/release")
def release_multi_view_provider(body: ProviderSessionRequest) -> dict[str, Any]:
    control = _test_provider_control(body.token)
    return control.release() if control is not None else {"paused": False, "failCalls": [], "failViews": [], "requests": []}


def _test_provider_control(token: str) -> TestProviderControl | None:
    with test_provider_controls_lock:
        return test_provider_controls.get(token)


def _plan_007_session(request: ImageGenerationRequest) -> str | None:
    prompt = "\n".join(
        getattr(segment, "text", "")
        for segment in request.prompt_document.segments
    )
    match = PLAN_007_SESSION_PATTERN.search(prompt)
    return match.group(1) if match else None


def _request_view_spec(request: ImageGenerationRequest) -> str | None:
    prompt = "\n".join(
        getattr(segment, "text", "")
        for segment in request.prompt_document.segments
    )
    return next((view for view, instruction in VIEW_INSTRUCTIONS.items() if instruction in prompt), None)


def _sanitized_request(
    request: ImageGenerationRequest,
    *,
    call: int | None = None,
    view_spec: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "segments": [
            {"type": "text", "text": segment.text}
            if hasattr(segment, "text")
            else {"type": "reference", "referenceId": segment.reference_id, "label": segment.label}
            for segment in request.prompt_document.segments
        ],
        "inputCount": len(request.inputs),
        "regionCount": len(request.regions),
        "resolution": request.resolution,
        "aspectRatio": request.aspect_ratio,
    }
    if call is not None:
        result["call"] = call
    if view_spec is not None:
        result["viewSpec"] = view_spec
    return result


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "38101")))
