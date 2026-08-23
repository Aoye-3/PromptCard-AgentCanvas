from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.gateway.skill_snapshots import resolve_local_agent_skill_snapshot


@pytest.mark.anyio
async def test_resolver_requests_only_global_pinned_snapshot() -> None:
    calls = []

    async def storage_request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {
            "skillId": "host-skill", "skillReferenceCode": "SKL-00000000000000000000000001",
            "revision": 2, "digest": "sha256:" + "a" * 64, "instructions": "Pinned",
            "references": [{
                "path": "references/guide.md", "contentType": "text/markdown",
                "content": "Guide",
            }],
        }

    snapshot = await resolve_local_agent_skill_snapshot(
        storage_request, skill_id="SKL-00000000000000000000000001", allowed_tools=set()
    )

    assert calls == [("GET", "/api/skill-host-snapshots/local-agent", {
        "params": {"skillId": "SKL-00000000000000000000000001"},
    })]
    assert snapshot == {
        "skillId": "host-skill", "skillReferenceCode": "SKL-00000000000000000000000001",
        "revision": 2, "digest": "sha256:" + "a" * 64, "instructions": "Pinned",
        "references": [{
            "path": "references/guide.md", "contentType": "text/markdown",
            "content": "Guide",
        }],
    }


@pytest.mark.anyio
@pytest.mark.parametrize("unsafe", [
    {"tools": ["shell"]},
    {"declaredCapabilities": {"network": ["internet"]}},
    {"entries": [{"type": "script", "path": "run.py"}]},
])
async def test_resolver_fails_closed_if_storage_payload_claims_more_authority(unsafe) -> None:
    async def storage_request(method, path, **kwargs):
        return {
            "skillId": "host-skill", "skillReferenceCode": "SKL-00000000000000000000000001",
            "revision": 1, "digest": "sha256:" + "a" * 64, "instructions": "Pinned",
            "references": [], **unsafe,
        }

    with pytest.raises(HTTPException) as error:
        await resolve_local_agent_skill_snapshot(
            storage_request, skill_id="SKL-00000000000000000000000001", allowed_tools=set()
        )

    assert error.value.status_code == 403
    assert error.value.detail == "skill_snapshot_scope_escalation"


@pytest.mark.anyio
async def test_resolver_rejects_malformed_or_mismatched_exact_snapshot() -> None:
    async def storage_request(method, path, **kwargs):
        return {
            "skillId": "host-skill", "skillReferenceCode": "SKL-00000000000000000000000002",
            "revision": 0, "digest": "not-a-digest", "instructions": "Pinned",
            "references": [],
        }

    with pytest.raises(HTTPException) as error:
        await resolve_local_agent_skill_snapshot(
            storage_request, skill_id="SKL-00000000000000000000000001", allowed_tools=set()
        )

    assert error.value.status_code == 502
    assert error.value.detail == "skill_snapshot_invalid"


@pytest.mark.anyio
async def test_resolver_checks_exact_revision_tool_declarations_against_run_scope() -> None:
    async def storage_request(method, path, **kwargs):
        return {
            "skillId": "host-skill", "skillReferenceCode": "SKL-00000000000000000000000001",
            "revision": 2, "digest": "sha256:" + "a" * 64,
            "instructions": "Pinned", "references": [],
            "declaredCapabilities": {
                "tools": ["emit_canvas_prompt_edit"], "network": [],
                "executables": [], "models": [], "other": [],
            },
        }

    snapshot = await resolve_local_agent_skill_snapshot(
        storage_request,
        skill_id="SKL-00000000000000000000000001",
        allowed_tools={"emit_canvas_prompt_edit"},
    )
    assert snapshot["revision"] == 2
    assert "declaredCapabilities" not in snapshot

    with pytest.raises(HTTPException) as error:
        await resolve_local_agent_skill_snapshot(
            storage_request, skill_id="SKL-00000000000000000000000001", allowed_tools=set()
        )
    assert error.value.status_code == 403
    assert error.value.detail == "skill_tool_dependency_not_allowed"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "payload",
    [
        {"instructions": "界" * 210_000},
        {"instructions": "\ud800"},
        {"references": [{
            "path": "references/large.md", "contentType": "text/markdown",
            "content": "界" * 44_000,
        }]},
        {
            "instructions": "x" * 220_000,
            "references": [
                {
                    "path": f"references/{index}.md",
                    "contentType": "text/markdown",
                    "content": "y" * 105_000,
                }
                for index in range(3)
            ],
        },
        {"references": [
            {"path": f"references/{index}.md", "contentType": "text/markdown", "content": "x"}
            for index in range(65)
        ]},
        {"references": [{
            "path": "../escape.md", "contentType": "text/markdown", "content": "x",
        }]},
        {"references": [{
            "path": "references//guide.md", "contentType": "text/markdown", "content": "x",
        }]},
        {"references": [{
            "path": "references/guide.md", "contentType": "application/octet-stream", "content": "x",
        }]},
        {"references": [{
            "path": "references/guide.md", "contentType": ["text/markdown"], "content": "x",
        }]},
        {"declaredCapabilities": {"tools": [f"tool-{index}" for index in range(65)]}},
        {"declaredCapabilities": {
            "network": [f"network-{index}" for index in range(33)],
            "models": [f"model-{index}" for index in range(32)],
        }},
    ],
)
async def test_resolver_reapplies_bounded_snapshot_contract(payload) -> None:
    async def storage_request(method, path, **kwargs):
        return {
            "skillId": "host-skill",
            "skillReferenceCode": "SKL-00000000000000000000000001",
            "revision": 1,
            "digest": "sha256:" + "a" * 64,
            "instructions": "Pinned",
            "references": [],
            "declaredCapabilities": {},
            **payload,
        }

    with pytest.raises(HTTPException) as error:
        await resolve_local_agent_skill_snapshot(
            storage_request,
            skill_id="skl-00000000000000000000000001",
            allowed_tools=set(),
        )
    assert error.value.status_code == 502


@pytest.mark.anyio
async def test_resolver_accepts_lowercase_lookup_and_returns_canonical_skl() -> None:
    async def storage_request(method, path, **kwargs):
        return {
            "skillId": "host-skill",
            "skillReferenceCode": "SKL-00000000000000000000000001",
            "revision": 1, "digest": "sha256:" + "a" * 64,
            "instructions": "Pinned", "references": [], "declaredCapabilities": {},
        }

    snapshot = await resolve_local_agent_skill_snapshot(
        storage_request,
        skill_id="skl-00000000000000000000000001",
        allowed_tools=set(),
    )
    assert snapshot["skillReferenceCode"] == "SKL-00000000000000000000000001"
