from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.gateway.model_management.catalog import model_by_id
from app.gateway.model_management.connection_store import default_connection_store_path
from app.gateway.promptcard_runtime import (
    PromptCardRuntimeMessageRequest,
    _allowed_tool_names,
    _resolve_canvas_node_context,
    _resolve_skill_snapshots,
    validate_agent_canvas_edits,
    validate_agent_proposals,
)
from app.gateway.routers import promptcard_runtime


@pytest.mark.anyio
async def test_selected_public_skill_lookup_is_casefolded_before_snapshot_resolution(
    monkeypatch,
):
    canonical = "SKL-00000000000000000000000002"
    calls = []

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == "/api/skills":
            return {"skills": [{
                "id": "external-skill-id",
                "referenceCode": canonical,
                "source": "external",
            }]}
        if path == "/api/skill-host-snapshots/local-agent":
            assert kwargs["params"] == {"skillId": canonical}
            return {
                "skillId": "external-skill-id",
                "skillReferenceCode": canonical,
                "revision": 1,
                "digest": "sha256:" + "a" * 64,
                "instructions": "Pinned",
                "references": [],
                "declaredCapabilities": {},
            }
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    body = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Use the selected skill",
        "selectedSkillIds": [canonical.lower()],
        "canvasNodeContext": {"mode": "prompt-library"},
    })

    snapshots = await _resolve_skill_snapshots(body)

    assert snapshots[0]["skillReferenceCode"] == canonical
    assert [call[1] for call in calls] == [
        "/api/skills",
        "/api/skill-host-snapshots/local-agent",
    ]


def test_prompt_library_search_tool_is_only_available_in_explicit_retrieval_mode():
    completion = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Complete it",
        "permissionScope": "workspace-chatbot-agent",
        "canvasNodeContext": {
            "mode": "complete", "targetNodeId": "text-1",
            "referenceNodeIds": [], "mentions": [],
        },
    })
    retrieval = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Find matching prompts",
        "permissionScope": "workspace-chatbot-agent",
        "canvasNodeContext": {
            "mode": "prompt-library", "targetNodeId": None,
            "referenceNodeIds": [], "mentions": [],
        },
    })

    assert _allowed_tool_names(completion) == {"emit_canvas_prompt_edit"}
    assert _allowed_tool_names(retrieval) == {"search_prompt_library"}


def test_prompt_library_retrieval_context_is_read_only():
    body = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Find matching prompts", "projectId": "project-1",
        "workspaceContext": {
            "projectId": "project-1",
            "snapshot": {"nodes": [
                {"id": "text-1", "kind": "text", "title": "Reference"},
            ]},
        },
        "canvasNodeContext": {
            "mode": "prompt-library", "targetNodeId": None,
            "referenceNodeIds": ["text-1"],
            "mentions": [{"nodeId": "text-1", "label": "Reference"}],
        },
    })

    resolved = _resolve_canvas_node_context(body)

    assert resolved["mode"] == "prompt-library"
    assert resolved["target"] is None
    assert resolved["references"] == [{"nodeId": "text-1", "name": "Reference"}]


def test_canvas_completion_is_validated_as_a_direct_edit_without_pending_status():
    target = {
        "id": "text-1",
        "kind": "text",
        "userText": "Original",
        "segments": [{
            "id": "segment-1",
            "source": "user",
            "text": "Original",
            "color": "#111827",
            "updatedAt": 7,
        }],
    }
    workspace_context = {"snapshot": {"nodes": [target]}}
    canvas_context = {
        "mode": "complete",
        "targetNodeId": "text-1",
        "targetNode": target,
    }

    edits = validate_agent_canvas_edits(
        [{
            "kind": "free_canvas_text_insertions",
            "insertions": [{
                "text": " inserted",
                "reason": "Add detail",
                "anchor": {
                    "type": "segment",
                    "segmentId": "segment-1",
                    "position": "after",
                },
            }],
            "rationale": "Complete the prompt",
        }],
        workspace_context=workspace_context,
        permission_scope="workspace-chatbot-agent",
        canvas_node_context=canvas_context,
    )

    assert edits[0]["kind"] == "free_canvas_text_insertions"
    assert edits[0]["nodeId"] == "text-1"
    assert edits[0]["baseSegmentsDigest"].startswith("sha256:")
    assert "status" not in edits[0]


def test_ark_multimodal_text_model_is_in_catalog():
    model = model_by_id("doubao-seed-2-0-lite-260215")

    assert model is not None
    assert model["providerId"] == "volcengine-ark"
    assert model["modality"] == "chat"
    assert model["capabilities"]["input"] == ["text", "image", "pdf"]


def test_ark_pro_text_model_is_in_catalog():
    model = model_by_id("doubao-seed-2-0-pro-260215")

    assert model == {
        "id": "doubao-seed-2-0-pro-260215",
        "providerId": "volcengine-ark",
        "displayName": "Doubao Seed 2.0 Pro",
        "modality": "chat",
        "capabilities": {
            "input": ["text", "image"],
            "toolCalling": True,
            "contextWindow": 256_000,
        },
    }


def test_connection_store_uses_promptcard_runtime_state_dir(monkeypatch):
    state_dir = Path(__file__).parent / ".runtime-state-test"
    monkeypatch.setenv("PROMPTCARD_RUNTIME_STATE_DIR", str(state_dir))

    assert default_connection_store_path() == state_dir / "promptcard-model-connections.json"


def test_selected_canvas_text_node_only_accepts_update_for_selected_node():
    context = {
        "snapshot": {
            "selectedNodeId": "text-1",
            "selectedNode": {"id": "text-1", "kind": "text", "userText": "old"},
            "nodes": [
                {"id": "text-1", "kind": "text"},
                {"id": "text-2", "kind": "text"},
            ],
        }
    }
    proposals = [
        {
            "kind": "free_canvas_text_update",
            "id": "keep",
            "nodeId": "text-1",
            "mode": "replace",
            "userText": "new",
        },
        {
            "kind": "free_canvas_text_update",
            "id": "drop",
            "nodeId": "text-2",
            "mode": "replace",
            "userText": "wrong target",
        },
        {
            "kind": "free_canvas_text_create",
            "id": "drop-create",
            "userText": "must not create while a text node is selected",
        },
    ]

    validated = validate_agent_proposals(
        proposals,
        workspace_context=context,
        permission_scope="workspace-chatbot-agent",
    )

    assert [proposal["id"] for proposal in validated] == ["keep"]
    assert validated[0]["editMode"] == "rewrite_all"


def test_explicit_canvas_context_forces_append_and_rejects_reference_updates():
    context = {
        "snapshot": {
            "nodes": [
                {"id": "text-1", "kind": "text", "revision": 3, "presetText": "Template", "userText": "Target prompt", "segments": [{"id": "target", "source": "user", "text": "Target prompt", "color": "#1"}]},
                {"id": "text-2", "kind": "text", "revision": 4, "presetText": "", "userText": "Reference", "segments": [{"id": "reference", "source": "user", "text": "Reference", "color": "#2"}]},
            ]
        }
    }
    canvas_context = {
        "mode": "complete", "targetNodeId": "text-1", "referenceNodeIds": ["text-2"], "mentions": []
    }
    proposals = [
        {"kind": "free_canvas_text_insertions", "id": "keep", "rationale": "Add", "insertions": [{"text": "Added", "reason": "Complete", "anchor": {"type": "text", "segmentId": "target", "text": "Target", "position": "after"}}]},
        {
            "kind": "free_canvas_text_insertions", "id": "drop", "rationale": "Change",
            "insertions": [{
                "text": "Changed", "reason": "Wrong node",
                "anchor": {
                    "type": "text", "segmentId": "reference",
                    "text": "Reference", "position": "after",
                },
            }],
        },
    ]

    validated = validate_agent_proposals(
        proposals,
        workspace_context=context,
        permission_scope="workspace-chatbot-agent",
        canvas_node_context=canvas_context,
    )

    assert [proposal["id"] for proposal in validated] == ["keep"]
    assert validated[0]["baseSegmentsDigest"].startswith("sha256:")


def test_canvas_complete_rejects_missing_and_ambiguous_anchors():
    context = {"snapshot": {"nodes": [{
        "id": "text-1", "kind": "text", "revision": 1,
        "segments": [
            {"id": "one", "source": "user", "text": "repeat repeat", "color": "#1"},
            {"id": "two", "source": "user", "text": "other", "color": "#2"},
        ],
    }]}}
    proposals = [
        {"kind": "free_canvas_text_insertions", "id": "missing", "rationale": "x", "insertions": [{"text": "a", "reason": "x", "anchor": {"type": "segment", "segmentId": "gone", "position": "after"}}]},
        {"kind": "free_canvas_text_insertions", "id": "ambiguous", "rationale": "x", "insertions": [{"text": "a", "reason": "x", "anchor": {"type": "text", "segmentId": "one", "text": "repeat", "position": "after"}}]},
    ]

    assert validate_agent_proposals(
        proposals, workspace_context=context, permission_scope="workspace-chatbot-agent",
        canvas_node_context={"mode": "complete", "targetNodeId": "text-1", "referenceNodeIds": [], "mentions": []},
    ) == []


def test_explicit_canvas_context_discards_model_controlled_edit_fields():
    context = {"snapshot": {"nodes": [{
        "id": "text-1", "kind": "text", "revision": 3,
        "presetText": "Template", "userText": "Target",
        "segments": [{"id": "target", "source": "user", "text": "Target", "color": "#1"}],
    }]}}
    canvas_context = {
        "mode": "complete", "targetNodeId": "text-1",
        "referenceNodeIds": [], "mentions": [],
        "targetNode": context["snapshot"]["nodes"][0],
        "referenceNodes": [],
    }

    validated = validate_agent_proposals(
        [{"kind": "free_canvas_text_insertions", "id": "keep", "rationale": "Add", "insertions": [{"text": "Added", "reason": "Complete", "anchor": {"type": "text", "segmentId": "target", "text": "Target", "position": "after"}}]}],
        workspace_context=context,
        permission_scope="workspace-chatbot-agent",
        canvas_node_context=canvas_context,
    )

    assert validated[0]["nodeId"] == "text-1"
    assert validated[0]["baseNodeRevision"] == 3
    assert validated[0]["baseSegmentsDigest"].startswith("sha256:")


def test_explicit_canvas_rewrite_selection_preserves_the_requested_range():
    context = {"snapshot": {"nodes": [{
        "id": "text-1", "kind": "text", "revision": 3,
        "presetText": "Template", "userText": "cold blue light",
    }]}}
    canvas_context = {
        "mode": "rewrite", "targetNodeId": "text-1", "referenceNodeIds": [], "mentions": [],
        "selection": {
            "start": 0,
            "end": 4,
            "selectedText": "cold",
            "baseContentDigest": "sha256:" + hashlib.sha256(b"cold blue light").hexdigest(),
        },
    }

    validated = validate_agent_proposals(
        [{"kind": "free_canvas_text_create", "id": "rewrite", "userText": "warm", "rationale": "Rewrite"}],
        workspace_context=context,
        permission_scope="workspace-chatbot-agent",
        canvas_node_context=canvas_context,
    )

    assert validated[0]["sourceNodeId"] == "text-1"
    assert validated[0]["basis"]["baseNodeRevision"] == 3


def test_explicit_canvas_context_without_target_rejects_all_canvas_mutations():
    validated = validate_agent_proposals(
        [{"kind": "free_canvas_text_create", "id": "create", "userText": "New"}],
        workspace_context={"snapshot": {"nodes": []}},
        permission_scope="workspace-chatbot-agent",
        canvas_node_context={"mode": "complete", "targetNodeId": None, "referenceNodeIds": [], "mentions": []},
    )

    assert validated == []


def test_canvas_context_requires_the_request_project_snapshot():
    body = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Complete it",
        "projectId": "project-1",
        "workspaceContext": {
            "projectId": "project-2",
            "snapshot": {"nodes": [{"id": "text-1", "kind": "text"}]},
        },
        "canvasNodeContext": {
            "mode": "complete", "targetNodeId": "text-1",
            "referenceNodeIds": [], "mentions": [],
        },
    })

    with pytest.raises(HTTPException) as error:
        _resolve_canvas_node_context(body)

    assert error.value.status_code == 409
    assert error.value.detail == "canvas_node_context_project_mismatch"


@pytest.mark.parametrize("reference_ids", ["text-2", ["text-2"] * 11])
def test_canvas_context_rejects_invalid_reference_collections(reference_ids):
    body = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Complete it", "projectId": "project-1",
        "workspaceContext": {
            "projectId": "project-1",
            "snapshot": {"nodes": [
                {"id": "text-1", "kind": "text"},
                {"id": "text-2", "kind": "text"},
            ]},
        },
        "canvasNodeContext": {
            "mode": "complete", "targetNodeId": "text-1",
            "referenceNodeIds": reference_ids, "mentions": [],
        },
    })

    with pytest.raises(HTTPException) as error:
        _resolve_canvas_node_context(body)

    assert error.value.status_code == 422
    assert error.value.detail == "canvas_node_context_nodes_invalid"


def test_canvas_context_uses_snapshot_names_and_rejects_unattached_mentions():
    body = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Use @Reference", "projectId": "project-1",
        "workspaceContext": {
            "projectId": "project-1",
            "snapshot": {"nodes": [
                {"id": "text-1", "kind": "text", "title": "Target"},
                {"id": "text-2", "kind": "text", "title": "Reference"},
                {"id": "text-3", "kind": "text", "title": "Not attached"},
            ]},
        },
        "canvasNodeContext": {
            "mode": "complete", "targetNodeId": "text-1",
            "referenceNodeIds": ["text-2"],
            "mentions": [{"nodeId": "text-2", "label": "Spoofed"}],
        },
    })

    resolved = _resolve_canvas_node_context(body)

    assert resolved["mentions"] == [{"nodeId": "text-2", "label": "Reference"}]
    assert resolved["target"] == {"nodeId": "text-1", "name": "Target"}
    assert resolved["references"] == [{"nodeId": "text-2", "name": "Reference"}]

    body.canvas_node_context["mentions"] = [{"nodeId": "text-3", "label": "Not attached"}]
    with pytest.raises(HTTPException) as error:
        _resolve_canvas_node_context(body)
    assert error.value.detail == "canvas_node_context_mentions_invalid"


def test_canvas_context_allows_image_references_but_requires_a_text_target():
    body = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Use this image", "projectId": "project-1",
        "workspaceContext": {
            "projectId": "project-1",
            "snapshot": {"nodes": [
                {"id": "image-1", "kind": "image", "title": "Reference image", "assetId": "asset-1"},
            ]},
        },
        "canvasNodeContext": {
            "mode": "complete", "targetNodeId": None,
            "referenceNodeIds": ["image-1"], "mentions": [],
        },
    })

    resolved = _resolve_canvas_node_context(body)

    assert resolved["references"] == [{"nodeId": "image-1", "name": "Reference image"}]
    assert resolved["referenceNodes"] == [
        {"id": "image-1", "kind": "image", "title": "Reference image", "assetId": "asset-1"},
    ]

    body.canvas_node_context["targetNodeId"] = "image-1"
    body.canvas_node_context["referenceNodeIds"] = []
    with pytest.raises(HTTPException) as error:
        _resolve_canvas_node_context(body)
    assert error.value.detail == "canvas_node_context_node_invalid"


@pytest.mark.anyio
async def test_canvas_image_reference_is_loaded_as_agent_attachment(monkeypatch):
    captured = {}

    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas-workspace",
                "modelBinding": {
                    "connectionId": "connection-1", "providerId": "volcengine-ark",
                    "modelId": "doubao-seed-2-0-lite-260215",
                },
                "messages": [],
            }
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    class FakeStorage:
        def load_asset(self, asset_id):
            assert asset_id == "asset-1"
            return SimpleNamespace(content=b"image-bytes", content_type="image/png")

        def close(self):
            captured["storageClosed"] = True

    async def fake_invoke(payload):
        captured["payload"] = payload
        return {
            "threadId": "thread-1",
            "text": "I can see the image.",
            "proposals": [],
            "canvasEdits": [],
            "diagnostics": {},
        }

    monkeypatch.setattr("app.gateway.promptcard_runtime.PromptCardStorageClient", FakeStorage)
    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    monkeypatch.setattr("app.gateway.promptcard_runtime._invoke_text_agent", fake_invoke)
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime._resolve_skill_snapshots",
        lambda _: __import__("asyncio").sleep(0, result=[]),
    )
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.resolve_text_model",
        lambda _: {
            "connectionId": "connection-1",
            "providerId": "volcengine-ark",
            "model": {
                "id": "doubao-seed-2-0-lite-260215",
                "displayName": "Doubao Seed 2.0 Lite",
                "capabilities": {"input": ["text", "image"], "toolCalling": True},
            },
        },
    )
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "content": "Use this image",
        "projectId": "project-1", "mode": "free-canvas-workspace",
        "workspaceContext": {
            "projectId": "project-1",
            "snapshot": {"nodes": [{
                "id": "image-1", "kind": "image", "title": "Reference image",
                "assetId": "asset-1",
            }]},
        },
        "canvasNodeContext": {
            "mode": "complete", "targetNodeId": None,
            "referenceNodeIds": ["image-1"], "mentions": [],
        },
    })

    result = await promptcard_runtime.runtime_service.send_message(body, None)

    assert result["text"] == "I can see the image."
    assert captured["payload"]["attachments"] == [{
        "assetId": "asset-1",
        "contentType": "image/png",
        "data": "aW1hZ2UtYnl0ZXM=",
    }]
    assert captured["storageClosed"] is True


@pytest.mark.anyio
async def test_canvas_image_reference_rejects_a_text_only_model(monkeypatch):
    async def fake_storage(method, path, **kwargs):
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas-workspace",
                "modelBinding": {
                    "connectionId": "connection-1", "providerId": "deepseek",
                    "modelId": "deepseek-chat",
                },
                "messages": [],
            }
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime._resolve_skill_snapshots",
        lambda _: __import__("asyncio").sleep(0, result=[]),
    )
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.resolve_text_model",
        lambda _: {
            "connectionId": "connection-1",
            "providerId": "deepseek",
            "model": {
                "id": "deepseek-chat",
                "displayName": "DeepSeek Chat",
                "capabilities": {"input": ["text"], "toolCalling": True},
            },
        },
    )
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime._invoke_text_agent",
        lambda _: (_ for _ in ()).throw(AssertionError("agent invocation must be skipped")),
    )
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "content": "Use this image",
        "projectId": "project-1", "mode": "free-canvas-workspace",
        "workspaceContext": {
            "projectId": "project-1",
            "snapshot": {"nodes": [{
                "id": "image-1", "kind": "image", "title": "Reference image",
                "assetId": "asset-1",
            }]},
        },
        "canvasNodeContext": {
            "mode": "complete", "targetNodeId": None,
            "referenceNodeIds": ["image-1"], "mentions": [],
        },
    })

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(body, None)

    assert error.value.status_code == 422
    assert error.value.detail == "agent_model_image_input_unsupported"


def test_canvas_selection_requires_exact_text_and_content_digest():
    text = "cold blue light"
    body = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Rewrite it", "projectId": "project-1",
        "workspaceContext": {
            "projectId": "project-1",
            "snapshot": {"nodes": [{
                "id": "text-1", "kind": "text", "userText": text,
            }]},
        },
        "canvasNodeContext": {
            "mode": "rewrite", "targetNodeId": "text-1",
            "referenceNodeIds": [], "mentions": [],
            "selection": {
                "start": 0, "end": 4, "selectedText": "cold",
                "baseContentDigest": "sha256:stale",
            },
        },
    })

    with pytest.raises(HTTPException) as error:
        _resolve_canvas_node_context(body)

    assert error.value.status_code == 409
    assert error.value.detail == "canvas_node_context_selection_stale"


def test_canvas_selection_uses_browser_utf16_offsets():
    text = "🙂cold light"
    body = PromptCardRuntimeMessageRequest.model_validate({
        "content": "Rewrite it", "projectId": "project-1",
        "workspaceContext": {
            "projectId": "project-1",
            "snapshot": {"nodes": [{
                "id": "text-1", "kind": "text", "userText": text,
            }]},
        },
        "canvasNodeContext": {
            "mode": "rewrite", "targetNodeId": "text-1",
            "referenceNodeIds": [], "mentions": [],
            "selection": {
                "start": 2, "end": 6, "selectedText": "cold",
                "baseContentDigest": "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest(),
            },
        },
    })

    resolved = _resolve_canvas_node_context(body)

    assert resolved["selection"]["selectedText"] == "cold"


def test_canvas_without_selected_text_node_only_accepts_text_create():
    context = {
        "snapshot": {
            "selectedNodeId": None,
            "selectedNode": None,
            "nodes": [{"id": "image-1", "kind": "image"}],
        }
    }
    proposals = [
        {
            "kind": "free_canvas_text_update",
            "id": "drop-update",
            "nodeId": "missing",
            "mode": "replace",
            "userText": "wrong",
        },
        {
            "kind": "free_canvas_text_create",
            "id": "keep-create",
            "title": "Agent Prompt",
            "userText": "new prompt",
        },
    ]

    validated = validate_agent_proposals(
        proposals,
        workspace_context=context,
        permission_scope="workspace-chatbot-agent",
    )

    assert [proposal["id"] for proposal in validated] == ["keep-create"]


def test_canvas_complete_only_accepts_anchored_insertions_with_reasons():
    context = {
        "projectId": "project-1",
        "snapshot": {"nodes": [{
            "id": "text-1", "kind": "text", "revision": 3,
            "presetText": "Template",
            "segments": [
                {"id": "preset-1", "source": "preset", "text": "Template", "color": "#111"},
                {"id": "user-1", "source": "user", "text": "Existing", "color": "#222"},
            ],
        }]},
    }
    proposals = [{
        "kind": "free_canvas_text_insertions", "id": "keep", "rationale": "Add atmosphere",
        "insertions": [{
            "text": "Warm rim light", "reason": "matches the request",
            "anchor": {"type": "segment", "segmentId": "user-1", "position": "after"},
        }],
    }, {
        "kind": "free_canvas_text_insertions", "id": "drop", "rationale": "Missing reason",
        "insertions": [{
            "text": "Drop", "reason": "", "anchor": {"type": "segment", "segmentId": "user-1", "position": "after"},
        }],
    }]

    validated = validate_agent_proposals(
        proposals,
        workspace_context=context,
        permission_scope="workspace-chatbot-agent",
        canvas_node_context={"mode": "complete", "targetNodeId": "text-1", "referenceNodeIds": [], "mentions": []},
    )

    assert [proposal["id"] for proposal in validated] == ["keep"]
    assert validated[0]["nodeId"] == "text-1"
    assert validated[0]["baseSegmentsDigest"].startswith("sha256:")


def test_canvas_rewrite_converts_new_edit_tool_output_to_derived_text_create():
    context = {
        "snapshot": {"nodes": [{
            "id": "text-1", "kind": "text", "revision": 3,
            "segments": [{"id": "user-1", "source": "user", "text": "Old", "color": "#222"}],
        }]},
    }
    validated = validate_agent_canvas_edits(
        [{"kind": "free_canvas_text_create", "id": "keep", "userText": "New", "rationale": "Clearer"}],
        workspace_context=context,
        permission_scope="workspace-chatbot-agent",
        canvas_node_context={"mode": "rewrite", "targetNodeId": "text-1", "referenceNodeIds": [], "mentions": []},
    )

    assert validated[0]["sourceNodeId"] == "text-1"
    assert validated[0]["basis"]["baseSegmentsDigest"].startswith("sha256:")
    assert "status" not in validated[0]


def test_prompt_library_scope_only_accepts_additive_create():
    proposals = [
        {
            "kind": "prompt_library_write_proposal",
            "id": "keep",
            "operation": "create",
            "presetDraft": {
                "type": "style",
                "category": "agent",
                "label": "Cinematic",
                "content": "cinematic light",
            },
        },
        {
            "kind": "prompt_library_write_proposal",
            "id": "drop",
            "operation": "update",
            "targetPresetId": "preset-1",
            "presetDraft": {
                "type": "style",
                "category": "agent",
                "label": "Overwrite",
                "content": "not allowed",
            },
        },
    ]

    validated = validate_agent_proposals(
        proposals,
        workspace_context=None,
        permission_scope="prompt-library-agent",
    )

    assert [proposal["id"] for proposal in validated] == ["keep"]


def test_messages_endpoint_keeps_public_contract(monkeypatch):
    async def fake_send_message(body: PromptCardRuntimeMessageRequest, request):
        assert body.content == "补全提示词"
        return {
            "threadId": "thread-1",
            "conversationId": "conversation-1",
            "requestId": "request-1",
            "text": "已生成待确认修改。",
            "proposals": [],
            "canvasEdits": [{
                "id": "canvas-edit-1",
                "kind": "free_canvas_text_insertions",
                "nodeId": "text-1",
                "insertions": [],
            }],
            "diagnostics": {"orchestrator": "pi"},
        }

    monkeypatch.setattr(promptcard_runtime.runtime_service, "send_message", fake_send_message)
    app = FastAPI()
    app.include_router(promptcard_runtime.router)

    with TestClient(app) as client:
        response = client.post(
            "/api/promptcard/runtime/messages",
            json={
                "content": "补全提示词",
                "mode": "free-canvas-workspace",
                "sessionKey": "workspace:free-canvas:project-1",
                "projectId": "project-1",
                "workspaceContext": {
                    "contextId": "free-canvas:project-1:text-1",
                    "mode": "free-canvas-workspace",
                    "projectId": "project-1",
                    "projectTitle": "Project",
                    "snapshot": {
                        "selectedNodeId": "text-1",
                        "selectedNode": {"id": "text-1", "kind": "text"},
                        "nodes": [{"id": "text-1", "kind": "text"}],
                    },
                },
            },
        )

    assert response.status_code == 200
    assert response.json()["threadId"] == "thread-1"
    assert response.json()["conversationId"] == "conversation-1"
    assert response.json()["requestId"] == "request-1"
    assert response.json()["canvasEdits"] == [{
        "id": "canvas-edit-1",
        "kind": "free_canvas_text_insertions",
        "nodeId": "text-1",
        "insertions": [],
    }]
    assert response.json()["diagnostics"]["orchestrator"] == "pi"


def test_internal_text_model_endpoint_returns_provider_descriptor(monkeypatch):
    monkeypatch.setenv("PROMPTCARD_INTERNAL_TOKEN", "internal-test-token")
    async def fake_internal_text_model():
        return {
            "connectionId": "connection-1",
            "providerId": "deepseek",
            "model": {
                "id": "deepseek-chat",
                "displayName": "DeepSeek Chat",
                "modality": "chat",
                "integrationGroup": {
                    "id": "pi-native",
                    "displayName": "PI 原生",
                    "kind": "pi-native",
                },
            },
        }

    monkeypatch.setattr(
        promptcard_runtime.runtime_service,
        "internal_text_model",
        fake_internal_text_model,
    )
    app = FastAPI()
    app.include_router(promptcard_runtime.router)

    with TestClient(app) as client:
        response = client.get(
            "/api/promptcard/runtime/internal/text-model",
            headers={"X-PromptCard-Internal-Token": "internal-test-token"},
        )

    assert response.status_code == 200
    assert response.json()["model"]["integrationGroup"]["kind"] == "pi-native"
    assert "credential" not in response.json()


def test_internal_text_model_endpoint_rejects_local_session_only(monkeypatch):
    monkeypatch.setenv("PROMPTCARD_INTERNAL_TOKEN", "internal-test-token")
    app = FastAPI()
    app.include_router(promptcard_runtime.router)

    with TestClient(app) as client:
        response = client.get("/api/promptcard/runtime/internal/text-model")

    assert response.status_code == 401
    assert response.json()["detail"] == "internal_auth_required"


def test_conversation_model_endpoint_uses_gateway_validation_boundary(monkeypatch):
    captured = {}

    async def fake_update(project_id, conversation_id, model_binding):
        captured.update(
            project_id=project_id,
            conversation_id=conversation_id,
            model_binding=model_binding,
        )
        return {"id": conversation_id, "modelBinding": model_binding}

    monkeypatch.setattr(
        promptcard_runtime.runtime_service,
        "update_conversation_model",
        fake_update,
    )
    app = FastAPI()
    app.include_router(promptcard_runtime.router)

    with TestClient(app) as client:
        response = client.patch(
            "/api/promptcard/runtime/projects/project-1/conversations/conversation-1/model",
            json={"modelBinding": {
                "connectionId": "connection-1",
                "providerId": "deepseek",
                "modelId": "deepseek-chat",
            }},
        )

    assert response.status_code == 200
    assert captured == {
        "project_id": "project-1",
        "conversation_id": "conversation-1",
        "model_binding": {
            "connectionId": "connection-1",
            "providerId": "deepseek",
            "modelId": "deepseek-chat",
        },
    }


def test_pi_native_proxy_injects_stored_credential_and_streams(monkeypatch):
    captured = {}
    monkeypatch.setenv("PROMPTCARD_INTERNAL_TOKEN", "internal-test-token")

    def fake_resolve(connection_id, model_id):
        assert connection_id == "connection-1"
        assert model_id == "deepseek-chat"
        return {
            "providerId": "deepseek",
            "apiBase": "https://api.deepseek.com",
            "credential": "stored-secret",
            "modelId": "deepseek-chat",
        }

    class FakeUpstream:
        status_code = 200
        headers = {"content-type": "text/event-stream"}

        async def aiter_raw(self):
            yield b'data: {"ok":true}\n\n'

        async def aclose(self):
            captured["upstreamClosed"] = True

    class FakeClient:
        def __init__(self, *, timeout):
            captured["timeout"] = timeout

        def build_request(self, method, url, *, content, headers):
            captured.update(
                method=method,
                url=url,
                content=content,
                headers=headers,
            )
            return object()

        async def send(self, request, *, stream):
            captured["stream"] = stream
            return FakeUpstream()

        async def aclose(self):
            captured["clientClosed"] = True

    monkeypatch.setattr(promptcard_runtime, "resolve_pi_native_proxy", fake_resolve)
    monkeypatch.setattr(promptcard_runtime.httpx, "AsyncClient", FakeClient)
    app = FastAPI()
    app.include_router(promptcard_runtime.router)

    with TestClient(app) as client:
        response = client.post(
            "/api/promptcard/runtime/internal/pi-proxy/connection-1/chat/completions",
            headers={
                "Authorization": "Bearer must-not-forward",
                "X-PromptCard-Internal-Token": "internal-test-token",
            },
            json={"model": "deepseek-chat", "stream": True},
        )

    assert response.status_code == 200
    assert captured["url"] == "https://api.deepseek.com/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer stored-secret"
    assert captured["stream"] is True
    assert captured["upstreamClosed"] is True
    assert captured["clientClosed"] is True


def test_media_analysis_endpoint_keeps_selected_asset_boundary(monkeypatch):
    async def fake_analyze(body, request):
        assert body.asset_id == "asset-selected"
        assert body.content_type == "image/png"
        assert body.prompt_language_mode == "mixed"
        return {
            "threadId": "media-thread-1",
            "text": "低饱和电影光。",
            "proposals": [],
            "diagnostics": {"attachmentCount": 1},
        }

    monkeypatch.setattr(promptcard_runtime.runtime_service, "analyze_media", fake_analyze)
    app = FastAPI()
    app.include_router(promptcard_runtime.router)

    with TestClient(app) as client:
        response = client.post(
            "/api/promptcard/runtime/media-analysis",
            json={
                "assetId": "asset-selected",
                "contentType": "image/png",
                "analysisType": "style",
                "content": "分析风格",
                "promptLanguageMode": "mixed",
            },
        )

    assert response.status_code == 200
    assert response.json()["diagnostics"]["attachmentCount"] == 1


@pytest.mark.anyio
async def test_persistent_message_loads_history_skills_and_saves_turn(monkeypatch):
    calls = []

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas",
                "modelBinding": {"connectionId": "connection-1", "providerId": "deepseek", "modelId": "deepseek-chat"},
                "messages": [
                    {"role": "user", "text": "Earlier question"},
                    {"role": "assistant", "text": "Earlier answer"},
                ],
            }
        if method == "GET" and path == "/api/skills":
            return {"skills": [{
                "id": "SKL-canvas-prompt-editor", "slug": "canvas-prompt-editor",
                "source": "builtin", "capabilityId": "canvas.prompt.edit",
                    "toolDependencies": ["emit_canvas_prompt_edit"], "revision": 1,
                    "referenceCode": "SKL-00000000000000000000000001",
            }]}
        if method == "GET" and path == "/api/skill-host-snapshots/local-agent":
            return {
                "skillId": "SKL-canvas-prompt-editor",
                "skillReferenceCode": "SKL-00000000000000000000000001",
                "revision": 1, "digest": "sha256:" + "a" * 64,
                "instructions": "Protect templates.", "references": [],
                "declaredCapabilities": {
                    "tools": ["emit_canvas_prompt_edit"], "network": [],
                    "executables": [], "models": [], "other": [],
                },
            }
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(payload):
        assert [message["content"][0]["text"] for message in payload["history"]] == ["Earlier question", "Earlier answer"]
        assert payload["skillSnapshots"][0]["skillId"] == "SKL-canvas-prompt-editor"
        return {"threadId": "thread-1", "text": "New answer", "proposals": [], "diagnostics": {}}

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    monkeypatch.setattr("app.gateway.promptcard_runtime._invoke_text_agent", fake_invoke)
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.resolve_text_model",
        lambda _: {
            "connectionId": "connection-1", "providerId": "deepseek",
            "model": {
                "id": "deepseek-chat", "displayName": "DeepSeek Chat",
                "capabilities": {"input": ["text"], "toolCalling": True},
            },
        },
    )
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1",
        "content": "New question", "projectId": "project-1", "mode": "free-canvas",
        "workspaceContext": {"projectId": "project-1", "snapshot": {
            "selectedNodeId": "text-1",
            "selectedNode": {
                "id": "text-1", "kind": "text", "revision": 3,
                "title": "Target", "presetText": "Template", "userText": "User",
            },
            "nodes": [
                {
                    "id": "text-1", "kind": "text", "revision": 3,
                    "title": "Target", "presetText": "Template", "userText": "User",
                },
                {"id": "text-2", "kind": "text", "title": "Reference"},
            ],
        }},
        "canvasNodeContext": {
            "mode": "complete", "targetNodeId": "text-1",
            "referenceNodeIds": ["text-2"],
            "mentions": [{"nodeId": "text-2", "label": "Reference"}],
        },
    })

    result = await promptcard_runtime.runtime_service.send_message(body, None)

    assert result["conversationId"] == "conversation-1"
    saved = next(call for call in calls if call[0] == "POST" and call[1].endswith("/turns"))
    assert saved[2]["json"]["requestId"] == "request-1"
    assert saved[2]["json"]["skillSnapshots"][0]["digest"] == "sha256:" + "a" * 64
    assert saved[2]["json"]["modelSnapshot"] == {
        "connectionId": "connection-1", "providerId": "deepseek", "modelId": "deepseek-chat",
        "displayName": "DeepSeek Chat", "capabilities": {"input": ["text"], "toolCalling": True},
    }
    assert saved[2]["json"]["userMessage"]["canvasNodeContext"] == {
        "mode": "complete",
        "target": {"nodeId": "text-1", "name": "Target"},
        "references": [{"nodeId": "text-2", "name": "Reference"}],
        "mentions": [{"nodeId": "text-2", "label": "Reference"}],
    }
    assert "targetNode" not in saved[2]["json"]["userMessage"]["canvasNodeContext"]


@pytest.mark.anyio
async def test_rejected_canvas_edit_does_not_claim_that_a_modification_was_generated(monkeypatch):
    async def fake_storage(method, path, **kwargs):
        if method == "GET":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas-workspace",
                "modelBinding": {"connectionId": "connection-1", "providerId": "deepseek", "modelId": "deepseek-chat"},
                "messages": [],
            }
        if method == "POST" and path.endswith("/turns"):
            return kwargs["json"]
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(_payload):
        return {
            "threadId": "thread-1",
            "text": "画布修改已生成。",
            "proposals": [],
            "canvasEdits": [{
                "kind": "free_canvas_text_insertions",
                "insertions": [{
                    "text": "Added", "reason": "More detail",
                    "anchor": {"type": "segment", "segmentId": "segment-1", "position": "inside"},
                }],
                "rationale": "Complete it",
            }],
            "diagnostics": {},
        }

    async def fake_skills(_body):
        return []

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    monkeypatch.setattr("app.gateway.promptcard_runtime._invoke_text_agent", fake_invoke)
    monkeypatch.setattr("app.gateway.promptcard_runtime._resolve_skill_snapshots", fake_skills)
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.resolve_text_model",
        lambda _: {
            "connectionId": "connection-1", "providerId": "deepseek",
            "model": {"id": "deepseek-chat", "displayName": "DeepSeek Chat", "capabilities": {"input": ["text"]}},
        },
    )
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1",
        "content": "Complete it", "projectId": "project-1", "mode": "free-canvas-workspace",
        "workspaceContext": {"projectId": "project-1", "snapshot": {"nodes": [{
            "id": "text-1", "kind": "text", "title": "Target", "userText": "",
            "segments": [{"id": "segment-1", "source": "preset", "text": "Original", "color": "#ef4423", "updatedAt": 1}],
        }]}},
        "canvasNodeContext": {
            "mode": "complete", "targetNodeId": "text-1", "referenceNodeIds": [], "mentions": [],
        },
    })

    result = await promptcard_runtime.runtime_service.send_message(body, None)

    assert result["canvasEdits"] == []
    assert result["text"] == "画布修改未通过校验，请重试。"
    assert result["diagnostics"]["canvasEditValidation"] == {"received": 1, "accepted": 0}


@pytest.mark.anyio
async def test_persistent_message_reuses_saved_turn_before_document_model_skill_or_provider_resolution(
    monkeypatch,
):
    saved_snapshot = {
        "connectionId": "connection-previous", "providerId": "deepseek", "modelId": "deepseek-chat",
        "displayName": "DeepSeek Chat", "capabilities": {"input": ["text"]},
    }

    async def fake_storage(method, path, **kwargs):
        assert method == "GET"
        assert path == "/api/agent-conversations/conversation-1"
        return {
            "id": "conversation-1", "projectId": "project-1",
            "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas",
            "modelBinding": {"connectionId": "connection-new", "providerId": "deepseek", "modelId": "deepseek-reasoner"},
            "turns": [{
                "requestId": "request-1",
                "messages": [
                    {
                        "role": "user",
                        "text": "Question",
                        "documentAttachments": [{"resourceId": "document-now-trashed"}],
                    },
                    {"role": "assistant", "text": "Saved answer"},
                ],
                "proposals": [{"id": "proposal-1"}],
                "modelSnapshot": saved_snapshot,
            }],
        }

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.resolve_text_model",
        lambda _: (_ for _ in ()).throw(AssertionError("model resolution must be skipped")),
    )
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime._invoke_text_agent",
        lambda _: (_ for _ in ()).throw(AssertionError("agent invocation must be skipped")),
    )
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1",
        "content": "Question", "projectId": "project-1", "mode": "free-canvas",
        "documentResourceIds": ["document-now-trashed"],
    })
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime._load_document_resources",
        lambda *_: (_ for _ in ()).throw(
            AssertionError("trashed document resolution must be skipped")
        ),
    )
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime._resolve_skill_snapshots",
        lambda *_: (_ for _ in ()).throw(
            AssertionError("Skill resolution must be skipped")
        ),
    )

    result = await promptcard_runtime.runtime_service.send_message(body, None)

    assert result == {
        "threadId": "conversation-1", "conversationId": "conversation-1", "requestId": "request-1",
        "text": "Saved answer", "proposals": [{"id": "proposal-1"}], "canvasEdits": [],
        "diagnostics": {"idempotent": True, "modelSnapshot": saved_snapshot},
    }


@pytest.mark.anyio
async def test_experimental_conversation_reloads_bound_skills_and_current_pin_each_turn(
    monkeypatch,
):
    conversation = {
        "id": "conversation-1",
        "projectId": "project-1",
        "entrypoint": "workspace-chatbot-agent",
        "mode": "free-canvas",
        "interactionMode": "chat-experimental",
        "boundSkillIds": ["SKL-00000000000000000000000002"],
        "modelBinding": {
            "connectionId": "connection-1",
            "providerId": "deepseek",
            "modelId": "deepseek-chat",
        },
        "messages": [],
        "turns": [],
    }
    pin_revision = 0
    invocations = []

    async def fake_storage(method, path, **kwargs):
        nonlocal pin_revision
        if method == "GET" and path == "/api/agent-conversations/conversation-1":
            return conversation
        if method == "GET" and path == "/api/skills":
            return {"skills": [{
                "id": "external-skill-id",
                "referenceCode": "SKL-00000000000000000000000002",
                "source": "external",
            }]}
        if method == "GET" and path == "/api/skill-host-snapshots/local-agent":
            pin_revision += 1
            return {
                "skillId": "external-skill-id",
                "skillReferenceCode": "SKL-00000000000000000000000002",
                "revision": pin_revision,
                "digest": "sha256:" + str(pin_revision) * 64,
                "instructions": f"Pinned revision {pin_revision}",
                "references": [],
                "declaredCapabilities": {
                    "tools": [], "network": [], "executables": [], "models": [], "other": [],
                },
            }
        if method == "POST" and path.endswith("/turns"):
            turn = {
                "requestId": kwargs["json"]["requestId"],
                "messages": [kwargs["json"]["userMessage"], kwargs["json"]["assistantMessage"]],
                "proposals": kwargs["json"]["proposals"],
                "skillSnapshots": kwargs["json"]["skillSnapshots"],
                "modelSnapshot": kwargs["json"]["modelSnapshot"],
            }
            conversation["turns"].append(turn)
            conversation["messages"].extend(turn["messages"])
            return turn
        raise AssertionError((method, path, kwargs))

    async def fake_invoke(payload):
        invocations.append(payload)
        return {
            "threadId": "conversation-1",
            "text": f"Answer {len(invocations)}",
            "proposals": [],
            "canvasEdits": [],
            "diagnostics": {},
        }

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    monkeypatch.setattr("app.gateway.promptcard_runtime._invoke_text_agent", fake_invoke)
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.resolve_text_model",
        lambda _: {
            "connectionId": "connection-1", "providerId": "deepseek",
            "model": {"id": "deepseek-chat", "displayName": "DeepSeek", "capabilities": {"input": ["text"]}},
        },
    )

    for request_id, content in (("request-1", "First"), ("request-2", "Second")):
        body = PromptCardRuntimeMessageRequest.model_validate({
            "conversationId": "conversation-1",
            "requestId": request_id,
            "content": content,
            "projectId": "project-1",
            "mode": "free-canvas",
            "selectedSkillIds": ["SKL-browser-one-shot-must-not-win"],
            "canvasNodeContext": {
                "mode": "complete", "targetNodeId": "stale-prompt-target",
                "referenceNodeIds": [], "mentions": [],
            },
        })
        await promptcard_runtime.runtime_service.send_message(body, None)

    assert [payload["interactionMode"] for payload in invocations] == [
        "chat-experimental", "chat-experimental",
    ]
    assert [payload["skillSnapshots"][0]["revision"] for payload in invocations] == [1, 2]
    assert [turn["skillSnapshots"][0]["digest"] for turn in conversation["turns"]] == [
        "sha256:" + "1" * 64,
        "sha256:" + "2" * 64,
    ]
    assert [message["content"][0]["text"] for message in invocations[1]["history"]] == [
        "First", "Answer 1",
    ]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "failure",
    [
        HTTPException(status_code=403, detail="skill_host_disabled"),
        HTTPException(status_code=403, detail="skill_revision_untrusted"),
        HTTPException(status_code=410, detail="skill_archived"),
        HTTPException(status_code=413, detail="skill_snapshot_too_large"),
        HTTPException(status_code=403, detail="skill_tool_dependency_not_allowed"),
    ],
    ids=["disabled", "untrusted", "archived", "over-budget", "missing-tool"],
)
async def test_experimental_bound_skill_failure_precedes_model_invocation(monkeypatch, failure):
    async def fake_storage(method, path, **kwargs):
        if path == "/api/agent-conversations/conversation-1":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas",
                "interactionMode": "chat-experimental", "boundSkillIds": ["SKL-00000000000000000000000002"],
                "messages": [], "turns": [],
            }
        if path == "/api/skills":
            return {"skills": [{
                "id": "external-skill-id", "referenceCode": "SKL-00000000000000000000000002", "source": "external",
            }]}
        if path == "/api/skill-host-snapshots/local-agent":
            raise failure
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.resolve_text_model",
        lambda _: (_ for _ in ()).throw(AssertionError("model resolution must be skipped")),
    )
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime._invoke_text_agent",
        lambda _: (_ for _ in ()).throw(AssertionError("agent invocation must be skipped")),
    )
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1",
        "content": "Use the bound Skill", "projectId": "project-1", "mode": "free-canvas",
    })

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(body, None)

    assert error.value.detail == failure.detail


@pytest.mark.anyio
async def test_persistent_message_rejects_conversation_entrypoint_mismatch(monkeypatch):
    async def fake_storage(method, path, **kwargs):
        assert method == "GET"
        return {
            "id": "conversation-1", "projectId": "project-1",
            "entrypoint": "prompt-library-agent", "mode": "free-canvas",
            "messages": [],
        }

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1",
        "content": "New question", "projectId": "project-1", "mode": "free-canvas",
        "permissionScope": "workspace-chatbot-agent",
    })

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(body, None)

    assert error.value.status_code == 409
    assert error.value.detail == "agent_conversation_entrypoint_mismatch"


@pytest.mark.anyio
async def test_persistent_message_resolves_its_saved_model_binding(monkeypatch):
    binding = {
        "connectionId": "connection-ark",
        "providerId": "volcengine-ark",
        "modelId": "doubao-seed-2-0-lite-260215",
    }

    async def fake_storage(method, path, **kwargs):
        if method == "GET":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas",
                "modelBinding": binding, "messages": [],
            }
        if method == "POST":
            return kwargs["json"]
        raise AssertionError((method, path))

    async def fake_invoke(payload):
        assert payload["modelDescriptor"]["connectionId"] == "connection-ark"
        assert payload["modelDescriptor"]["model"]["id"] == binding["modelId"]
        return {"threadId": "thread-1", "text": "Answer", "proposals": [], "diagnostics": {}}

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    monkeypatch.setattr("app.gateway.promptcard_runtime._invoke_text_agent", fake_invoke)
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime.resolve_text_model",
        lambda value: {
            "connectionId": value["connectionId"], "providerId": value["providerId"],
            "model": {"id": value["modelId"], "displayName": "Ark", "modality": "chat", "integrationGroup": {"id": "volcengine-ark-sdk", "displayName": "Ark SDK", "kind": "sdk"}},
        },
    )
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "content": "Question", "projectId": "project-1", "mode": "free-canvas",
    })

    await promptcard_runtime.runtime_service.send_message(body, None)


@pytest.mark.anyio
async def test_persistent_message_persists_the_default_model_binding_once(monkeypatch):
    calls = []

    async def fake_storage(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if method == "GET":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas",
                "modelBinding": None, "messages": [],
            }
        if method == "PATCH":
            return {"id": "conversation-1", "modelBinding": kwargs["json"]["modelBinding"]}
        if method == "POST":
            return kwargs["json"]
        raise AssertionError((method, path))

    descriptor = {
        "connectionId": "connection-deepseek", "providerId": "deepseek",
        "model": {"id": "deepseek-chat", "displayName": "DeepSeek", "modality": "chat", "integrationGroup": {"id": "pi-native", "displayName": "PI", "kind": "pi-native"}},
    }
    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    monkeypatch.setattr("app.gateway.promptcard_runtime.resolve_text_model", lambda _: descriptor)
    monkeypatch.setattr(
        "app.gateway.promptcard_runtime._invoke_text_agent",
        lambda payload: __import__("asyncio").sleep(0, result={"threadId": "thread-1", "text": "Answer", "proposals": [], "diagnostics": {}}),
    )
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "content": "Question", "projectId": "project-1", "mode": "free-canvas",
    })

    await promptcard_runtime.runtime_service.send_message(body, None)

    patch = next(call for call in calls if call[0] == "PATCH")
    assert patch[1] == "/api/projects/project-1/agent-conversations/conversation-1/model"
    assert patch[2]["json"] == {"modelBinding": {
        "connectionId": "connection-deepseek", "providerId": "deepseek", "modelId": "deepseek-chat",
    }}


@pytest.mark.anyio
async def test_persistent_message_rejects_skill_with_disallowed_tool_dependency(monkeypatch):
    async def fake_storage(method, path, **kwargs):
        if path == "/api/agent-conversations/conversation-1":
            return {
                "id": "conversation-1", "projectId": "project-1",
                "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas",
                "messages": [],
            }
        if path == "/api/skills":
            return {"skills": [{
                "id": "SKL-external", "source": "external",
                "referenceCode": "SKL-00000000000000000000000002",
            }]}
        if path == "/api/skill-host-snapshots/local-agent":
            return {
                "skillId": "external", "skillReferenceCode": "SKL-00000000000000000000000002",
                "revision": 2, "digest": "sha256:" + "b" * 64,
                "instructions": "Unsafe exact revision", "references": [],
                "declaredCapabilities": {
                    "tools": ["delete_project"], "network": [], "executables": [],
                    "models": [], "other": [],
                },
            }
        raise AssertionError((method, path, kwargs))

    monkeypatch.setattr("app.gateway.promptcard_runtime._storage_request", fake_storage)
    body = PromptCardRuntimeMessageRequest.model_validate({
        "conversationId": "conversation-1", "requestId": "request-1",
        "content": "Use this Skill", "projectId": "project-1", "mode": "free-canvas",
        "permissionScope": "workspace-chatbot-agent", "selectedSkillIds": ["SKL-external"],
    })

    with pytest.raises(HTTPException) as error:
        await promptcard_runtime.runtime_service.send_message(body, None)

    assert error.value.status_code == 403
    assert error.value.detail == "skill_tool_dependency_not_allowed"
