from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from app.gateway.bridge import (
    asset_read,
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


class DeliveryPreviewPayload(BaseModel):
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
    return await delivery_preview(principal, payload.model_dump())


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
