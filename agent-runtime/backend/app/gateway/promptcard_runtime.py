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
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, unquote, urlparse

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
MAX_PROMPT_HANDOFF_BYTES = 100_000
_DOCUMENT_INVOCATION_TTL_SECONDS = 300
_MAX_DOCUMENT_INVOCATIONS = 32
_DOCUMENT_EDIT_KINDS = {
    "document_create", "document_changes", "storyboard_create", "storyboard_changes"
}
_STORYBOARD_SEQUENCE_FIELDS = {"name", "description", "style", "constraints"}
_STORYBOARD_ROW_FIELDS = {
    "cutLabel", "timeRange", "subject", "action", "scene", "camera",
    "lighting", "audio", "duration",
}
_MAX_STORYBOARD_AGGREGATE_TEXT_BYTES = 256_000
_DOCUMENT_EDIT_MAX_OPERATIONS = 16
_DOCUMENT_EDIT_MAX_TEXT_BYTES = 64 * 1024


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
    document_write_context: dict[str, Any] | None = Field(
        default=None,
        alias="documentWriteContext",
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


class PromptCardAgentEditAckRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    request_id: str = Field(alias="requestId", min_length=1)
    status: Literal["applied", "failed"]
    error_code: str | None = Field(default=None, alias="errorCode")


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
        payload.pop("documentWriteContext", None)
        resolved_canvas_context: dict[str, Any] | None = None
        conversation_id = body.conversation_id
        model_binding: dict[str, Any] | None = None
        request_id = body.request_id or str(uuid.uuid4())
        skill_snapshots: list[dict[str, Any]] = []
        interaction_mode: Literal["prompt-edit", "chat-experimental"] = "prompt-edit"
        authoritative_document_project: dict[str, Any] | None = None
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
            if any(
                isinstance(turn, dict)
                and isinstance(turn.get("applyEdit"), dict)
                and turn["applyEdit"].get("status") == "pending_apply"
                for turn in conversation.get("turns", [])
            ):
                raise HTTPException(status_code=409, detail="agent_apply_edit_pending")
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
        document_write_context = None
        if body.document_write_context is not None:
            if interaction_mode != "chat-experimental" or not body.project_id:
                raise HTTPException(status_code=422, detail="document_write_context_scope_invalid")
            authoritative_document_project = await _storage_request(
                "GET",
                f"/api/projects/{quote(body.project_id, safe='')}",
            )
            document_write_context = _resolve_document_write_context(
                body,
                authoritative_document_project,
            )
            if document_write_context.get("operationKind") == "storyboard_create":
                resource_ids = document_write_context.pop("linkedDocumentResourceIds", [])
                source_assets = await _load_document_resources(body.project_id, resource_ids)
                document_write_context["documentResourceDigests"] = [
                    "sha256:" + hashlib.sha256(asset.content).hexdigest()
                    for asset in source_assets
                ]
        payload["documentWriteContext"] = document_write_context
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
        model_snapshot = _model_snapshot(descriptor)
        skill_audit = [
            {key: skill[key] for key in ("skillId", "revision", "digest")}
            for skill in skill_snapshots
        ]
        run_provenance = {"model": model_snapshot, "skills": skill_audit}
        if interaction_mode == "chat-experimental" and any(
            isinstance(edit, dict) and edit.get("kind") in _DOCUMENT_EDIT_KINDS
            for edit in raw_canvas_edits
        ):
            authoritative_project = authoritative_document_project or await _storage_request(
                "GET", f"/api/projects/{quote(str(body.project_id), safe='')}"
            )
            response["canvasEdits"] = validate_agent_document_edits(
                raw_canvas_edits,
                conversation_id=str(conversation_id),
                request_id=request_id,
                project=authoritative_project,
                expected_write_context=document_write_context,
                run_provenance=run_provenance,
            )
        else:
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
        raw_proposals = response.get("proposals")
        raw_proposals = raw_proposals if isinstance(raw_proposals, list) else []
        response["proposals"] = validate_agent_proposals(
            raw_proposals,
            workspace_context=body.workspace_context,
            permission_scope=validation_permission_scope,
            canvas_node_context=resolved_canvas_context,
            expected_write_context=document_write_context,
            interaction_mode=interaction_mode,
        )
        prompt_handoff_requested = (
            interaction_mode == "chat-experimental"
            and isinstance(document_write_context, dict)
            and document_write_context.get("operationKind") == "prompt_handoff"
        )
        if prompt_handoff_requested and (len(raw_proposals) != 1 or len(response["proposals"]) != 1):
            response["proposals"] = []
            response["text"] = "Prompt 提案未通过校验，请重试。"
            response["diagnostics"] = {
                "promptHandoffValidation": {
                    "status": "rejected",
                    "received": len(raw_proposals),
                    "accepted": 0,
                    "reason": "invalid_output",
                }
            }
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
        apply_edit = None
        if len(response["canvasEdits"]) == 1:
            candidate = response["canvasEdits"][0]
            if candidate.get("kind") in _DOCUMENT_EDIT_KINDS:
                apply_edit = {
                    key: candidate[key]
                    for key in (
                        "conversationId",
                        "requestId",
                        "editId",
                        "kind",
                        "nodeId",
                        "expectedResultDigest",
                    )
                }
                apply_edit["status"] = "pending_apply"
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
                        **(
                            {
                                "diagnostics": {
                                    "promptHandoffValidation": response["diagnostics"]["promptHandoffValidation"]
                                }
                            }
                            if isinstance((response.get("diagnostics") or {}).get("promptHandoffValidation"), dict)
                            else {}
                        ),
                    },
                    "proposals": response["proposals"],
                    "modelSnapshot": model_snapshot,
                    "skillSnapshots": skill_audit,
                    **({"applyEdit": apply_edit} if apply_edit is not None else {}),
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

    async def ack_document_edit(
        self,
        project_id: str,
        conversation_id: str,
        edit_id: str,
        body: PromptCardAgentEditAckRequest,
    ) -> dict[str, Any]:
        return await self._reconcile_document_edit(
            project_id,
            conversation_id,
            request_id=body.request_id,
            edit_id=edit_id,
        )

    async def reconcile_document_edits(
        self,
        project_id: str,
        conversation_id: str,
    ) -> dict[str, Any]:
        conversation = await _storage_request(
            "GET",
            f"/api/agent-conversations/{quote(conversation_id, safe='')}",
            params={"projectId": project_id},
        )
        pending = [
            turn for turn in conversation.get("turns", [])
            if isinstance(turn, dict)
            and isinstance(turn.get("applyEdit"), dict)
            and turn["applyEdit"].get("status") == "pending_apply"
        ]
        if not pending:
            return {"status": "idle", "canvasEdits": []}
        if len(pending) != 1:
            raise HTTPException(status_code=502, detail="agent_apply_edit_ledger_invalid")
        ledger = pending[0]["applyEdit"]
        return await self._reconcile_document_edit(
            project_id,
            conversation_id,
            request_id=str(ledger.get("requestId") or ""),
            edit_id=str(ledger.get("editId") or ""),
            conversation=conversation,
            include_canvas_edits=True,
        )

    async def _reconcile_document_edit(
        self,
        project_id: str,
        conversation_id: str,
        *,
        request_id: str,
        edit_id: str,
        conversation: dict[str, Any] | None = None,
        include_canvas_edits: bool = False,
    ) -> dict[str, Any]:
        if conversation is None:
            conversation = await _storage_request(
                "GET",
                f"/api/agent-conversations/{quote(conversation_id, safe='')}",
                params={"projectId": project_id},
            )
        if conversation.get("projectId") != project_id:
            raise HTTPException(status_code=409, detail="agent_conversation_project_mismatch")
        turn = next(
            (
                item for item in conversation.get("turns", [])
                if isinstance(item, dict) and item.get("requestId") == request_id
            ),
            None,
        )
        ledger = turn.get("applyEdit") if isinstance(turn, dict) else None
        if (
            not isinstance(ledger, dict)
            or ledger.get("conversationId") != conversation_id
            or ledger.get("requestId") != request_id
            or ledger.get("editId") != edit_id
        ):
            raise HTTPException(status_code=409, detail="agent_apply_edit_identity_mismatch")
        if ledger.get("status") != "pending_apply":
            return {
                **ledger,
                **({"canvasEdits": []} if include_canvas_edits else {}),
            }
        edit = _turn_document_edit(turn, edit_id)
        if edit is None:
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_integrity",
                {"code": "saved_edit_missing"},
                include_canvas_edits=include_canvas_edits,
            )
        try:
            project = await _storage_request(
                "GET",
                f"/api/projects/{quote(project_id, safe='')}",
            )
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_target_missing",
                {"code": "project_missing"},
                include_canvas_edits=include_canvas_edits,
            )
        node_id = str(ledger.get("nodeId") or "")
        node = _project_canvas_node(project, node_id)
        base = edit.get("base")
        edit_kind = str(ledger.get("kind") or "")
        storyboard_edit = edit_kind in {"storyboard_create", "storyboard_changes"}
        expected_node_kind = "storyboard" if storyboard_edit else "document"
        if edit_kind == "storyboard_create" or edit_kind == "storyboard_changes":
            expected_storyboard_source = _expected_storyboard_source_from_turn(
                conversation, turn, edit
            )
            if (
                expected_storyboard_source is None
                or (
                    isinstance(node, dict)
                    and node.get("kind") == "storyboard"
                    and node.get("source") != expected_storyboard_source
                )
            ):
                return await _terminal_agent_edit(
                    conversation_id,
                    request_id,
                    edit_id,
                    "failed_integrity",
                    {"nodeId": node_id, "kind": "storyboard", "code": "storyboard_source_mismatch"},
                    include_canvas_edits=include_canvas_edits,
                )
        marker = node.get("agentAppliedEdit") if isinstance(node, dict) else None
        if isinstance(marker, dict):
            if node.get("kind") != expected_node_kind:
                return await _terminal_agent_edit(
                    conversation_id,
                    request_id,
                    edit_id,
                    "failed_integrity",
                    {"nodeId": node_id, "kind": str(node.get("kind") or "unknown"), "code": "node_kind_mismatch"},
                    include_canvas_edits=include_canvas_edits,
                )
            expected_digest = str(ledger.get("expectedResultDigest") or "")
            marker_matches = marker == {
                "conversationId": conversation_id,
                "requestId": request_id,
                "editId": edit_id,
                "resultDigest": expected_digest,
            }
            storyboard_state = _persisted_storyboard_state(node) if storyboard_edit else None
            digest_matches = (
                storyboard_state is not None and storyboard_state["digest"] == expected_digest
            ) if storyboard_edit else _persisted_document_digest(node.get("document")) == expected_digest
            if marker_matches and digest_matches:
                return await _terminal_agent_edit(
                    conversation_id,
                    request_id,
                    edit_id,
                    "applied",
                    {
                        "projectRevision": int(project.get("revision") or 1),
                        "nodeId": node_id,
                        "kind": expected_node_kind,
                        "resultDigest": expected_digest,
                    },
                    include_canvas_edits=include_canvas_edits,
                )
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_integrity",
                {"nodeId": node_id, "kind": expected_node_kind, "code": "marker_or_digest_mismatch"},
                include_canvas_edits=include_canvas_edits,
            )
        if edit_kind == "storyboard_create" and await _authoritative_storyboard_source(
            project_id, project, conversation, turn, edit
        ) is None:
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_integrity",
                {"nodeId": node_id, "kind": "storyboard", "code": "storyboard_source_mismatch"},
                include_canvas_edits=include_canvas_edits,
            )
        if not isinstance(base, dict) or not isinstance(base.get("projectRevision"), int) or isinstance(base.get("projectRevision"), bool):
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_integrity",
                {"code": "saved_edit_base_invalid"},
                include_canvas_edits=include_canvas_edits,
            )
        if project.get("revision") != base["projectRevision"]:
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_conflict",
                {"code": "project_revision_changed"},
                include_canvas_edits=include_canvas_edits,
            )
        if node is None:
            if edit_kind in {"document_create", "storyboard_create"}:
                return {
                    "status": "pending_apply",
                    "conversationId": conversation_id,
                    "requestId": request_id,
                    "editId": edit_id,
                    "canvasEdits": [edit],
                }
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_target_missing",
                {"code": f"{expected_node_kind}_target_missing"},
                include_canvas_edits=include_canvas_edits,
            )
        if node.get("kind") != expected_node_kind:
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_integrity",
                {"nodeId": node_id, "kind": str(node.get("kind") or "unknown"), "code": "node_kind_mismatch"},
                include_canvas_edits=include_canvas_edits,
            )
        if edit_kind in {"document_create", "storyboard_create"}:
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_integrity",
                {"nodeId": node_id, "kind": expected_node_kind, "code": "create_identity_occupied"},
                include_canvas_edits=include_canvas_edits,
            )
        persisted_state = (
            _persisted_storyboard_state(node)
            if storyboard_edit
            else _normalize_persisted_document(node.get("document"))
        )
        if persisted_state is None:
            return await _terminal_agent_edit(
                conversation_id,
                request_id,
                edit_id,
                "failed_integrity",
                {"nodeId": node_id, "kind": expected_node_kind, "code": f"{expected_node_kind}_shape_invalid"},
                include_canvas_edits=include_canvas_edits,
            )
        if (
            persisted_state["revision"] == base.get("nodeRevision")
            and persisted_state["digest"] == base.get("nodeDigest")
        ):
            return {
                "status": "pending_apply",
                "conversationId": conversation_id,
                "requestId": request_id,
                "editId": edit_id,
                "canvasEdits": [edit],
            }
        return await _terminal_agent_edit(
            conversation_id,
            request_id,
            edit_id,
            "failed_conflict",
            {"nodeId": node_id, "kind": expected_node_kind, "code": f"{expected_node_kind}_base_changed"},
            include_canvas_edits=include_canvas_edits,
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
    expected_write_context: dict[str, Any] | None = None,
    interaction_mode: str = "prompt-edit",
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
            isinstance(expected_write_context, dict)
            and expected_write_context.get("operationKind") == "prompt_handoff"
            and validated
        ):
            continue
        if (
            not validated
            and permission_scope == "chat-experimental"
            and interaction_mode == "chat-experimental"
            and isinstance(expected_write_context, dict)
            and expected_write_context.get("operationKind") == "prompt_handoff"
            and kind == "free_canvas_text_create"
            and _normalize_storyboard_text(
                proposal.get("userText"), persisted=False,
                max_bytes=MAX_PROMPT_HANDOFF_BYTES, nonempty=True,
            ) is not None
            and _normalize_storyboard_text(
                proposal.get("userText"), persisted=False,
                max_bytes=MAX_PROMPT_HANDOFF_BYTES, nonempty=True,
            ) == proposal.get("userText")
            and isinstance(expected_write_context.get("basis"), dict)
        ):
            base = _proposal_base(proposal, index)
            validated.append({
                "id": base["id"],
                "agentName": base["agentName"],
                "status": "pending",
                "createdAt": base["createdAt"],
                "kind": "free_canvas_text_create",
                "title": str(proposal.get("title") or "Agent Prompt")[:128],
                "userText": _normalize_storyboard_text(
                    proposal["userText"], persisted=False,
                    max_bytes=MAX_PROMPT_HANDOFF_BYTES, nonempty=True,
                ),
                "handoffBasis": expected_write_context["basis"],
                "rationale": unicodedata.normalize(
                    "NFC", str(proposal.get("rationale") or "Explicit planning handoff")
                )[:2000],
            })
            continue
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
            and interaction_mode != "chat-experimental"
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


def _canonical_nfc_json(value: Any) -> str:
    def normalize(item: Any) -> Any:
        if isinstance(item, str):
            return unicodedata.normalize("NFC", item)
        if isinstance(item, list):
            return [normalize(child) for child in item]
        if isinstance(item, dict):
            return {
                unicodedata.normalize("NFC", str(key)): normalize(child)
                for key, child in item.items()
            }
        if item is None or isinstance(item, (bool, int, float)):
            return item
        raise ValueError("canonical_json_invalid")

    return json.dumps(
        normalize(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _normalize_storyboard_text(
    value: Any,
    *,
    persisted: bool,
    max_bytes: int = 10_000,
    nonempty: bool = False,
) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize("NFC", value)
    if persisted and normalized != value:
        return None
    try:
        encoded = normalized.encode("utf-8")
    except UnicodeEncodeError:
        return None
    if len(encoded) > max_bytes or (nonempty and not normalized):
        return None
    return normalized


def _valid_storyboard_timestamp(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 9_007_199_254_740_991
    )


def _normalize_storyboard_sequence(value: Any, *, model_output: bool) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    core = {"id", "name", "description", "style", "constraints", "rows"}
    persisted = core | {"createdAt", "updatedAt", "meta"}
    if set(value) != (core if model_output else persisted):
        return None
    sequence_id = _normalize_storyboard_text(
        value.get("id"), persisted=not model_output, nonempty=True
    )
    rows = value.get("rows")
    if sequence_id is None or not isinstance(rows, list) or not 0 < len(rows) <= 200:
        return None
    if not model_output and (
        not _valid_storyboard_timestamp(value.get("createdAt"))
        or not _valid_storyboard_timestamp(value.get("updatedAt"))
        or not isinstance(value.get("meta"), dict)
    ):
        return None
    fields: dict[str, str] = {}
    aggregate_text_bytes = 0
    for field in _STORYBOARD_SEQUENCE_FIELDS:
        item = _normalize_storyboard_text(value.get(field), persisted=not model_output)
        if item is None:
            return None
        fields[field] = item
        aggregate_text_bytes += len(item.encode("utf-8"))
    normalized_rows: list[dict[str, Any]] = []
    row_ids: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            return None
        row_core = {"id", *_STORYBOARD_ROW_FIELDS}
        row_persisted = row_core | {"createdAt", "updatedAt"}
        allowed_persisted = {frozenset(row_persisted), frozenset(row_persisted | {"imageUrl"})}
        if (model_output and set(row) != row_core) or (not model_output and frozenset(row) not in allowed_persisted):
            return None
        row_id = _normalize_storyboard_text(
            row.get("id"), persisted=not model_output, nonempty=True
        )
        if row_id is None or row_id in row_ids:
            return None
        if not model_output and (
            not _valid_storyboard_timestamp(row.get("createdAt"))
            or not _valid_storyboard_timestamp(row.get("updatedAt"))
        ):
            return None
        row_ids.add(row_id)
        normalized_row: dict[str, Any] = {"id": row_id}
        for field in _STORYBOARD_ROW_FIELDS:
            item = _normalize_storyboard_text(row.get(field), persisted=not model_output)
            if item is None:
                return None
            normalized_row[field] = item
            aggregate_text_bytes += len(item.encode("utf-8"))
        timestamp = int(time.time() * 1000)
        normalized_row["createdAt"] = timestamp if model_output else row["createdAt"]
        normalized_row["updatedAt"] = timestamp if model_output else row["updatedAt"]
        if not model_output and "imageUrl" in row:
            image_url = _normalize_storyboard_text(row["imageUrl"], persisted=True)
            if image_url is None:
                return None
            normalized_row["imageUrl"] = image_url
        normalized_rows.append(normalized_row)
    if aggregate_text_bytes > _MAX_STORYBOARD_AGGREGATE_TEXT_BYTES:
        return None
    timestamp = int(time.time() * 1000)
    return {
        "id": sequence_id,
        **fields,
        "rows": normalized_rows,
        "createdAt": timestamp if model_output else value["createdAt"],
        "updatedAt": timestamp if model_output else value["updatedAt"],
        "meta": {} if model_output else deepcopy(value["meta"]),
    }


def _storyboard_digest(sequence: dict[str, Any], pending: list[dict[str, Any]]) -> str:
    canonical_sequence = {
        "id": sequence["id"],
        **{field: sequence[field] for field in sorted(_STORYBOARD_SEQUENCE_FIELDS)},
        "rows": [{"id": row["id"], **{field: row[field] for field in sorted(_STORYBOARD_ROW_FIELDS)}} for row in sequence["rows"]],
    }
    return "sha256:" + hashlib.sha256(
        _canonical_nfc_json({"sequence": canonical_sequence, "pendingFieldChanges": pending}).encode("utf-8")
    ).hexdigest()


def _valid_storyboard_source(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != {"documentNodeId", "documentRevision", "documentDigest", "documentResourceDigests", "model", "skills"}:
        return False
    model = value.get("model")
    skills = value.get("skills")
    resource_digests = value.get("documentResourceDigests")
    if (
        _normalize_storyboard_text(value.get("documentNodeId"), persisted=True, nonempty=True) is None
        or not isinstance(value.get("documentRevision"), int)
        or isinstance(value["documentRevision"], bool)
        or not 0 <= value["documentRevision"] <= 9_007_199_254_740_991
        or not _valid_sha256_digest(value.get("documentDigest"))
        or not isinstance(resource_digests, list)
        or len(resource_digests) > 5
        or not all(_valid_sha256_digest(item) for item in resource_digests)
        or not isinstance(model, dict)
        or set(model) != {"connectionId", "providerId", "modelId", "displayName", "capabilities"}
        or any(
            _normalize_storyboard_text(model.get(key), persisted=True, nonempty=True) is None
            for key in ("connectionId", "providerId", "modelId", "displayName")
        )
        or not isinstance(model.get("capabilities"), dict)
        or not isinstance(skills, list)
        or len(skills) > 8
    ):
        return False
    skill_ids: set[str] = set()
    for skill in skills:
        if not isinstance(skill, dict) or set(skill) != {"skillId", "revision", "digest"}:
            return False
        skill_id = _normalize_storyboard_text(skill.get("skillId"), persisted=True, nonempty=True)
        revision = skill.get("revision")
        if (
            skill_id is None
            or skill_id in skill_ids
            or not isinstance(revision, int)
            or isinstance(revision, bool)
            or not 0 <= revision <= 9_007_199_254_740_991
            or not _valid_sha256_digest(skill.get("digest"))
        ):
            return False
        skill_ids.add(skill_id)
    return True


def _expected_storyboard_source_from_turn(
    conversation: dict[str, Any],
    current_turn: dict[str, Any],
    edit: dict[str, Any],
) -> dict[str, Any] | None:
    expected_source, source_turn = _expected_storyboard_source(conversation, current_turn, edit)
    if edit.get("kind") == "storyboard_changes":
        return deepcopy(expected_source) if _valid_storyboard_source(expected_source) else None
    if (
        not _valid_storyboard_source(expected_source)
        or not isinstance(source_turn, dict)
        or source_turn.get("modelSnapshot") != expected_source["model"]
        or source_turn.get("skillSnapshots") != expected_source["skills"]
    ):
        return None
    return deepcopy(expected_source)


def _expected_storyboard_source(
    conversation: dict[str, Any],
    current_turn: dict[str, Any],
    edit: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if edit.get("kind") == "storyboard_create":
        payload = edit.get("payload")
        return (payload.get("source") if isinstance(payload, dict) else None), current_turn
    payload = edit.get("payload")
    return (payload.get("source") if isinstance(payload, dict) else None), current_turn


async def _authoritative_storyboard_source(
    project_id: str,
    project: dict[str, Any],
    conversation: dict[str, Any],
    current_turn: dict[str, Any],
    edit: dict[str, Any],
) -> dict[str, Any] | None:
    expected_source = _expected_storyboard_source_from_turn(conversation, current_turn, edit)
    if expected_source is None:
        return None
    document_node = _project_canvas_node(project, expected_source["documentNodeId"])
    if not isinstance(document_node, dict) or document_node.get("kind") != "document":
        return None
    document = _normalize_persisted_document(document_node.get("document"))
    resource_ids = document_node.get("linkedDocumentResourceIds")
    if (
        document is None
        or document["revision"] != expected_source["documentRevision"]
        or document["digest"] != expected_source["documentDigest"]
        or not isinstance(resource_ids, list)
        or len(resource_ids) > MAX_DOCUMENT_ATTACHMENTS
        or not all(
            _normalize_storyboard_text(item, persisted=True, nonempty=True) is not None
            for item in resource_ids
        )
    ):
        return None
    try:
        resources = await _load_document_resources(project_id, resource_ids)
    except HTTPException:
        return None
    resource_digests = ["sha256:" + hashlib.sha256(resource.content).hexdigest() for resource in resources]
    return deepcopy(expected_source) if resource_digests == expected_source["documentResourceDigests"] else None


def _storyboard_sequence_text_bytes(sequence: dict[str, Any]) -> int:
    values = [sequence[field] for field in _STORYBOARD_SEQUENCE_FIELDS]
    values.extend(
        row[field]
        for row in sequence["rows"]
        for field in _STORYBOARD_ROW_FIELDS
    )
    return sum(len(value.encode("utf-8")) for value in values)


def _normalize_storyboard_pending_changes(
    value: Any,
    sequence: dict[str, Any] | None = None,
) -> list[dict[str, Any]] | None:
    if not isinstance(value, list) or len(value) > 32:
        return None
    rows = {
        row["id"]: row for row in sequence.get("rows", [])
    } if isinstance(sequence, dict) else {}
    change_ids: set[str] = set()
    identities: set[str] = set()
    aggregate_text_bytes = _storyboard_sequence_text_bytes(sequence) if sequence is not None else 0
    result: list[dict[str, Any]] = []
    for change in value:
        if not isinstance(change, dict) or change.get("scope") not in {"sequence", "row"}:
            return None
        required = {"id", "editId", "scope", "field", "previousValue", "newValue"}
        if change["scope"] == "row":
            required.add("rowId")
        if set(change) != required:
            return None
        change_id = _normalize_storyboard_text(change.get("id"), persisted=True, nonempty=True)
        edit_id = _normalize_storyboard_text(change.get("editId"), persisted=True, nonempty=True)
        previous_value = _normalize_storyboard_text(change.get("previousValue"), persisted=True)
        new_value = _normalize_storyboard_text(change.get("newValue"), persisted=True)
        if (
            change_id is None or edit_id is None or previous_value is None or new_value is None
            or change_id in change_ids
        ):
            return None
        scope = change["scope"]
        field = change.get("field")
        if (
            scope == "sequence" and field not in _STORYBOARD_SEQUENCE_FIELDS
        ) or (
            scope == "row" and field not in _STORYBOARD_ROW_FIELDS
        ):
            return None
        if scope == "sequence":
            identity = f"sequence:{field}"
            expected_previous = sequence.get(field) if isinstance(sequence, dict) else None
            normalized_change = {
                "id": change_id, "editId": edit_id, "scope": scope, "field": field,
                "previousValue": previous_value, "newValue": new_value,
            }
        else:
            row_id = _normalize_storyboard_text(change.get("rowId"), persisted=True, nonempty=True)
            if row_id is None or (sequence is not None and row_id not in rows):
                return None
            identity = f"row:{row_id}:{field}"
            expected_previous = rows.get(row_id, {}).get(field) if sequence is not None else None
            normalized_change = {
                "id": change_id, "editId": edit_id, "scope": scope, "rowId": row_id,
                "field": field, "previousValue": previous_value, "newValue": new_value,
            }
        if identity in identities or (sequence is not None and previous_value != expected_previous):
            return None
        change_ids.add(change_id)
        identities.add(identity)
        aggregate_text_bytes += len(new_value.encode("utf-8")) - len(previous_value.encode("utf-8"))
        result.append(normalized_change)
    if aggregate_text_bytes > _MAX_STORYBOARD_AGGREGATE_TEXT_BYTES:
        return None
    return result


def _normalize_storyboard_change_operations(value: Any, sequence: dict[str, Any]) -> list[dict[str, str]] | None:
    if not isinstance(value, list) or not 0 < len(value) <= 32:
        return None
    row_ids = {row["id"] for row in sequence["rows"]}
    identities: set[str] = set()
    result: list[dict[str, str]] = []
    aggregate_text_bytes = _storyboard_sequence_text_bytes(sequence)
    for change in value:
        if not isinstance(change, dict) or change.get("scope") not in {"sequence", "row"} or not isinstance(change.get("value"), str):
            return None
        scope = change["scope"]
        field = change.get("field")
        normalized_value = _normalize_storyboard_text(change["value"], persisted=False)
        if normalized_value is None:
            return None
        if scope == "sequence":
            if set(change) != {"scope", "field", "value"} or field not in _STORYBOARD_SEQUENCE_FIELDS:
                return None
            identity = f"sequence:{field}"
            normalized = {"scope": "sequence", "field": field, "value": normalized_value}
            previous_value = sequence[field]
        else:
            row_id = change.get("rowId")
            if set(change) != {"scope", "rowId", "field", "value"} or row_id not in row_ids or field not in _STORYBOARD_ROW_FIELDS:
                return None
            identity = f"row:{row_id}:{field}"
            normalized = {"scope": "row", "rowId": row_id, "field": field, "value": normalized_value}
            previous_value = next(row[field] for row in sequence["rows"] if row["id"] == row_id)
        if identity in identities:
            return None
        identities.add(identity)
        result.append(normalized)
        aggregate_text_bytes += len(normalized["value"].encode("utf-8")) - len(previous_value.encode("utf-8"))
    if aggregate_text_bytes > _MAX_STORYBOARD_AGGREGATE_TEXT_BYTES:
        return None
    return result


def _storyboard_pending_from_operations(edit_id: str, sequence: dict[str, Any], operations: list[dict[str, str]]) -> list[dict[str, Any]]:
    rows = {row["id"]: row for row in sequence["rows"]}
    result: list[dict[str, Any]] = []
    for index, operation in enumerate(operations):
        if operation["scope"] == "sequence":
            result.append({
                "id": f"sbf-{edit_id}-{index}", "editId": edit_id, "scope": "sequence",
                "field": operation["field"], "previousValue": sequence[operation["field"]],
                "newValue": operation["value"],
            })
        else:
            result.append({
                "id": f"sbf-{edit_id}-{index}", "editId": edit_id, "scope": "row",
                "rowId": operation["rowId"], "field": operation["field"],
                "previousValue": rows[operation["rowId"]][operation["field"]],
                "newValue": operation["value"],
            })
    return result


def _deterministic_document_edit_ids(
    conversation_id: str,
    request_id: str,
    kind: str,
    target_node_id: str | None,
) -> tuple[str, str]:
    normalized_target = unicodedata.normalize("NFC", target_node_id or "")
    edit_name = _canonical_nfc_json([
        "promptcard",
        "agent-document-edit-v1",
        conversation_id,
        request_id,
        kind,
        normalized_target,
    ])
    edit_id = str(uuid.uuid5(uuid.NAMESPACE_URL, edit_name))
    if kind in {"document_create", "storyboard_create"}:
        node_name = _canonical_nfc_json([
            "promptcard",
            "agent-document-node-v1" if kind == "document_create" else "agent-storyboard-node-v1",
            conversation_id,
            request_id,
        ])
        node_id = str(uuid.uuid5(uuid.NAMESPACE_URL, node_name))
    else:
        node_id = normalized_target
    return edit_id, node_id


def validate_agent_document_edits(
    edits: list[dict[str, Any]],
    *,
    conversation_id: str,
    request_id: str,
    project: dict[str, Any],
    expected_write_context: dict[str, Any] | None,
    run_provenance: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if len(edits) != 1 or not conversation_id or not request_id:
        return []
    edit = edits[0]
    if not isinstance(edit, dict) or edit.get("kind") not in _DOCUMENT_EDIT_KINDS:
        return []
    kind = str(edit["kind"])
    if (
        not isinstance(expected_write_context, dict)
        or expected_write_context.get("operationKind") != kind
    ):
        return []
    project_revision = project.get("revision")
    if not isinstance(project_revision, int) or isinstance(project_revision, bool):
        return []
    target_node_id = None
    payload: dict[str, Any]
    expected_result_digest: str
    if kind == "storyboard_create":
        payload_source = edit.get("payload") if isinstance(edit.get("payload"), dict) else edit
        title = payload_source.get("title")
        sequence = _normalize_storyboard_sequence(payload_source.get("sequence"), model_output=True)
        if (
            not isinstance(title, str) or not title.strip() or len(title) > 200
            or sequence is None or not isinstance(run_provenance, dict)
        ):
            return []
        source = {
            "documentNodeId": expected_write_context.get("documentNodeId"),
            "documentRevision": expected_write_context.get("documentRevision"),
            "documentDigest": expected_write_context.get("documentDigest"),
            "documentResourceDigests": expected_write_context.get("documentResourceDigests"),
            "model": deepcopy(run_provenance.get("model")),
            "skills": deepcopy(run_provenance.get("skills")),
        }
        if not _valid_storyboard_source(source):
            return []
        payload = {
            "title": unicodedata.normalize("NFC", title.strip()),
            "sequence": sequence,
            "source": source,
        }
        expected_result_digest = _storyboard_digest(sequence, [])
        supplied_digest = edit.get("expectedResultDigest")
        if supplied_digest is not None and supplied_digest != expected_result_digest:
            return []
        base = {"projectRevision": project_revision}
    elif kind == "storyboard_changes":
        payload_source = edit.get("payload") if isinstance(edit.get("payload"), dict) else edit
        target_node_id = str(payload_source.get("nodeId") or "").strip()
        target = _project_canvas_node(project, target_node_id)
        target_source = target.get("source") if isinstance(target, dict) else None
        if (
            target_node_id != expected_write_context.get("nodeId")
            or not isinstance(target, dict)
            or target.get("kind") != "storyboard"
            or not _valid_storyboard_source(target_source)
        ):
            return []
        sequence = _normalize_storyboard_sequence(target.get("sequence"), model_output=False)
        pending = _normalize_storyboard_pending_changes(target.get("pendingFieldChanges"), sequence)
        revision = target.get("revision", 0)
        digest = target.get("digest") or (_storyboard_digest(sequence, pending) if sequence is not None and pending is not None else None)
        if (
            sequence is None or pending is None or pending
            or not isinstance(revision, int) or isinstance(revision, bool) or revision < 0
            or digest != _storyboard_digest(sequence, pending)
            or payload_source.get("baseRevision") != revision
            or payload_source.get("baseDigest") != digest
        ):
            return []
        changes = _normalize_storyboard_change_operations(payload_source.get("changes"), sequence)
        if changes is None:
            return []
        candidate_edit_id, _ = _deterministic_document_edit_ids(conversation_id, request_id, kind, target_node_id)
        field_changes = _storyboard_pending_from_operations(candidate_edit_id, sequence, changes)
        expected_result_digest = _storyboard_digest(sequence, field_changes)
        supplied_digest = edit.get("expectedResultDigest")
        if supplied_digest is not None and supplied_digest != expected_result_digest:
            return []
        payload = {"changes": changes, "source": deepcopy(target_source)}
        base = {"projectRevision": project_revision, "nodeRevision": revision, "nodeDigest": digest}
    elif kind == "document_create":
        payload_source = edit.get("payload") if isinstance(edit.get("payload"), dict) else edit
        title = payload_source.get("title")
        blocks = payload_source.get("blocks")
        resource_ids = payload_source.get("linkedDocumentResourceIds", [])
        authoritative_resource_ids = expected_write_context.get(
            "linkedDocumentResourceIds"
        )
        if (
            not isinstance(title, str)
            or not title.strip()
            or len(title) > 200
            or not _valid_planning_document_blocks(blocks)
            or not isinstance(resource_ids, list)
            or not isinstance(authoritative_resource_ids, list)
            or resource_ids != authoritative_resource_ids
            or len(resource_ids) > MAX_DOCUMENT_ATTACHMENTS
            or len(resource_ids) != len(set(resource_ids))
            or not all(isinstance(item, str) and item.strip() for item in resource_ids)
        ):
            return []
        payload = {
            "title": unicodedata.normalize("NFC", title.strip()),
            "blocks": _normalize_nfc_json_value(blocks),
            "linkedDocumentResourceIds": list(authoritative_resource_ids),
        }
        expected_result_digest = _planning_document_digest(payload["blocks"], [])
        supplied_digest = edit.get("expectedResultDigest")
        if supplied_digest is not None and supplied_digest != expected_result_digest:
            return []
        base = {"projectRevision": project_revision}
    else:
        payload_source = edit.get("payload") if isinstance(edit.get("payload"), dict) else edit
        target_node_id = str(payload_source.get("nodeId") or "").strip()
        if target_node_id != expected_write_context.get("nodeId"):
            return []
        target = _project_canvas_node(project, target_node_id)
        if not target_node_id or not isinstance(target, dict) or target.get("kind") != "document":
            return []
        document = _normalize_persisted_document(target.get("document"))
        operations = payload_source.get("operations")
        if document is None or not _valid_document_change_operations(operations):
            return []
        base_revision = payload_source.get("baseRevision")
        base_digest = payload_source.get("baseDigest")
        if (
            not isinstance(base_revision, int)
            or isinstance(base_revision, bool)
            or base_revision != document.get("revision")
            or base_digest != document.get("digest")
            or _persisted_document_digest(document) != base_digest
        ):
            return []
        candidate_edit_id, _ = _deterministic_document_edit_ids(
            conversation_id,
            request_id,
            kind,
            target_node_id,
        )
        applied_document = _apply_document_change_operations(
            document,
            candidate_edit_id,
            operations,
        )
        if applied_document is None:
            return []
        expected_result_digest = applied_document["digest"]
        payload = {"operations": _normalize_nfc_json_value(operations)}
        base = {
            "projectRevision": project_revision,
            "nodeRevision": base_revision,
            "nodeDigest": base_digest,
        }
    edit_id, node_id = _deterministic_document_edit_ids(
        conversation_id,
        request_id,
        kind,
        target_node_id,
    )
    rationale = edit.get("rationale")
    return [{
        "kind": kind,
        "id": edit_id,
        "editId": edit_id,
        "conversationId": conversation_id,
        "requestId": request_id,
        "nodeId": node_id,
        "expectedResultDigest": expected_result_digest,
        "base": base,
        "payload": payload,
        "rationale": unicodedata.normalize("NFC", rationale.strip())
        if isinstance(rationale, str) and rationale.strip()
        else "Document update",
    }]


def _resolve_document_write_context(
    body: PromptCardRuntimeMessageRequest,
    project: dict[str, Any],
) -> dict[str, Any]:
    value = body.document_write_context
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="document_write_context_invalid")
    operation_kind = value.get("operationKind")
    if operation_kind == "prompt_handoff":
        return _resolve_prompt_handoff_context(value, project)
    if operation_kind == "document_create":
        if set(value) != {"operationKind"}:
            raise HTTPException(status_code=422, detail="document_write_context_invalid")
        return {
            "operationKind": "document_create",
            "linkedDocumentResourceIds": list(body.document_resource_ids),
        }
    if operation_kind == "storyboard_create":
        if set(value) != {"operationKind", "documentNodeId"}:
            raise HTTPException(status_code=422, detail="document_write_context_invalid")
        node_id = value.get("documentNodeId")
        node = _project_canvas_node(project, str(node_id or "").strip())
        if not isinstance(node, dict) or node.get("kind") != "document":
            raise HTTPException(status_code=422, detail="document_write_target_invalid")
        document = _normalize_persisted_document(node.get("document"))
        resource_ids = node.get("linkedDocumentResourceIds", [])
        if document is None or not isinstance(resource_ids, list) or len(resource_ids) > MAX_DOCUMENT_ATTACHMENTS or not all(isinstance(item, str) and item for item in resource_ids):
            raise HTTPException(status_code=409, detail="document_write_target_invalid")
        effective_text = "\n".join(text for _, text in _planning_document_leaf_texts(document["blocks"]))
        if len(effective_text.encode("utf-8")) > MAX_DOCUMENT_MODEL_TEXT_CHARS:
            raise HTTPException(status_code=413, detail="document_context_too_large")
        return {
            "operationKind": "storyboard_create",
            "documentNodeId": str(node_id).strip(),
            "documentRevision": document["revision"],
            "documentDigest": document["digest"],
            "effectiveText": effective_text,
            "linkedDocumentResourceIds": list(resource_ids),
        }
    if operation_kind == "storyboard_changes":
        if set(value) != {"operationKind", "nodeId"}:
            raise HTTPException(status_code=422, detail="document_write_context_invalid")
        node_id = value.get("nodeId")
        node = _project_canvas_node(project, str(node_id or "").strip())
        if not isinstance(node, dict) or node.get("kind") != "storyboard":
            raise HTTPException(status_code=422, detail="document_write_target_invalid")
        sequence = _normalize_storyboard_sequence(node.get("sequence"), model_output=False)
        pending = _normalize_storyboard_pending_changes(node.get("pendingFieldChanges"), sequence)
        revision = node.get("revision", 0)
        digest = node.get("digest") or (_storyboard_digest(sequence, pending) if sequence is not None and pending is not None else None)
        if sequence is None or pending is None or pending or not isinstance(revision, int) or digest != _storyboard_digest(sequence, pending):
            raise HTTPException(status_code=409, detail="storyboard_write_target_invalid")
        return {"operationKind": "storyboard_changes", "nodeId": str(node_id).strip(), "baseRevision": revision, "baseDigest": digest, "sequence": sequence}
    if operation_kind != "document_changes" or set(value) != {"operationKind", "nodeId"}:
        raise HTTPException(status_code=422, detail="document_write_context_invalid")
    node_id = value.get("nodeId")
    if not isinstance(node_id, str) or not node_id.strip():
        raise HTTPException(status_code=422, detail="document_write_context_invalid")
    node = _project_canvas_node(project, node_id.strip())
    if not isinstance(node, dict) or node.get("kind") != "document":
        raise HTTPException(status_code=422, detail="document_write_target_invalid")
    document = _normalize_persisted_document(node.get("document"))
    if document is None:
        raise HTTPException(status_code=409, detail="document_write_target_invalid")
    pending_leaves = {
        suggestion.get("blockId")
        for suggestion in document.get("suggestions", [])
        if isinstance(suggestion, dict)
    }
    blocks = []
    total_bytes = 0
    for block_id, text in _planning_document_leaf_texts(document["blocks"]):
        if block_id in pending_leaves:
            continue
        total_bytes += len(text.encode("utf-8"))
        if total_bytes > MAX_DOCUMENT_MODEL_TEXT_CHARS:
            raise HTTPException(status_code=413, detail="document_context_too_large")
        blocks.append({
            "blockId": block_id,
            "text": text,
            "expectedTextDigest": _text_digest(text),
        })
    if not blocks:
        raise HTTPException(status_code=409, detail="document_write_target_unavailable")
    return {
        "operationKind": "document_changes",
        "nodeId": node_id.strip(),
        "baseRevision": document["revision"],
        "baseDigest": document["digest"],
        "blocks": blocks,
    }


def _resolve_prompt_handoff_context(
    value: dict[str, Any],
    project: dict[str, Any],
) -> dict[str, Any]:
    if set(value) != {"operationKind", "basis"} or not isinstance(value.get("basis"), dict):
        raise HTTPException(status_code=422, detail="prompt_handoff_context_invalid")
    basis = value["basis"]
    kind = basis.get("kind")
    if kind == "document-selection":
        required = {
            "kind", "nodeId", "documentRevision", "documentDigest", "blockId",
            "utf8Start", "utf8End", "selectedText", "selectedTextDigest",
        }
        if set(basis) != required:
            raise HTTPException(status_code=422, detail="prompt_handoff_selection_invalid")
        node = _project_canvas_node(project, str(basis.get("nodeId") or "").strip())
        if not isinstance(node, dict) or node.get("kind") != "document":
            raise HTTPException(status_code=422, detail="prompt_handoff_source_invalid")
        document = _normalize_persisted_document(node.get("document"))
        if document is None:
            raise HTTPException(status_code=409, detail="prompt_handoff_source_invalid")
        if (
            basis.get("documentRevision") != document["revision"]
            or basis.get("documentDigest") != document["digest"]
        ):
            raise HTTPException(status_code=409, detail="prompt_handoff_source_stale")
        block_id = basis.get("blockId")
        leaf = next((text for identity, text in _planning_document_leaf_texts(document["blocks"]) if identity == block_id), None)
        if leaf is None:
            raise HTTPException(status_code=409, detail="prompt_handoff_selection_stale")
        if any(
            isinstance(item, dict) and item.get("blockId") == block_id
            for item in document.get("suggestions", [])
        ):
            raise HTTPException(status_code=409, detail="prompt_handoff_selection_pending")
        start = basis.get("utf8Start")
        end = basis.get("utf8End")
        if (
            not isinstance(start, int) or isinstance(start, bool)
            or not isinstance(end, int) or isinstance(end, bool)
            or start < 0 or end <= start or end - start > MAX_PROMPT_HANDOFF_BYTES
            or start not in _utf8_boundaries(leaf) or end not in _utf8_boundaries(leaf)
        ):
            raise HTTPException(status_code=422, detail="prompt_handoff_selection_invalid")
        selected_text = _utf8_text_slice(leaf, start, end)
        if (
            selected_text != basis.get("selectedText")
            or selected_text != unicodedata.normalize("NFC", selected_text)
            or basis.get("selectedTextDigest") != _text_digest(selected_text)
        ):
            raise HTTPException(status_code=409, detail="prompt_handoff_selection_stale")
        return {"operationKind": "prompt_handoff", "basis": {
            "kind": "document-selection", "nodeId": str(node["id"]),
            "documentRevision": document["revision"], "documentDigest": document["digest"],
            "blockId": str(block_id), "utf8Start": start, "utf8End": end,
            "selectedText": selected_text, "selectedTextDigest": _text_digest(selected_text),
        }}
    if kind == "storyboard-shot":
        required = {
            "kind", "nodeId", "storyboardRevision", "storyboardDigest", "rowId", "shotDigest",
        }
        if set(basis) != required:
            raise HTTPException(status_code=422, detail="prompt_handoff_shot_invalid")
        node = _project_canvas_node(project, str(basis.get("nodeId") or "").strip())
        if not isinstance(node, dict) or node.get("kind") != "storyboard":
            raise HTTPException(status_code=422, detail="prompt_handoff_source_invalid")
        sequence = _normalize_storyboard_sequence(node.get("sequence"), model_output=False)
        pending = _normalize_storyboard_pending_changes(node.get("pendingFieldChanges"), sequence)
        revision = node.get("revision", 0)
        digest = node.get("digest")
        if sequence is None or pending is None or pending:
            raise HTTPException(status_code=409, detail="prompt_handoff_shot_pending")
        if (
            not isinstance(revision, int) or isinstance(revision, bool)
            or digest != _storyboard_digest(sequence, pending)
            or basis.get("storyboardRevision") != revision
            or basis.get("storyboardDigest") != digest
        ):
            raise HTTPException(status_code=409, detail="prompt_handoff_source_stale")
        row = next((item for item in sequence["rows"] if item["id"] == basis.get("rowId")), None)
        if row is None:
            raise HTTPException(status_code=409, detail="prompt_handoff_shot_stale")
        shot_text = _canonical_nfc_json(row)
        shot_digest = _text_digest(shot_text)
        if basis.get("shotDigest") != shot_digest:
            raise HTTPException(status_code=409, detail="prompt_handoff_shot_stale")
        if len(shot_text.encode("utf-8")) > MAX_PROMPT_HANDOFF_BYTES:
            raise HTTPException(status_code=413, detail="prompt_handoff_shot_too_large")
        return {"operationKind": "prompt_handoff", "basis": {
            "kind": "storyboard-shot", "nodeId": str(node["id"]),
            "storyboardRevision": revision, "storyboardDigest": digest,
            "rowId": str(row["id"]), "shotDigest": shot_digest, "shotText": shot_text,
        }}
    raise HTTPException(status_code=422, detail="prompt_handoff_context_invalid")


def _planning_document_leaf_texts(
    blocks: list[dict[str, Any]],
) -> list[tuple[str, str]]:
    leaves: list[tuple[str, str]] = []
    for block in blocks:
        if block.get("type") in {"paragraph", "blockquote", "heading"}:
            leaves.append((block["id"], _rich_content_text(block["content"])))
        elif block.get("type") in {"bulletList", "orderedList", "checkList"}:
            leaves.extend(
                (item["id"], _rich_content_text(item["content"]))
                for item in block["items"]
            )
        elif block.get("type") == "table":
            for row in block["rows"]:
                leaves.extend(
                    (cell["id"], _rich_content_text(cell["content"]))
                    for cell in row["cells"]
                )
    return leaves


def _valid_planning_document_blocks(value: Any) -> bool:
    if not isinstance(value, list) or not 0 < len(value) <= 200:
        return False
    try:
        if len(_canonical_nfc_json(value).encode("utf-8")) > 1_000_000:
            return False
    except (TypeError, ValueError):
        return False
    ids: set[str] = set()

    def valid_id(item: Any) -> bool:
        if not isinstance(item, str):
            return False
        normalized = unicodedata.normalize("NFC", item)
        if not normalized or len(normalized) > 192 or normalized in ids:
            return False
        ids.add(normalized)
        return True

    def valid_inline(content: Any) -> bool:
        if not isinstance(content, list):
            return False
        previous: tuple[bool, bool, str] | None = None
        normalized_text_parts: list[str] = []
        for inline in content:
            if not isinstance(inline, dict):
                return False
            if not set(inline).issubset({"text", "bold", "italic", "href"}):
                return False
            text = inline.get("text")
            if not isinstance(text, str) or not unicodedata.normalize("NFC", text):
                return False
            normalized_text_parts.append(unicodedata.normalize("NFC", text))
            if inline.get("bold") not in {None, True} or inline.get("italic") not in {None, True}:
                return False
            href = inline.get("href", "")
            if not isinstance(href, str) or (href and not _safe_document_link(href)):
                return False
            signature = (
                inline.get("bold") is True,
                inline.get("italic") is True,
                unicodedata.normalize("NFC", href),
            )
            if signature == previous:
                return False
            previous = signature
        joined_text = "".join(normalized_text_parts)
        return joined_text == unicodedata.normalize("NFC", joined_text)

    for block in value:
        if not isinstance(block, dict) or not valid_id(block.get("id")):
            return False
        block_type = block.get("type")
        if block_type in {"paragraph", "blockquote"}:
            if set(block) != {"id", "type", "content"} or not valid_inline(block.get("content")):
                return False
        elif block_type == "heading":
            if set(block) != {"id", "type", "level", "content"} or block.get("level") not in {1, 2, 3} or not valid_inline(block.get("content")):
                return False
        elif block_type in {"bulletList", "orderedList", "checkList"}:
            items = block.get("items")
            if not isinstance(items, list) or not items:
                return False
            for item in items:
                required = {"id", "content", "checked"} if block_type == "checkList" else {"id", "content"}
                if not isinstance(item, dict) or set(item) != required or not valid_id(item.get("id")) or not valid_inline(item.get("content")):
                    return False
                if block_type == "checkList" and not isinstance(item.get("checked"), bool):
                    return False
        elif block_type == "table":
            rows = block.get("rows")
            if not isinstance(rows, list) or not rows:
                return False
            columns = None
            for row in rows:
                if not isinstance(row, dict):
                    return False
                cells = row.get("cells")
                if set(row) != {"id", "cells"} or not valid_id(row.get("id")) or not isinstance(cells, list) or not cells:
                    return False
                if columns is None:
                    columns = len(cells)
                if len(cells) != columns:
                    return False
                for cell in cells:
                    if not isinstance(cell, dict) or not set(cell).issubset({"id", "header", "content"}) or set(cell) - {"header"} != {"id", "content"}:
                        return False
                    if cell.get("header") not in {None, True} or not valid_id(cell.get("id")) or not valid_inline(cell.get("content")):
                        return False
        else:
            return False
    return True


def _valid_document_change_operations(value: Any) -> bool:
    if not isinstance(value, list) or not 0 < len(value) <= _DOCUMENT_EDIT_MAX_OPERATIONS:
        return False
    inserted_bytes = 0
    for operation in value:
        if not isinstance(operation, dict) or operation.get("kind") not in {"insert", "delete", "replace"}:
            return False
        kind = operation["kind"]
        required = {"kind", "blockId", "expectedTextDigest"}
        required |= {"utf8Offset", "text"} if kind == "insert" else {"utf8Start", "utf8End"}
        if kind == "replace":
            required.add("text")
        if set(operation) != required:
            return False
        if not isinstance(operation.get("blockId"), str) or not operation["blockId"]:
            return False
        if not _valid_sha256_digest(operation.get("expectedTextDigest")):
            return False
        for key in ("utf8Offset", "utf8Start", "utf8End"):
            if key in operation and (
                not isinstance(operation[key], int)
                or isinstance(operation[key], bool)
                or operation[key] < 0
                or operation[key] > 9_007_199_254_740_991
            ):
                return False
        if "utf8Start" in operation and operation["utf8End"] < operation["utf8Start"]:
            return False
        if "text" in operation and (
            not isinstance(operation["text"], str)
            or not unicodedata.normalize("NFC", operation["text"])
            or len(unicodedata.normalize("NFC", operation["text"]).encode("utf-8")) > _DOCUMENT_EDIT_MAX_TEXT_BYTES
        ):
            return False
        if "text" in operation:
            inserted_bytes += len(
                unicodedata.normalize("NFC", operation["text"]).encode("utf-8")
            )
    if inserted_bytes > _DOCUMENT_EDIT_MAX_TEXT_BYTES:
        return False
    return True


def _safe_document_link(value: str) -> bool:
    parsed = urlparse(value)
    if parsed.scheme == "mailto":
        return bool(parsed.path)
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def _apply_document_change_operations(
    document: dict[str, Any],
    edit_id: str,
    operations: list[dict[str, Any]],
) -> dict[str, Any] | None:
    try:
        blocks = deepcopy(document["blocks"])
        existing_suggestions = deepcopy(document.get("suggestions", []))
        pending_leaves = {
            suggestion.get("blockId")
            for suggestion in existing_suggestions
            if isinstance(suggestion, dict)
        }
        prepared: list[dict[str, Any]] = []
        for index, operation in enumerate(operations):
            block_id = unicodedata.normalize("NFC", operation["blockId"])
            if block_id in pending_leaves:
                return None
            content = _find_document_leaf_content(blocks, block_id)
            if content is None:
                return None
            leaf_text = _rich_content_text(content)
            if operation["expectedTextDigest"] != _text_digest(leaf_text):
                return None
            start = operation.get("utf8Offset", operation.get("utf8Start"))
            end = start if operation["kind"] == "insert" else operation["utf8End"]
            boundaries = _utf8_boundaries(leaf_text)
            if start not in boundaries or end not in boundaries or end < start:
                return None
            if operation["kind"] != "insert" and end == start:
                return None
            inserted_text = "" if operation["kind"] == "delete" else unicodedata.normalize("NFC", operation["text"])
            if inserted_text and ("\n" in inserted_text or "\r" in inserted_text):
                return None
            marks = _marks_strictly_inside(content, start) if operation["kind"] == "insert" else {}
            inserted = [{"text": inserted_text, **marks}] if inserted_text else []
            prepared.append({
                "index": index,
                "operation": operation,
                "blockId": block_id,
                "start": start,
                "end": end,
                "inserted": inserted,
                "deleted": _slice_rich_range(content, start, end),
            })
        if _document_operations_overlap(prepared):
            return None
        for operation in sorted(
            prepared,
            key=lambda item: (item["blockId"], -item["start"]),
        ):
            if not _replace_document_leaf_content(
                blocks,
                operation["blockId"],
                lambda content, item=operation: _replace_rich_range(
                    content,
                    item["start"],
                    item["end"],
                    item["inserted"],
                ),
            ):
                return None
        suggestions: list[dict[str, Any]] = []
        for operation in prepared:
            final_start = operation["start"] + sum(
                _rich_byte_length(candidate["inserted"])
                - (candidate["end"] - candidate["start"])
                for candidate in prepared
                if candidate["blockId"] == operation["blockId"]
                and candidate["start"] < operation["start"]
            )
            group_id = "docsg-" + hashlib.sha256(
                _canonical_nfc_json([
                    "document-suggestion-group-v1",
                    edit_id,
                    operation["index"],
                ]).encode("utf-8")
            ).hexdigest()
            base = {
                "groupId": group_id,
                "editId": edit_id,
                "blockId": operation["blockId"],
                "utf8Start": final_start,
            }
            if operation["operation"]["kind"] in {"delete", "replace"}:
                suggestions.append({
                    **base,
                    "id": _document_suggestion_id(edit_id, operation["index"], "delete"),
                    "kind": "delete",
                    "utf8End": final_start,
                    "content": deepcopy(operation["deleted"]),
                })
            if operation["operation"]["kind"] in {"insert", "replace"}:
                suggestions.append({
                    **base,
                    "id": _document_suggestion_id(edit_id, operation["index"], "insert"),
                    "kind": "insert",
                    "utf8End": final_start + _rich_byte_length(operation["inserted"]),
                    "content": deepcopy(operation["inserted"]),
                })
        result = {
            "version": 1,
            "blocks": blocks,
            "revision": int(document["revision"]) + 1,
            "suggestions": [*existing_suggestions, *suggestions],
        }
        result["digest"] = _planning_document_digest(
            result["blocks"],
            result["suggestions"],
        )
        return result
    except (KeyError, TypeError, ValueError):
        return None


def _document_suggestion_id(edit_id: str, index: int, kind: str) -> str:
    return "docs-" + hashlib.sha256(
        _canonical_nfc_json([
            "document-suggestion-v1",
            edit_id,
            index,
            kind,
        ]).encode("utf-8")
    ).hexdigest()


def _find_document_leaf_content(
    blocks: list[dict[str, Any]],
    leaf_id: str,
) -> list[dict[str, Any]] | None:
    for block in blocks:
        if block.get("type") in {"paragraph", "blockquote", "heading"} and block.get("id") == leaf_id:
            return block.get("content")
        if block.get("type") in {"bulletList", "orderedList", "checkList"}:
            found = next((item for item in block.get("items", []) if item.get("id") == leaf_id), None)
            if found is not None:
                return found.get("content")
        if block.get("type") == "table":
            for row in block.get("rows", []):
                found = next((cell for cell in row.get("cells", []) if cell.get("id") == leaf_id), None)
                if found is not None:
                    return found.get("content")
    return None


def _replace_document_leaf_content(
    blocks: list[dict[str, Any]],
    leaf_id: str,
    update: Any,
) -> bool:
    content = _find_document_leaf_content(blocks, leaf_id)
    if content is None:
        return False
    replacement = update(content)
    content[:] = replacement
    return True


def _split_rich_content(
    content: list[dict[str, Any]],
    offset: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    before: list[dict[str, Any]] = []
    after: list[dict[str, Any]] = []
    cursor = 0
    for inline in content:
        text = inline["text"]
        length = len(text.encode("utf-8"))
        if offset <= cursor:
            after.append(deepcopy(inline))
        elif offset >= cursor + length:
            before.append(deepcopy(inline))
        else:
            local = offset - cursor
            split_index = _utf8_offset_to_index(text, local)
            before.append({**inline, "text": text[:split_index]})
            after.append({**inline, "text": text[split_index:]})
        cursor += length
    if offset > cursor:
        raise ValueError("document_change_utf8_boundary_invalid")
    return _canonicalize_rich_content(before), _canonicalize_rich_content(after)


def _replace_rich_range(
    content: list[dict[str, Any]],
    start: int,
    end: int,
    inserted: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    before_end, after = _split_rich_content(content, end)
    before, _ = _split_rich_content(before_end, start)
    return _canonicalize_rich_content([*before, *deepcopy(inserted), *after])


def _slice_rich_range(
    content: list[dict[str, Any]],
    start: int,
    end: int,
) -> list[dict[str, Any]]:
    if start == end:
        return []
    before_end, _ = _split_rich_content(content, end)
    _, selected = _split_rich_content(before_end, start)
    return _canonicalize_rich_content(selected)


def _canonicalize_rich_content(content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for candidate in content:
        text = unicodedata.normalize("NFC", candidate.get("text", ""))
        if not text:
            continue
        inline = {"text": text}
        if candidate.get("bold") is True:
            inline["bold"] = True
        if candidate.get("italic") is True:
            inline["italic"] = True
        if candidate.get("href"):
            inline["href"] = candidate["href"]
        signature = (inline.get("bold"), inline.get("italic"), inline.get("href"))
        previous = result[-1] if result else None
        if previous is not None and (
            previous.get("bold"),
            previous.get("italic"),
            previous.get("href"),
        ) == signature:
            previous["text"] += text
        else:
            result.append(inline)
    return result


def _marks_strictly_inside(content: list[dict[str, Any]], offset: int) -> dict[str, Any]:
    cursor = 0
    for inline in content:
        end = cursor + len(inline["text"].encode("utf-8"))
        if cursor < offset < end:
            return {
                key: inline[key]
                for key in ("bold", "italic", "href")
                if inline.get(key)
            }
        cursor = end
    return {}


def _rich_content_text(content: list[dict[str, Any]]) -> str:
    return unicodedata.normalize("NFC", "".join(inline["text"] for inline in content))


def _rich_byte_length(content: list[dict[str, Any]]) -> int:
    return len(_rich_content_text(content).encode("utf-8"))


def _utf8_boundaries(value: str) -> set[int]:
    boundaries = {0}
    total = 0
    for character in value:
        total += len(character.encode("utf-8"))
        boundaries.add(total)
    return boundaries


def _utf8_offset_to_index(value: str, offset: int) -> int:
    total = 0
    for index, character in enumerate(value):
        if total == offset:
            return index
        total += len(character.encode("utf-8"))
    if total == offset:
        return len(value)
    raise ValueError("document_change_utf8_boundary_invalid")


def _document_operations_overlap(operations: list[dict[str, Any]]) -> bool:
    for index, left in enumerate(operations):
        for right in operations[index + 1:]:
            if left["blockId"] != right["blockId"]:
                continue
            overlap = left["start"] == right["start"] or max(left["start"], right["start"]) < min(left["end"], right["end"])
            left_point_inside = left["start"] == left["end"] and right["start"] < left["start"] < right["end"]
            right_point_inside = right["start"] == right["end"] and left["start"] < right["start"] < left["end"]
            if overlap or left_point_inside or right_point_inside:
                return True
    return False


def _normalize_nfc_json_value(value: Any) -> Any:
    return json.loads(_canonical_nfc_json(value))


def _valid_sha256_digest(value: Any) -> bool:
    if not isinstance(value, str) or len(value) != 71 or not value.startswith("sha256:"):
        return False
    return all(character in "0123456789abcdef" for character in value[7:])


def _planning_document_digest(blocks: list[dict[str, Any]], suggestions: list[Any]) -> str:
    canonical = _canonical_nfc_json({
        "version": 1,
        "blocks": blocks,
        "suggestions": suggestions,
    })
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _project_canvas_node(project: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    canvas = project.get("freeCanvas")
    nodes = canvas.get("nodes") if isinstance(canvas, dict) else None
    if not isinstance(nodes, list):
        return None
    return next(
        (
            node for node in nodes
            if isinstance(node, dict) and node.get("id") == node_id
        ),
        None,
    )


def _turn_document_edit(turn: dict[str, Any], edit_id: str) -> dict[str, Any] | None:
    messages = turn.get("messages")
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        edits = message.get("canvasEdits")
        if not isinstance(edits, list):
            continue
        found = next(
            (
                edit for edit in edits
                if isinstance(edit, dict)
                and edit.get("editId") == edit_id
                and edit.get("kind") in _DOCUMENT_EDIT_KINDS
            ),
            None,
        )
        if found is not None:
            return found
    return None


def _persisted_document_digest(value: Any) -> str | None:
    document = _normalize_persisted_document(value)
    return document["digest"] if document is not None else None


def _persisted_storyboard_state(node: Any) -> dict[str, Any] | None:
    if not isinstance(node, dict):
        return None
    sequence = _normalize_storyboard_sequence(node.get("sequence"), model_output=False)
    pending = _normalize_storyboard_pending_changes(node.get("pendingFieldChanges"), sequence)
    revision = node.get("revision")
    digest = node.get("digest")
    if (
        sequence is None
        or pending is None
        or not isinstance(revision, int)
        or isinstance(revision, bool)
        or not 0 <= revision <= 9_007_199_254_740_991
        or not _valid_sha256_digest(digest)
        or digest != _storyboard_digest(sequence, pending)
    ):
        return None
    return {"sequence": sequence, "pendingFieldChanges": pending, "revision": revision, "digest": digest}


def _normalize_persisted_document(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if (
        set(value) != {"version", "blocks", "revision", "digest", "suggestions"}
        or value.get("version") != 1
        or not isinstance(value.get("revision"), int)
        or isinstance(value.get("revision"), bool)
        or value["revision"] < 0
        or not _valid_sha256_digest(value.get("digest"))
    ):
        return None
    try:
        blocks = _normalize_nfc_json_value(value.get("blocks"))
    except (TypeError, ValueError):
        return None
    if not _valid_planning_document_blocks(blocks):
        return None
    suggestions = _normalize_persisted_document_suggestions(
        value.get("suggestions"),
        blocks,
    )
    if suggestions is None:
        return None
    computed = _planning_document_digest(blocks, suggestions)
    if value.get("digest") != computed:
        return None
    return {
        "version": 1,
        "blocks": blocks,
        "revision": value["revision"],
        "digest": computed,
        "suggestions": suggestions,
    }


def _normalize_persisted_document_suggestions(
    value: Any,
    blocks: list[dict[str, Any]],
) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    normalized: list[dict[str, Any]] = []
    suggestion_ids: set[str] = set()
    group_kinds: dict[str, set[str]] = {}
    exact_keys = {
        "id",
        "groupId",
        "editId",
        "kind",
        "blockId",
        "utf8Start",
        "utf8End",
        "content",
    }
    for item in value:
        if not isinstance(item, dict) or set(item) != exact_keys:
            return None
        strings: dict[str, str] = {}
        for key in ("id", "groupId", "editId", "blockId"):
            raw = item.get(key)
            if not isinstance(raw, str):
                return None
            normalized_string = unicodedata.normalize("NFC", raw)
            if not normalized_string:
                return None
            strings[key] = normalized_string
        if strings["id"] in suggestion_ids:
            return None
        suggestion_ids.add(strings["id"])
        kind = item.get("kind")
        if kind not in {"insert", "delete"}:
            return None
        start = item.get("utf8Start")
        end = item.get("utf8End")
        if (
            not isinstance(start, int)
            or isinstance(start, bool)
            or not isinstance(end, int)
            or isinstance(end, bool)
            or start < 0
            or end < start
            or end > 9_007_199_254_740_991
        ):
            return None
        try:
            content = _normalize_nfc_json_value(item.get("content"))
        except (TypeError, ValueError):
            return None
        if (
            not isinstance(content, list)
            or not content
            or not _valid_planning_document_blocks([{
                "id": "__suggestion_content__",
                "type": "paragraph",
                "content": content,
            }])
        ):
            return None
        leaf_content = _find_document_leaf_content(blocks, strings["blockId"])
        if leaf_content is None:
            return None
        leaf_text = _rich_content_text(leaf_content)
        boundaries = _utf8_boundaries(leaf_text)
        if start not in boundaries or end not in boundaries:
            return None
        content_text = _rich_content_text(content)
        content_bytes = len(content_text.encode("utf-8"))
        if kind == "insert":
            if end - start != content_bytes or _utf8_text_slice(leaf_text, start, end) != content_text:
                return None
        elif start != end:
            return None
        kinds = group_kinds.setdefault(strings["groupId"], set())
        if kind in kinds:
            return None
        kinds.add(kind)
        normalized.append({
            "id": strings["id"],
            "groupId": strings["groupId"],
            "editId": strings["editId"],
            "kind": kind,
            "blockId": strings["blockId"],
            "utf8Start": start,
            "utf8End": end,
            "content": content,
        })
    for suggestion in normalized:
        group = [
            item for item in normalized
            if item["groupId"] == suggestion["groupId"]
        ]
        if (
            len(group) > 2
            or any(
                item["editId"] != suggestion["editId"]
                or item["blockId"] != suggestion["blockId"]
                for item in group
            )
            or (
                len(group) == 2
                and (
                    group[0]["utf8Start"] != group[1]["utf8Start"]
                    or group[0]["utf8End"] != group[1]["utf8Start"]
                )
            )
        ):
            return None
    return normalized


def _utf8_text_slice(value: str, start: int, end: int) -> str:
    start_index = _utf8_offset_to_index(value, start)
    end_index = _utf8_offset_to_index(value, end)
    return value[start_index:end_index]


async def _terminal_agent_edit(
    conversation_id: str,
    request_id: str,
    edit_id: str,
    status: str,
    evidence: dict[str, Any],
    *,
    include_canvas_edits: bool = False,
) -> dict[str, Any]:
    ledger = await _storage_request(
        "PATCH",
        (
            f"/api/agent-conversations/{quote(conversation_id, safe='')}"
            f"/turns/{quote(request_id, safe='')}/apply-edit"
        ),
        json={"editId": edit_id, "status": status, "evidence": evidence},
    )
    return {
        **ledger,
        **({"canvasEdits": []} if include_canvas_edits else {}),
    }


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
            response = await client.request(
                method,
                f"{base_url}{path}",
                params=params,
                json=json,
                headers=create_internal_auth_headers(),
            )
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="storage_unavailable") from None
    if response.status_code == 404:
        raise HTTPException(status_code=404, detail="agent_storage_item_not_found")
    if response.status_code >= 400:
        if response.status_code == 409:
            try:
                detail = response.json().get("detail", {})
                code = detail.get("code") if isinstance(detail, dict) else None
            except ValueError:
                code = None
            if code in {
                "agent_apply_edit_pending",
                "agent_apply_edit_identity_mismatch",
                "agent_apply_edit_terminal",
            }:
                raise HTTPException(status_code=409, detail=code)
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
