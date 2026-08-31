from __future__ import annotations

import hashlib

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.gateway import promptcard_runtime
from app.gateway.promptcard_runtime import PromptCardRuntimeMessageRequest


def _document(text: str, *, revision: int = 3) -> dict:
    blocks = [{
        "id": "paragraph-1",
        "type": "paragraph",
        "content": [{"text": text}],
    }]
    suggestions: list[dict] = []
    return {
        "version": 1,
        "blocks": blocks,
        "revision": revision,
        "digest": promptcard_runtime._planning_document_digest(blocks, suggestions),
        "suggestions": suggestions,
    }


def _document_node(node_id: str, document: dict) -> dict:
    return {
        "id": node_id,
        "kind": "document",
        "title": "Authoritative plan",
        "document": document,
        "linkedDocumentResourceIds": [],
    }


def _project(nodes: list[dict], *, project_id: str = "project-1") -> dict:
    return {
        "id": project_id,
        "type": "free-canvas",
        "revision": 7,
        "freeCanvas": {"nodes": nodes, "edges": [], "meta": {}},
    }


def _conversation(*, interaction_mode: str = "chat-experimental") -> dict:
    return {
        "id": "conversation-1",
        "projectId": "project-1",
        "entrypoint": "workspace-chatbot-agent",
        "mode": "free-canvas",
        "interactionMode": interaction_mode,
        "boundSkillIds": [],
        "modelBinding": {
            "connectionId": "connection-1",
            "providerId": "deepseek",
            "modelId": "deepseek-chat",
        },
        "messages": [],
        "turns": [],
    }


def _body(node_ids: list[str]) -> PromptCardRuntimeMessageRequest:
    return PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1",
        "requestId": "request-1",
        "content": "Discuss the selected plan",
        "projectId": "project-1",
        "mode": "free-canvas",
        "explicitDocumentNodeIds": node_ids,
    })


def _stub_model(monkeypatch) -> None:
    monkeypatch.setattr(
        promptcard_runtime,
        "resolve_text_model",
        lambda _binding: {
            "connectionId": "connection-1",
            "providerId": "deepseek",
            "model": {
                "id": "deepseek-chat",
                "displayName": "DeepSeek",
                "capabilities": {"input": ["text"], "toolCalling": True},
            },
        },
    )


@pytest.mark.anyio
async def test_explicit_document_uses_only_authoritative_effective_draft(monkeypatch):
    source = _document("Draft wording")
    effective = promptcard_runtime._apply_document_change_operations(
        source,
        "edit-1",
        [{
            "kind": "replace",
            "blockId": "paragraph-1",
            "utf8Start": 0,
            "utf8End": len(b"Draft wording"),
            "text": "Approved wording",
            "expectedTextDigest": "sha256:" + hashlib.sha256(
                b"Draft wording"
            ).hexdigest(),
        }],
    )
    assert effective is not None
    project = _project([
        _document_node("document-selected", effective),
        _document_node("document-not-selected", _document("UNSELECTED BODY")),
    ])
    invoked: dict = {}

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return _conversation()
        if method == "GET" and path == "/api/projects/project-1":
            return project
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(payload):
        invoked.update(payload)
        return {
            "threadId": "conversation-1",
            "text": "ok",
            "proposals": [],
            "canvasEdits": [],
            "diagnostics": {},
        }

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    _stub_model(monkeypatch)

    await promptcard_runtime.runtime_service.send_message(
        _body(["document-selected"]),
        None,
    )

    assert invoked["content"].startswith("Discuss the selected plan")
    assert "document-selected" in invoked["content"]
    assert effective["digest"] in invoked["content"]
    assert "Approved wording" in invoked["content"]
    assert "Draft wording" not in invoked["content"]
    assert "UNSELECTED BODY" not in invoked["content"]
    assert "explicitDocumentNodeIds" not in invoked
    assert invoked["canvasNodeContext"] is None


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("project", "expected_detail"),
    [
        (_project([], project_id="project-other"), "document_context_unavailable"),
        (_project([]), "document_context_unavailable"),
        (_project([{"id": "document-selected", "kind": "text"}]), "document_context_unavailable"),
        (
            _project([
                _document_node(
                    "document-selected",
                    {**_document("Digest drift"), "digest": "sha256:" + "f" * 64},
                )
            ]),
            "document_integrity_failed",
        ),
        (
            _project([_document_node("document-selected", {
                "version": 1,
                "blocks": [{"id": "bad", "type": "html", "content": []}],
                "revision": 1,
                "digest": "sha256:" + "a" * 64,
                "suggestions": [],
            })]),
            "document_integrity_failed",
        ),
        (
            _project([
                _document_node("document-selected", _document("First")),
                _document_node("document-selected", _document("Second")),
            ]),
            "document_integrity_failed",
        ),
    ],
    ids=[
        "storage-project-mismatch",
        "missing",
        "non-document",
        "digest-drift",
        "malformed-ast",
        "duplicate-authoritative-node",
    ],
)
async def test_explicit_document_rejects_unavailable_or_corrupt_authority(
    monkeypatch,
    project,
    expected_detail,
):
    invoked = False

    async def fake_storage(method, path, **_kwargs):
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return _conversation()
        if method == "GET" and path == "/api/projects/project-1":
            return project
        raise AssertionError((method, path))

    async def fake_invoke(_payload):
        nonlocal invoked
        invoked = True
        raise AssertionError("invalid explicit Document must fail before invocation")

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(
            _body(["document-selected"]),
            None,
        )

    assert error.value.detail == expected_detail
    assert invoked is False


@pytest.mark.anyio
async def test_explicit_document_rejects_duplicate_ids_before_project_resolution(monkeypatch):
    project_requested = False

    async def fake_storage(method, path, **_kwargs):
        nonlocal project_requested
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return _conversation()
        if method == "GET" and path.startswith("/api/projects/"):
            project_requested = True
        raise AssertionError((method, path))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    body = _body(["document-selected"])
    body.explicit_document_node_ids = ["document-selected", "document-selected"]

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(
            body,
            None,
        )

    assert error.value.detail == "explicit_document_node_ids_duplicate"
    assert project_requested is False


@pytest.mark.anyio
async def test_explicit_document_is_rejected_outside_experimental_mode(monkeypatch):
    project_requested = False

    async def fake_storage(method, path, **_kwargs):
        nonlocal project_requested
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return _conversation(interaction_mode="prompt-edit")
        if method == "GET" and path.startswith("/api/projects/"):
            project_requested = True
        raise AssertionError((method, path))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(
            _body(["document-selected"]),
            None,
        )

    assert error.value.detail == "explicit_document_context_scope_invalid"
    assert project_requested is False


@pytest.mark.anyio
async def test_explicit_document_budget_counts_utf8_bytes(monkeypatch):
    project = _project([_document_node("document-selected", _document("éé"))])

    async def fake_storage(method, path, **_kwargs):
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return _conversation()
        if method == "GET" and path == "/api/projects/project-1":
            return project
        raise AssertionError((method, path))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "MAX_DOCUMENT_MODEL_TEXT_CHARS", 3)

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(
            _body(["document-selected"]),
            None,
        )

    assert error.value.status_code == 413
    assert error.value.detail == "document_context_too_large"


@pytest.mark.parametrize(
    "node_ids",
    [
        ["document-1", "document-2", "document-3", "document-4", "document-5", "document-6"],
        ["../private-path"],
        ["document-" + "x" * 192],
    ],
    ids=["more-than-five", "invalid-characters", "overlong-id"],
)
def test_explicit_document_request_rejects_invalid_identity_lists(node_ids):
    with pytest.raises(ValidationError):
        PromptCardRuntimeMessageRequest.model_validate({
            "content": "Discuss it",
            "projectId": "project-1",
            "explicitDocumentNodeIds": node_ids,
        })


def test_explicit_document_request_rejects_duplicate_ids_during_model_validation():
    with pytest.raises(ValidationError):
        PromptCardRuntimeMessageRequest.model_validate({
            "content": "Discuss it",
            "projectId": "project-1",
            "explicitDocumentNodeIds": ["document-1", "document-1"],
        })


@pytest.mark.anyio
async def test_duplicate_explicit_document_without_conversation_has_no_side_effects(
    monkeypatch,
):
    body = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Discuss it",
        "projectId": "project-1",
        "explicitDocumentNodeIds": ["document-1"],
    })
    body.explicit_document_node_ids = ["document-1", "document-1"]
    monkeypatch.setattr(
        promptcard_runtime,
        "_storage_request",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("duplicate IDs must fail before conversation creation")
        ),
    )
    monkeypatch.setattr(
        promptcard_runtime,
        "_resolve_skill_snapshots",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("duplicate IDs must fail before Skill resolution")
        ),
    )

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(body, None)

    assert error.value.detail == "explicit_document_node_ids_duplicate"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("revision", "accepted"),
    [
        (9_007_199_254_740_991, True),
        (9_007_199_254_740_992, False),
    ],
    ids=["safe-max", "unsafe"],
)
async def test_explicit_document_requires_a_safe_revision(
    monkeypatch,
    revision,
    accepted,
):
    project = _project([
        _document_node("document-selected", _document("Safe revision", revision=revision))
    ])
    invoked: dict = {}

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return _conversation()
        if method == "GET" and path == "/api/projects/project-1":
            return project
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(payload):
        invoked.update(payload)
        return {
            "threadId": "conversation-1",
            "text": "ok",
            "proposals": [],
            "canvasEdits": [],
            "diagnostics": {},
        }

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    _stub_model(monkeypatch)

    if accepted:
        await promptcard_runtime.runtime_service.send_message(
            _body(["document-selected"]),
            None,
        )
        assert f"revision={revision}" in invoked["content"]
    else:
        with pytest.raises(HTTPException) as error:
            await promptcard_runtime.runtime_service.send_message(
                _body(["document-selected"]),
                None,
            )
        assert error.value.status_code == 409
        assert error.value.detail == "document_integrity_failed"
        assert invoked == {}


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("left_size", "right_size", "accepted"),
    [
        (250_000, 250_000, True),
        (250_000, 250_001, False),
    ],
    ids=["exactly-500000", "500001"],
)
async def test_explicit_document_aggregate_utf8_budget_across_documents(
    monkeypatch,
    left_size,
    right_size,
    accepted,
):
    project = _project([
        _document_node("document-left", _document("a" * left_size)),
        _document_node("document-right", _document("b" * right_size)),
    ])
    invoked = False

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return _conversation()
        if method == "GET" and path == "/api/projects/project-1":
            return project
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(_payload):
        nonlocal invoked
        invoked = True
        return {
            "threadId": "conversation-1",
            "text": "ok",
            "proposals": [],
            "canvasEdits": [],
            "diagnostics": {},
        }

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    _stub_model(monkeypatch)

    if accepted:
        await promptcard_runtime.runtime_service.send_message(
            _body(["document-left", "document-right"]),
            None,
        )
        assert invoked is True
    else:
        with pytest.raises(HTTPException) as error:
            await promptcard_runtime.runtime_service.send_message(
                _body(["document-left", "document-right"]),
                None,
            )
        assert error.value.status_code == 413
        assert error.value.detail == "document_context_too_large"
        assert invoked is False


@pytest.mark.anyio
async def test_explicit_document_and_write_context_share_one_project_read(monkeypatch):
    project = _project([
        _document_node("document-selected", _document("Authoritative text"))
    ])
    project_reads = 0
    invoked: dict = {}

    async def fake_storage(method, path, **kwargs):
        nonlocal project_reads
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return _conversation()
        if method == "GET" and path == "/api/projects/project-1":
            project_reads += 1
            return project
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(payload):
        invoked.update(payload)
        return {
            "threadId": "conversation-1",
            "text": "ok",
            "proposals": [],
            "canvasEdits": [],
            "diagnostics": {},
        }

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    _stub_model(monkeypatch)
    body = _body(["document-selected"])
    body.document_write_context = {
        "operationKind": "document_changes",
        "nodeId": "document-selected",
    }

    await promptcard_runtime.runtime_service.send_message(body, None)

    assert project_reads == 1
    assert invoked["documentWriteContext"]["nodeId"] == "document-selected"
    assert "Authoritative text" in invoked["content"]
