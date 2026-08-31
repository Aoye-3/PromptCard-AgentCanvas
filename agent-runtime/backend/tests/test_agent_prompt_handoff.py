import hashlib

import pytest
from fastapi import HTTPException

from app.gateway import promptcard_runtime


def _digest(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _project(nodes):
    return {"freeCanvas": {"nodes": nodes}}


def _request(context):
    return promptcard_runtime.PromptCardRuntimeMessageRequest.model_validate({
        "content": "create prompt proposal",
        "projectId": "project-1",
        "interactionMode": "chat-experimental",
        "documentWriteContext": context,
    })


def _document_node():
    blocks = [{"id": "paragraph-1", "type": "paragraph", "content": [{"text": "Café scene"}]}]
    document = {
        "version": 1, "blocks": blocks, "revision": 4, "suggestions": [],
        "digest": promptcard_runtime._planning_document_digest(blocks, []),
    }
    return {"id": "document-1", "kind": "document", "document": document}


def _storyboard_node():
    sequence = {
        "id": "sequence-1", "name": "Opening", "description": "desc", "style": "film", "constraints": "safe",
        "rows": [{
            "id": "shot-1", "cutLabel": "1", "timeRange": "0-2s", "subject": "hero", "action": "walks",
            "scene": "street", "camera": "wide", "lighting": "dawn", "audio": "steps", "duration": "2s",
            "createdAt": 1, "updatedAt": 1,
        }], "createdAt": 1, "updatedAt": 1, "meta": {},
    }
    return {
        "id": "storyboard-1", "kind": "storyboard", "revision": 3,
        "sequence": sequence, "pendingFieldChanges": [],
        "digest": promptcard_runtime._storyboard_digest(sequence, []),
    }


def test_gateway_rebuilds_document_selection_basis_from_current_storage_project():
    context = {
        "operationKind": "prompt_handoff",
        "basis": {
            "kind": "document-selection", "nodeId": "document-1", "documentRevision": 4,
            "documentDigest": _document_node()["document"]["digest"], "blockId": "paragraph-1",
            "utf8Start": 0, "utf8End": len("Café".encode()), "selectedText": "Café",
            "selectedTextDigest": _digest("Café"),
        },
    }
    resolved = promptcard_runtime._resolve_document_write_context(_request(context), _project([_document_node()]))
    assert resolved == context


@pytest.mark.parametrize("mutation", [
    {"documentRevision": 3}, {"documentDigest": "sha256:" + "0" * 64},
    {"blockId": "missing"}, {"utf8End": 4}, {"selectedText": "Cafe"},
    {"selectedTextDigest": "sha256:" + "0" * 64}, {"endBlockId": "other"},
])
def test_gateway_visibly_rejects_stale_or_forged_document_selection(mutation):
    node = _document_node()
    basis = {
        "kind": "document-selection", "nodeId": "document-1", "documentRevision": 4,
        "documentDigest": node["document"]["digest"], "blockId": "paragraph-1",
        "utf8Start": 0, "utf8End": len("Café".encode()), "selectedText": "Café",
        "selectedTextDigest": _digest("Café"), **mutation,
    }
    with pytest.raises(HTTPException) as error:
        promptcard_runtime._resolve_document_write_context(
            _request({"operationKind": "prompt_handoff", "basis": basis}), _project([node])
        )
    assert error.value.status_code in {409, 413, 422}


def test_gateway_rebuilds_storyboard_shot_basis_and_rejects_pending_or_wrong_kind():
    node = _storyboard_node()
    shot_text = promptcard_runtime._canonical_nfc_json(node["sequence"]["rows"][0])
    basis = {
        "kind": "storyboard-shot", "nodeId": "storyboard-1", "storyboardRevision": 3,
        "storyboardDigest": node["digest"], "rowId": "shot-1", "shotDigest": _digest(shot_text),
    }
    resolved = promptcard_runtime._resolve_document_write_context(
        _request({"operationKind": "prompt_handoff", "basis": basis}), _project([node])
    )
    assert resolved["basis"] == {**basis, "shotText": shot_text}

    pending = {**node, "pendingFieldChanges": [{"id": "pending"}]}
    for invalid in [pending, {"id": "storyboard-1", "kind": "document", "document": _document_node()["document"]}]:
        with pytest.raises(HTTPException):
            promptcard_runtime._resolve_document_write_context(
                _request({"operationKind": "prompt_handoff", "basis": basis}), _project([invalid])
            )


@pytest.mark.anyio
@pytest.mark.parametrize("basis_kind", ["document-selection", "storyboard-shot"])
async def test_endpoint_rejects_duplicate_authority_before_model_invocation(
    monkeypatch,
    basis_kind,
):
    if basis_kind == "document-selection":
        authoritative = _document_node()
        duplicate = _document_node()
        duplicate["document"] = {**duplicate["document"], "revision": 5}
        basis = {
            "kind": "document-selection", "nodeId": "document-1", "documentRevision": 4,
            "documentDigest": authoritative["document"]["digest"], "blockId": "paragraph-1",
            "utf8Start": 0, "utf8End": len("Café".encode()), "selectedText": "Café",
            "selectedTextDigest": _digest("Café"),
        }
    else:
        authoritative = _storyboard_node()
        duplicate = _storyboard_node()
        duplicate["revision"] = 4
        shot_text = promptcard_runtime._canonical_nfc_json(
            authoritative["sequence"]["rows"][0]
        )
        basis = {
            "kind": "storyboard-shot", "nodeId": "storyboard-1", "storyboardRevision": 3,
            "storyboardDigest": authoritative["digest"], "rowId": "shot-1",
            "shotDigest": _digest(shot_text),
        }
    invocations = 0

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas-workspace",
                "interactionMode": "chat-experimental", "boundSkillIds": [], "messages": [],
                "modelBinding": {
                    "connectionId": "connection-1", "providerId": "deepseek",
                    "modelId": "deepseek-chat",
                },
            }
        if method == "GET" and path == "/api/projects/project-1":
            return _project([authoritative, duplicate])
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(_payload):
        nonlocal invocations
        invocations += 1
        return {
            "threadId": "conversation-1", "text": "must not run", "proposals": [],
            "canvasEdits": [], "diagnostics": {},
        }

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    monkeypatch.setattr(
        promptcard_runtime,
        "_resolve_skill_snapshots",
        lambda _body: __import__("asyncio").sleep(0, result=[]),
    )
    monkeypatch.setattr(promptcard_runtime, "resolve_text_model", lambda _: {
        "connectionId": "connection-1", "providerId": "deepseek",
        "model": {
            "id": "deepseek-chat", "displayName": "DeepSeek",
            "capabilities": {"input": ["text"]},
        },
    })
    body = promptcard_runtime.PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1",
        "content": "Create Prompt", "projectId": "project-1",
        "mode": "free-canvas-workspace", "interactionMode": "chat-experimental",
        "documentWriteContext": {"operationKind": "prompt_handoff", "basis": basis},
    })

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(body, None)

    assert error.value.status_code == 409
    assert invocations == 0


def test_gateway_accepts_only_one_authority_bound_pending_prompt_create_proposal():
    handoff = {
        "operationKind": "prompt_handoff",
        "basis": {
            "kind": "storyboard-shot", "nodeId": "storyboard-1", "storyboardRevision": 3,
            "storyboardDigest": "sha256:" + "a" * 64, "rowId": "shot-1",
            "shotDigest": "sha256:" + "b" * 64, "shotText": "authoritative shot",
        },
    }
    proposals = promptcard_runtime.validate_agent_proposals(
        [
            {"kind": "free_canvas_text_create", "userText": "first", "sourceNodeId": "forged"},
            {"kind": "free_canvas_text_create", "userText": "second"},
            {"kind": "prompt_library_write_proposal", "operation": "create", "presetDraft": {"label": "x", "content": "y"}},
        ],
        workspace_context=None, permission_scope="chat-experimental",
        interaction_mode="chat-experimental", expected_write_context=handoff,
    )
    assert len(proposals) == 1
    assert proposals[0]["kind"] == "free_canvas_text_create"
    assert proposals[0]["status"] == "pending"
    assert proposals[0]["handoffBasis"] == handoff["basis"]
    assert "sourceNodeId" not in proposals[0]


def test_gateway_rejects_model_reported_prompt_create_without_explicit_experimental_handoff():
    assert promptcard_runtime.validate_agent_proposals(
        [{"kind": "free_canvas_text_create", "userText": "bypass"}],
        workspace_context=None, permission_scope="workspace-chatbot-agent",
        interaction_mode="chat-experimental", expected_write_context=None,
    ) == []


def test_gateway_enforces_exact_utf8_prompt_handoff_output_budget():
    handoff = {
        "operationKind": "prompt_handoff",
        "basis": {
            "kind": "storyboard-shot", "nodeId": "storyboard-1", "storyboardRevision": 3,
            "storyboardDigest": "sha256:" + "a" * 64, "rowId": "shot-1",
            "shotDigest": "sha256:" + "b" * 64, "shotText": "authoritative shot",
        },
    }
    accepted = promptcard_runtime.validate_agent_proposals(
        [{"kind": "free_canvas_text_create", "userText": "a" * 100_000}],
        workspace_context=None, permission_scope="chat-experimental",
        interaction_mode="chat-experimental", expected_write_context=handoff,
    )
    rejected = promptcard_runtime.validate_agent_proposals(
        [{"kind": "free_canvas_text_create", "userText": "a" * 100_001}],
        workspace_context=None, permission_scope="chat-experimental",
        interaction_mode="chat-experimental", expected_write_context=handoff,
    )
    assert len(accepted) == 1
    assert len(accepted[0]["userText"].encode()) == 100_000
    assert rejected == []


@pytest.mark.anyio
@pytest.mark.parametrize("invalid_text", ["a" * 100_001, "e\u0301"], ids=["over-budget", "non-nfc"])
async def test_endpoint_visibly_persists_redacted_prompt_handoff_validation_failure(monkeypatch, invalid_text):
    calls = []
    node = _document_node()
    context = {
        "operationKind": "prompt_handoff",
        "basis": {
            "kind": "document-selection", "nodeId": "document-1", "documentRevision": 4,
            "documentDigest": node["document"]["digest"], "blockId": "paragraph-1",
            "utf8Start": 0, "utf8End": len("Café".encode()), "selectedText": "Café",
            "selectedTextDigest": _digest("Café"),
        },
    }

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas-workspace",
                "interactionMode": "chat-experimental", "boundSkillIds": [], "messages": [],
                "modelBinding": {"connectionId": "connection-1", "providerId": "deepseek", "modelId": "deepseek-chat"},
            }
        if method == "GET" and path == "/api/projects/project-1":
            return _project([node])
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(_payload):
        return {
            "threadId": "conversation-1", "text": "Prompt proposal created successfully.",
            "proposals": [{"kind": "free_canvas_text_create", "userText": invalid_text}],
            "canvasEdits": [], "diagnostics": {"providerRequestId": "must-not-persist"},
        }

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", fake_invoke)
    monkeypatch.setattr(promptcard_runtime, "_resolve_skill_snapshots", lambda _body: __import__("asyncio").sleep(0, result=[]))
    monkeypatch.setattr(promptcard_runtime, "resolve_text_model", lambda _: {
        "connectionId": "connection-1", "providerId": "deepseek",
        "model": {"id": "deepseek-chat", "displayName": "DeepSeek", "capabilities": {"input": ["text"]}},
    })
    body = promptcard_runtime.PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1", "content": "Create Prompt",
        "projectId": "project-1", "mode": "free-canvas-workspace", "interactionMode": "chat-experimental",
        "documentWriteContext": context,
    })

    result = await promptcard_runtime.runtime_service.send_message(body, None)

    assert result["proposals"] == []
    assert result["text"] == "Prompt 提案未通过校验，请重试。"
    assert result["diagnostics"]["promptHandoffValidation"] == {
        "status": "rejected", "received": 1, "accepted": 0, "reason": "invalid_output"
    }
    saved = next(call[2]["json"] for call in calls if call[0] == "POST" and call[1].endswith("/turns"))
    assert saved["assistantMessage"]["text"] == result["text"]
    assert saved["assistantMessage"]["diagnostics"]["promptHandoffValidation"] == result["diagnostics"]["promptHandoffValidation"]
    serialized = str(result["diagnostics"]) + str(saved["assistantMessage"]["diagnostics"])
    assert invalid_text not in serialized
    assert "must-not-persist" not in serialized


@pytest.mark.anyio
async def test_endpoint_accepts_exact_prompt_handoff_budget_without_validation_error(monkeypatch):
    node = _document_node()
    context = {
        "operationKind": "prompt_handoff",
        "basis": {
            "kind": "document-selection", "nodeId": "document-1", "documentRevision": 4,
            "documentDigest": node["document"]["digest"], "blockId": "paragraph-1",
            "utf8Start": 0, "utf8End": len("Café".encode()), "selectedText": "Café",
            "selectedTextDigest": _digest("Café"),
        },
    }

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return {
                "id": "conversation-1", "projectId": "project-1", "entrypoint": "workspace-chatbot-agent",
                "mode": "free-canvas-workspace", "interactionMode": "chat-experimental", "boundSkillIds": [],
                "messages": [], "modelBinding": {"connectionId": "connection-1", "providerId": "deepseek", "modelId": "deepseek-chat"},
            }
        if method == "GET" and path == "/api/projects/project-1":
            return _project([node])
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr(promptcard_runtime, "_storage_request", fake_storage)
    monkeypatch.setattr(promptcard_runtime, "_invoke_text_agent", lambda _payload: __import__("asyncio").sleep(0, result={
        "threadId": "conversation-1", "text": "Created.", "canvasEdits": [], "diagnostics": {},
        "proposals": [{"kind": "free_canvas_text_create", "userText": "a" * 100_000}],
    }))
    monkeypatch.setattr(promptcard_runtime, "_resolve_skill_snapshots", lambda _body: __import__("asyncio").sleep(0, result=[]))
    monkeypatch.setattr(promptcard_runtime, "resolve_text_model", lambda _: {
        "connectionId": "connection-1", "providerId": "deepseek",
        "model": {"id": "deepseek-chat", "displayName": "DeepSeek", "capabilities": {"input": ["text"]}},
    })
    body = promptcard_runtime.PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1", "content": "Create Prompt",
        "projectId": "project-1", "mode": "free-canvas-workspace", "interactionMode": "chat-experimental",
        "documentWriteContext": context,
    })

    result = await promptcard_runtime.runtime_service.send_message(body, None)
    assert len(result["proposals"]) == 1
    assert len(result["proposals"][0]["userText"].encode()) == 100_000
    assert "promptHandoffValidation" not in result["diagnostics"]
