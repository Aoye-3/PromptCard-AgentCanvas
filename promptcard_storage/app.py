from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import quote, unquote

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from .assets import MAX_IMAGE_IMPORT_BYTES
from .document_resources import (
    DocumentTooLargeError,
    DocumentValidationError,
    document_size_limit,
)
from .reference_codes import ReferenceCodeError
from .remote_images import RemoteImage, RemoteImageError, fetch_remote_image
from .skill_importer import SkillPackageImportError, SkillPackageImportService
from .skill_hosts import CodexProjectionAdapter, SkillHostConflict, SkillHostService
from .store import (
    AgentApplyEditConflict,
    AssetInUse,
    AssetValidationError,
    DeletedAsset,
    DuplicateItem,
    FolderCycle,
    FolderNotEmpty,
    MissingItem,
    PromptReferenceError,
    RevisionConflict,
    SkillReviewConflict,
    SqliteStore,
)


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("PROMPTCARD_STORAGE_DATA_DIR", ROOT_DIR / "data"))
SEED_FILE = ROOT_DIR / "public" / "prompt-library-presets.json"
MAX_ASSET_UPLOAD_BYTES = 200 * 1024 * 1024
INTERNAL_AUTH_HEADER_NAME = "X-PromptCard-Internal-Token"


def load_seed_presets() -> list[dict[str, Any]]:
    if not SEED_FILE.exists():
        return []
    payload = json.loads(SEED_FILE.read_text(encoding="utf-8"))
    return list(payload.get("presets", []))


class RevisionPayload(BaseModel):
    revision: int


class UpdatePayload(RevisionPayload):
    updates: dict[str, Any] = Field(default_factory=dict)


class ReorderPayload(BaseModel):
    orderedIds: list[str]
    revisions: dict[str, int] = Field(default_factory=dict)


class TrashPayload(BaseModel):
    ids: list[str]
    deletedBy: str = "user"
    deleteReason: str | None = None


class IdsPayload(BaseModel):
    ids: list[str]


class MigrationPayload(BaseModel):
    migrationId: str = "browser-cache-v1"
    projects: list[dict[str, Any]] = Field(default_factory=list)
    workspace: dict[str, Any] | None = None
    presets: list[dict[str, Any]] = Field(default_factory=list)


class PresetBatchPayload(BaseModel):
    presets: list[dict[str, Any]] = Field(default_factory=list)


class PromptRetrievalPayload(BaseModel):
    query: str = Field(min_length=1, max_length=256)
    types: list[str] = Field(default_factory=list, max_length=16)
    categories: list[str] = Field(default_factory=list, max_length=16)
    limit: int = Field(default=8, ge=1, le=20)
    callerKind: Literal["bridge", "local-agent", "maintenance"]
    callerId: str = Field(min_length=1, max_length=128)


class RecentCaptureRegistrationPayload(BaseModel):
    intent: Literal["initial", "analysis-derived"] = "initial"
    mode: str
    captures: list[dict[str, Any]] = Field(default_factory=list)
    prompt: dict[str, Any] | None = None


class AgentConversationProjectPayload(BaseModel):
    projectId: str


class AgentConversationRenamePayload(AgentConversationProjectPayload):
    title: str


class AgentConversationTurnPayload(AgentConversationProjectPayload):
    requestId: str
    userMessage: dict[str, Any]
    assistantMessage: dict[str, Any]
    proposals: list[dict[str, Any]] = Field(default_factory=list)
    skillSnapshots: list[dict[str, Any]] = Field(default_factory=list)
    modelSnapshot: dict[str, Any] | None = None
    applyEdit: dict[str, Any] | None = None


class AgentApplyEditPayload(BaseModel):
    editId: str
    status: Literal[
        "applied",
        "failed_conflict",
        "failed_integrity",
        "failed_target_missing",
    ]
    evidence: dict[str, Any] = Field(default_factory=dict)


class AgentConversationModelBindingPayload(BaseModel):
    modelBinding: dict[str, Any] | None = None


class AgentConversationInteractionPayload(BaseModel):
    interactionMode: Literal["prompt-edit", "chat-experimental"]
    boundSkillIds: list[str] = Field(default_factory=list, max_length=8)
    expectedRevision: int = Field(ge=1)


class AgentProposalStatusPayload(AgentConversationProjectPayload):
    status: str


class RemoteImagePayload(BaseModel):
    url: str


class SkillHostPinPayload(BaseModel):
    enabled: bool
    revision: int = Field(ge=1)
    repositoryScope: str | None = None
    publicationName: str | None = None


class SkillRevisionReviewPayload(BaseModel):
    expectedDigest: str
    decision: Literal["trusted", "untrusted"]


class CodexProjectionRepairPayload(BaseModel):
    repositoryScope: str
    expectedRevision: int = Field(ge=1)
    expectedDigest: str


class ProviderFileCleanupPayload(BaseModel):
    providerId: str
    connectionId: str
    remoteFileId: str


class ProviderFileCleanupSucceededPayload(BaseModel):
    cleanupId: str


class ProviderFileCleanupRetryPayload(BaseModel):
    cleanupId: str
    nextAttemptAt: int = Field(ge=0)
    errorCode: str


def create_app(
    storage: SqliteStore,
    remote_image_fetcher: Callable[[str], RemoteImage] = fetch_remote_image,
    skill_import_service: SkillPackageImportService | None = None,
    skill_host_service: SkillHostService | None = None,
) -> FastAPI:
    application = FastAPI(title="PromptCard Storage", version="1.0.0")
    skill_imports = skill_import_service or SkillPackageImportService(storage)
    skill_hosts = skill_host_service or SkillHostService(
        storage,
        CodexProjectionAdapter({
            os.environ.get("PROMPTCARD_REPOSITORY_SCOPE", "local-repository"): Path(
                os.environ.get("PROMPTCARD_REPOSITORY_ROOT", ROOT_DIR)
            )
        }),
    )

    @application.get("/health")
    def health() -> dict[str, Any]:
        return storage.health()

    @application.post("/api/assets")
    async def create_asset(request: Request) -> dict[str, Any]:
        try:
            chunks = bytearray()
            async for chunk in request.stream():
                chunks.extend(chunk)
                if len(chunks) > MAX_ASSET_UPLOAD_BYTES:
                    raise AssetValidationError("Asset must be between 1 byte and 200 MB")
            return storage.save_asset(
                unquote(request.headers.get("x-file-name", "image")),
                request.headers.get("content-type", ""),
                bytes(chunks),
            )
        except AssetValidationError as exc:
            raise _http_error(400, "invalid_asset", str(exc)) from exc

    @application.get("/api/assets/diagnostics")
    def diagnose_assets() -> dict[str, Any]:
        return storage.diagnose_assets()

    @application.get("/api/assets/{asset_id}")
    def get_asset(asset_id: str):
        try:
            path, content_type = storage.get_asset(asset_id)
            return FileResponse(path, media_type=content_type)
        except DeletedAsset as exc:
            raise _http_error(410, "asset_deleted", "Asset was permanently deleted") from exc
        except MissingItem as exc:
            raise _http_error(404, "not_found", "Asset not found") from exc

    @application.post("/api/remote-images/fetch")
    def fetch_browser_image(payload: RemoteImagePayload) -> Response:
        try:
            image = remote_image_fetcher(payload.url)
            return Response(
                content=image.content,
                media_type=image.content_type,
                headers={"X-File-Name": image.filename},
            )
        except RemoteImageError as exc:
            raise _http_error(400, "remote_image_rejected", str(exc)) from exc

    @application.get("/api/storage/summary")
    def get_storage_summary() -> dict[str, Any]:
        return storage.get_storage_summary()

    @application.get("/api/storage/artifacts")
    def list_storage_artifacts(
        category: str | None = None,
        status: str = "active",
        mediaType: str | None = None,
        query: str | None = None,
        sort: str = "created-desc",
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.list_storage_artifacts(
            category=category,
            status=status,
            media_type=mediaType,
            query=query,
            sort=sort,
            cursor=cursor,
            limit=limit,
        ))

    @application.get("/api/storage/artifacts/{asset_id}/references")
    def get_storage_artifact_references(asset_id: str) -> dict[str, Any]:
        return _handle(lambda: {"references": storage.get_storage_artifact_references(asset_id)})

    @application.get("/api/storage/artifacts/{asset_id}/download")
    def download_storage_artifact(asset_id: str):
        try:
            path, content_type, filename = storage.get_asset_download(asset_id)
            return FileResponse(path, media_type=content_type, filename=filename)
        except DeletedAsset as exc:
            raise _http_error(410, "asset_deleted", "Asset was permanently deleted") from exc
        except MissingItem as exc:
            raise _http_error(404, "not_found", "Asset not found") from exc

    @application.post("/api/storage/artifacts/trash")
    def trash_storage_artifacts(payload: TrashPayload) -> dict[str, Any]:
        return _handle(lambda: {"artifacts": storage.trash_storage_artifacts(
            payload.ids, payload.deletedBy, payload.deleteReason
        )})

    @application.post("/api/storage/artifacts/restore")
    def restore_storage_artifacts(payload: IdsPayload) -> dict[str, Any]:
        return _handle(lambda: {"artifacts": storage.restore_storage_artifacts(payload.ids)})

    @application.post("/api/storage/artifacts/delete-forever")
    def delete_storage_artifacts_forever(payload: IdsPayload) -> dict[str, Any]:
        return _handle(lambda: _delete_storage_artifacts(storage, payload.ids))

    @application.post("/api/storage/reconcile-orphans")
    def reconcile_orphan_assets() -> dict[str, Any]:
        return _handle(lambda: {"artifacts": storage.reconcile_orphan_assets()})

    @application.post("/api/image-assets/import")
    async def import_image_asset(request: Request) -> dict[str, Any]:
        try:
            chunks = bytearray()
            async for chunk in request.stream():
                chunks.extend(chunk)
                if len(chunks) > MAX_IMAGE_IMPORT_BYTES:
                    raise AssetValidationError("Image asset must be between 1 byte and 30 MB")
            return storage.import_image_asset(
                unquote(request.headers.get("x-file-name", "image")),
                request.headers.get("content-type", ""),
                bytes(chunks),
            )
        except AssetValidationError as exc:
            raise _http_error(400, "invalid_asset", str(exc)) from exc

    @application.post("/api/image-assets/derivations")
    def create_image_asset_derivation(item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.create_image_asset_derivation(item))

    @application.get("/api/image-assets/derivations/{source_asset_id}")
    def list_image_asset_derivations(source_asset_id: str) -> dict[str, Any]:
        return {"derivations": storage.list_image_asset_derivations(source_asset_id)}

    @application.post("/api/image-generation-runs")
    def create_image_generation_run(item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.create_image_generation_run(item))

    @application.post("/api/image-generation-runs/batch")
    def create_image_generation_runs_batch(item: dict[str, Any]) -> dict[str, Any]:
        runs = item.get("runs") if isinstance(item, dict) else None
        return _handle(lambda: {"runs": storage.create_image_generation_runs(runs)})

    @application.get("/api/image-generation-runs")
    def list_image_generation_runs(
        projectId: str,
        nodeId: str | None = None,
        conversationId: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.list_image_generation_runs(
            project_id=projectId, node_id=nodeId, conversation_id=conversationId,
            cursor=cursor, limit=limit
        ))

    @application.patch("/api/image-generation-runs/{run_id}/state")
    def update_image_generation_run_state(run_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.update_image_generation_run_state(run_id, patch))

    @application.get("/api/image-generation-runs/{run_id}")
    def get_image_generation_run(run_id: str, projectId: str) -> dict[str, Any]:
        return _handle(lambda: storage.get_image_generation_run(run_id, project_id=projectId))

    @application.get("/api/image-generation-conversations")
    def list_image_generation_conversations(
        projectId: str,
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.list_image_generation_conversations(
            project_id=projectId, cursor=cursor, limit=limit
        ))

    @application.get("/api/image-generation-conversations/{conversation_id}/runs")
    def list_image_generation_conversation_runs(
        conversation_id: str,
        projectId: str,
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.list_image_generation_conversation_runs(
            conversation_id, project_id=projectId, cursor=cursor, limit=limit
        ))

    @application.get("/api/image-generation-conversations/{conversation_id}")
    def get_image_generation_conversation(conversation_id: str, projectId: str) -> dict[str, Any]:
        return _handle(lambda: storage.get_image_generation_conversation(conversation_id, projectId))

    @application.post("/api/agent-conversations")
    def create_agent_conversation(item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.create_agent_conversation(item))

    @application.get("/api/agent-conversations")
    def list_agent_conversations(
        projectId: str,
        status: str = "active",
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.list_agent_conversations(projectId, status, cursor, limit))

    @application.get("/api/agent-conversations/{conversation_id}")
    def get_agent_conversation(
        conversation_id: str,
        projectId: str,
        includeTrash: bool = False,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.get_agent_conversation(conversation_id, projectId, includeTrash))

    @application.patch("/api/agent-conversations/{conversation_id}")
    def rename_agent_conversation(
        conversation_id: str,
        payload: AgentConversationRenamePayload,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.rename_agent_conversation(conversation_id, payload.projectId, payload.title))

    @application.patch("/api/projects/{project_id}/agent-conversations/{conversation_id}/model")
    def update_agent_conversation_model_binding(
        project_id: str,
        conversation_id: str,
        payload: AgentConversationModelBindingPayload,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.update_agent_conversation_model_binding(
            conversation_id, project_id, payload.modelBinding
        ))

    @application.patch("/api/projects/{project_id}/conversations/{conversation_id}/interaction")
    def update_agent_conversation_interaction(
        project_id: str,
        conversation_id: str,
        payload: AgentConversationInteractionPayload,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.update_agent_conversation_interaction(
            conversation_id,
            project_id,
            payload.interactionMode,
            payload.boundSkillIds,
            expected_revision=payload.expectedRevision,
        ))

    @application.post("/api/agent-conversations/{conversation_id}/turns")
    def append_agent_conversation_turn(
        conversation_id: str,
        payload: AgentConversationTurnPayload,
        request: Request,
    ) -> dict[str, Any]:
        _require_internal_auth(request)
        return _handle(lambda: storage.append_agent_conversation_turn(
            conversation_id, payload.projectId, payload.model_dump(exclude={"projectId"})
        ))

    @application.patch(
        "/api/agent-conversations/{conversation_id}/turns/{request_id}/apply-edit"
    )
    def update_agent_apply_edit(
        conversation_id: str,
        request_id: str,
        payload: AgentApplyEditPayload,
        request: Request,
    ) -> dict[str, Any]:
        _require_internal_auth(request)
        return _handle(
            lambda: storage.update_agent_apply_edit(
                conversation_id,
                request_id=request_id,
                edit_id=payload.editId,
                status=payload.status,
                evidence=payload.evidence,
            )
        )

    @application.patch("/api/agent-conversations/{conversation_id}/proposals/{proposal_id}")
    def update_agent_proposal_status(
        conversation_id: str,
        proposal_id: str,
        payload: AgentProposalStatusPayload,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.update_agent_proposal_status(
            conversation_id, payload.projectId, proposal_id, payload.status
        ))

    @application.post("/api/agent-conversations/{conversation_id}/trash")
    def trash_agent_conversation(
        conversation_id: str,
        payload: AgentConversationProjectPayload,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.trash_agent_conversation(conversation_id, payload.projectId))

    @application.post("/api/agent-conversations/{conversation_id}/restore")
    def restore_agent_conversation(
        conversation_id: str,
        payload: AgentConversationProjectPayload,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.restore_agent_conversation(conversation_id, payload.projectId))

    @application.delete("/api/agent-conversations/{conversation_id}")
    def delete_agent_conversation(
        conversation_id: str,
        payload: AgentConversationProjectPayload,
    ) -> dict[str, bool]:
        def delete() -> dict[str, bool]:
            storage.delete_agent_conversation_forever(conversation_id, payload.projectId)
            return {"ok": True}
        return _handle(delete)

    @application.get("/api/skills")
    def list_skills() -> dict[str, Any]:
        return storage.list_skills()

    @application.post("/api/skills")
    def create_skill(item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.create_skill(item))

    @application.get("/api/skills/{skill_id}")
    def get_skill(skill_id: str) -> dict[str, Any]:
        return _handle(lambda: storage.get_skill(skill_id))

    @application.post("/api/skills/{skill_id}/revisions")
    def add_skill_revision(skill_id: str, item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.add_skill_revision(skill_id, item))

    @application.post("/api/skills/{skill_id}/archive")
    def archive_skill(skill_id: str) -> dict[str, Any]:
        return _handle(lambda: storage.archive_skill(skill_id))

    @application.post("/api/skills/{skill_id}/restore")
    def restore_skill(skill_id: str) -> dict[str, Any]:
        return _handle(lambda: storage.restore_skill(skill_id))

    @application.post("/api/skills/{skill_id}/revisions/{revision}/review")
    def review_skill_revision(
        skill_id: str,
        revision: int,
        payload: SkillRevisionReviewPayload,
    ) -> dict[str, Any]:
        return _handle(lambda: storage.review_skill_revision(
            skill_id,
            revision,
            payload.expectedDigest,
            payload.decision,
        ))

    @application.get("/api/skill-hosts")
    def describe_skill_hosts() -> dict[str, Any]:
        return skill_hosts.describe_hosts()

    @application.put("/api/skills/{skill_id}/host-pins/{host}")
    def update_skill_host_pin(
        skill_id: str, host: str, payload: SkillHostPinPayload
    ) -> dict[str, Any]:
        return _handle(lambda: skill_hosts.update_pin(
            skill_id,
            host,
            payload.repositoryScope,
            payload.enabled,
            payload.revision,
            publication_name=payload.publicationName,
        ))

    @application.get("/api/skills/{skill_id}/host-pins/{host}")
    def get_skill_host_pin(
        skill_id: str,
        host: str,
        repositoryScope: str | None = None,
    ) -> dict[str, Any]:
        return _handle(lambda: skill_hosts.get_pin(skill_id, host, repositoryScope))

    @application.post("/api/skills/{skill_id}/host-pins/codex/repair")
    def repair_codex_projection(
        skill_id: str,
        payload: CodexProjectionRepairPayload,
    ) -> dict[str, Any]:
        return _handle(lambda: skill_hosts.repair_codex_projection(
            skill_id,
            payload.repositoryScope,
            payload.expectedRevision,
            payload.expectedDigest,
        ))

    @application.get("/api/skill-host-snapshots/local-agent")
    def get_local_agent_skill_snapshot(skillId: str) -> dict[str, Any]:
        return _handle(lambda: skill_hosts.local_agent_snapshot(skillId))

    @application.post("/api/skill-package-inspections/folder")
    async def inspect_skill_package_folder(request: Request) -> dict[str, Any]:
        item = await _bounded_skill_json(request, skill_imports.control_request_body_limit)
        return _handle(lambda: skill_imports.inspect_folder_request(item))

    @application.post("/api/skill-package-inspections/archive")
    async def inspect_skill_package_archive(request: Request) -> dict[str, Any]:
        item = await _bounded_skill_json(request, skill_imports.archive_request_body_limit)
        return _handle(lambda: skill_imports.inspect_archive_request(item))

    @application.post("/api/skill-package-imports")
    async def import_inspected_skill_package(request: Request) -> dict[str, Any]:
        item = await _bounded_skill_json(request, skill_imports.control_request_body_limit)
        return _handle(lambda: skill_imports.import_request(item))

    @application.get("/api/image-generation-placements")
    def list_image_generation_placements(projectId: str, state: str | None = None) -> dict[str, Any]:
        return _handle(lambda: storage.list_image_generation_placements(
            project_id=projectId, state=state
        ))

    @application.patch("/api/image-generation-placements/{run_id}")
    def update_image_generation_placement(run_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.update_image_generation_placement(run_id, patch))

    @application.get("/api/recent-captures")
    def list_recent_captures() -> dict[str, Any]:
        return {"captures": storage.list_recent_captures()}

    @application.get("/api/recent-captures/{item_id}")
    def get_recent_capture(item_id: str) -> dict[str, Any]:
        return _handle(lambda: storage.get_recent_capture(item_id))

    @application.post("/api/recent-captures")
    def create_recent_capture(item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.create_recent_capture(item))

    @application.post("/api/recent-captures/register-to-prompt-library")
    def register_recent_captures(payload: RecentCaptureRegistrationPayload) -> dict[str, Any]:
        return _handle(lambda: storage.register_recent_captures_to_prompt_library(payload.model_dump()))

    @application.put("/api/recent-captures/{item_id}")
    def update_recent_capture(item_id: str, payload: UpdatePayload) -> dict[str, Any]:
        return _handle(lambda: storage.update_recent_capture(item_id, payload.updates, payload.revision))

    @application.delete("/api/recent-captures/{item_id}")
    def delete_recent_capture(item_id: str, payload: RevisionPayload) -> dict[str, Any]:
        def delete() -> dict[str, bool]:
            storage.delete_recent_capture(item_id, payload.revision)
            return {"ok": True}

        return _handle(delete)

    @application.post("/api/context-packs")
    def create_context_pack(payload: Any = Body(None)) -> dict[str, Any]:
        return _handle(lambda: storage.create_context_pack(payload))

    @application.get("/api/context-packs")
    def list_context_packs(projectCode: str | None = None) -> dict[str, Any]:
        return _handle(lambda: {
            "contextPacks": storage.list_context_packs(projectCode)
        })

    @application.get("/api/context-packs/{cvc_code}/resolve")
    def resolve_context_pack(cvc_code: str) -> dict[str, Any]:
        return _handle(lambda: storage.resolve_context_pack(cvc_code))

    @application.get(
        "/api/internal/context-packs/{cvc_code}/assets/{reference_code}"
    )
    def read_context_asset(
        cvc_code: str,
        reference_code: str,
        request: Request,
    ) -> FileResponse:
        _require_internal_auth(request)
        path, metadata = _handle(
            lambda: storage.read_context_asset(cvc_code, reference_code)
        )
        return FileResponse(
            path,
            media_type=metadata["contentType"],
            headers={
                "X-File-Name": quote(metadata["filename"], safe=""),
                "X-PromptCard-Reference-Namespace": metadata["reference"]["namespace"],
                "X-PromptCard-Reference-Code": metadata["reference"]["code"],
                "X-PromptCard-Asset-Size": str(metadata["size"]),
            },
        )

    @application.get("/api/context-packs/{cvc_code}")
    def inspect_context_pack(cvc_code: str) -> dict[str, Any]:
        return _handle(lambda: storage.inspect_context_pack(cvc_code))

    @application.post("/api/context-packs/{cvc_code}/revoke")
    def revoke_context_pack(
        cvc_code: str, payload: Any = Body(None)
    ) -> dict[str, Any]:
        if not isinstance(payload, dict) or set(payload) != {"actor", "reason"}:
            raise _http_error(
                400, "invalid_payload", "Context pack revocation payload fields are invalid"
            )
        return _handle(lambda: storage.revoke_context_pack(
            cvc_code, payload.get("actor"), payload.get("reason")
        ))

    @application.get("/api/projects")
    def list_projects() -> dict[str, Any]:
        return {"projects": storage.list_projects()}

    @application.get("/api/projects/trash")
    def list_project_trash() -> dict[str, Any]:
        return {"items": storage.list_project_trash()}

    @application.get("/api/projects/{project_id}/resources")
    def list_project_resources(project_id: str) -> dict[str, Any]:
        return _handle(lambda: storage.list_project_resources(project_id))

    @application.post("/api/projects/{project_id}/resource-folders")
    def create_project_resource_folder(project_id: str, item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.create_project_resource_folder(project_id, item))

    @application.put("/api/projects/{project_id}/resource-folders/{folder_id}")
    def update_project_resource_folder(
        project_id: str,
        folder_id: str,
        payload: UpdatePayload,
    ) -> dict[str, Any]:
        return _handle(
            lambda: storage.update_project_resource_folder(
                project_id, folder_id, payload.updates, payload.revision
            )
        )

    @application.delete("/api/projects/{project_id}/resource-folders/{folder_id}")
    def delete_project_resource_folder(
        project_id: str,
        folder_id: str,
        payload: RevisionPayload,
    ) -> dict[str, Any]:
        def delete() -> dict[str, bool]:
            storage.delete_project_resource_folder(project_id, folder_id, payload.revision)
            return {"ok": True}

        return _handle(delete)

    @application.post("/api/projects/{project_id}/resources")
    def create_project_resource(project_id: str, item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.create_project_resource(project_id, item))

    @application.put("/api/projects/{project_id}/resources/{resource_id}")
    def update_project_resource(
        project_id: str,
        resource_id: str,
        payload: UpdatePayload,
    ) -> dict[str, Any]:
        return _handle(
            lambda: storage.update_project_resource(
                project_id, resource_id, payload.updates, payload.revision
            )
        )

    @application.delete("/api/projects/{project_id}/resources/{resource_id}")
    def delete_project_resource(
        project_id: str,
        resource_id: str,
        payload: RevisionPayload,
    ) -> dict[str, Any]:
        def delete() -> dict[str, bool]:
            storage.delete_project_resource(project_id, resource_id, payload.revision)
            return {"ok": True}

        return _handle(delete)

    @application.put("/api/projects/{project_id}/resource-layout")
    def update_project_resource_layout(project_id: str, layout: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.update_project_resource_layout(project_id, layout))

    @application.get("/api/projects/{item_id}")
    def get_project(item_id: str) -> dict[str, Any]:
        return _handle(lambda: storage.get_project(item_id))

    @application.post("/api/projects")
    def create_project(item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.create_project(item))

    @application.put("/api/projects/{item_id}")
    def update_project(item_id: str, payload: UpdatePayload) -> dict[str, Any]:
        return _handle(lambda: storage.update_project(item_id, payload.updates, payload.revision))

    @application.post("/api/projects/trash")
    def trash_projects(payload: TrashPayload) -> dict[str, Any]:
        return {"projects": storage.trash_projects(payload.ids, payload.deletedBy, payload.deleteReason)}

    @application.post("/api/projects/trash/restore")
    def restore_projects(payload: IdsPayload) -> dict[str, Any]:
        return {"projects": storage.restore_projects(payload.ids)}

    @application.delete("/api/projects/trash")
    def delete_project_trash(payload: IdsPayload) -> dict[str, Any]:
        storage.delete_project_trash(payload.ids)
        return {"ok": True}

    @application.get("/api/projects/references/{reference_code}")
    def resolve_project_reference(reference_code: str) -> dict[str, Any]:
        return _handle(lambda: storage.resolve_project_reference(reference_code))

    @application.get(
        "/api/projects/references/{project_reference_code}/nodes/{node_reference_code}"
    )
    def resolve_canvas_reference(
        project_reference_code: str,
        node_reference_code: str,
    ) -> dict[str, Any]:
        return _handle(
            lambda: storage.resolve_canvas_reference(
                project_reference_code, node_reference_code
            )
        )

    @application.get(
        "/api/projects/references/{project_reference_code}/creative/{creative_reference_code}"
    )
    def resolve_creative_reference(
        project_reference_code: str,
        creative_reference_code: str,
    ) -> dict[str, Any]:
        return _handle(
            lambda: storage.resolve_creative_reference(
                project_reference_code, creative_reference_code
            )
        )

    @application.get("/api/presets")
    def list_presets() -> dict[str, Any]:
        return {"presets": storage.list_presets()}

    @application.post("/api/prompt-retrieval/search")
    def search_prompts(payload: PromptRetrievalPayload) -> dict[str, Any]:
        return _handle(
            lambda: storage.search_prompts(
                payload.query,
                types=payload.types,
                categories=payload.categories,
                limit=payload.limit,
                caller_kind=payload.callerKind,
                caller_id=payload.callerId,
            )
        )

    @application.get("/api/prompt-retrieval/health")
    def prompt_retrieval_health() -> dict[str, Any]:
        return storage.prompt_retrieval_health()

    @application.post("/api/prompt-retrieval/rebuild")
    def rebuild_prompt_retrieval_index() -> dict[str, Any]:
        return _handle(storage.rebuild_prompt_retrieval)

    @application.get("/api/presets/trash")
    def list_preset_trash() -> dict[str, Any]:
        return {"items": storage.list_preset_trash()}

    @application.get("/api/presets/{item_id}")
    def get_preset(item_id: str) -> dict[str, Any]:
        return _handle(lambda: storage.get_preset(item_id))

    @application.post("/api/presets")
    def create_preset(item: dict[str, Any]) -> dict[str, Any]:
        return _handle(lambda: storage.create_preset(item))

    @application.put("/api/presets/batch")
    def replace_presets(payload: PresetBatchPayload) -> dict[str, Any]:
        return _handle(lambda: {"presets": storage.replace_presets(payload.presets)})

    @application.put("/api/presets/{item_id}")
    def update_preset(item_id: str, payload: UpdatePayload) -> dict[str, Any]:
        return _handle(lambda: storage.update_preset(item_id, payload.updates, payload.revision))

    @application.post("/api/presets/reorder")
    def reorder_presets(payload: ReorderPayload) -> dict[str, Any]:
        return _handle(lambda: {"presets": storage.reorder_presets(payload.orderedIds, payload.revisions)})

    @application.post("/api/presets/{item_id}/increment-usage")
    def increment_preset_usage(item_id: str, payload: RevisionPayload) -> dict[str, Any]:
        return _handle(lambda: storage.increment_preset_usage(item_id, payload.revision))

    @application.post("/api/presets/trash")
    def trash_presets(payload: TrashPayload) -> dict[str, Any]:
        return {"presets": storage.trash_presets(payload.ids, payload.deletedBy, payload.deleteReason)}

    @application.post("/api/presets/trash/restore")
    def restore_presets(payload: IdsPayload) -> dict[str, Any]:
        return {"presets": storage.restore_presets(payload.ids)}

    @application.delete("/api/presets/trash")
    def delete_preset_trash(payload: IdsPayload) -> dict[str, Any]:
        storage.delete_preset_trash(payload.ids)
        return {"ok": True}

    @application.post("/api/migrations/browser-cache")
    def migrate_browser_cache(payload: MigrationPayload) -> dict[str, Any]:
        return storage.migrate_browser_payload(payload.model_dump())

    @application.get("/api/prompt-library/references/{reference_code}")
    def resolve_prompt_reference(reference_code: str) -> dict[str, Any]:
        return _handle(lambda: storage.resolve_prompt_reference(reference_code))

    @application.post("/api/projects/{project_id}/document-resources")
    async def create_project_document_resource(
        project_id: str,
        request: Request,
    ) -> dict[str, Any]:
        filename = unquote(request.headers.get("x-file-name", ""))
        content_type = request.headers.get("content-type", "")
        try:
            limit = document_size_limit(filename, content_type)
            content_length = request.headers.get("content-length")
            if content_length is not None and int(content_length) > limit:
                raise DocumentTooLargeError("Document exceeds the format size limit")
            chunks: list[bytes] = []
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise DocumentTooLargeError("Document exceeds the format size limit")
                chunks.append(chunk)
            return storage.create_project_document_resource(
                project_id,
                filename,
                content_type,
                b"".join(chunks),
            )
        except DocumentTooLargeError as exc:
            raise _http_error(413, "document_too_large", str(exc)) from exc
        except (DocumentValidationError, ValueError) as exc:
            raise _http_error(400, "invalid_document", str(exc)) from exc

    @application.get("/api/projects/{project_id}/document-resources")
    def list_project_document_resources(project_id: str) -> dict[str, Any]:
        return _handle(
            lambda: {
                "resources": storage.list_project_document_resources(project_id)
            }
        )

    @application.get(
        "/api/projects/{project_id}/document-resources/{resource_id}"
    )
    def get_project_document_resource(
        project_id: str,
        resource_id: str,
    ) -> dict[str, Any]:
        return _handle(
            lambda: storage.get_project_document_resource(project_id, resource_id)
        )

    @application.delete(
        "/api/projects/{project_id}/document-resources/{resource_id}"
    )
    def trash_project_document_resource(
        project_id: str,
        resource_id: str,
    ) -> dict[str, Any]:
        return _handle(
            lambda: storage.trash_project_document_resource(project_id, resource_id)
        )

    @application.post(
        "/api/projects/{project_id}/document-resources/{resource_id}/restore"
    )
    def restore_project_document_resource(
        project_id: str,
        resource_id: str,
    ) -> dict[str, Any]:
        return _handle(
            lambda: storage.restore_project_document_resource(project_id, resource_id)
        )

    @application.get(
        "/api/internal/projects/{project_id}/document-resources/{resource_id}/content"
    )
    def read_project_document_resource(
        project_id: str,
        resource_id: str,
        request: Request,
    ) -> Response:
        _require_internal_auth(request)
        try:
            content, metadata = storage.read_project_document_resource(
                project_id, resource_id
            )
        except MissingItem as exc:
            raise _http_error(404, "not_found", "Storage item not found") from exc
        except DocumentValidationError as exc:
            raise _http_error(
                409, "document_integrity_failed", "Stored document failed validation"
            ) from exc
        return Response(
            content=content,
            media_type=metadata["contentType"],
            headers={
                "X-File-Name": quote(metadata["originalFilename"], safe=""),
                "X-Document-Resource-Id": metadata["id"],
            },
        )

    @application.post("/api/internal/provider-file-cleanup")
    def enqueue_provider_file_cleanup(
        payload: ProviderFileCleanupPayload,
        request: Request,
    ) -> dict[str, Any]:
        _require_internal_auth(request)
        return _handle(
            lambda: storage.enqueue_provider_file_cleanup(
                payload.providerId, payload.connectionId, payload.remoteFileId
            )
        )

    @application.get("/api/internal/provider-file-cleanup/due")
    def get_due_provider_file_cleanup(
        request: Request,
        now: int,
        limit: int = 20,
    ) -> dict[str, Any]:
        _require_internal_auth(request)
        return _handle(
            lambda: {
                "items": storage.get_due_provider_file_cleanup(now=now, limit=limit)
            }
        )

    @application.post("/api/internal/provider-file-cleanup/succeeded")
    def mark_provider_file_cleanup_succeeded(
        payload: ProviderFileCleanupSucceededPayload,
        request: Request,
    ) -> dict[str, bool]:
        _require_internal_auth(request)
        storage.mark_provider_file_cleanup_succeeded(payload.cleanupId)
        return {"ok": True}

    @application.post("/api/internal/provider-file-cleanup/retry")
    def mark_provider_file_cleanup_retry(
        payload: ProviderFileCleanupRetryPayload,
        request: Request,
    ) -> dict[str, bool]:
        _require_internal_auth(request)
        def mark_retry() -> dict[str, bool]:
            storage.mark_provider_file_cleanup_retry(
                payload.cleanupId, payload.nextAttemptAt, payload.errorCode
            )
            return {"ok": True}

        return _handle(mark_retry)

    return application


def _handle(callback: Callable[[], Any]) -> Any:
    try:
        return callback()
    except SkillPackageImportError as exc:
        raise _http_error(exc.status_code, exc.code, exc.message) from exc
    except SkillHostConflict as exc:
        raise _http_error(exc.status_code, exc.code, exc.message) from exc
    except SkillReviewConflict as exc:
        raise _http_error(409, exc.code, exc.message) from exc
    except PromptReferenceError as exc:
        raise _http_error(
            exc.status_code,
            exc.code,
            exc.message,
            {"reference": exc.reference},
        ) from exc
    except ReferenceCodeError as exc:
        raise _http_error(400, exc.code, "Invalid public reference code") from exc
    except MissingItem as exc:
        raise _http_error(404, "not_found", "Storage item not found") from exc
    except DuplicateItem as exc:
        raise _http_error(409, "duplicate_item", "Storage item already exists", {"id": str(exc)}) from exc
    except RevisionConflict as exc:
        raise _http_error(409, "revision_conflict", "Storage revision conflict", current=exc.current) from exc
    except AgentApplyEditConflict as exc:
        raise _http_error(409, exc.code, exc.message) from exc
    except FolderCycle as exc:
        raise _http_error(409, "folder_cycle", "A folder cannot be moved inside itself") from exc
    except FolderNotEmpty as exc:
        raise _http_error(409, "folder_not_empty", "The folder must be empty before deletion") from exc
    except AssetInUse as exc:
        raise _http_error(409, "asset_in_use", "Asset is still referenced", {"references": exc.references}) from exc
    except DeletedAsset as exc:
        raise _http_error(410, "asset_deleted", "Asset was permanently deleted") from exc
    except ValueError as exc:
        raise _http_error(400, "invalid_payload", str(exc)) from exc


async def _bounded_skill_json(request: Request, limit: int) -> Any:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > limit:
                raise _http_error(
                    413, "request_too_large", "Skill package request exceeds the safety limit"
                )
        except ValueError:
            raise _http_error(400, "invalid_inspection_request", "Skill package request is invalid")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise _http_error(
                413, "request_too_large", "Skill package request exceeds the safety limit"
            )
        chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise _http_error(400, "invalid_inspection_request", "Skill package request is invalid")


def _http_error(status: int, code: str, message: str, detail: Any = None, current: Any = None) -> HTTPException:
    payload: dict[str, Any] = {"code": code, "message": message}
    if detail is not None:
        payload["detail"] = detail
    if current is not None:
        payload["current"] = current
    return HTTPException(status_code=status, detail=payload)


def _require_internal_auth(request: Request) -> None:
    expected = os.environ.get("PROMPTCARD_INTERNAL_TOKEN", "").strip()
    supplied = request.headers.get(INTERNAL_AUTH_HEADER_NAME)
    if not expected:
        raise _http_error(
            503,
            "internal_auth_unavailable",
            "Storage internal authentication is unavailable",
        )
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise _http_error(401, "internal_auth_required", "Internal authentication is required")


def _delete_storage_artifacts(storage: SqliteStore, ids: list[str]) -> dict[str, bool]:
    storage.delete_storage_artifacts_forever(ids)
    return {"ok": True}


store = SqliteStore(DATA_DIR, presets_seed=load_seed_presets())
app = create_app(store)
