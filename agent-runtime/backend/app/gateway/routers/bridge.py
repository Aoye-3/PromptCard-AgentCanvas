from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.gateway.bridge import (
    asset_read,
    asset_stage,
    delivery_commit,
    delivery_preview,
    delivery_status,
    prompt_search,
    reference_resolve,
    runtime_description,
    skill_read,
    workspace_description,
)
from app.gateway.bridge_auth import BridgePrincipal, require_bridge_principal

router = APIRouter(prefix="/api/promptcard/bridge/v3", tags=["promptcard-bridge"])
Principal = Annotated[BridgePrincipal, Depends(require_bridge_principal)]


class PromptSearchPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cvcCode: str
    query: str = Field(min_length=1, max_length=256)
    types: list[str] = Field(default_factory=list, max_length=16)
    categories: list[str] = Field(default_factory=list, max_length=16)
    limit: int = Field(default=8, ge=1, le=20)


class SkillPinPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skillCode: str
    revision: int = Field(ge=1)
    digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class DeliveryTargetPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cvcCode: str


class PromptCreatePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=500)
    userText: str = Field(min_length=1, max_length=100_000)


class PromptDeliveryPreviewPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientRequestId: str = Field(min_length=1, max_length=128)
    normalizedRequestDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    kind: Literal["prompt.create"]
    target: DeliveryTargetPayload
    sourceCodes: list[str] = Field(max_length=32)
    skillPins: list[SkillPinPayload] = Field(max_length=8)
    rationale: str = Field(min_length=1, max_length=4000)
    provenance: Literal["promptcard-bridge"]
    payload: PromptCreatePayload


class DocumentInlinePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(max_length=10_000)
    bold: Literal[True] | None = None
    italic: Literal[True] | None = None
    href: str | None = Field(default=None, min_length=1, max_length=2048)


class SimpleDocumentBlockPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    type: Literal["paragraph", "blockquote", "heading"]
    level: int | None = Field(default=None, ge=1, le=3)
    content: list[DocumentInlinePayload] = Field(max_length=200)

    @model_validator(mode="after")
    def validate_heading_level(self):
        if (self.type == "heading") != (self.level is not None):
            raise ValueError("document heading level is invalid")
        return self


class DocumentCreateTargetPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cvcCode: str


class DocumentCreatePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=500)
    blocks: list[SimpleDocumentBlockPayload] = Field(min_length=1, max_length=500)


class DocumentCreateDeliveryPreviewPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientRequestId: str = Field(min_length=1, max_length=128)
    normalizedRequestDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    kind: Literal["document.create"]
    target: DocumentCreateTargetPayload
    sourceCodes: list[str] = Field(max_length=32)
    skillPins: list[SkillPinPayload] = Field(max_length=8)
    rationale: str = Field(min_length=1, max_length=4000)
    provenance: Literal["promptcard-bridge"]
    payload: DocumentCreatePayload


class DocumentChangeTargetPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cvcCode: str
    documentCode: str
    baseRevision: int = Field(ge=0)
    baseDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class DocumentInsertOperationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["insert"]
    blockId: str = Field(min_length=1, max_length=128)
    utf8Offset: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=10_000)
    expectedTextDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class DocumentDeleteOperationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["delete"]
    blockId: str = Field(min_length=1, max_length=128)
    utf8Start: int = Field(ge=0)
    utf8End: int = Field(ge=0)
    expectedTextDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    @model_validator(mode="after")
    def validate_range(self):
        if self.utf8End < self.utf8Start:
            raise ValueError("document change range is invalid")
        return self


class DocumentReplaceOperationPayload(DocumentDeleteOperationPayload):
    kind: Literal["replace"]
    text: str = Field(min_length=1, max_length=10_000)


DocumentOperationPayload = Annotated[
    DocumentInsertOperationPayload
    | DocumentDeleteOperationPayload
    | DocumentReplaceOperationPayload,
    Field(discriminator="kind"),
]


class DocumentChangePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operations: list[DocumentOperationPayload] = Field(min_length=1, max_length=32)


class DocumentChangeDeliveryPreviewPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientRequestId: str = Field(min_length=1, max_length=128)
    normalizedRequestDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    kind: Literal["document.change"]
    target: DocumentChangeTargetPayload
    sourceCodes: list[str] = Field(max_length=32)
    skillPins: list[SkillPinPayload] = Field(max_length=8)
    rationale: str = Field(min_length=1, max_length=4000)
    provenance: Literal["promptcard-bridge"]
    payload: DocumentChangePayload


class ImagePlacementTargetPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cvcCode: str
    storyboardCode: str | None = None
    baseRevision: int | None = Field(default=None, ge=0)
    baseDigest: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )
    shotOrdinal: int | None = Field(default=None, ge=0, le=199)

    @model_validator(mode="after")
    def validate_storyboard_target(self):
        values = (
            self.storyboardCode,
            self.baseRevision,
            self.baseDigest,
            self.shotOrdinal,
        )
        if any(value is not None for value in values) and not all(
            value is not None for value in values
        ):
            raise ValueError("storyboard target fields must be supplied together")
        return self


class ImagePlacementPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stagedAssetHandle: str = Field(pattern=r"^AST-[0-7][0-9A-HJKMNP-TV-Z]{25}$")
    altText: str = Field(default="", max_length=1000)


class ImageDeliveryPreviewPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientRequestId: str = Field(min_length=1, max_length=128)
    normalizedRequestDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    kind: Literal["image.place"]
    target: ImagePlacementTargetPayload
    sourceCodes: list[str] = Field(max_length=32)
    skillPins: list[SkillPinPayload] = Field(max_length=8)
    rationale: str = Field(min_length=1, max_length=4000)
    provenance: Literal["promptcard-bridge"]
    payload: ImagePlacementPayload


DeliveryPreviewPayload = Annotated[
    PromptDeliveryPreviewPayload
    | ImageDeliveryPreviewPayload
    | DocumentCreateDeliveryPreviewPayload
    | DocumentChangeDeliveryPreviewPayload,
    Field(discriminator="kind"),
]


class AssetStagePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientRequestId: str = Field(min_length=1, max_length=128)
    cvcCode: str
    workspaceRelativePath: str = Field(min_length=1, max_length=1024)
    contentDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    mediaType: Literal["image/png", "image/jpeg", "image/webp"]
    byteLength: int = Field(ge=1, le=30 * 1024 * 1024)


class DeliveryCommitPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clientRequestId: str = Field(min_length=1, max_length=128)
    normalizedRequestDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    proposalId: str = Field(pattern=r"^DVP-[0-7][0-9A-HJKMNP-TV-Z]{25}$")


@router.get("/runtime")
async def describe_runtime(request: Request, principal: Principal):
    _reject_extra_query(request, set())
    return runtime_description(principal)


@router.get("/workspace")
async def describe_workspace(
    request: Request,
    principal: Principal,
    project_code: str = Query(alias="projectCode"),
    cvc_code: str = Query(alias="cvcCode"),
):
    _reject_extra_query(request, {"projectCode", "cvcCode"})
    return await workspace_description(principal, project_code, cvc_code)


@router.get("/reference")
async def resolve_reference(
    request: Request,
    principal: Principal,
    cvc_code: str = Query(alias="cvcCode"),
    code: str = Query(),
):
    _reject_extra_query(request, {"cvcCode", "code"})
    return await reference_resolve(principal, cvc_code, code)


@router.get("/skill")
async def read_skill(
    request: Request,
    principal: Principal,
    skill_code: str = Query(alias="skillCode"),
    revision: int = Query(ge=1),
    digest: str = Query(min_length=71, max_length=71),
):
    _reject_extra_query(request, {"skillCode", "revision", "digest"})
    return await skill_read(principal, skill_code, revision, digest)


@router.post("/prompt-search")
async def search_prompt_library(
    request: Request,
    payload: PromptSearchPayload,
    principal: Principal,
):
    _reject_extra_query(request, set())
    return await prompt_search(
        principal,
        payload.cvcCode,
        payload.query,
        payload.types,
        payload.categories,
        payload.limit,
    )


@router.get("/asset")
async def read_asset(
    request: Request,
    principal: Principal,
    cvc_code: str = Query(alias="cvcCode"),
    code: str = Query(),
):
    _reject_extra_query(request, {"cvcCode", "code"})
    return await asset_read(principal, cvc_code, code)


@router.post("/delivery/preview")
async def preview_delivery(
    request: Request,
    payload: DeliveryPreviewPayload,
    principal: Principal,
):
    _reject_extra_query(request, set())
    return await delivery_preview(principal, payload.model_dump(exclude_none=True))


@router.post("/assets/stage")
async def stage_asset(
    request: Request,
    principal: Principal,
    metadata: Annotated[str, Form(min_length=2, max_length=8192)],
    file: Annotated[UploadFile, File()],
):
    _reject_extra_query(request, set())
    try:
        payload = AssetStagePayload.model_validate_json(metadata)
    except ValueError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "asset_stage_request_invalid"}
        ) from exc
    return await asset_stage(principal, payload.model_dump(), file)


@router.post("/delivery/commit")
async def commit_delivery(
    request: Request,
    payload: DeliveryCommitPayload,
    principal: Principal,
):
    _reject_extra_query(request, set())
    return await delivery_commit(principal, payload.model_dump())


@router.get("/delivery/status")
async def read_delivery_status(
    request: Request,
    principal: Principal,
    client_request_id: str = Query(alias="clientRequestId", min_length=1, max_length=128),
):
    _reject_extra_query(request, {"clientRequestId"})
    return await delivery_status(principal, client_request_id)


def _reject_extra_query(request: Request, allowed: set[str]) -> None:
    if set(request.query_params.keys()) != allowed:
        raise HTTPException(status_code=422, detail={"code": "query_fields_invalid"})
