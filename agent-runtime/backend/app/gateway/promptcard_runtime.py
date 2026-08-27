from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import secrets
import threading
import time
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, unquote

import httpx
from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from app.gateway.ark_responses import ResolvedDocumentAsset
from app.gateway.csrf_middleware import is_secure_request
from app.gateway.image_generation.service import PromptCardStorageClient, StorageGatewayError
from app.gateway.internal_auth import create_internal_auth_headers
from app.gateway.local_session import LOCAL_SESSION_COOKIE, local_session_token
from app.gateway.model_management.catalog import MODELS, model_by_id
from app.gateway.model_management.connection_store import (
    CREDENTIAL_MASK,
    ModelManagementError,
    get_connection_store,
)
from app.gateway.model_management.contracts import ConnectionRequest
from app.gateway.model_management.service import ConnectionProbeError, probe_connection
from app.gateway.skill_snapshots import resolve_local_agent_skill_snapshot
from app.gateway.text_generation.service import (
    agent_chat_model_catalog,
    assigned_text_model,
    complete_sdk_text,
    complete_sdk_text_with_documents,
    require_pdf_text_model,
    resolve_text_model,
)

MAX_CANVAS_AGENT_IMAGE_BYTES = 30 * 1024 * 1024
MAX_DOCUMENT_ATTACHMENTS = 5
MAX_DOCUMENT_TURN_BYTES = 100 * 1024 * 1024
MAX_DOCUMENT_MODEL_TEXT_CHARS = 500_000
_DOCUMENT_INVOCATION_TTL_SECONDS = 300
_MAX_DOCUMENT_INVOCATIONS = 32


@dataclass(frozen=True)
class DocumentInvocation:
    assets: tuple[ResolvedDocumentAsset, ...]
    connection_id: str
    provider_id: str
    model_id: str
    expires_at: float


class DocumentInvocationRegistry:
    def __init__(self) -> None:
        self._items: dict[str, DocumentInvocation] = {}
        self._lock = threading.Lock()

    def register(
        self,
        assets: list[ResolvedDocumentAsset],
        descriptor: dict[str, Any],
    ) -> str:
        now = time.monotonic()
        model = descriptor.get("model") or {}
        invocation = DocumentInvocation(
            assets=tuple(assets),
            connection_id=str(descriptor.get("connectionId") or ""),
            provider_id=str(descriptor.get("providerId") or ""),
            model_id=str(model.get("id") or ""),
            expires_at=now + _DOCUMENT_INVOCATION_TTL_SECONDS,
        )
        with self._lock:
            self._prune(now)
            if len(self._items) >= _MAX_DOCUMENT_INVOCATIONS:
                raise HTTPException(status_code=503, detail="document_context_busy")
            handle = secrets.token_urlsafe(32)
            self._items[handle] = invocation
        return handle

    def resolve(self, handle: str) -> DocumentInvocation | None:
        if not isinstance(handle, str) or not handle:
            return None
        now = time.monotonic()
        with self._lock:
            self._prune(now)
            return self._items.get(handle)

    def discard(self, handle: str) -> None:
        with self._lock:
            self._items.pop(handle, None)

    def _prune(self, now: float) -> None:
        expired = [
            handle
            for handle, invocation in self._items.items()
            if invocation.expires_at <= now
        ]
        for handle in expired:
            self._items.pop(handle, None)


_document_invocations = DocumentInvocationRegistry()


class PromptCardRuntimeMessageRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    thread_id: str | None = Field(default=None, alias="threadId")
    conversation_id: str | None = Field(default=None, alias="conversationId")
    request_id: str | None = Field(default=None, alias="requestId")
    content: str = Field(min_length=1, max_length=20_000)
    mode: str | None = None
    permission_scope: str = Field(
        default="workspace-chatbot-agent",
        alias="permissionScope",
    )
    session_key: str | None = Field(default=None, alias="sessionKey")
    project_id: str | None = Field(default=None, alias="projectId")
    workspace_context: dict[str, Any] | None = Field(
        default=None,
        alias="workspaceContext",
    )
    prompt_library: list[dict[str, Any]] = Field(
        default_factory=list,
        alias="promptLibrary",
        max_length=200,
    )
    selected_skill_ids: list[str] = Field(
        default_factory=list,
        alias="selectedSkillIds",
        max_length=8,
    )
    interaction_mode: Literal["prompt-edit", "chat-experimental"] = Field(
        default="prompt-edit",
        alias="interactionMode",
    )
    canvas_node_context: dict[str, Any] | None = Field(
        default=None,
        alias="canvasNodeContext",
    )
    document_resource_ids: list[str] = Field(
        default_factory=list,
        alias="documentResourceIds",
        max_length=MAX_DOCUMENT_ATTACHMENTS,
    )
    explicit_document_node_ids: list[str] = Field(
        default_factory=list,
        alias="explicitDocumentNodeIds",
        max_length=MAX_DOCUMENT_ATTACHMENTS,
    )


class PromptCardMediaAnalysisRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    thread_id: str | None = Field(default=None, alias="threadId")
    asset_id: str = Field(alias="assetId", min_length=1)
    content_type: str = Field(alias="contentType", min_length=1)
    analysis_type: str = Field(alias="analysisType")
    content: str = Field(default="", max_length=20_000)
    history: list[dict[str, Any]] = Field(default_factory=list, max_length=40)
    media_action: str = Field(default="chat", alias="mediaAction")
    prompt_language_mode: Literal["zh", "en", "mixed"] = Field(
        default="mixed",
        alias="promptLanguageMode",
    )
    media_preview: dict[str, Any] | None = Field(default=None, alias="mediaPreview")
    selection: dict[str, Any] | None = None


class PromptCardModelConfigRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    enabled: bool | None = None
    api_base: str | None = Field(default=None, alias="apiBase")
    api_key: str | None = Field(default=None, alias="apiKey")
    model_name: str | None = Field(default=None, alias="modelName")
    temperature: float | None = None
    max_tokens: int | None = Field(default=None, alias="maxTokens")


class PromptCardInternalChatRequest(BaseModel):
    model: str
    connection_id: str = Field(alias="connectionId")
    system_prompt: str = Field(default="", alias="systemPrompt")
    messages: list[dict[str, Any]] = Field(default_factory=list)
    tools: list[dict[str, Any]] = Field(default_factory=list)
    temperature: float | None = None
    max_tokens: int | None = Field(default=None, alias="maxTokens")
    document_invocation_handle: str | None = Field(
        default=None,
        alias="documentInvocationHandle",
        exclude=True,
    )


class PromptCardConversationModelRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    model_binding: dict[str, Any] | None = Field(alias="modelBinding")


class PromptCardRuntimeService:
    async def status(self, request: Request) -> dict[str, Any]:
        text_agent_url = _text_agent_url()
        text_agent: dict[str, Any]
        try:
            async with httpx.AsyncClient(timeout=1.5) as client:
                response = await client.get(f"{text_agent_url}/health")
                text_agent = {
                    "ok": response.status_code == 200,
                    "payload": response.json() if response.status_code == 200 else None,
                }
        except (httpx.HTTPError, ValueError):
            text_agent = {"ok": False}
        assignment = get_connection_store().assignment("chat.primary")
        return {
            "runtime": {
                "ok": True,
                "service": "promptcard-runtime",
                "orchestrator": "pi",
            },
            "auth": {"ok": True, "mode": "local-process-token"},
            "models": {"ok": assignment is not None, "count": 1 if assignment else 0},
            "tools": {"ok": text_agent["ok"], "count": 4},
            "storage": await _storage_health(),
            "textAgent": text_agent,
        }

    async def bootstrap(self, request: Request, response: Response) -> dict[str, Any]:
        response.set_cookie(
            key=LOCAL_SESSION_COOKIE,
            value=local_session_token(),
            httponly=True,
            secure=is_secure_request(request),
            samesite="strict",
        )
        return {
            "user": {
                "id": "local-promptcard-user",
                "email": "local@promptcard",
                "name": "Local PromptCard User",
            },
            "expires_in": None,
        }

    async def catalog(self, request: Request) -> dict[str, Any]:
        chat_models = agent_chat_model_catalog()
        try:
            skill_catalog = await _storage_request("GET", "/api/skills")
            skills = skill_catalog.get("skills", [])
        except HTTPException:
            skills = []
        return {
            "models": chat_models,
            "tools": [
                {"name": "search_prompt_library", "group": "prompt-library"},
                {"name": "emit_canvas_prompt_edit", "group": "proposal"},
                {"name": "emit_prompt_library_create", "group": "proposal"},
                {"name": "emit_media_prompt_preview", "group": "preview"},
            ],
            "builtins": [],
            "subagentEnabled": False,
            "skills": skills,
            "agents": [
                {
                    "id": "promptcard-text-agent",
                    "name": "PromptCard Text Agent",
                    "description": "pi orchestration with pluggable multimodal text providers",
                }
            ],
        }

    async def send_message(
        self,
        body: PromptCardRuntimeMessageRequest,
        request: Request,
    ) -> dict[str, Any]:
        payload = body.model_dump(by_alias=True)
        payload.pop("documentResourceIds", None)
        payload.pop("explicitDocumentNodeIds", None)
        resolved_canvas_context: dict[str, Any] | None = None
        conversation_id = body.conversation_id
        model_binding: dict[str, Any] | None = None
        request_id = body.request_id or str(uuid.uuid4())
        skill_snapshots: list[dict[str, Any]] = []
        interaction_mode: Literal["prompt-edit", "chat-experimental"] = "prompt-edit"
        if body.permission_scope == "workspace-chatbot-agent" and body.project_id:
            if not conversation_id:
                created = await _storage_request("POST", "/api/agent-conversations", json={
                    "projectId": body.project_id,
                    "entrypoint": body.permission_scope,
                    "mode": body.mode or "workspace",
                    "title": _conversation_title(body.content),
                })
                conversation_id = str(created["id"])
            conversation = await _storage_request(
                "GET",
                f"/api/agent-conversations/{quote(conversation_id, safe='')}",
                params={"projectId": body.project_id},
            )
            if conversation.get("projectId") != body.project_id:
                raise HTTPException(status_code=409, detail="agent_conversation_project_mismatch")
            if conversation.get("entrypoint") != body.permission_scope:
                raise HTTPException(status_code=409, detail="agent_conversation_entrypoint_mismatch")
            if body.mode and conversation.get("mode") != body.mode:
                raise HTTPException(status_code=409, detail="agent_conversation_mode_mismatch")
            existing_turn = next(
                (
                    turn for turn in conversation.get("turns", [])
                    if isinstance(turn, dict) and turn.get("requestId") == request_id
                ),
                None,
            )
            if existing_turn is not None:
                return _saved_turn_response(conversation_id, request_id, existing_turn)
            stored_interaction_mode = conversation.get("interactionMode", "prompt-edit")
            if stored_interaction_mode not in {"prompt-edit", "chat-experimental"}:
                raise HTTPException(
                    status_code=502,
                    detail="agent_conversation_interaction_invalid",
                )
            interaction_mode = stored_interaction_mode
            bound_skill_ids = conversation.get("boundSkillIds", [])
            if not isinstance(bound_skill_ids, list) or not all(
                isinstance(skill_id, str) for skill_id in bound_skill_ids
            ):
                raise HTTPException(
                    status_code=502,
                    detail="agent_conversation_skill_bindings_invalid",
                )
            if interaction_mode == "chat-experimental":
                payload["selectedSkillIds"] = []
            model_binding = conversation.get("modelBinding")
            payload["history"] = _agent_history(conversation.get("messages") or [])
            skill_request = body.model_copy(update={
                "interaction_mode": interaction_mode,
                "selected_skill_ids": (
                    bound_skill_ids
                    if interaction_mode == "chat-experimental"
                    else body.selected_skill_ids
                ),
            })
            skill_snapshots = await _resolve_skill_snapshots(skill_request)
            payload["skillSnapshots"] = skill_snapshots
        _validate_document_resource_ids(body.project_id, body.document_resource_ids)
        if body.explicit_document_node_ids:
            if len(set(body.explicit_document_node_ids)) != len(
                body.explicit_document_node_ids
            ):
                raise HTTPException(
                    status_code=422,
                    detail="explicit_document_node_ids_duplicate",
                )
            raise HTTPException(
                status_code=422,
                detail="document_context_unavailable",
            )
        document_assets = await _load_document_resources(
            body.project_id,
            body.document_resource_ids,
        )
        if sum(len(asset.content) for asset in document_assets) > MAX_DOCUMENT_TURN_BYTES:
            raise HTTPException(
                status_code=413,
                detail="document_attachments_too_large",
            )
        payload["content"] = _content_with_document_text(
            body.content,
            document_assets,
        )
        if interaction_mode == "prompt-edit":
            resolved_canvas_context = _resolve_canvas_node_context(body)
        payload["canvasNodeContext"] = resolved_canvas_context
        payload["interactionMode"] = interaction_mode
        if any(asset.content_type == "application/pdf" for asset in document_assets):
            try:
                require_pdf_text_model(model_binding)
            except ModelManagementError as exc:
                if str(exc) != "document_input_not_supported":
                    raise
                raise HTTPException(
                    status_code=422,
                    detail="document_input_not_supported",
                ) from None
        descriptor = resolve_text_model(model_binding)
        normalized_binding = _model_binding_from_descriptor(descriptor)
        if conversation_id and body.project_id and model_binding is None:
            await _storage_request(
                "PATCH",
                _conversation_model_path(body.project_id, conversation_id),
                json={"modelBinding": normalized_binding},
            )
        payload["threadId"] = conversation_id or body.thread_id
        payload["requestId"] = request_id
        payload["modelDescriptor"] = descriptor
        attachments = await _load_canvas_image_attachments(
            resolved_canvas_context,
            descriptor,
        )
        if attachments:
            payload["attachments"] = attachments
        document_handle: str | None = None
        try:
            pdf_assets = [
                asset
                for asset in document_assets
                if asset.content_type == "application/pdf"
            ]
            if pdf_assets:
                document_handle = _document_invocations.register(
                    pdf_assets,
                    descriptor,
                )
                payload["documentInvocationHandle"] = document_handle
            response = await _invoke_text_agent(payload)
        finally:
            if document_handle is not None:
                _document_invocations.discard(document_handle)
        raw_canvas_edits = response.get("canvasEdits")
        raw_canvas_edits = raw_canvas_edits if isinstance(raw_canvas_edits, list) else []
        validation_permission_scope = (
            "chat-experimental"
            if interaction_mode == "chat-experimental"
            else body.permission_scope
        )
        response["canvasEdits"] = validate_agent_canvas_edits(
            raw_canvas_edits,
            workspace_context=body.workspace_context,
            permission_scope=validation_permission_scope,
            canvas_node_context=resolved_canvas_context,
        )
        if raw_canvas_edits:
            response["diagnostics"] = {
                **(response.get("diagnostics") or {}),
                "canvasEditValidation": {
                    "received": len(raw_canvas_edits),
                    "accepted": len(response["canvasEdits"]),
                },
            }
            if not response["canvasEdits"]:
                response["text"] = "画布修改未通过校验，请重试。"
        response["proposals"] = validate_agent_proposals(
            response.get("proposals") or [],
            workspace_context=body.workspace_context,
            permission_scope=validation_permission_scope,
            canvas_node_context=resolved_canvas_context,
        )
        model_snapshot = _model_snapshot(descriptor)
        skill_audit = [
            {key: skill[key] for key in ("skillId", "revision", "digest")}
            for skill in skill_snapshots
        ]
        response["proposals"] = [
            {
                **proposal,
                "provenance": {"model": model_snapshot, "skills": skill_audit},
            }
            if proposal.get("kind") in {"free_canvas_text_insertions", "free_canvas_text_create"}
            else proposal
            for proposal in response["proposals"]
        ]
        response["canvasEdits"] = [
            {
                **edit,
                "provenance": {"model": model_snapshot, "skills": skill_audit},
            }
            for edit in response["canvasEdits"]
        ]
        if conversation_id and body.project_id:
            saved = await _storage_request(
                "POST",
                f"/api/agent-conversations/{quote(conversation_id, safe='')}/turns",
                json={
                    "projectId": body.project_id,
                    "requestId": request_id,
                    "userMessage": {
                        "role": "user",
                        "text": body.content,
                        **(
                            {
                                "documentAttachments": [
                                    {
                                        "resourceId": asset.resource_id,
                                        "name": asset.filename,
                                        "contentType": asset.content_type,
                                        "size": len(asset.content),
                                    }
                                    for asset in document_assets
                                ]
                            }
                            if document_assets
                            else {}
                        ),
                        **(
                            {"canvasNodeContext": _canvas_node_context_audit(resolved_canvas_context)}
                            if resolved_canvas_context is not None
                            else {}
                        ),
                    },
                    "assistantMessage": {
                        "role": "assistant",
                        "text": response.get("text", ""),
                        "canvasEdits": response["canvasEdits"],
                    },
                    "proposals": response["proposals"],
                    "modelSnapshot": model_snapshot,
                    "skillSnapshots": skill_audit,
                },
            )
            response["conversationId"] = conversation_id
            response["requestId"] = request_id
            response["savedTurn"] = saved
        return response

    async def analyze_media(
        self,
        body: PromptCardMediaAnalysisRequest,
        request: Request,
    ) -> dict[str, Any]:
        if not body.content_type.startswith("image/"):
            raise HTTPException(status_code=422, detail="media_analysis_image_required")
        storage = PromptCardStorageClient()
        try:
            asset = await run_in_threadpool(storage.load_asset, body.asset_id)
        except StorageGatewayError:
            raise HTTPException(status_code=502, detail="media_asset_unavailable") from None
        finally:
            storage.close()
        if len(asset.content) > 30 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="media_asset_too_large")
        if not asset.content_type.startswith("image/"):
            raise HTTPException(status_code=422, detail="media_analysis_image_required")
        prompt = body.content.strip() or {
            "style": "分析这张图片的媒体风格，并给出可复用的视觉风格描述。",
            "prompt": "逆向拆解这张图片，输出可用于图片生成的结构化提示词。",
        }.get(body.analysis_type, "分析当前图片并回答用户问题。")
        response = await _invoke_text_agent(
            {
                "threadId": body.thread_id,
                "content": prompt,
                "permissionScope": "media-analysis-agent",
                "workspaceContext": None,
                "promptLibrary": [],
                "history": _agent_history(body.history),
                "mediaAction": body.media_action,
                "promptLanguageMode": body.prompt_language_mode,
                "mediaPreview": body.media_preview,
                "modelDescriptor": resolve_text_model(None),
                "selection": body.selection,
                "skillSnapshots": await _builtin_skill_snapshot("media.prompt.reverse", {"emit_media_prompt_preview"}),
                "attachment": {
                    "assetId": body.asset_id,
                    "contentType": asset.content_type,
                    "data": base64.b64encode(asset.content).decode("ascii"),
                },
            }
        )
        response["proposals"] = [
            proposal for proposal in response.get("proposals") or []
            if body.media_action == "preview" and proposal.get("kind") == "media_prompt_preview"
        ]
        return response

    async def internal_chat(
        self,
        body: PromptCardInternalChatRequest,
    ) -> dict[str, Any]:
        handle = body.document_invocation_handle
        if handle is not None:
            invocation = _document_invocations.resolve(handle)
            if (
                invocation is None
                or invocation.connection_id != body.connection_id
                or invocation.provider_id != "volcengine-ark"
                or invocation.model_id != body.model
            ):
                raise HTTPException(
                    status_code=409,
                    detail="document_context_unavailable",
                )
            payload = body.model_dump(by_alias=True)
            pdf_assets = [
                asset
                for asset in invocation.assets
                if asset.content_type == "application/pdf"
            ]
            return await run_in_threadpool(
                complete_sdk_text_with_documents,
                payload,
                connection_id=body.connection_id,
                model_id=body.model,
                pdf_assets=pdf_assets,
            )
        return await run_in_threadpool(
            complete_sdk_text,
            body.model_dump(by_alias=True),
            connection_id=body.connection_id,
            model_id=body.model,
        )

    async def internal_text_model(self) -> dict[str, Any]:
        return await run_in_threadpool(assigned_text_model)

    async def update_conversation_model(
        self,
        project_id: str,
        conversation_id: str,
        model_binding: dict[str, Any] | None,
    ) -> dict[str, Any]:
        normalized = None
        if model_binding is not None:
            descriptor = resolve_text_model(model_binding)
            normalized = _model_binding_from_descriptor(descriptor)
            catalog_item = next(
                (
                    item for item in agent_chat_model_catalog()
                    if item["connectionId"] == normalized["connectionId"]
                    and item["modelId"] == normalized["modelId"]
                ),
                None,
            )
            if catalog_item is None or not catalog_item["available"]:
                raise ModelManagementError("agent_chat_model_unavailable")
        return await _storage_request(
            "PATCH",
            _conversation_model_path(project_id, conversation_id),
            json={"modelBinding": normalized},
        )

    async def get_model_config(self, request: Request) -> dict[str, Any]:
        store = get_connection_store()
        assignment = store.assignment("chat.primary")
        connection = (
            store.get_connection(assignment["connectionId"])
            if assignment is not None
            else None
        )
        return {
            "enabled": bool(connection and connection.get("enabled", True)),
            "apiBase": connection.get("apiBase") if connection else "https://ark.cn-beijing.volces.com/api/v3",
            "apiKeyConfigured": bool(connection and connection.get("credentialConfigured")),
            "apiKeyPreview": CREDENTIAL_MASK if connection and connection.get("credentialConfigured") else None,
            "modelName": assignment["modelId"] if assignment else "doubao-seed-2-0-lite-260215",
            "temperature": 0.4,
            "maxTokens": 4096,
            "availableModels": [
                model["id"] for model in MODELS if model["modality"] == "chat"
            ],
        }

    async def save_model_config(
        self,
        body: PromptCardModelConfigRequest,
        request: Request,
    ) -> dict[str, Any]:
        model_id = (body.model_name or "doubao-seed-2-0-lite-260215").strip()
        model = model_by_id(model_id)
        provider_id = (
            str(model["providerId"])
            if model is not None
            else "deepseek"
        )
        api_base = body.api_base or {
            "volcengine-ark": "https://ark.cn-beijing.volces.com/api/v3",
            "deepseek": "https://api.deepseek.com",
        }[provider_id]
        get_connection_store().save_legacy_chat(
            ConnectionRequest(
                providerId=provider_id,
                displayName="Volcengine Ark" if provider_id == "volcengine-ark" else "DeepSeek",
                apiBase=api_base,
                enabled=True if body.enabled is None else body.enabled,
                credential=body.api_key,
            ),
            model_id,
        )
        return await self.get_model_config(request)

    async def test_model_config(
        self,
        body: PromptCardModelConfigRequest,
        request: Request,
    ) -> dict[str, Any]:
        store = get_connection_store()
        assignment = store.assignment("chat.primary")
        if assignment is None:
            raise ModelManagementError("assignment_not_found")
        connection = store.get_connection_config(assignment["connectionId"])
        credential = body.api_key or store.credential_store.get(connection["id"])
        if not credential:
            raise ModelManagementError("credential_missing")
        try:
            await run_in_threadpool(
                probe_connection,
                str(connection["providerId"]),
                body.api_base or connection["apiBase"],
                credential,
            )
        except ConnectionProbeError:
            return {"success": False, "message": "Connection failed."}
        return {"success": True, "message": "Connection ok."}


def validate_agent_proposals(
    proposals: list[dict[str, Any]],
    *,
    workspace_context: dict[str, Any] | None,
    permission_scope: str,
    canvas_node_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    validated = []
    snapshot = (
        workspace_context.get("snapshot")
        if isinstance(workspace_context, dict)
        else {}
    ) or {}
    selected_node = snapshot.get("selectedNode")
    if canvas_node_context is not None:
        selected_text_id = canvas_node_context.get("targetNodeId")
        selected_node = canvas_node_context.get("targetNode")
        if not isinstance(selected_node, dict) and selected_text_id:
            selected_node = next(
                (
                    node for node in snapshot.get("nodes", [])
                    if isinstance(node, dict) and str(node.get("id")) == str(selected_text_id)
                ),
                None,
            )
    else:
        selected_text_id = (
            str(selected_node.get("id"))
            if isinstance(selected_node, dict)
            and selected_node.get("kind") == "text"
            and selected_node.get("id") == snapshot.get("selectedNodeId")
            else None
        )
    for index, proposal in enumerate(proposals):
        if not isinstance(proposal, dict):
            continue
        kind = proposal.get("kind")
        if (
            permission_scope == "workspace-chatbot-agent"
            and selected_text_id
            and canvas_node_context is not None
            and canvas_node_context.get("mode") == "complete"
            and kind == "free_canvas_text_insertions"
            and _valid_canvas_insertions(proposal.get("insertions"), selected_node)
            and str(proposal.get("rationale") or "").strip()
        ):
            validated.append({
                **_canvas_proposal_base(proposal, index),
                "nodeId": str(selected_text_id),
                "insertions": proposal["insertions"],
                **_canvas_protection(selected_node),
            })
        elif (
            permission_scope == "workspace-chatbot-agent"
            and selected_text_id
            and canvas_node_context is not None
            and canvas_node_context.get("mode") == "rewrite"
            and kind == "free_canvas_text_create"
            and isinstance(proposal.get("userText"), str)
            and proposal["userText"].strip()
        ):
            validated.append({
                **_canvas_proposal_base(proposal, index),
                "kind": "free_canvas_text_create",
                "sourceNodeId": str(selected_text_id),
                "basis": _canvas_protection(selected_node),
            })
        elif (
            permission_scope == "workspace-chatbot-agent"
            and selected_text_id
            and kind == "free_canvas_text_update"
            and canvas_node_context is None
            and str(proposal.get("nodeId")) == selected_text_id
            and isinstance(proposal.get("userText"), str)
            and proposal["userText"].strip()
        ):
            protected = _canvas_protection(selected_node)
            protected["editMode"] = "rewrite_all"
            if canvas_node_context is not None:
                selection = canvas_node_context.get("selection")
                edit_mode = (
                    "append"
                    if canvas_node_context.get("mode") == "complete"
                    else "rewrite_selection" if selection else "rewrite_all"
                )
                protected["editMode"] = edit_mode
                if edit_mode == "rewrite_selection":
                    protected["selection"] = {
                        "start": selection["start"],
                        "end": selection["end"],
                        "selectedText": selection["selectedText"],
                    }
            validated.append({
                **_canvas_proposal_base(proposal, index),
                "nodeId": str(selected_text_id),
                **protected,
            })
        elif (
            permission_scope == "workspace-chatbot-agent"
            and selected_text_id is None
            and canvas_node_context is None
            and kind == "free_canvas_text_create"
            and isinstance(proposal.get("userText"), str)
            and proposal["userText"].strip()
        ):
            validated.append(_proposal_base(proposal, index))
        elif (
            permission_scope == "prompt-library-agent"
            and kind == "prompt_library_write_proposal"
            and proposal.get("operation", "create") == "create"
            and isinstance(proposal.get("presetDraft"), dict)
            and str(proposal["presetDraft"].get("label") or "").strip()
            and str(proposal["presetDraft"].get("content") or "").strip()
        ):
            validated.append(_proposal_base(proposal, index))
    return validated


def validate_agent_canvas_edits(
    edits: list[dict[str, Any]],
    *,
    workspace_context: dict[str, Any] | None,
    permission_scope: str,
    canvas_node_context: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if permission_scope != "workspace-chatbot-agent" or canvas_node_context is None:
        return []
    selected_text_id = canvas_node_context.get("targetNodeId")
    if not selected_text_id:
        return []
    snapshot = (
        workspace_context.get("snapshot")
        if isinstance(workspace_context, dict)
        else {}
    ) or {}
    selected_node = canvas_node_context.get("targetNode")
    if not isinstance(selected_node, dict):
        selected_node = next(
            (
                node for node in snapshot.get("nodes", [])
                if isinstance(node, dict) and str(node.get("id")) == str(selected_text_id)
            ),
            None,
        )

    validated: list[dict[str, Any]] = []
    for index, edit in enumerate(edits):
        if not isinstance(edit, dict):
            continue
        kind = edit.get("kind")
        if (
            canvas_node_context.get("mode") == "complete"
            and kind == "free_canvas_text_insertions"
            and _valid_canvas_insertions(edit.get("insertions"), selected_node)
            and str(edit.get("rationale") or "").strip()
        ):
            validated.append({
                **_canvas_edit_base(edit, index),
                "nodeId": str(selected_text_id),
                "insertions": edit["insertions"],
                **_canvas_protection(selected_node),
            })
        elif (
            canvas_node_context.get("mode") == "rewrite"
            and kind == "free_canvas_text_create"
            and isinstance(edit.get("userText"), str)
            and edit["userText"].strip()
            and str(edit.get("rationale") or "").strip()
        ):
            validated.append({
                **_canvas_edit_base(edit, index),
                "kind": "free_canvas_text_create",
                "sourceNodeId": str(selected_text_id),
                "basis": _canvas_protection(selected_node),
            })
    return validated


def _proposal_base(proposal: dict[str, Any], index: int) -> dict[str, Any]:
    return {
        **proposal,
        "id": str(proposal.get("id") or f"proposal-{int(time.time() * 1000)}-{index}"),
        "agentName": str(proposal.get("agentName") or "PromptCard Agent"),
        "status": "pending",
        "createdAt": int(proposal.get("createdAt") or int(time.time() * 1000)),
    }


def _canvas_proposal_base(proposal: dict[str, Any], index: int) -> dict[str, Any]:
    model_controlled_fields = {
        "nodeId",
        "mode",
        "editMode",
        "selection",
        "baseNodeRevision",
        "templateDigest",
        "baseContentDigest",
    }
    return _proposal_base(
        {
            key: value
            for key, value in proposal.items()
            if key not in model_controlled_fields
        },
        index,
    )


def _canvas_edit_base(edit: dict[str, Any], index: int) -> dict[str, Any]:
    gateway_controlled_fields = {
        "nodeId",
        "sourceNodeId",
        "mode",
        "editMode",
        "selection",
        "basis",
        "baseNodeRevision",
        "templateDigest",
        "baseContentDigest",
        "baseSegmentsDigest",
        "provenance",
        "status",
    }
    filtered = {
        key: value
        for key, value in edit.items()
        if key not in gateway_controlled_fields
    }
    return {
        **filtered,
        "id": str(filtered.get("id") or f"canvas-edit-{int(time.time() * 1000)}-{index}"),
        "agentName": str(filtered.get("agentName") or "PromptCard Agent"),
        "createdAt": int(filtered.get("createdAt") or int(time.time() * 1000)),
    }


def _canvas_protection(selected: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(selected, dict):
        return {}
    revision = selected.get("revision")
    protected = {
        "presetText": selected.get("presetText", ""),
        "segments": [
            segment for segment in selected.get("segments", [])
            if isinstance(segment, dict) and segment.get("source") == "preset"
        ],
    }
    digest = hashlib.sha256(
        json.dumps(protected, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return {
        "baseNodeRevision": revision,
        "templateDigest": f"sha256:{digest}",
        "baseSegmentsDigest": "sha256:" + hashlib.sha256(
            json.dumps(
                [
                    {
                        key: segment.get(key)
                        for key in ("id", "source", "text", "color")
                    }
                    for segment in selected.get("segments", [])
                    if isinstance(segment, dict)
                ],
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest(),
        "baseContentDigest": _text_digest(str(selected.get("userText") or "")),
    }


def _valid_canvas_insertions(value: Any, selected: dict[str, Any] | None) -> bool:
    if not isinstance(value, list) or not 0 < len(value) <= 16:
        return False
    for insertion in value:
        if not isinstance(insertion, dict):
            return False
        if not str(insertion.get("text") or "").strip() or not str(insertion.get("reason") or "").strip():
            return False
        anchor = insertion.get("anchor")
        if not isinstance(anchor, dict) or anchor.get("position") not in {"before", "after"}:
            return False
        segments = selected.get("segments", []) if isinstance(selected, dict) else []
        if anchor.get("type") == "segment" and any(
            isinstance(segment, dict) and segment.get("id") == anchor.get("segmentId")
            for segment in segments
        ):
            continue
        if anchor.get("type") == "text":
            segment_id = anchor.get("segmentId")
            anchor_text = anchor.get("text")
            target_segment = next(
                (
                    segment for segment in segments
                    if isinstance(segment, dict) and segment.get("id") == segment_id
                ),
                None,
            )
            if (
                isinstance(anchor_text, str)
                and anchor_text
                and isinstance(target_segment, dict)
                and _substring_occurrences(str(target_segment.get("text") or ""), anchor_text) == 1
            ):
                continue
        return False
    return True


def _substring_occurrences(value: str, substring: str) -> int:
    count = 0
    start = 0
    while start < len(value):
        position = value.find(substring, start)
        if position < 0:
            return count
        count += 1
        start = position + 1
    return count


def _text_digest(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _resolve_canvas_node_context(body: PromptCardRuntimeMessageRequest) -> dict[str, Any] | None:
    raw = body.canvas_node_context
    if raw is None:
        return None
    if body.permission_scope != "workspace-chatbot-agent":
        raise HTTPException(status_code=422, detail="canvas_node_context_scope_invalid")
    mode = raw.get("mode")
    if mode not in {"complete", "rewrite", "prompt-library"}:
        raise HTTPException(status_code=422, detail="canvas_node_context_mode_invalid")
    workspace_context = body.workspace_context
    if not isinstance(workspace_context, dict):
        raise HTTPException(status_code=422, detail="canvas_node_context_workspace_invalid")
    context_project_id = str(workspace_context.get("projectId") or "")
    if not body.project_id or context_project_id != body.project_id:
        raise HTTPException(status_code=409, detail="canvas_node_context_project_mismatch")
    snapshot = workspace_context.get("snapshot")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("nodes"), list):
        raise HTTPException(status_code=422, detail="canvas_node_context_workspace_invalid")
    nodes = {
        str(node.get("id")): node
        for node in snapshot.get("nodes", [])
        if isinstance(node, dict) and node.get("id")
    }
    raw_target_id = raw.get("targetNodeId")
    if raw_target_id is not None and (
        not isinstance(raw_target_id, str) or not raw_target_id.strip()
    ):
        raise HTTPException(status_code=422, detail="canvas_node_context_nodes_invalid")
    target_id = raw_target_id.strip() if isinstance(raw_target_id, str) else None
    if mode == "prompt-library" and target_id:
        raise HTTPException(status_code=422, detail="canvas_prompt_library_target_forbidden")
    raw_reference_ids = raw.get("referenceNodeIds")
    if not isinstance(raw_reference_ids, list) or any(
        not isinstance(node_id, str) or not node_id.strip()
        for node_id in raw_reference_ids
    ):
        raise HTTPException(status_code=422, detail="canvas_node_context_nodes_invalid")
    reference_ids = [node_id.strip() for node_id in raw_reference_ids]
    if len(reference_ids) != len(set(reference_ids)) or len(reference_ids) + (1 if target_id else 0) > 10:
        raise HTTPException(status_code=422, detail="canvas_node_context_nodes_invalid")
    if target_id and target_id in reference_ids:
        raise HTTPException(status_code=422, detail="canvas_node_context_roles_invalid")
    if target_id and (target_id not in nodes or nodes[target_id].get("kind") != "text"):
        raise HTTPException(status_code=422, detail="canvas_node_context_node_invalid")
    if any(
        node_id not in nodes or nodes[node_id].get("kind") not in {"text", "image"}
        for node_id in reference_ids
    ):
        raise HTTPException(status_code=422, detail="canvas_node_context_node_invalid")
    attached_ids = set(reference_ids)
    if target_id:
        attached_ids.add(target_id)
    mentions = raw.get("mentions")
    if not isinstance(mentions, list) or any(
        not isinstance(mention, dict)
        or not isinstance(mention.get("nodeId"), str)
        or mention["nodeId"] not in attached_ids
        for mention in mentions
    ):
        raise HTTPException(status_code=422, detail="canvas_node_context_mentions_invalid")
    selection = raw.get("selection")
    if selection is not None:
        if mode != "rewrite" or not target_id or not isinstance(selection, dict):
            raise HTTPException(status_code=422, detail="canvas_node_context_selection_invalid")
        target_text = str(nodes[target_id].get("userText") or "")
        start = selection.get("start")
        end = selection.get("end")
        selected_text = selection.get("selectedText")
        if (
            not isinstance(start, int)
            or isinstance(start, bool)
            or not isinstance(end, int)
            or isinstance(end, bool)
            or start < 0
            or end <= start
            or not isinstance(selected_text, str)
            or _utf16_slice(target_text, start, end) != selected_text
            or selection.get("baseContentDigest") != _text_digest(target_text)
        ):
            raise HTTPException(status_code=409, detail="canvas_node_context_selection_stale")
        selection = {
            "start": start,
            "end": end,
            "selectedText": selected_text,
            "baseContentDigest": _text_digest(target_text),
        }
    def node_name(node_id: str) -> str:
        return str(nodes[node_id].get("title") or node_id)[:32]

    target = (
        {"nodeId": target_id, "name": node_name(target_id)}
        if target_id
        else None
    )
    references = [
        {"nodeId": node_id, "name": node_name(node_id)}
        for node_id in reference_ids
    ]
    canonical_mentions = [
        {"nodeId": mention["nodeId"], "label": node_name(mention["nodeId"])}
        for mention in mentions
    ]
    return {
        "mode": mode,
        "targetNodeId": target_id,
        "referenceNodeIds": reference_ids,
        "mentions": canonical_mentions,
        **({"selection": selection} if selection else {}),
        "target": target,
        "references": references,
        "targetNode": nodes.get(target_id) if target_id else None,
        "referenceNodes": [nodes[node_id] for node_id in reference_ids],
    }


async def _load_canvas_image_attachments(
    context: dict[str, Any] | None,
    descriptor: dict[str, Any],
) -> list[dict[str, str]]:
    reference_nodes = context.get("referenceNodes") if context else []
    image_nodes = [
        node for node in reference_nodes or []
        if isinstance(node, dict) and node.get("kind") == "image"
    ]
    if not image_nodes:
        return []

    capabilities = descriptor.get("model", {}).get("capabilities", {})
    inputs = capabilities.get("input", []) if isinstance(capabilities, dict) else []
    if not isinstance(inputs, list) or "image" not in inputs:
        raise HTTPException(status_code=422, detail="agent_model_image_input_unsupported")

    storage = PromptCardStorageClient()
    attachments: list[dict[str, str]] = []
    total_bytes = 0
    try:
        for node in image_nodes:
            asset_id = node.get("assetId")
            if not isinstance(asset_id, str) or not asset_id.strip():
                raise HTTPException(status_code=422, detail="canvas_reference_image_asset_invalid")
            try:
                asset = await run_in_threadpool(storage.load_asset, asset_id)
            except StorageGatewayError:
                raise HTTPException(status_code=502, detail="canvas_reference_image_unavailable") from None
            if not asset.content_type.startswith("image/"):
                raise HTTPException(status_code=422, detail="canvas_reference_image_asset_invalid")
            total_bytes += len(asset.content)
            if total_bytes > MAX_CANVAS_AGENT_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="canvas_reference_images_too_large")
            attachments.append({
                "assetId": asset_id,
                "contentType": asset.content_type,
                "data": base64.b64encode(asset.content).decode("ascii"),
            })
    finally:
        storage.close()
    return attachments


async def _load_document_resources(
    project_id: str | None,
    resource_ids: list[str],
) -> list[ResolvedDocumentAsset]:
    _validate_document_resource_ids(project_id, resource_ids)
    if not resource_ids:
        return []

    base_url = os.getenv(
        "PROMPTCARD_STORAGE_URL",
        "http://127.0.0.1:8002",
    ).rstrip("/")
    assets: list[ResolvedDocumentAsset] = []
    total_bytes = 0
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            for resource_id in resource_ids:
                response = await client.get(
                    f"{base_url}/api/internal/projects/"
                    f"{quote(project_id, safe='')}/document-resources/"
                    f"{quote(resource_id, safe='')}/content",
                    headers=create_internal_auth_headers(),
                )
                if response.status_code == 404:
                    raise HTTPException(
                        status_code=422,
                        detail="document_resource_invalid",
                    )
                if response.status_code == 409:
                    raise HTTPException(
                        status_code=409,
                        detail="document_integrity_failed",
                    )
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail="document_storage_failed",
                    )
                if response.headers.get("x-document-resource-id") != resource_id:
                    raise HTTPException(
                        status_code=502,
                        detail="document_storage_invalid_response",
                    )
                content = response.content
                total_bytes += len(content)
                if total_bytes > MAX_DOCUMENT_TURN_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="document_attachments_too_large",
                    )
                content_type = response.headers.get("content-type", "").split(";", 1)[0]
                filename = unquote(response.headers.get("x-file-name", ""))
                if (
                    not filename
                    or len(filename) > 255
                    or "/" in filename
                    or "\\" in filename
                    or Path(filename).name != filename
                    or any(ord(character) < 32 for character in filename)
                ):
                    raise HTTPException(
                        status_code=502,
                        detail="document_storage_invalid_response",
                    )
                normalized_text = _normalized_document_text(content_type, content)
                assets.append(
                    ResolvedDocumentAsset(
                        resource_id=resource_id,
                        filename=filename,
                        content_type=content_type,
                        content=content,
                        normalized_text=normalized_text,
                    )
                )
    except HTTPException:
        raise
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="document_storage_unavailable") from None
    return assets


def _validate_document_resource_ids(
    project_id: str | None,
    resource_ids: list[str],
) -> None:
    if not resource_ids:
        return
    if not project_id:
        raise HTTPException(status_code=422, detail="document_project_required")
    if len(resource_ids) > MAX_DOCUMENT_ATTACHMENTS:
        raise HTTPException(status_code=413, detail="document_attachments_too_many")
    if any(
        not resource_id or resource_id != resource_id.strip()
        for resource_id in resource_ids
    ):
        raise HTTPException(status_code=422, detail="document_resource_id_invalid")
    if len(set(resource_ids)) != len(resource_ids):
        raise HTTPException(status_code=422, detail="document_resource_ids_duplicate")


def _normalized_document_text(content_type: str, content: bytes) -> str | None:
    if content_type == "application/pdf":
        return None
    if content_type in {"text/plain", "text/markdown"}:
        try:
            text = content.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise HTTPException(status_code=502, detail="document_content_invalid") from None
        return unicodedata.normalize(
            "NFC",
            text.replace("\r\n", "\n").replace("\r", "\n"),
        )[:MAX_DOCUMENT_MODEL_TEXT_CHARS]
    if content_type == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ):
        try:
            from docx import Document
            from docx.table import Table
            from docx.text.paragraph import Paragraph

            document = Document(io.BytesIO(content))
            lines: list[str] = []
            for block in document.iter_inner_content():
                if isinstance(block, Paragraph) and block.text:
                    lines.append(block.text)
                elif isinstance(block, Table):
                    for row in block.rows:
                        lines.append("\t".join(cell.text for cell in row.cells))
            return unicodedata.normalize("NFC", "\n".join(lines))[
                :MAX_DOCUMENT_MODEL_TEXT_CHARS
            ]
        except (KeyError, ValueError, OSError):
            raise HTTPException(status_code=502, detail="document_content_invalid") from None
    raise HTTPException(status_code=502, detail="document_content_type_invalid")


def _content_with_document_text(
    content: str,
    assets: list[ResolvedDocumentAsset],
) -> str:
    remaining = MAX_DOCUMENT_MODEL_TEXT_CHARS
    sections = [content]
    for asset in assets:
        if not asset.normalized_text or remaining <= 0:
            continue
        text = asset.normalized_text[:remaining]
        remaining -= len(text)
        sections.append(
            f"[Attached document: {asset.filename}]\n{text}"
        )
    return "\n\n".join(sections)


def _canvas_node_context_audit(context: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": context["mode"],
        "target": context.get("target"),
        "references": list(context.get("references") or []),
        "mentions": list(context.get("mentions") or []),
        **(
            {"selection": {
                "start": context["selection"]["start"],
                "end": context["selection"]["end"],
                "selectedText": context["selection"]["selectedText"],
                "baseContentDigest": context["selection"]["baseContentDigest"],
            }}
            if context.get("selection")
            else {}
        ),
    }


def _utf16_slice(value: str, start: int, end: int) -> str | None:
    encoded = value.encode("utf-16-le")
    if end * 2 > len(encoded):
        return None
    try:
        return encoded[start * 2:end * 2].decode("utf-16-le")
    except UnicodeDecodeError:
        return None


def _agent_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    history = []
    for message in messages[-40:]:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "")
        if role not in {"user", "assistant"}:
            continue
        text = str(message.get("text") or "").strip()
        if text:
            history.append({"role": role, "content": [{"type": "text", "text": text}]})
    return history


def _conversation_title(content: str) -> str:
    normalized = " ".join(content.strip().split())
    return normalized[:48] or "New conversation"


def _allowed_tool_names(body: PromptCardRuntimeMessageRequest) -> set[str]:
    if body.interaction_mode == "chat-experimental":
        return set()
    tools: set[str] = set()
    if body.permission_scope == "prompt-library-agent":
        tools.add("search_prompt_library")
    if body.canvas_node_context is not None:
        if body.canvas_node_context.get("mode") == "prompt-library":
            tools.add("search_prompt_library")
        elif body.canvas_node_context.get("targetNodeId"):
            tools.add("emit_canvas_prompt_edit")
        return tools
    snapshot = (body.workspace_context or {}).get("snapshot") or {}
    selected = snapshot.get("selectedNode")
    if isinstance(selected, dict) and selected.get("kind") == "text":
        tools.add("emit_canvas_prompt_edit")
    return tools


async def _resolve_skill_snapshots(body: PromptCardRuntimeMessageRequest) -> list[dict[str, Any]]:
    allowed_tools = _allowed_tool_names(body)
    snapshots = (
        []
        if body.interaction_mode == "chat-experimental"
        or (body.canvas_node_context or {}).get("mode") == "prompt-library"
        else await _builtin_skill_snapshot("canvas.prompt.edit", allowed_tools)
    )
    if not body.selected_skill_ids:
        return snapshots
    catalog = await _storage_request("GET", "/api/skills")
    by_id: dict[str, dict[str, Any]] = {}
    by_public_code: dict[str, dict[str, Any]] = {}
    for item in catalog.get("skills", []):
        if not isinstance(item, dict):
            continue
        by_id[str(item.get("id"))] = item
        reference_code = item.get("referenceCode")
        if isinstance(reference_code, str) and reference_code:
            by_public_code[reference_code.casefold()] = item
    for skill_id in body.selected_skill_ids:
        summary = by_id.get(skill_id) or by_public_code.get(skill_id.casefold())
        if not summary:
            raise HTTPException(status_code=404, detail="selected_skill_not_found")
        if summary.get("source") != "external":
            raise HTTPException(status_code=403, detail="selected_skill_not_user_triggerable")
        snapshot = await resolve_local_agent_skill_snapshot(
            _storage_request,
            skill_id=str(summary.get("referenceCode") or skill_id),
            allowed_tools=allowed_tools,
        )
        snapshots.append(snapshot)
    return snapshots[:8]


async def _builtin_skill_snapshot(capability_id: str, allowed_tools: set[str]) -> list[dict[str, Any]]:
    catalog = await _storage_request("GET", "/api/skills")
    for summary in catalog.get("skills", []):
        if not isinstance(summary, dict) or summary.get("capabilityId") != capability_id:
            continue
        identifier = str(summary.get("referenceCode") or summary["id"])
        try:
            snapshot = await resolve_local_agent_skill_snapshot(
                _storage_request,
                skill_id=identifier,
                allowed_tools=allowed_tools,
            )
        except HTTPException as exc:
            if exc.status_code == 403:
                return []
            raise
        return [snapshot]
    return []


def _current_skill_revision(detail: dict[str, Any]) -> dict[str, Any] | None:
    current = detail.get("currentRevision")
    revision = next(
        (
            item for item in detail.get("revisions", [])
            if isinstance(item, dict) and item.get("revision") == current
        ),
        None,
    )
    if not revision:
        return None
    return {
        "skillId": str(detail.get("id")),
        "revision": int(revision["revision"]),
        "digest": str(revision["digest"]),
        "instructions": str(revision.get("instructions") or ""),
        "references": list(revision.get("references") or []),
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
            response = await client.request(method, f"{base_url}{path}", params=params, json=json)
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="storage_unavailable") from None
    if response.status_code == 404:
        raise HTTPException(status_code=404, detail="agent_storage_item_not_found")
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail="agent_storage_failed")
    try:
        payload = response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="agent_storage_invalid_response") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="agent_storage_invalid_response")
    return payload


async def _invoke_text_agent(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{_text_agent_url()}/invoke",
                headers=create_internal_auth_headers(),
                json=payload,
            )
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="text_agent_unavailable") from None
    if response.status_code == 409:
        raise HTTPException(status_code=409, detail="text_agent_session_mismatch")
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="text_agent_failed")
    return response.json()


def _text_agent_url() -> str:
    return os.getenv("PROMPTCARD_TEXT_AGENT_URL", "http://127.0.0.1:8011").rstrip("/")


def _conversation_model_path(project_id: str, conversation_id: str) -> str:
    return (
        f"/api/projects/{quote(project_id, safe='')}/agent-conversations/"
        f"{quote(conversation_id, safe='')}/model"
    )


def _model_binding_from_descriptor(descriptor: dict[str, Any]) -> dict[str, str]:
    model = descriptor.get("model")
    if not isinstance(model, dict):
        raise ModelManagementError("invalid_model_binding")
    connection_id = descriptor.get("connectionId")
    provider_id = descriptor.get("providerId")
    model_id = model.get("id")
    if not all(isinstance(value, str) and value for value in (connection_id, provider_id, model_id)):
        raise ModelManagementError("invalid_model_binding")
    return {
        "connectionId": connection_id,
        "providerId": provider_id,
        "modelId": model_id,
    }


def _model_snapshot(descriptor: dict[str, Any]) -> dict[str, Any]:
    binding = _model_binding_from_descriptor(descriptor)
    model = descriptor["model"]
    return {
        **binding,
        "displayName": model.get("displayName"),
        "capabilities": model.get("capabilities", {}),
    }


def _saved_turn_response(
    conversation_id: str,
    request_id: str,
    turn: dict[str, Any],
) -> dict[str, Any]:
    messages = turn.get("messages") or []
    assistant = next(
        (
            message for message in reversed(messages)
            if isinstance(message, dict) and message.get("role") == "assistant"
        ),
        {},
    )
    return {
        "threadId": conversation_id,
        "conversationId": conversation_id,
        "requestId": request_id,
        "text": str(assistant.get("text") or ""),
        "proposals": turn.get("proposals") or [],
        "canvasEdits": assistant.get("canvasEdits") or [],
        "diagnostics": {"idempotent": True, "modelSnapshot": turn.get("modelSnapshot")},
    }


async def _storage_health() -> dict[str, Any]:
    url = os.getenv(
        "PROMPTCARD_STORAGE_HEALTH_URL",
        "http://127.0.0.1:8002/health",
    )
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            response = await client.get(url)
        return {"ok": response.status_code == 200}
    except httpx.HTTPError:
        return {"ok": False}


def load_prompt_library_snapshot() -> list[dict[str, Any]]:
    path = Path(
        os.getenv(
            "PROMPTCARD_LIBRARY_FILE",
            "data/prompt-library-presets.json",
        )
    )
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = payload if isinstance(payload, list) else payload.get("presets", [])
    return [item for item in items if isinstance(item, dict)][:200]


runtime_service = PromptCardRuntimeService()
