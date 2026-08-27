from __future__ import annotations

import pytest

from app.gateway.model_management.connection_store import (
    ModelConnectionStore,
    ModelManagementError,
)
from app.gateway.model_management.contracts import AssignmentRequest, ConnectionRequest
from app.gateway.text_generation import service


class MemoryCredentialStore:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.lookups: list[str] = []

    def set(self, connection_id: str, secret: str) -> None:
        self.values[connection_id] = secret

    def get(self, connection_id: str) -> str | None:
        self.lookups.append(connection_id)
        return self.values.get(connection_id)

    def delete(self, connection_id: str) -> None:
        self.values.pop(connection_id, None)


def configured_store(tmp_path, provider_id: str, model_id: str):
    credentials = MemoryCredentialStore()
    store = ModelConnectionStore(tmp_path / "connections.json", credentials)
    connection = store.create_connection(
        ConnectionRequest(
            providerId=provider_id,
            displayName=provider_id,
            apiBase={
                "deepseek": "https://api.deepseek.com",
                "volcengine-ark": "https://ark.cn-beijing.volces.com/api/v3",
            }[provider_id],
            credential="secret-value",
        )
    )
    store.set_assignment(
        "chat.primary",
        AssignmentRequest(connectionId=connection["id"], modelId=model_id),
    )
    store.record_test(connection["id"], success=True)
    return store


def test_pi_native_descriptor_excludes_connection_credential(tmp_path, monkeypatch):
    store = configured_store(tmp_path, "deepseek", "deepseek-chat")
    monkeypatch.setattr(service, "get_connection_store", lambda: store)

    descriptor = service.assigned_text_model()

    assert descriptor["model"]["integrationGroup"]["kind"] == "pi-native"
    assert "credential" not in descriptor
    assert "apiBase" not in descriptor


def test_sdk_text_dispatches_through_provider_adapter(tmp_path, monkeypatch):
    store = configured_store(
        tmp_path,
        "volcengine-ark",
        "doubao-seed-2-0-lite-260215",
    )
    monkeypatch.setattr(service, "get_connection_store", lambda: store)

    class FakeAdapter:
        provider_id = "volcengine-ark"

        def complete(self, payload, *, api_base, credential, model_id):
            return {
                "payload": payload,
                "apiBase": api_base,
                "credential": credential,
                "modelId": model_id,
            }

    monkeypatch.setitem(service._SDK_ADAPTERS, "volcengine-ark", FakeAdapter())

    result = service.complete_sdk_text({"messages": []})

    assert result["modelId"] == "doubao-seed-2-0-lite-260215"
    assert result["credential"] == "secret-value"


def test_pi_native_model_cannot_enter_sdk_dispatch(tmp_path, monkeypatch):
    store = configured_store(tmp_path, "deepseek", "deepseek-chat")
    monkeypatch.setattr(service, "get_connection_store", lambda: store)

    with pytest.raises(ModelManagementError, match="text_provider_unsupported"):
        service.complete_sdk_text({"messages": []})


def test_bound_text_model_requires_the_connection_whitelist(tmp_path, monkeypatch):
    store = configured_store(tmp_path, "deepseek", "deepseek-chat")
    state = store.read_state()
    connection = state["connections"][0]
    connection["agentChatModelIds"] = []
    store.replace_state(state)
    monkeypatch.setattr(service, "get_connection_store", lambda: store)

    with pytest.raises(ModelManagementError, match="agent_chat_model_not_configured"):
        service.resolve_text_model({
            "connectionId": connection["id"],
            "providerId": "deepseek",
            "modelId": "deepseek-chat",
        })


@pytest.mark.parametrize(
    ("unavailable_state", "error"),
    [
        ("credential_missing", "credential_missing"),
        ("not_tested", "connection_not_tested"),
        ("test_failed", "connection_test_failed"),
    ],
)
def test_text_model_resolution_rejects_unavailable_connections(
    tmp_path, monkeypatch, unavailable_state, error,
):
    store = configured_store(tmp_path, "deepseek", "deepseek-chat")
    connection_id = store.read_state()["connections"][0]["id"]
    if unavailable_state == "credential_missing":
        store.credential_store.delete(connection_id)
    elif unavailable_state == "not_tested":
        state = store.read_state()
        state["connections"][0].pop("lastTest", None)
        store.replace_state(state)
    else:
        store.record_test(connection_id, success=False)
    monkeypatch.setattr(service, "get_connection_store", lambda: store)

    with pytest.raises(ModelManagementError, match=error):
        service.resolve_text_model({
            "connectionId": connection_id,
            "providerId": "deepseek",
            "modelId": "deepseek-chat",
        })


def test_agent_catalog_contains_only_connection_whitelisted_models_with_availability(tmp_path, monkeypatch):
    store = configured_store(tmp_path, "deepseek", "deepseek-chat")
    connection = store.read_state()["connections"][0]
    store.record_test(connection["id"], success=True)
    monkeypatch.setattr(service, "get_connection_store", lambda: store)

    assert service.agent_chat_model_catalog() == [{
        "key": f'{connection["id"]}:deepseek-chat',
        "connectionId": connection["id"],
        "providerId": "deepseek",
        "modelId": "deepseek-chat",
        "displayName": "DeepSeek Chat",
        "capabilities": {},
        "available": True,
        "unavailableReason": None,
        "isDefault": True,
    }]


def test_pdf_document_dispatch_uses_responses_only_for_declared_ark_capability(
    tmp_path,
    monkeypatch,
):
    from app.gateway.ark_responses import ResolvedDocumentAsset

    store = configured_store(
        tmp_path,
        "volcengine-ark",
        "doubao-seed-2-0-lite-260215",
    )
    connection_id = store.read_state()["connections"][0]["id"]
    monkeypatch.setattr(service, "get_connection_store", lambda: store)
    calls = []

    def complete(payload, **kwargs):
        calls.append((payload, kwargs))
        return {"content": [], "stopReason": "stop", "usage": {}}

    monkeypatch.setattr(service, "complete_ark_response", complete)
    pdf = ResolvedDocumentAsset(
        resource_id="pdf-1",
        filename="scan.pdf",
        content_type="application/pdf",
        content=b"%PDF-scan",
    )

    service.complete_sdk_text_with_documents(
        {"messages": []},
        connection_id=connection_id,
        model_id="doubao-seed-2-0-lite-260215",
        pdf_assets=[pdf],
    )

    assert calls[0][1]["credential"] == "secret-value"
    assert calls[0][1]["connection_id"] == connection_id
    assert calls[0][1]["pdf_assets"] == [pdf]


@pytest.mark.parametrize(
    ("provider_id", "model_id", "unavailable_state"),
    [
        ("volcengine-ark", "doubao-seed-2-0-pro-260215", "credential_missing"),
        ("deepseek", "deepseek-chat", "not_tested"),
    ],
)
def test_unsupported_pdf_preflight_wins_before_availability_or_provider(
    tmp_path,
    monkeypatch,
    provider_id,
    model_id,
    unavailable_state,
):
    from app.gateway.ark_responses import ResolvedDocumentAsset

    store = configured_store(tmp_path, provider_id, model_id)
    connection_id = store.read_state()["connections"][0]["id"]
    if unavailable_state == "credential_missing":
        store.credential_store.delete(connection_id)
    else:
        state = store.read_state()
        state["connections"][0].pop("lastTest", None)
        store.replace_state(state)
    store.credential_store.lookups.clear()
    provider_called = False

    def complete(*args, **kwargs):
        nonlocal provider_called
        provider_called = True

    monkeypatch.setattr(service, "get_connection_store", lambda: store)
    monkeypatch.setattr(service, "complete_ark_response", complete)
    pdf = ResolvedDocumentAsset(
        resource_id="pdf-unsupported",
        filename="scan.pdf",
        content_type="application/pdf",
        content=b"%PDF-scan",
    )

    with pytest.raises(ModelManagementError, match="document_input_not_supported"):
        service.complete_sdk_text_with_documents(
            {"messages": []},
            connection_id=connection_id,
            model_id=model_id,
            pdf_assets=[pdf],
        )

    assert store.credential_store.lookups == []
    assert provider_called is False
