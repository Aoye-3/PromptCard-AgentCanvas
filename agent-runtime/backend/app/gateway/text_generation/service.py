from __future__ import annotations

from typing import Any

from app.gateway.ark_responses import (
    ArkResponsesError,
    ResolvedDocumentAsset,
    complete_ark_response,
)
from app.gateway.model_management.catalog import (
    connection_models_response,
    model_by_id,
)
from app.gateway.model_management.connection_store import (
    ModelManagementError,
    get_connection_store,
)
from app.gateway.model_management.provider_registry import provider_definition
from app.gateway.text_generation.providers.base import TextProviderAdapter
from app.gateway.text_generation.providers.volcengine_ark import (
    VolcengineArkTextAdapter,
)

_SDK_ADAPTERS: dict[str, TextProviderAdapter] = {
    "volcengine-ark": VolcengineArkTextAdapter(),
}


def assigned_text_model() -> dict[str, Any]:
    return resolve_text_model(None)


def resolve_text_model(binding: dict[str, Any] | None) -> dict[str, Any]:
    store = get_connection_store()
    if binding is None:
        assignment = store.assignment("chat.primary")
        if assignment is None:
            raise ModelManagementError("assignment_not_found")
        binding = {
            "connectionId": assignment["connectionId"],
            "modelId": assignment["modelId"],
        }
    connection_id = binding.get("connectionId")
    model_id = binding.get("modelId")
    provider_id = binding.get("providerId")
    if not isinstance(connection_id, str) or not isinstance(model_id, str):
        raise ModelManagementError("invalid_model_binding")
    connection = store.get_connection_config(connection_id)
    if not connection.get("enabled", True):
        raise ModelManagementError("connection_disabled")
    model = model_by_id(model_id)
    if model is None:
        raise ModelManagementError("model_not_found")
    if model["modality"] != "chat":
        raise ModelManagementError("incompatible_model_slot")
    if model["providerId"] != connection["providerId"]:
        raise ModelManagementError("model_provider_mismatch")
    if provider_id is not None and provider_id != connection["providerId"]:
        raise ModelManagementError("model_provider_mismatch")
    if model_id not in connection.get("agentChatModelIds", []):
        raise ModelManagementError("agent_chat_model_not_configured")
    available, unavailable_reason = _model_availability(store, connection)
    if not available:
        raise ModelManagementError(unavailable_reason or "model_unavailable")
    discovered = connection_models_response(connection_id, str(connection["providerId"]))
    descriptor = next(
        (item for item in discovered["models"] if item["id"] == model_id),
        None,
    )
    if descriptor is None or not descriptor.get("assignable", False):
        raise ModelManagementError("model_not_found")
    return {
        "connectionId": connection_id,
        "providerId": str(connection["providerId"]),
        "model": descriptor,
    }


def complete_sdk_text(
    payload: dict[str, Any],
    *,
    connection_id: str | None = None,
    model_id: str | None = None,
) -> dict[str, Any]:
    if (connection_id is None) != (model_id is None):
        raise ModelManagementError("invalid_model_binding")
    resolved = resolve_text_model(
        None if connection_id is None else {
            "connectionId": connection_id,
            "modelId": model_id,
        }
    )
    provider_id = resolved["providerId"]
    model = resolved["model"]
    group = model.get("integrationGroup") or {}
    if group.get("kind") != "sdk":
        raise ModelManagementError("text_provider_unsupported")
    adapter = _SDK_ADAPTERS.get(provider_id)
    if adapter is None:
        raise ModelManagementError("text_provider_unsupported")
    store = get_connection_store()
    connection = store.get_connection_config(resolved["connectionId"])
    credential = store.credential_store.get(resolved["connectionId"])
    if not credential:
        raise ModelManagementError("credential_missing")
    return adapter.complete(
        payload,
        api_base=str(connection["apiBase"]),
        credential=credential,
        model_id=str(model["id"]),
    )


def complete_sdk_text_with_documents(
    payload: dict[str, Any],
    *,
    connection_id: str,
    model_id: str,
    pdf_assets: list[ResolvedDocumentAsset],
) -> dict[str, Any]:
    if not pdf_assets:
        return complete_sdk_text(
            payload,
            connection_id=connection_id,
            model_id=model_id,
        )
    resolved = resolve_text_model(
        {"connectionId": connection_id, "modelId": model_id}
    )
    model = resolved["model"]
    capabilities = model.get("capabilities") or {}
    if (
        resolved["providerId"] != "volcengine-ark"
        or "pdf" not in (capabilities.get("input") or [])
        or (model.get("integrationGroup") or {}).get("kind") != "sdk"
    ):
        raise ModelManagementError("document_input_not_supported")
    store = get_connection_store()
    connection = store.get_connection_config(connection_id)
    credential = store.credential_store.get(connection_id)
    if not credential:
        raise ModelManagementError("credential_missing")
    try:
        return complete_ark_response(
            payload,
            api_base=str(connection["apiBase"]),
            credential=credential,
            model_id=str(model["id"]),
            pdf_assets=pdf_assets,
            connection_id=connection_id,
        )
    except ArkResponsesError as exc:
        raise ModelManagementError(exc.code) from None


def resolve_pi_native_proxy(connection_id: str, model_id: str) -> dict[str, str]:
    resolved = resolve_text_model({
        "connectionId": connection_id,
        "modelId": model_id,
    })
    group = resolved["model"].get("integrationGroup") or {}
    if group.get("kind") != "pi-native":
        raise ModelManagementError("text_provider_unsupported")
    provider = provider_definition(resolved["providerId"])
    if provider is None:
        raise ModelManagementError("text_provider_unsupported")
    store = get_connection_store()
    connection = store.get_connection_config(connection_id)
    credential = store.credential_store.get(connection_id)
    if not credential:
        raise ModelManagementError("credential_missing")
    return {
        "providerId": provider.id,
        "apiBase": str(connection["apiBase"]),
        "credential": credential,
        "modelId": str(resolved["model"]["id"]),
    }


def agent_chat_model_catalog() -> list[dict[str, Any]]:
    store = get_connection_store()
    assignment = store.assignment("chat.primary")
    default = (
        (str(assignment["connectionId"]), str(assignment["modelId"]))
        if assignment is not None
        else None
    )
    items: list[dict[str, Any]] = []
    for connection in store.read_state()["connections"]:
        connection_id = str(connection["id"])
        provider_id = str(connection["providerId"])
        for model_id in connection["agentChatModelIds"]:
            model = model_by_id(model_id)
            if model is None or model["modality"] != "chat":
                continue
            available, reason = _model_availability(store, connection)
            items.append({
                "key": f"{connection_id}:{model_id}",
                "connectionId": connection_id,
                "providerId": provider_id,
                "modelId": model_id,
                "displayName": model["displayName"],
                "capabilities": model.get("capabilities", {}),
                "available": available,
                "unavailableReason": reason,
                "isDefault": default == (connection_id, model_id),
            })
    return items


def _model_availability(
    store: Any,
    connection: dict[str, Any],
) -> tuple[bool, str | None]:
    if not connection.get("enabled", True):
        return False, "connection_disabled"
    if not store.credential_store.get(str(connection["id"])):
        return False, "credential_missing"
    last_test = connection.get("lastTest")
    if not isinstance(last_test, dict):
        return False, "connection_not_tested"
    if last_test.get("ok") is not True:
        return False, "connection_test_failed"
    return True, None
