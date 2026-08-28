from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import StreamingResponse

from app.gateway.internal_auth import (
    INTERNAL_AUTH_HEADER_NAME,
    is_valid_internal_auth_token,
)
from app.gateway.model_management.connection_store import ModelManagementError
from app.gateway.model_management.credential_store import CredentialStoreError
from app.gateway.promptcard_runtime import (
    PromptCardAgentEditAckRequest,
    PromptCardConversationModelRequest,
    PromptCardInternalChatRequest,
    PromptCardMediaAnalysisRequest,
    PromptCardModelConfigRequest,
    PromptCardRuntimeMessageRequest,
    runtime_service,
)
from app.gateway.text_generation.service import resolve_pi_native_proxy

router = APIRouter(prefix="/api/promptcard/runtime", tags=["promptcard-runtime"])


class PromptCardRuntimeMessageResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    thread_id: str = Field(alias="threadId")
    conversation_id: str | None = Field(default=None, alias="conversationId")
    request_id: str | None = Field(default=None, alias="requestId")
    text: str
    proposals: list[dict[str, Any]]
    canvas_edits: list[dict[str, Any]] = Field(default_factory=list, alias="canvasEdits")
    diagnostics: dict[str, Any] = Field(default_factory=dict)


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    return await runtime_service.status(request)


@router.post("/bootstrap")
async def bootstrap(request: Request, response: Response) -> dict[str, Any]:
    return await runtime_service.bootstrap(request, response)


@router.get("/catalog")
async def catalog(request: Request) -> dict[str, Any]:
    try:
        return await runtime_service.catalog(request)
    except (ModelManagementError, CredentialStoreError, OSError) as exc:
        raise _model_http_error(exc) from None


@router.get("/model-config", deprecated=True)
async def model_config(request: Request) -> dict[str, Any]:
    try:
        return await runtime_service.get_model_config(request)
    except (ModelManagementError, CredentialStoreError, OSError) as exc:
        raise _model_http_error(exc) from None


@router.put("/model-config", deprecated=True)
async def save_model_config(body: PromptCardModelConfigRequest, request: Request) -> dict[str, Any]:
    try:
        return await runtime_service.save_model_config(body, request)
    except (ModelManagementError, CredentialStoreError, OSError) as exc:
        raise _model_http_error(exc) from None


@router.post("/model-config/test", deprecated=True)
async def test_model_config(body: PromptCardModelConfigRequest, request: Request) -> dict[str, Any]:
    try:
        return await runtime_service.test_model_config(body, request)
    except (ModelManagementError, CredentialStoreError, OSError) as exc:
        raise _model_http_error(exc) from None


@router.post("/messages", response_model=PromptCardRuntimeMessageResponse)
async def messages(body: PromptCardRuntimeMessageRequest, request: Request) -> dict[str, Any]:
    try:
        return await runtime_service.send_message(body, request)
    except (ModelManagementError, CredentialStoreError, OSError) as exc:
        raise _model_http_error(exc) from None


@router.patch("/projects/{project_id}/conversations/{conversation_id}/model")
async def update_conversation_model(
    project_id: str,
    conversation_id: str,
    body: PromptCardConversationModelRequest,
) -> dict[str, Any]:
    try:
        return await runtime_service.update_conversation_model(
            project_id,
            conversation_id,
            body.model_binding,
        )
    except (ModelManagementError, CredentialStoreError, OSError) as exc:
        raise _model_http_error(exc) from None


@router.post(
    "/projects/{project_id}/conversations/{conversation_id}/edits/{edit_id}/ack"
)
async def acknowledge_document_edit(
    project_id: str,
    conversation_id: str,
    edit_id: str,
    body: PromptCardAgentEditAckRequest,
) -> dict[str, Any]:
    return await runtime_service.ack_document_edit(
        project_id,
        conversation_id,
        edit_id,
        body,
    )


@router.post(
    "/projects/{project_id}/conversations/{conversation_id}/edits/reconcile"
)
async def reconcile_document_edits(
    project_id: str,
    conversation_id: str,
) -> dict[str, Any]:
    return await runtime_service.reconcile_document_edits(
        project_id,
        conversation_id,
    )


@router.post("/media-analysis", response_model=PromptCardRuntimeMessageResponse)
async def media_analysis(
    body: PromptCardMediaAnalysisRequest,
    request: Request,
) -> dict[str, Any]:
    return await runtime_service.analyze_media(body, request)


@router.post("/internal/chat")
async def internal_chat(
    body: PromptCardInternalChatRequest,
    request: Request,
) -> dict[str, Any]:
    _require_internal_auth(request)
    try:
        return await runtime_service.internal_chat(body)
    except (ModelManagementError, CredentialStoreError, OSError) as exc:
        raise _model_http_error(exc) from None


@router.get("/internal/text-model")
async def internal_text_model(request: Request) -> dict[str, Any]:
    _require_internal_auth(request)
    try:
        return await runtime_service.internal_text_model()
    except (ModelManagementError, CredentialStoreError, OSError) as exc:
        raise _model_http_error(exc) from None


@router.post("/internal/pi-proxy/{connection_id}/{upstream_path:path}")
async def pi_native_proxy(
    connection_id: str,
    upstream_path: str,
    request: Request,
) -> StreamingResponse:
    try:
        normalized_path = upstream_path.strip("/")
        _require_internal_auth(request)
        if normalized_path != "chat/completions":
            raise HTTPException(status_code=404, detail="pi_proxy_path_invalid")
        body = await request.body()
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise HTTPException(status_code=422, detail="pi_proxy_payload_invalid") from None
        if not isinstance(payload, dict) or not isinstance(payload.get("model"), str):
            raise HTTPException(status_code=422, detail="pi_proxy_model_mismatch")
        target = resolve_pi_native_proxy(connection_id, payload["model"])
        upstream_url = f'{target["apiBase"].rstrip("/")}/{normalized_path}'
        client = httpx.AsyncClient(timeout=httpx.Timeout(120, read=None))
        try:
            upstream = await client.send(
                client.build_request(
                    "POST",
                    upstream_url,
                    content=body,
                    headers={
                        "Authorization": f'Bearer {target["credential"]}',
                        "Content-Type": request.headers.get(
                            "content-type",
                            "application/json",
                        ),
                        "Accept": request.headers.get("accept", "text/event-stream"),
                    },
                ),
                stream=True,
            )
        except httpx.HTTPError:
            await client.aclose()
            raise HTTPException(
                status_code=502,
                detail="pi_provider_unavailable",
            ) from None
    except (ModelManagementError, CredentialStoreError, OSError) as exc:
        raise _model_http_error(exc) from None

    async def response_body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    response_headers = {}
    if content_encoding := upstream.headers.get("content-encoding"):
        response_headers["Content-Encoding"] = content_encoding
    return StreamingResponse(
        response_body(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
        headers=response_headers,
    )


def _require_internal_auth(request: Request) -> None:
    if not is_valid_internal_auth_token(
        request.headers.get(INTERNAL_AUTH_HEADER_NAME)
    ):
        raise HTTPException(status_code=401, detail="internal_auth_required")


def _model_http_error(exc: ModelManagementError | CredentialStoreError | OSError) -> HTTPException:
    code = getattr(exc, "code", "connection_store_unavailable")
    if code in {
        "credential_store_unavailable",
        "connection_store_unavailable",
        "migration_failed",
        "migration_rollback_failed",
        "model_config_rollback_failed",
    }:
        status_code = 503
    elif code == "connection_is_assigned":
        status_code = 409
    else:
        status_code = 422
    return HTTPException(status_code=status_code, detail=code)
