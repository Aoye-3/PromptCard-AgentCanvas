from __future__ import annotations

import hashlib
import json

import pytest

from app.gateway import promptcard_runtime
from app.gateway.promptcard_runtime import PromptCardRuntimeMessageRequest


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
        "model": {"connectionId": "connection-1", "providerId": "provider-1", "modelId": "model-1"},
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


def test_storyboard_changes_are_bound_to_strict_revision_digest_and_allowed_fields():
    sequence = {
        "id": "sequence-1", "name": "Opening", "description": "", "style": "ink", "constraints": "",
        "rows": [{"id": "row-1", "cutLabel": "1", "timeRange": "0-3s", "subject": "Mara", "action": "enters", "scene": "hall", "camera": "wide", "lighting": "", "audio": "", "duration": "3s", "createdAt": 1, "updatedAt": 1}],
        "createdAt": 1, "updatedAt": 1, "meta": {},
    }
    node_digest = promptcard_runtime._storyboard_digest(sequence, [])
    node = {"id": "storyboard-1", "kind": "storyboard", "sequence": sequence, "pendingFieldChanges": [], "revision": 3, "digest": node_digest}
    context = {"operationKind": "storyboard_changes", "nodeId": "storyboard-1", "baseRevision": 3, "baseDigest": node_digest, "sequence": sequence}
    valid = promptcard_runtime.validate_agent_document_edits(
        [{"kind": "storyboard_changes", "payload": {"nodeId": "storyboard-1", "baseRevision": 3, "baseDigest": node_digest, "changes": [{"scope": "row", "rowId": "row-1", "field": "camera", "value": "close-up"}]}, "rationale": "Refine"}],
        conversation_id="conversation-1", request_id="request-2", project=project([node]), expected_write_context=context,
        run_provenance={"model": {"connectionId": "c", "providerId": "p", "modelId": "m"}, "skills": []},
    )
    invalid = promptcard_runtime.validate_agent_document_edits(
        [{"kind": "storyboard_changes", "payload": {"nodeId": "storyboard-1", "baseRevision": 3, "baseDigest": node_digest, "changes": [{"scope": "row", "rowId": "row-1", "field": "imageUrl", "value": "forged"}]}, "rationale": "No"}],
        conversation_id="conversation-1", request_id="request-3", project=project([node]), expected_write_context=context,
        run_provenance={"model": {"connectionId": "c", "providerId": "p", "modelId": "m"}, "skills": []},
    )

    assert len(valid) == 1
    expected_pending = promptcard_runtime._storyboard_pending_from_operations(
        valid[0]["editId"], sequence, valid[0]["payload"]["changes"]
    )
    assert expected_pending[0]["previousValue"] == "wide"
    assert valid[0]["expectedResultDigest"] == promptcard_runtime._storyboard_digest(sequence, expected_pending)
    assert invalid == []


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
        "payload": {"title": "Opening", "sequence": sequence, "source": {}}, "rationale": "Create",
    }
    nodes = [{"id": "other", "kind": "text"}]
    if saved:
        nodes = [{
            "id": node_id, "kind": "storyboard", "sequence": sequence,
            "pendingFieldChanges": [], "revision": 0, "digest": expected,
            "agentAppliedEdit": {
                "conversationId": "conversation-1", "requestId": "request-create",
                "editId": edit_id, "resultDigest": expected,
            },
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
@pytest.mark.parametrize(("changed", "expected_status"), [(False, "pending_apply"), (True, "failed_conflict")])
async def test_storyboard_changes_reconcile_replays_only_the_strict_persisted_base(monkeypatch, changed, expected_status):
    base_sequence = storyboard_sequence()
    base_digest = promptcard_runtime._storyboard_digest(base_sequence, [])
    edit_id, node_id = promptcard_runtime._deterministic_document_edit_ids(
        "conversation-1", "request-change", "storyboard_changes", "storyboard-1"
    )
    edit = {
        "kind": "storyboard_changes", "id": edit_id, "editId": edit_id,
        "conversationId": "conversation-1", "requestId": "request-change", "nodeId": node_id,
        "base": {"projectRevision": 12, "nodeRevision": 3, "nodeDigest": base_digest},
        "expectedResultDigest": "sha256:" + "f" * 64,
        "payload": {"changes": [{"scope": "row", "rowId": "row-1", "field": "camera", "value": "close-up"}]},
        "rationale": "Refine",
    }
    persisted_sequence = storyboard_sequence("medium" if changed else "wide")
    persisted_digest = promptcard_runtime._storyboard_digest(persisted_sequence, [])
    node = {
        "id": node_id, "kind": "storyboard", "sequence": persisted_sequence,
        "pendingFieldChanges": [], "revision": 4 if changed else 3, "digest": persisted_digest,
    }
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation_with_edit(edit)
        if method == "GET" and path == "/api/projects/project-1":
            return project([node])
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    result = await promptcard_runtime.runtime_service.reconcile_document_edits("project-1", "conversation-1")

    assert result["status"] == expected_status
    if changed:
        assert result["canvasEdits"] == []
        assert patches[0]["evidence"]["code"] == "storyboard_base_changed"
    else:
        assert result["canvasEdits"] == [edit]
        assert patches == []
