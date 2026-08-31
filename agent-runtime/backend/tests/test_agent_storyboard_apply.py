from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest

from app.gateway import promptcard_runtime
from app.gateway.promptcard_runtime import PromptCardAgentEditAckRequest, PromptCardRuntimeMessageRequest


def sha(value: object) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def document() -> dict:
    blocks = [{"id": "p-1", "type": "paragraph", "content": [{"text": "Effective new draft"}]}]
    base = {"version": 1, "blocks": blocks, "suggestions": []}
    return {**base, "revision": 7, "digest": sha(base)}


def project(nodes: list[dict], revision: int = 12) -> dict:
    return {"id": "project-1", "revision": revision, "freeCanvas": {"nodes": nodes, "edges": [], "meta": {}}}


def conversation_with_edit(edit: dict) -> dict:
    return {
        "id": "conversation-1", "projectId": "project-1", "messages": [],
        "turns": [{
            "requestId": edit["requestId"],
            "messages": [{"role": "assistant", "text": "ok", "canvasEdits": [edit]}],
            "modelSnapshot": deepcopy(edit["payload"].get("source", {}).get("model", {})),
            "skillSnapshots": deepcopy(edit["payload"].get("source", {}).get("skills", [])),
            "applyEdit": {
                "status": "pending_apply", "conversationId": "conversation-1",
                "requestId": edit["requestId"], "editId": edit["editId"],
                "kind": edit["kind"], "nodeId": edit["nodeId"],
                "expectedResultDigest": edit["expectedResultDigest"],
            },
        }],
    }


def storyboard_sequence(camera: str = "wide") -> dict:
    return {
        "id": "sequence-1", "name": "Opening", "description": "", "style": "ink", "constraints": "",
        "rows": [{
            "id": "row-1", "cutLabel": "1", "timeRange": "0-3s", "subject": "Mara", "action": "enters",
            "scene": "hall", "camera": camera, "lighting": "", "audio": "", "duration": "3s",
            "createdAt": 1, "updatedAt": 1,
        }],
        "createdAt": 1, "updatedAt": 1, "meta": {},
    }


def storyboard_source() -> dict:
    return {
        "documentNodeId": "document-1", "documentRevision": 7,
        "documentDigest": document()["digest"],
        "documentResourceDigests": ["sha256:" + hashlib.sha256(b"resource body").hexdigest()],
        "model": model_snapshot(),
        "skills": [{"skillId": "skill-1", "revision": 4, "digest": "sha256:" + "c" * 64}],
    }


def model_snapshot() -> dict:
    return {
        "connectionId": "connection-1", "providerId": "provider-1", "modelId": "model-1",
        "displayName": "Production model", "capabilities": {"input": ["text"], "toolCalling": True},
    }


def aggregate_storyboard_sequence(total_bytes: int) -> dict:
    rows = [{
        "id": f"row-{index + 1}", "cutLabel": "", "timeRange": "", "subject": "", "action": "",
        "scene": "", "camera": "", "lighting": "", "audio": "", "duration": "",
    } for index in range(3)]
    sequence = {
        "id": "sequence-budget", "name": "", "description": "", "style": "", "constraints": "", "rows": rows,
    }
    targets = [(sequence, field) for field in ("name", "description", "style", "constraints")]
    targets.extend((row, field) for row in rows for field in (
        "cutLabel", "timeRange", "subject", "action", "scene", "camera", "lighting", "audio", "duration"
    ))
    remaining = total_bytes
    for target, field in targets:
        size = min(10_000, remaining)
        target[field] = "a" * size
        remaining -= size
    if remaining:
        raise AssertionError("aggregate fixture too large")
    return sequence


def persisted_aggregate_storyboard_sequence(total_bytes: int) -> dict:
    sequence = aggregate_storyboard_sequence(total_bytes)
    sequence.update({"createdAt": 1, "updatedAt": 1, "meta": {}})
    for row in sequence["rows"]:
        row.update({"createdAt": 1, "updatedAt": 1})
    return sequence


def test_storyboard_create_context_is_resolved_from_authoritative_effective_document():
    request = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1", "content": "transform",
        "projectId": "project-1", "interactionMode": "chat-experimental",
        "documentWriteContext": {"operationKind": "storyboard_create", "documentNodeId": "document-1"},
    })
    source = document()
    resolved = promptcard_runtime._resolve_document_write_context(request, project([{
        "id": "document-1", "kind": "document", "document": source,
        "linkedDocumentResourceIds": ["resource-a"],
    }]))

    assert resolved == {
        "operationKind": "storyboard_create", "documentNodeId": "document-1",
        "documentRevision": 7, "documentDigest": source["digest"],
        "effectiveText": "Effective new draft", "linkedDocumentResourceIds": ["resource-a"],
    }


def test_storyboard_create_validation_ignores_model_source_and_binds_exact_authority():
    sequence = {
        "id": "sequence-1", "name": "Opening", "description": "Effective new draft", "style": "ink", "constraints": "",
        "rows": [{"id": "row-1", "cutLabel": "1", "timeRange": "0-3s", "subject": "Mara", "action": "enters", "scene": "hall", "camera": "wide", "lighting": "dawn", "audio": "", "duration": "3s"}],
    }
    authority = {
        "operationKind": "storyboard_create", "documentNodeId": "document-1", "documentRevision": 7,
        "documentDigest": "sha256:" + "a" * 64, "effectiveText": "Effective new draft",
        "documentResourceDigests": ["sha256:" + "b" * 64],
    }
    provenance = {
        "model": model_snapshot(),
        "skills": [{"skillId": "skill-1", "revision": 4, "digest": "sha256:" + "c" * 64}],
    }
    accepted = promptcard_runtime.validate_agent_document_edits(
        [{"kind": "storyboard_create", "payload": {"title": "Shots", "sequence": sequence, "source": {"documentDigest": "forged"}}, "rationale": "Explicit"}],
        conversation_id="conversation-1", request_id="request-1", project=project([]),
        expected_write_context=authority, run_provenance=provenance,
    )

    assert len(accepted) == 1
    edit = accepted[0]
    assert edit["kind"] == "storyboard_create"
    assert edit["payload"]["source"] == {
        "documentNodeId": "document-1", "documentRevision": 7,
        "documentDigest": "sha256:" + "a" * 64,
        "documentResourceDigests": ["sha256:" + "b" * 64], **provenance,
    }
    assert edit["expectedResultDigest"] == promptcard_runtime._storyboard_digest(edit["payload"]["sequence"], [])


@pytest.mark.anyio
async def test_production_storyboard_request_persists_the_real_five_key_model_snapshot(monkeypatch):
    saved: dict = {}
    descriptor = {
        "connectionId": "connection-1", "providerId": "provider-1",
        "model": {
            "id": "model-1", "displayName": "Production model",
            "capabilities": {"input": ["text"], "toolCalling": True},
        },
    }
    detail = {
        "id": "conversation-1", "projectId": "project-1", "messages": [], "turns": [],
        "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas-workspace",
        "interactionMode": "chat-experimental", "boundSkillIds": ["skill-1"],
        "modelBinding": {"connectionId": "connection-1", "providerId": "provider-1", "modelId": "model-1"},
    }

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return detail
        if method == "GET" and path == "/api/projects/project-1":
            return project([{
                "id": "document-1", "kind": "document", "document": document(),
                "linkedDocumentResourceIds": ["resource-1"],
            }])
        if method == "POST" and path.endswith("/turns"):
            saved.update(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(_payload):
        raw_sequence = storyboard_sequence()
        raw_sequence["rows"] = [{
            key: value for key, value in row.items() if key not in {"createdAt", "updatedAt"}
        } for row in raw_sequence["rows"]]
        return {
            "threadId": "conversation-1", "text": "ok", "proposals": [],
            "canvasEdits": [{
                "kind": "storyboard_create",
                "payload": {"title": "Shots", "sequence": {
                    key: value for key, value in raw_sequence.items()
                    if key not in {"createdAt", "updatedAt", "meta"}
                }},
                "rationale": "Explicit transform",
            }],
        }

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    monkeypatch.setattr(promptcard_runtime, "resolve_text_model", lambda _: descriptor)
    monkeypatch.setattr(promptcard_runtime, "_resolve_skill_snapshots", lambda _: __import__("asyncio").sleep(
        0, result=[{"skillId": "skill-1", "revision": 4, "digest": "sha256:" + "c" * 64}]
    ))
    async def fake_resources(_project_id, resource_ids):
        return [] if not resource_ids else [SimpleNamespace(
            content=b"resource body", content_type="text/plain", filename="resource.txt", resource_id="resource-1"
        )]

    monkeypatch.setattr(promptcard_runtime, "_load_document_resources", fake_resources)
    request = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-production", "content": "transform",
        "projectId": "project-1", "mode": "free-canvas-workspace", "interactionMode": "chat-experimental",
        "documentWriteContext": {"operationKind": "storyboard_create", "documentNodeId": "document-1"},
        "workspaceContext": {"projectId": "project-1", "projectRevision": 12, "snapshot": {"nodes": []}},
    })

    result = await promptcard_runtime.runtime_service.send_message(request, None)

    assert result["canvasEdits"][0]["payload"]["source"]["model"] == model_snapshot()
    assert saved["modelSnapshot"] == model_snapshot()


def test_storyboard_changes_are_bound_to_strict_revision_digest_and_allowed_fields():
    sequence = {
        "id": "sequence-1", "name": "Opening", "description": "", "style": "ink", "constraints": "",
        "rows": [{"id": "row-1", "cutLabel": "1", "timeRange": "0-3s", "subject": "Mara", "action": "enters", "scene": "hall", "camera": "wide", "lighting": "", "audio": "", "duration": "3s", "createdAt": 1, "updatedAt": 1}],
        "createdAt": 1, "updatedAt": 1, "meta": {},
    }
    node_digest = promptcard_runtime._storyboard_digest(sequence, [])
    node = {
        "id": "storyboard-1", "kind": "storyboard", "sequence": sequence,
        "pendingFieldChanges": [], "revision": 3, "digest": node_digest, "source": storyboard_source(),
    }
    context = {"operationKind": "storyboard_changes", "nodeId": "storyboard-1", "baseRevision": 3, "baseDigest": node_digest, "sequence": sequence}
    valid = promptcard_runtime.validate_agent_document_edits(
        [{"kind": "storyboard_changes", "payload": {"nodeId": "storyboard-1", "baseRevision": 3, "baseDigest": node_digest, "changes": [{"scope": "row", "rowId": "row-1", "field": "camera", "value": "close-up"}]}, "rationale": "Refine"}],
        conversation_id="conversation-1", request_id="request-2", project=project([node]), expected_write_context=context,
        run_provenance={"model": model_snapshot(), "skills": []},
    )
    invalid = promptcard_runtime.validate_agent_document_edits(
        [{"kind": "storyboard_changes", "payload": {"nodeId": "storyboard-1", "baseRevision": 3, "baseDigest": node_digest, "changes": [{"scope": "row", "rowId": "row-1", "field": "imageUrl", "value": "forged"}]}, "rationale": "No"}],
        conversation_id="conversation-1", request_id="request-3", project=project([node]), expected_write_context=context,
        run_provenance={"model": model_snapshot(), "skills": []},
    )

    assert len(valid) == 1
    expected_pending = promptcard_runtime._storyboard_pending_from_operations(
        valid[0]["editId"], sequence, valid[0]["payload"]["changes"]
    )
    assert expected_pending[0]["previousValue"] == "wide"
    assert valid[0]["expectedResultDigest"] == promptcard_runtime._storyboard_digest(sequence, expected_pending)
    assert invalid == []


@pytest.mark.parametrize(("base_bytes", "accepted_count"), [(246_000, 1), (246_001, 0)])
def test_storyboard_changes_validate_the_complete_prospective_aggregate(base_bytes, accepted_count):
    sequence = persisted_aggregate_storyboard_sequence(base_bytes)
    node_digest = promptcard_runtime._storyboard_digest(sequence, [])
    source = storyboard_source()
    node = {
        "id": "storyboard-1", "kind": "storyboard", "sequence": sequence,
        "pendingFieldChanges": [], "revision": 3, "digest": node_digest, "source": source,
    }
    context = {
        "operationKind": "storyboard_changes", "nodeId": "storyboard-1",
        "baseRevision": 3, "baseDigest": node_digest, "sequence": sequence,
    }

    accepted = promptcard_runtime.validate_agent_document_edits(
        [{
            "kind": "storyboard_changes",
            "payload": {
                "nodeId": "storyboard-1", "baseRevision": 3, "baseDigest": node_digest,
                "changes": [{
                    "scope": "row", "rowId": "row-3", "field": "duration", "value": "b" * 10_000,
                }],
                "source": {"documentDigest": "model-forged"},
            },
            "rationale": "Fill the final field",
        }],
        conversation_id="conversation-budget", request_id=f"request-{base_bytes}",
        project=project([node]), expected_write_context=context,
        run_provenance={"model": model_snapshot(), "skills": []},
    )

    assert len(accepted) == accepted_count
    if accepted:
        assert accepted[0]["payload"]["source"] == source


@pytest.mark.parametrize(("total_bytes", "accepted_count"), [(256_000, 1), (256_001, 0)])
def test_storyboard_create_enforces_the_frozen_aggregate_byte_boundary(total_bytes, accepted_count):
    authority = {
        "operationKind": "storyboard_create", "documentNodeId": "document-1", "documentRevision": 7,
        "documentDigest": "sha256:" + "a" * 64, "effectiveText": "Effective",
        "documentResourceDigests": [],
    }
    accepted = promptcard_runtime.validate_agent_document_edits(
        [{
            "kind": "storyboard_create",
            "payload": {"title": "Boundary", "sequence": aggregate_storyboard_sequence(total_bytes)},
            "rationale": "Boundary",
        }],
        conversation_id="conversation-1", request_id=f"request-{total_bytes}", project=project([]),
        expected_write_context=authority,
        run_provenance={"model": model_snapshot(), "skills": []},
    )

    assert len(accepted) == accepted_count


@pytest.mark.anyio
@pytest.mark.parametrize("saved", [False, True])
async def test_storyboard_create_reconcile_replays_absent_and_recovers_saved_before_ack(monkeypatch, saved):
    sequence = storyboard_sequence()
    expected = promptcard_runtime._storyboard_digest(sequence, [])
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-create", "storyboard_create", None
    )
    edit = {
        "kind": "storyboard_create", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-create", "nodeId": node_id,
        "base": {"projectRevision": 12}, "expectedResultDigest": expected,
        "payload": {"title": "Opening", "sequence": sequence, "source": storyboard_source()}, "rationale": "Create",
    }
    nodes = [{"id": "other", "kind": "text"}, {
        "id": "document-1", "kind": "document", "document": document(),
        "linkedDocumentResourceIds": ["resource-1"],
    }]
    if saved:
        nodes = [{
            "id": node_id, "kind": "storyboard", "sequence": sequence,
            "pendingFieldChanges": [], "revision": 0, "digest": expected,
            "source": storyboard_source(),
            "agentAppliedEdit": {
                "conversationId": "conversation-1", "requestId": "request-create",
                "editId": edit_id, "resultDigest": expected,
            },
        }, {
            "id": "document-1", "kind": "document", "document": document(),
            "linkedDocumentResourceIds": ["resource-1"],
        }]
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation_with_edit(edit)
        if method == "GET" and path == "/api/projects/project-1":
            return project(nodes)
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_load_document_resources", lambda *_: __import__("asyncio").sleep(
        0, result=[SimpleNamespace(content=b"resource body")]
    ))
    result = await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")

    if saved:
        assert result["status"] == "applied"
        assert result["canvasEdits"] == []
        assert patches[0]["evidence"] == {
            "projectRevision": 12, "nodeId": node_id, "kind": "storyboard", "resultDigest": expected,
        }
    else:
        assert result["status"] == "pending_apply"
        assert result["canvasEdits"] == [edit]
        assert patches == []


@pytest.mark.anyio
async def test_saved_storyboard_recovery_rejects_duplicate_target_identity(monkeypatch):
    sequence = storyboard_sequence()
    expected = promptcard_runtime._storyboard_digest(sequence, [])
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-create", "storyboard_create", None
    )
    edit = {
        "kind": "storyboard_create", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-create", "nodeId": node_id,
        "base": {"projectRevision": 12}, "expectedResultDigest": expected,
        "payload": {
            "title": "Opening", "sequence": sequence, "source": storyboard_source(),
        },
        "rationale": "Create",
    }
    saved_node = {
        "id": node_id, "kind": "storyboard", "sequence": sequence,
        "pendingFieldChanges": [], "revision": 0, "digest": expected,
        "source": storyboard_source(),
        "agentAppliedEdit": {
            "conversationId": "conversation-1", "requestId": "request-create",
            "editId": edit_id, "resultDigest": expected,
        },
    }
    other_sequence = storyboard_sequence("close-up")
    duplicate_node = {
        "id": node_id, "kind": "storyboard", "sequence": other_sequence,
        "pendingFieldChanges": [], "revision": 1,
        "digest": promptcard_runtime._storyboard_digest(other_sequence, []),
        "source": storyboard_source(),
    }
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation_with_edit(edit)
        if method == "GET" and path == "/api/projects/project-1":
            return project([saved_node, duplicate_node])
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    result = await promptcard_runtime.runtime_service.ack_document_edit(
        "project-1", "conversation-1", edit_id,
        PromptCardAgentEditAckRequest(
            requestId="request-create", status="failed", errorCode="browser_lost_state"
        ),
    )

    assert result["status"] == "failed_integrity"
    assert patches[0]["status"] == "failed_integrity"
    assert all(update["status"] != "applied" for update in patches)


@pytest.mark.anyio
@pytest.mark.parametrize("tamper", [
    "missing_edit_source", "edit_source", "turn_model", "turn_skills",
    "missing_document", "stale_document", "missing_resource", "resource_digest",
])
async def test_storyboard_create_absent_target_never_replays_without_complete_authority(monkeypatch, tamper):
    sequence = storyboard_sequence()
    expected = promptcard_runtime._storyboard_digest(sequence, [])
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-absent", "storyboard_create", None
    )
    source = storyboard_source()
    edit = {
        "kind": "storyboard_create", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-absent", "nodeId": node_id,
        "base": {"projectRevision": 12}, "expectedResultDigest": expected,
        "payload": {"title": "Opening", "sequence": sequence, "source": deepcopy(source)}, "rationale": "Create",
    }
    if tamper == "missing_edit_source":
        edit["payload"].pop("source")
    elif tamper == "edit_source":
        edit["payload"]["source"]["documentDigest"] = "sha256:" + "d" * 64
    detail = conversation_with_edit(edit)
    if tamper == "turn_model":
        detail["turns"][0]["modelSnapshot"]["modelId"] = "forged"
    if tamper == "turn_skills":
        detail["turns"][0]["skillSnapshots"] = []
    nodes = [{
        "id": "document-1", "kind": "document", "document": document(),
        "linkedDocumentResourceIds": ["resource-1"],
    }]
    if tamper == "missing_document":
        nodes = [{"id": "other", "kind": "text"}]
    elif tamper == "stale_document":
        nodes[0]["document"] = {**document(), "revision": 8}
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return detail
        if method == "GET" and path == "/api/projects/project-1":
            return project(nodes)
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_resources(*_args):
        if tamper == "missing_resource":
            raise promptcard_runtime.HTTPException(status_code=404, detail="missing")
        content = b"tampered" if tamper == "resource_digest" else b"resource body"
        return [SimpleNamespace(content=content)]

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_load_document_resources", fake_resources)
    result = await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")

    assert result["status"] == "failed_integrity"
    assert result["canvasEdits"] == []
    assert patches[0]["evidence"]["code"] == "storyboard_source_mismatch"


@pytest.mark.anyio
@pytest.mark.parametrize("invalid_skills", [
    {}, [[]], [{"skillId": [], "revision": 4, "digest": "sha256:" + "c" * 64}],
    [
        {"skillId": "duplicate", "revision": 4, "digest": "sha256:" + "c" * 64},
        {"skillId": "duplicate", "revision": 5, "digest": "sha256:" + "d" * 64},
    ],
    [{"skillId": "skill-1", "revision": "4", "digest": "sha256:" + "c" * 64}],
    [{"skillId": "skill-1", "revision": 4, "digest": "bad"}],
    [{"skillId": "x" * 10_001, "revision": 4, "digest": "sha256:" + "c" * 64}],
    [
        {"skillId": f"skill-{index}", "revision": index, "digest": "sha256:" + f"{index}" * 64}
        for index in range(1, 10)
    ],
])
async def test_absent_storyboard_recovery_rejects_every_malformed_skill_snapshot_without_raising(monkeypatch, invalid_skills):
    sequence = storyboard_sequence()
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-skills", "storyboard_create", None
    )
    source = storyboard_source()
    source["skills"] = deepcopy(invalid_skills)
    edit = {
        "kind": "storyboard_create", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-skills", "nodeId": node_id,
        "base": {"projectRevision": 12}, "expectedResultDigest": promptcard_runtime._storyboard_digest(sequence, []),
        "payload": {"title": "Opening", "sequence": sequence, "source": source}, "rationale": "Create",
    }
    detail = conversation_with_edit(edit)
    detail["turns"][0]["skillSnapshots"] = deepcopy(invalid_skills)
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return detail
        if method == "GET" and path == "/api/projects/project-1":
            return project([{
                "id": "document-1", "kind": "document", "document": document(),
                "linkedDocumentResourceIds": ["resource-1"],
            }])
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_load_document_resources", lambda *_: __import__("asyncio").sleep(
        0, result=[SimpleNamespace(content=b"resource body")]
    ))
    try:
        result = await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")
    except Exception as exc:
        pytest.fail(f"malformed Skill provenance raised {type(exc).__name__}: {exc}")

    assert result["status"] == "failed_integrity"
    assert result["canvasEdits"] == []
    assert patches[0]["evidence"]["code"] == "storyboard_source_mismatch"


@pytest.mark.anyio
async def test_absent_storyboard_recovery_accepts_exactly_eight_authoritative_skill_snapshots(monkeypatch):
    sequence = storyboard_sequence()
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-eight-skills", "storyboard_create", None
    )
    source = storyboard_source()
    source["skills"] = [
        {"skillId": f"skill-{index}", "revision": index, "digest": "sha256:" + f"{index}" * 64}
        for index in range(1, 9)
    ]
    edit = {
        "kind": "storyboard_create", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-eight-skills", "nodeId": node_id,
        "base": {"projectRevision": 12}, "expectedResultDigest": promptcard_runtime._storyboard_digest(sequence, []),
        "payload": {"title": "Opening", "sequence": sequence, "source": source}, "rationale": "Create",
    }
    detail = conversation_with_edit(edit)

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return detail
        if method == "GET" and path == "/api/projects/project-1":
            return project([{
                "id": "document-1", "kind": "document", "document": document(),
                "linkedDocumentResourceIds": ["resource-1"],
            }])
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_load_document_resources", lambda *_: __import__("asyncio").sleep(
        0, result=[SimpleNamespace(content=b"resource body")]
    ))

    result = await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")

    assert result["status"] == "pending_apply"
    assert result["canvasEdits"] == [edit]


@pytest.mark.anyio
@pytest.mark.parametrize("tamper", ["missing", "document", "resources", "model", "skills"])
@pytest.mark.parametrize("entrypoint", ["ack", "reconcile"])
async def test_storyboard_saved_before_ack_rejects_any_tampered_canonical_source(monkeypatch, tamper, entrypoint):
    sequence = storyboard_sequence()
    expected = promptcard_runtime._storyboard_digest(sequence, [])
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-tamper", "storyboard_create", None
    )
    expected_source = storyboard_source()
    edit = {
        "kind": "storyboard_create", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-tamper", "nodeId": node_id,
        "base": {"projectRevision": 12}, "expectedResultDigest": expected,
        "payload": {"title": "Opening", "sequence": sequence, "source": expected_source}, "rationale": "Create",
    }
    saved_source = deepcopy(expected_source)
    if tamper == "missing":
        saved_source = None
    elif tamper == "document":
        saved_source["documentDigest"] = "sha256:" + "d" * 64
    elif tamper == "resources":
        saved_source["documentResourceDigests"] = []
    elif tamper == "model":
        saved_source["model"]["modelId"] = "forged"
    else:
        saved_source["skills"] = []
    storyboard = {
        "id": node_id, "kind": "storyboard", "sequence": sequence,
        "pendingFieldChanges": [], "revision": 0, "digest": expected,
        "agentAppliedEdit": {
            "conversationId": "conversation-1", "requestId": "request-tamper",
            "editId": edit_id, "resultDigest": expected,
        },
    }
    if saved_source is not None:
        storyboard["source"] = saved_source
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation_with_edit(edit)
        if method == "GET" and path == "/api/projects/project-1":
            return project([storyboard, {
                "id": "document-1", "kind": "document", "document": document(),
                "linkedDocumentResourceIds": ["resource-1"],
            }])
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_load_document_resources", lambda *_: __import__("asyncio").sleep(
        0, result=[SimpleNamespace(content=b"resource body")]
    ))
    result = (
        await promptcard_runtime.runtime_service.ack_document_edit(
            "project-1", "conversation-1", edit_id,
            PromptCardAgentEditAckRequest(requestId="request-tamper", status="applied"),
        )
        if entrypoint == "ack"
        else await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")
    )

    assert result["status"] == "failed_integrity"
    if entrypoint == "reconcile":
        assert result["canvasEdits"] == []
    else:
        assert "canvasEdits" not in result
    assert patches[0]["evidence"]["code"] == "storyboard_source_mismatch"


@pytest.mark.anyio
@pytest.mark.parametrize("entrypoint", ["ack", "reconcile"])
async def test_saved_storyboard_marker_finalizes_after_its_source_document_and_resources_advance(monkeypatch, entrypoint):
    sequence = storyboard_sequence()
    expected = promptcard_runtime._storyboard_digest(sequence, [])
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-advanced", "storyboard_create", None
    )
    source = storyboard_source()
    edit = {
        "kind": "storyboard_create", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-advanced", "nodeId": node_id,
        "base": {"projectRevision": 12}, "expectedResultDigest": expected,
        "payload": {"title": "Opening", "sequence": sequence, "source": deepcopy(source)}, "rationale": "Create",
    }
    advanced_document = document()
    advanced_document["revision"] = 8
    advanced_document["digest"] = "sha256:" + "e" * 64
    storyboard = {
        "id": node_id, "kind": "storyboard", "sequence": sequence, "source": deepcopy(source),
        "pendingFieldChanges": [], "revision": 0, "digest": expected,
        "agentAppliedEdit": {
            "conversationId": "conversation-1", "requestId": "request-advanced",
            "editId": edit_id, "resultDigest": expected,
        },
    }
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation_with_edit(edit)
        if method == "GET" and path == "/api/projects/project-1":
            return project([storyboard, {
                "id": "document-1", "kind": "document", "document": advanced_document,
                "linkedDocumentResourceIds": ["resource-2"],
            }], revision=13)
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_load_document_resources", lambda *_: __import__("asyncio").sleep(
        0, result=[SimpleNamespace(content=b"advanced resource")]
    ))
    result = (
        await promptcard_runtime.runtime_service.ack_document_edit(
            "project-1", "conversation-1", edit_id,
            PromptCardAgentEditAckRequest(requestId="request-advanced", status="applied"),
        )
        if entrypoint == "ack"
        else await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")
    )

    assert result["status"] == "applied"
    assert patches[0]["status"] == "applied"


@pytest.mark.anyio
@pytest.mark.parametrize("malformed", [
    "unpaired_surrogate", "invalid_timestamp", "invalid_meta", "source_unicode",
    "duplicate_pending", "invalid_row_ref", "previous_value", "pending_budget",
])
async def test_storyboard_recovery_is_total_and_rejects_malformed_persisted_state(monkeypatch, malformed):
    sequence = storyboard_sequence()
    source = storyboard_source()
    pending = [{
        "id": "change-1", "editId": "edit-create", "scope": "row", "rowId": "row-1",
        "field": "camera", "previousValue": "wide", "newValue": "close-up",
    }]
    if malformed == "unpaired_surrogate":
        sequence["name"] = "bad\ud800"
    elif malformed == "invalid_timestamp":
        sequence["rows"][0]["createdAt"] = True
    elif malformed == "invalid_meta":
        sequence["meta"] = []
    elif malformed == "source_unicode":
        source["model"]["modelId"] = "bad\ud800"
    elif malformed == "duplicate_pending":
        pending.append({**pending[0], "id": "change-2", "newValue": "medium"})
    elif malformed == "invalid_row_ref":
        pending[0]["rowId"] = "missing-row"
    elif malformed == "previous_value":
        pending[0]["previousValue"] = "forged"
    elif malformed == "pending_budget":
        pending[0]["newValue"] = "a" * 10_001
    result_digest = (
        "sha256:" + "e" * 64
        if malformed == "unpaired_surrogate"
        else promptcard_runtime._storyboard_digest(sequence, pending)
    )
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-malformed", "storyboard_create", None
    )
    edit = {
        "kind": "storyboard_create", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-malformed", "nodeId": node_id,
        "base": {"projectRevision": 12}, "expectedResultDigest": result_digest,
        "payload": {"title": "Opening", "sequence": storyboard_sequence(), "source": deepcopy(source)},
        "rationale": "Create",
    }
    node = {
        "id": node_id, "kind": "storyboard", "sequence": sequence, "source": source,
        "pendingFieldChanges": pending, "revision": 1, "digest": result_digest,
        "agentAppliedEdit": {
            "conversationId": "conversation-1", "requestId": "request-malformed",
            "editId": edit_id, "resultDigest": result_digest,
        },
    }
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation_with_edit(edit)
        if method == "GET" and path == "/api/projects/project-1":
            return project([node, {
                "id": "document-1", "kind": "document", "document": document(),
                "linkedDocumentResourceIds": ["resource-1"],
            }])
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_load_document_resources", lambda *_: __import__("asyncio").sleep(
        0, result=[SimpleNamespace(content=b"resource body")]
    ))
    try:
        result = await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")
    except Exception as exc:  # Recovery must be total over persisted JSON.
        pytest.fail(f"reconcile raised {type(exc).__name__}: {exc}")

    assert result["status"] == "failed_integrity"
    assert result["canvasEdits"] == []
    assert patches[0]["status"] == "failed_integrity"


@pytest.mark.anyio
@pytest.mark.parametrize(("changed", "expected_status"), [(False, "pending_apply"), (True, "failed_conflict")])
async def test_storyboard_changes_reconcile_replays_only_the_strict_persisted_base(monkeypatch, changed, expected_status):
    base_sequence = storyboard_sequence()
    base_digest = promptcard_runtime._storyboard_digest(base_sequence, [])
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-change", "storyboard_changes", "storyboard-1"
    )
    create_source = storyboard_source()
    edit = {
        "kind": "storyboard_changes", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-change", "nodeId": node_id,
        "base": {"projectRevision": 12, "nodeRevision": 3, "nodeDigest": base_digest},
        "expectedResultDigest": "sha256:" + "f" * 64,
        "payload": {
            "changes": [{"scope": "row", "rowId": "row-1", "field": "camera", "value": "close-up"}],
            "source": deepcopy(create_source),
        },
        "rationale": "Refine",
    }
    persisted_sequence = storyboard_sequence("medium" if changed else "wide")
    persisted_digest = promptcard_runtime._storyboard_digest(persisted_sequence, [])
    node = {
        "id": node_id, "kind": "storyboard", "sequence": persisted_sequence,
        "pendingFieldChanges": [], "revision": 4 if changed else 3, "digest": persisted_digest,
        "source": create_source,
    }
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation_with_edit(edit)
        if method == "GET" and path == "/api/projects/project-1":
            return project([node, {
                "id": "document-1", "kind": "document", "document": document(),
                "linkedDocumentResourceIds": ["resource-1"],
            }])
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_load_document_resources", lambda *_: __import__("asyncio").sleep(
        0, result=[SimpleNamespace(content=b"resource body")]
    ))
    result = await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")

    assert result["status"] == expected_status
    if changed:
        assert result["canvasEdits"] == []
        assert patches[0]["evidence"]["code"] == "storyboard_base_changed"
    else:
        assert result["canvasEdits"] == [edit]
        assert patches == []


@pytest.mark.anyio
async def test_storyboard_changes_reconcile_uses_frozen_target_source_after_document_advances(monkeypatch):
    sequence = storyboard_sequence()
    source = storyboard_source()
    digest = promptcard_runtime._storyboard_digest(sequence, [])
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-change", "storyboard_changes", "storyboard-1"
    )
    edit = {
        "kind": "storyboard_changes", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-change", "nodeId": node_id,
        "base": {"projectRevision": 12, "nodeRevision": 3, "nodeDigest": digest},
        "expectedResultDigest": "sha256:" + "f" * 64,
        "payload": {
            "changes": [{"scope": "row", "rowId": "row-1", "field": "camera", "value": "close-up"}],
            "source": deepcopy(source),
        },
        "rationale": "Refine",
    }
    node = {
        "id": node_id, "kind": "storyboard", "sequence": sequence,
        "pendingFieldChanges": [], "revision": 3, "digest": digest, "source": deepcopy(source),
    }
    advanced_document = document()
    advanced_document["revision"] = 8
    advanced_document["blocks"][0]["content"][0]["text"] = "A newer effective draft"
    advanced_document["digest"] = sha({
        "version": advanced_document["version"], "blocks": advanced_document["blocks"], "suggestions": [],
    })

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation_with_edit(edit)
        if method == "GET" and path == "/api/projects/project-1":
            return project([node, {
                "id": "document-1", "kind": "document", "document": advanced_document,
                "linkedDocumentResourceIds": ["resource-1"],
            }])
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    result = await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")

    assert result["status"] == "pending_apply"
    assert result["canvasEdits"] == [edit]


@pytest.mark.anyio
async def test_storyboard_changes_reconcile_cross_conversation_without_a_create_turn(monkeypatch):
    sequence = storyboard_sequence()
    source = storyboard_source()
    digest = promptcard_runtime._storyboard_digest(sequence, [])
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-2", "request-change", "storyboard_changes", "storyboard-1"
    )
    edit = {
        "kind": "storyboard_changes", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-2", "requestId": "request-change", "nodeId": node_id,
        "base": {"projectRevision": 12, "nodeRevision": 3, "nodeDigest": digest},
        "expectedResultDigest": "sha256:" + "f" * 64,
        "payload": {
            "changes": [{"scope": "row", "rowId": "row-1", "field": "camera", "value": "close-up"}],
            "source": deepcopy(source),
        },
        "rationale": "Refine in another conversation",
    }
    node = {
        "id": node_id, "kind": "storyboard", "sequence": sequence,
        "pendingFieldChanges": [], "revision": 3, "digest": digest, "source": deepcopy(source),
    }

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-2"):
            detail = conversation_with_edit(edit)
            detail["id"] = "conversation-2"
            detail["turns"][0]["applyEdit"]["conversationId"] = "conversation-2"
            return detail
        if method == "GET" and path == "/api/projects/project-1":
            return project([node])
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    result = await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-2")

    assert result["status"] == "pending_apply"
    assert result["canvasEdits"] == [edit]
