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
