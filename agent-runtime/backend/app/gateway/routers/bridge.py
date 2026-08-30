from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from app.gateway.bridge import (
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


def _reject_extra_query(request: Request, allowed: set[str]) -> None:
    if set(request.query_params.keys()) != allowed:
        raise HTTPException(status_code=422, detail={"code": "query_fields_invalid"})
