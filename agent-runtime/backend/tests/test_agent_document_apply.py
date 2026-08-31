from __future__ import annotations

import hashlib
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.gateway import promptcard_runtime
from app.gateway.promptcard_runtime import (
    PromptCardAgentEditAckRequest,
    PromptCardRuntimeMessageRequest,
    _canonical_nfc_json,
    _deterministic_document_edit_ids,
)
from app.gateway.routers.promptcard_runtime import router


def digest(value: object) -> str:
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def document(blocks: list[dict], revision: int = 0) -> dict:
    base = {"version": 1, "blocks": blocks, "suggestions": []}
    return {**base, "revision": revision, "digest": digest(base)}


def document_with_insert_suggestion() -> dict:
    blocks = [{
        "id": "block-1",
        "type": "paragraph",
        "content": [{"text": "New"}],
    }]
    suggestions = [{
        "id": "suggestion-1",
        "groupId": "group-1",
        "editId": "edit-1",
        "kind": "insert",
        "blockId": "block-1",
        "utf8Start": 0,
        "utf8End": 3,
        "content": [{"text": "New"}],
    }]
    base = {"version": 1, "blocks": blocks, "suggestions": suggestions}
    return {**base, "revision": 1, "digest": digest(base)}


def create_edit() -> dict:
    blocks = [{"id": "block-é", "type": "paragraph", "content": [{"text": "Café"}]}]
    result = document(blocks)
    return {
        "kind": "document_create",
        "title": "Café plan",
        "blocks": blocks,
        "linkedDocumentResourceIds": [],
        "rationale": "Draft the plan",
        "expectedResultDigest": result["digest"],
    }


def project_with_node(node: dict, revision: int = 3) -> dict:
    return {
        "id": "project-1",
        "revision": revision,
        "freeCanvas": {"nodes": [node], "edges": [], "meta": {}},
    }


def saved_turn(edit: dict, status: str = "pending_apply") -> dict:
    return {
        "requestId": "request-1",
        "messages": [{"role": "assistant", "text": "ok", "canvasEdits": [edit]}],
        "proposals": [],
        "applyEdit": {
            "status": status,
            "conversationId": "conversation-1",
            "requestId": "request-1",
            "editId": edit["editId"],
            "kind": edit["kind"],
            "nodeId": edit["nodeId"],
            "expectedResultDigest": edit["expectedResultDigest"],
        },
    }


def conversation(turns: list[dict] | None = None) -> dict:
    return {
        "id": "conversation-1",
        "projectId": "project-1",
        "entrypoint": "workspace-chatbot-agent",
        "mode": "free-canvas-workspace",
        "interactionMode": "chat-experimental",
        "boundSkillIds": [],
        "messages": [],
        "turns": turns or [],
        "modelBinding": {
            "connectionId": "connection-1",
            "providerId": "volcengine-ark",
            "modelId": "doubao-seed-2-0-lite-260215",
        },
    }


def body(request_id: str = "request-1") -> PromptCardRuntimeMessageRequest:
    return PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1",
        "requestId": request_id,
        "content": "Create the plan",
        "projectId": "project-1",
        "mode": "free-canvas-workspace",
        "interactionMode": "chat-experimental",
        "documentWriteContext": {"operationKind": "document_create"},
        "workspaceContext": {
            "projectId": "project-1",
            "projectRevision": 1,
            "snapshot": {"nodes": []},
        },
    })


def descriptor() -> dict:
    return {
        "connectionId": "connection-1",
        "providerId": "volcengine-ark",
        "model": {
            "id": "doubao-seed-2-0-lite-260215",
            "displayName": "Doubao",
            "capabilities": {"input": ["text"], "toolCalling": True},
        },
    }


def test_canonical_nfc_json_and_uuid5_ids_match_golden_vectors() -> None:
    decomposed = ["conversation-1", "request-1", {"title": "Cafe\u0301"}]

    assert _canonical_nfc_json(decomposed) == '["conversation-1","request-1",{"title":"Café"}]'
    assert _deterministic_document_edit_ids(
        "conversation-1", "request-1", "document_create", None
    ) == (
        "8726b417-c1dc-5791-abee-3020f3f8909b",
        "8190b326-4c7f-5a8f-a9e8-357007b2825a",
    )


def test_gateway_exposes_ack_and_reconcile_under_existing_runtime_prefix(monkeypatch) -> None:
    calls: list[tuple] = []

    async def fake_ack(project_id, conversation_id, edit_id, body):
        calls.append(("ack", project_id, conversation_id, edit_id, body.request_id, body.status))
        return {"status": "applied"}

    async def fake_reconcile(project_id, conversation_id):
        calls.append(("reconcile", project_id, conversation_id))
        return {"status": "idle", "canvasEdits": []}

    monkeypatch.setattr(promptcard_runtime.runtime_service, "ack_document_edit", fake_ack)
    monkeypatch.setattr(promptcard_runtime.runtime_service, "reconcile_document_edits", fake_reconcile)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    ack = client.post(
        "/api/promptcard/runtime/projects/project-1/conversations/conversation-1/edits/edit-1/ack",
        json={"requestId": "request-1", "status": "failed", "errorCode": "save_failed"},
    )
    reconcile = client.post(
        "/api/promptcard/runtime/projects/project-1/conversations/conversation-1/edits/reconcile"
    )

    assert ack.status_code == 200
    assert ack.json() == {"status": "applied"}
    assert reconcile.status_code == 200
    assert calls == [
        ("ack", "project-1", "conversation-1", "edit-1", "request-1", "failed"),
        ("reconcile", "project-1", "conversation-1"),
    ]


@pytest.mark.anyio
async def test_send_stores_pending_before_return_and_response_loss_replays_without_provider(monkeypatch):
    calls: list[tuple[str, str, dict]] = []
    stored: dict = {}

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation([stored] if stored else [])
        if method == "GET" and path == "/api/projects/project-1":
            return project_with_node({"id": "other", "kind": "text"}, revision=1)
        if method == "POST" and path.endswith("/turns"):
            turn = kwargs["json"]
            stored.update({
                "requestId": turn["requestId"],
                "messages": [turn["userMessage"], turn["assistantMessage"]],
                "proposals": turn["proposals"],
                "modelSnapshot": turn["modelSnapshot"],
                "skillSnapshots": turn["skillSnapshots"],
                "applyEdit": turn["applyEdit"],
            })
            return stored
        raise AssertionError((method, path, kwargs))

    invokes = 0

    async def fake_invoke(_payload):
        nonlocal invokes
        invokes += 1
        return {"threadId": "conversation-1", "text": "ok", "proposals": [], "canvasEdits": [create_edit()]}

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    monkeypatch.setattr(promptcard_runtime, "resolve_text_model", lambda _: descriptor())
    monkeypatch.setattr(promptcard_runtime, "_resolve_skill_snapshots", lambda _: __import__("asyncio").sleep(0, result=[]))

    first = await promptcard_runtime.runtime_service.send_message(body(), None)
    replay = await promptcard_runtime.runtime_service.send_message(body(), None)

    assert invokes == 1
    assert first["canvasEdits"] == replay["canvasEdits"]
    assert stored["applyEdit"]["status"] == "pending_apply"
    assert stored["applyEdit"]["editId"] == first["canvasEdits"][0]["editId"]
    assert replay["diagnostics"]["idempotent"] is True


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("request_resource_ids", "runtime_resource_ids", "accepted"),
    [
        ([], ["resource-from-another-project"], False),
        (["resource-project-1"], ["resource-project-2"], False),
        (["resource-project-1"], ["resource-project-1"], True),
    ],
)
async def test_document_create_binds_linked_resources_to_authoritative_request_context(
    monkeypatch,
    request_resource_ids,
    runtime_resource_ids,
    accepted,
):
    saved: dict = {}

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation([])
        if method == "GET" and path == "/api/projects/project-1":
            return project_with_node({"id": "other", "kind": "text"}, revision=1)
        if method == "POST" and path.endswith("/turns"):
            saved.update(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(_payload):
        edit = create_edit()
        edit["linkedDocumentResourceIds"] = runtime_resource_ids
        return {
            "threadId": "conversation-1",
            "text": "ok",
            "proposals": [],
            "canvasEdits": [edit],
        }

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    monkeypatch.setattr(promptcard_runtime, "resolve_text_model", lambda _: descriptor())
    monkeypatch.setattr(
        promptcard_runtime,
        "_resolve_skill_snapshots",
        lambda _: __import__("asyncio").sleep(0, result=[]),
    )
    monkeypatch.setattr(
        promptcard_runtime,
        "_load_document_resources",
        lambda *_: __import__("asyncio").sleep(0, result=[]),
    )
    request = body().model_copy(update={"document_resource_ids": request_resource_ids})

    result = await promptcard_runtime.runtime_service.send_message(request, None)

    if accepted:
        assert result["canvasEdits"][0]["payload"]["linkedDocumentResourceIds"] == request_resource_ids
        assert saved["applyEdit"]["status"] == "pending_apply"
    else:
        assert result["canvasEdits"] == []
        assert "applyEdit" not in saved
    assert saved["proposals"] == []


@pytest.mark.anyio
async def test_changes_context_is_storage_derived_and_result_digest_is_gateway_computed(monkeypatch):
    source = document([{
        "id": "block-1",
        "type": "paragraph",
        "content": [{"text": "Café", "bold": True}],
    }], revision=4)
    node = {"id": "document-1", "kind": "document", "document": source}
    saved: dict = {}
    invoked: dict = {}

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation([])
        if method == "GET" and path == "/api/projects/project-1":
            return project_with_node(node, revision=8)
        if method == "POST" and path.endswith("/turns"):
            saved.update(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(payload):
        invoked.update(payload)
        context = payload["documentWriteContext"]
        return {
            "threadId": "conversation-1",
            "text": "ok",
            "proposals": [],
            "canvasEdits": [{
                "kind": "document_changes",
                "payload": {
                    "nodeId": context["nodeId"],
                    "baseRevision": context["baseRevision"],
                    "baseDigest": context["baseDigest"],
                    "operations": [{
                        "kind": "replace",
                        "blockId": "block-1",
                        "utf8Start": 0,
                        "utf8End": 3,
                        "text": "Bar",
                        "expectedTextDigest": context["blocks"][0]["expectedTextDigest"],
                    }],
                },
                "rationale": "Revise",
            }],
        }

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    monkeypatch.setattr(promptcard_runtime, "resolve_text_model", lambda _: descriptor())
    monkeypatch.setattr(promptcard_runtime, "_resolve_skill_snapshots", lambda _: __import__("asyncio").sleep(0, result=[]))
    request = body()
    request.document_write_context = {
        "operationKind": "document_changes",
        "nodeId": "document-1",
    }

    result = await promptcard_runtime.runtime_service.send_message(request, None)

    assert invoked["documentWriteContext"] == {
        "operationKind": "document_changes",
        "nodeId": "document-1",
        "baseRevision": 4,
        "baseDigest": source["digest"],
        "blocks": [{
            "blockId": "block-1",
            "text": "Café",
            "expectedTextDigest": "sha256:" + hashlib.sha256("Café".encode()).hexdigest(),
        }],
    }
    enriched = result["canvasEdits"][0]
    assert enriched["base"] == {
        "projectRevision": 8,
        "nodeRevision": 4,
        "nodeDigest": source["digest"],
    }
    assert enriched["payload"] == {"operations": invoked["documentWriteContext"] and enriched["payload"]["operations"]}
    assert enriched["editId"] == "fb129056-2d8a-51e0-9ac3-06409dcb60b3"
    assert enriched["expectedResultDigest"] == saved["applyEdit"]["expectedResultDigest"]
    assert enriched["expectedResultDigest"] == "sha256:cca3ff5660d258fbfd88f3a778ec4b1437c40ea7bc438943fd6f5c8ad39f1592"


@pytest.mark.anyio
async def test_new_request_is_blocked_before_skill_model_and_provider_when_pending(monkeypatch):
    edit_id, node_id = _deterministic_document_edit_ids(
        "conversation-1", "request-1", "document_create", None
    )
    edit = {**create_edit(), "editId": edit_id, "id": edit_id, "nodeId": node_id}

    async def fake_storage(method, path, **_kwargs):
        assert method == "GET"
        return conversation([saved_turn(edit)])

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_resolve_skill_snapshots", lambda _: (_ for _ in ()).throw(AssertionError("skills")))
    monkeypatch.setattr(promptcard_runtime, "resolve_text_model", lambda _: (_ for _ in ()).throw(AssertionError("model")))
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", lambda _: (_ for _ in ()).throw(AssertionError("provider")))

    with pytest.raises(HTTPException) as raised:
        await promptcard_runtime.runtime_service.send_message(body("request-2"), None)

    assert raised.value.status_code == 409
    assert raised.value.detail == "agent_apply_edit_pending"


@pytest.mark.anyio
async def test_ack_reloads_project_and_marks_saved_before_ack_applied(monkeypatch):
    edit_id, node_id = _deterministic_document_edit_ids(
        "conversation-1", "request-1", "document_create", None
    )
    raw = create_edit()
    edit = {**raw, "editId": edit_id, "id": edit_id, "nodeId": node_id}
    node = {
        "id": node_id,
        "kind": "document",
        "document": document(raw["blocks"]),
        "agentAppliedEdit": {
            "conversationId": "conversation-1",
            "requestId": "request-1",
            "editId": edit_id,
            "resultDigest": raw["expectedResultDigest"],
        },
    }
    patched: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation([saved_turn(edit)])
        if method == "GET" and path == "/api/projects/project-1":
            return project_with_node(node)
        if method == "PATCH" and path.endswith("/apply-edit"):
            patched.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    result = await promptcard_runtime.runtime_service.ack_document_edit(
        "project-1",
        "conversation-1",
        edit_id,
        PromptCardAgentEditAckRequest(requestId="request-1", status="failed", errorCode="browser_lost_state"),
    )

    assert result["status"] == "applied"
    assert "canvasEdits" not in result
    assert patched[0]["status"] == "applied"
    assert patched[0]["evidence"] == {
        "projectRevision": 3,
        "nodeId": node_id,
        "kind": "document",
        "resultDigest": raw["expectedResultDigest"],
    }


@pytest.mark.anyio
async def test_saved_document_recovery_rejects_duplicate_target_identity(monkeypatch):
    edit_id, node_id = _deterministic_document_edit_ids(
        "conversation-1", "request-1", "document_create", None
    )
    raw = create_edit()
    edit = {**raw, "editId": edit_id, "id": edit_id, "nodeId": node_id}
    saved_node = {
        "id": node_id,
        "kind": "document",
        "document": document(raw["blocks"]),
        "agentAppliedEdit": {
            "conversationId": "conversation-1",
            "requestId": "request-1",
            "editId": edit_id,
            "resultDigest": raw["expectedResultDigest"],
        },
    }
    duplicate_node = {
        "id": node_id,
        "kind": "document",
        "document": document([{
            "id": "other-block", "type": "paragraph", "content": [{"text": "Other"}],
        }]),
    }
    patched: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation([saved_turn(edit)])
        if method == "GET" and path == "/api/projects/project-1":
            return {
                "id": "project-1", "revision": 3,
                "freeCanvas": {"nodes": [saved_node, duplicate_node], "edges": [], "meta": {}},
            }
        if method == "PATCH" and path.endswith("/apply-edit"):
            patched.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    result = await promptcard_runtime.runtime_service.ack_document_edit(
        "project-1",
        "conversation-1",
        edit_id,
        PromptCardAgentEditAckRequest(
            requestId="request-1", status="failed", errorCode="browser_lost_state"
        ),
    )

    assert result["status"] == "failed_integrity"
    assert patched[0]["status"] == "failed_integrity"
    assert all(update["status"] != "applied" for update in patched)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("node", "expected"),
    [
        (None, "replay"),
        ({"id": "NODE", "kind": "text"}, "failed_integrity"),
        ({"id": "NODE", "kind": "document", "document": {"digest": "sha256:wrong"}}, "failed_integrity"),
        ({"id": "NODE", "kind": "document", "document": {"digest": "sha256:expected"}}, "failed_integrity"),
    ],
)
async def test_reconcile_create_absent_replays_but_mismatch_and_conflict_are_terminal(monkeypatch, node, expected):
    edit_id, node_id = _deterministic_document_edit_ids(
        "conversation-1", "request-1", "document_create", None
    )
    edit = {
        **create_edit(),
        "editId": edit_id,
        "id": edit_id,
        "nodeId": node_id,
        "base": {"projectRevision": 1},
        "expectedResultDigest": "sha256:expected",
    }
    if node is not None:
        node = {**node, "id": node_id}
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation([saved_turn(edit)])
        if method == "GET" and path == "/api/projects/project-1":
            return project_with_node(node, revision=1) if node else project_with_node({"id": "other", "kind": "text"}, revision=1)
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    result = await promptcard_runtime.runtime_service.reconcile_document_edits(
        "project-1", "conversation-1"
    )

    if expected == "replay":
        assert result["status"] == "pending_apply"
        assert result["canvasEdits"] == [edit]
        assert patches == []
    else:
        assert result["status"] == expected
        assert result["canvasEdits"] == []
        assert patches[0]["status"] == expected


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("target_state", "expected"),
    [
        ("same", "pending_apply"),
        ("changed", "failed_conflict"),
        ("missing", "failed_target_missing"),
    ],
)
async def test_reconcile_document_changes_replays_only_an_unchanged_base(monkeypatch, target_state, expected):
    source = document([{
        "id": "block-1",
        "type": "paragraph",
        "content": [{"text": "Before"}],
    }], revision=2)
    edit_id, node_id = _deterministic_document_edit_ids(
        "conversation-1", "request-1", "document_changes", "document-1"
    )
    edit = {
        "kind": "document_changes",
        "editId": edit_id,
        "id": edit_id,
        "nodeId": node_id,
        "expectedResultDigest": "sha256:" + "b" * 64,
        "base": {
            "projectRevision": 4,
            "nodeRevision": source["revision"],
            "nodeDigest": source["digest"],
        },
        "payload": {"operations": []},
    }
    ledger_turn = saved_turn(edit)
    if target_state == "same":
        nodes = [{"id": node_id, "kind": "document", "document": source}]
    elif target_state == "changed":
        nodes = [{
            "id": node_id,
            "kind": "document",
            "document": document([{
                "id": "block-1",
                "type": "paragraph",
                "content": [{"text": "Changed"}],
            }], revision=3),
        }]
    else:
        nodes = [{"id": "other", "kind": "text"}]
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation([ledger_turn])
        if method == "GET" and path == "/api/projects/project-1":
            return {
                "id": "project-1",
                "revision": 4,
                "freeCanvas": {"nodes": nodes, "edges": [], "meta": {}},
            }
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    result = await promptcard_runtime.runtime_service.reconcile_document_edits(
        "project-1", "conversation-1"
    )

    assert result["status"] == expected
    if expected == "pending_apply":
        assert result["canvasEdits"] == [edit]
        assert patches == []
    else:
        assert result["canvasEdits"] == []
        assert patches[0]["status"] == expected


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["document_create", "document_changes"])
async def test_reconcile_project_revision_drift_is_terminal_conflict_even_when_target_base_is_replayable(monkeypatch, kind):
    source = document([{
        "id": "block-1",
        "type": "paragraph",
        "content": [{"text": "Unchanged"}],
    }], revision=2)
    target_id = None if kind == "document_create" else "document-1"
    edit_id, node_id = _deterministic_document_edit_ids(
        "conversation-1", "request-1", kind, target_id
    )
    edit = {
        "kind": kind,
        "editId": edit_id,
        "id": edit_id,
        "nodeId": node_id,
        "expectedResultDigest": "sha256:" + "b" * 64,
        "base": {
            "projectRevision": 4,
            **(
                {"nodeRevision": source["revision"], "nodeDigest": source["digest"]}
                if kind == "document_changes"
                else {}
            ),
        },
        "payload": {"operations": []} if kind == "document_changes" else {"blocks": []},
    }
    nodes = (
        [{"id": node_id, "kind": "document", "document": source}]
        if kind == "document_changes"
        else [{"id": "other", "kind": "text"}]
    )
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation([saved_turn(edit)])
        if method == "GET" and path == "/api/projects/project-1":
            return {
                "id": "project-1",
                "revision": 5,
                "freeCanvas": {"nodes": nodes, "edges": [], "meta": {}},
            }
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    result = await promptcard_runtime.runtime_service.reconcile_document_edits(
        "project-1", "conversation-1"
    )

    assert result["status"] == "failed_conflict"
    assert result["canvasEdits"] == []
    assert patches[0]["evidence"]["code"] == "project_revision_changed"


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update({"forwardField": True}),
        lambda value: value.update({"version": 2}),
        lambda value: value.pop("revision"),
        lambda value: value.update({"revision": True}),
        lambda value: value["suggestions"][0].update({"forwardField": True}),
        lambda value: value["suggestions"][0].update({"kind": "replace"}),
        lambda value: value["suggestions"][0].update({"utf8End": 2}),
        lambda value: value["suggestions"][0].update({"content": []}),
        lambda value: value["suggestions"][0].update({"blockId": "missing-block"}),
    ],
)
def test_persisted_document_target_rejects_noncanonical_or_forward_suggestion_shapes(mutation):
    value = document_with_insert_suggestion()
    mutation(value)
    base = {
        "version": value.get("version"),
        "blocks": value.get("blocks"),
        "suggestions": value.get("suggestions"),
    }
    value["digest"] = digest(base)

    assert promptcard_runtime._persisted_document_digest(value) is None


def test_persisted_document_rejects_cross_mark_non_nfc_composition_before_utf8_authorization():
    blocks = [{
        "id": "block-1",
        "type": "paragraph",
        "content": [
            {"text": "e", "bold": True},
            {"text": "\u0301"},
        ],
    }]
    value = document(blocks, revision=1)

    assert promptcard_runtime._persisted_document_digest(value) is None


def test_persisted_document_nfc_projects_structural_and_suggestion_identities():
    raw_blocks = [{
        "id": "cafe\u0301-block",
        "type": "paragraph",
        "content": [{"text": "Cafe\u0301"}],
    }]
    raw_suggestions = [{
        "id": "sugge\u0301stion-1",
        "groupId": "groupe\u0301-1",
        "editId": "edite\u0301-1",
        "kind": "insert",
        "blockId": "cafe\u0301-block",
        "utf8Start": 0,
        "utf8End": 5,
        "content": [{"text": "Cafe\u0301"}],
    }]
    expected_digest = promptcard_runtime._planning_document_digest(
        raw_blocks,
        raw_suggestions,
    )
    value = {
        "version": 1,
        "blocks": raw_blocks,
        "revision": 2,
        "digest": expected_digest,
        "suggestions": raw_suggestions,
    }

    normalized = promptcard_runtime._normalize_persisted_document(value)

    assert normalized is not None
    assert normalized["digest"] == expected_digest
    assert normalized["blocks"][0]["id"] == "café-block"
    assert normalized["suggestions"][0] == {
        "id": "suggéstion-1",
        "groupId": "groupé-1",
        "editId": "edité-1",
        "kind": "insert",
        "blockId": "café-block",
        "utf8Start": 0,
        "utf8End": 5,
        "content": [{"text": "Café"}],
    }


def test_document_write_context_uses_the_strict_nfc_projected_document():
    raw_blocks = [{
        "id": "cafe\u0301-block",
        "type": "paragraph",
        "content": [{"text": "Cafe\u0301"}],
    }]
    persisted = {
        "version": 1,
        "blocks": raw_blocks,
        "revision": 2,
        "digest": promptcard_runtime._planning_document_digest(raw_blocks, []),
        "suggestions": [],
    }
    request = body()
    request.document_write_context = {
        "operationKind": "document_changes",
        "nodeId": "document-1",
    }

    result = promptcard_runtime._resolve_document_write_context(
        request,
        project_with_node({
            "id": "document-1",
            "kind": "document",
            "document": persisted,
        }),
    )

    assert result["blocks"] == [{
        "blockId": "café-block",
        "text": "Café",
        "expectedTextDigest": "sha256:" + hashlib.sha256("Café".encode()).hexdigest(),
    }]


@pytest.mark.anyio
async def test_reconcile_does_not_authorize_a_malformed_persisted_document(monkeypatch):
    source = document([{
        "id": "block-1",
        "type": "paragraph",
        "content": [{"text": "Before"}],
    }], revision=2)
    source["forwardField"] = True
    edit_id, node_id = _deterministic_document_edit_ids(
        "conversation-1", "request-1", "document_changes", "document-1"
    )
    edit = {
        "kind": "document_changes",
        "editId": edit_id,
        "id": edit_id,
        "nodeId": node_id,
        "expectedResultDigest": "sha256:" + "b" * 64,
        "base": {
            "projectRevision": 4,
            "nodeRevision": source["revision"],
            "nodeDigest": source["digest"],
        },
        "payload": {"operations": []},
    }
    patches: list[dict] = []

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path.endswith("/conversation-1"):
            return conversation([saved_turn(edit)])
        if method == "GET" and path == "/api/projects/project-1":
            return project_with_node({
                "id": node_id,
                "kind": "document",
                "document": source,
            }, revision=4)
        if method == "PATCH" and path.endswith("/apply-edit"):
            patches.append(kwargs["json"])
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)

    result = await promptcard_runtime.runtime_service.reconcile_document_edits(
        "project-1", "conversation-1"
    )

    assert result["status"] == "failed_integrity"
    assert result["canvasEdits"] == []
    assert patches[0]["evidence"]["code"] == "document_shape_invalid"
