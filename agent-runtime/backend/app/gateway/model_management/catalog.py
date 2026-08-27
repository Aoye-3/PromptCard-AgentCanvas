from __future__ import annotations

from copy import deepcopy
from typing import Any

from app.gateway.model_management.provider_registry import (
    provider_definition,
    provider_responses,
)

MODELS: tuple[dict[str, Any], ...] = (
    {
        "id": "deepseek-chat",
        "providerId": "deepseek",
        "displayName": "DeepSeek Chat",
        "modality": "chat",
    },
    {
        "id": "doubao-seed-2-0-lite-260215",
        "providerId": "volcengine-ark",
        "displayName": "Doubao Seed 2.0 Lite",
        "modality": "chat",
        "capabilities": {
            "input": ["text", "image", "pdf"],
            "toolCalling": True,
            "contextWindow": 256_000,
        },
    },
    {
        "id": "doubao-seed-2-0-pro-260215",
        "providerId": "volcengine-ark",
        "displayName": "Doubao Seed 2.0 Pro",
        "modality": "chat",
        "capabilities": {
            "input": ["text", "image"],
            "toolCalling": True,
            "contextWindow": 256_000,
        },
    },
    {
        "id": "doubao-seedream-5-0-pro-260628",
        "providerId": "volcengine-ark",
        "displayName": "Seedream 5.0 Pro",
        "modality": "image",
        "capabilities": {
            "modes": ["generate", "edit", "region-edit"],
            "maxReferenceImages": 10,
            "mentionStrategy": "ordered-image-labels",
            "regionInputs": ["point", "bbox"],
            "resolutions": ["1K", "2K"],
            "aspectRatios": ["smart", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "custom"],
            "customSize": {
                "minPixels": 921600,
                "maxPixels": 4624220,
                "minAspectRatio": 1 / 16,
                "maxAspectRatio": 16,
            },
            "promptOptimization": {
                "modes": ["standard", "fast"],
                "default": "standard",
            },
            "inputConstraints": {
                "formats": ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"],
                "maxImages": 10,
                "maxBytesPerImage": 30 * 1024 * 1024,
                "maxPixelsPerImage": 36_000_000,
                "minSideExclusive": 14,
                "minAspectRatio": 1 / 16,
                "maxAspectRatio": 16,
            },
            "annotationInputs": ["raster-markup"],
            "outputFormats": ["png", "jpeg"],
            "responseTransports": ["url", "b64_json"],
            "watermark": True,
            "outputCount": 1,
            "streaming": False,
            "references": {
                "maxCount": 10,
                "ordering": "positional",
                "nativeRoles": [],
                "acceptedSources": ["asset"],
            },
            "outputs": {
                "countMode": "single",
                "countGuarantee": "exact",
                "maxCount": 1,
                "formats": ["png", "jpeg"],
                "alpha": "unknown",
            },
            "execution": {
                "submission": "synchronous",
                "progress": ["none"],
                "completion": ["inline"],
                "cancellation": False,
            },
            "delivery": {
                "forms": ["temporary-url", "base64"],
                "urlTtlSeconds": None,
                "browserReadable": "unknown",
                "mustPersistImmediately": True,
            },
        },
    },
)


def catalog_response() -> dict[str, Any]:
    return {
        "providers": provider_responses(),
        "models": [_model_response(model) for model in MODELS],
    }


def connection_models_response(connection_id: str, provider_id: str) -> dict[str, Any]:
    provider = provider_definition(provider_id)
    if provider is None:
        return {"connectionId": connection_id, "providerId": provider_id, "models": []}
    return {
        "connectionId": connection_id,
        "providerId": provider_id,
        "models": [_model_response(model) for model in MODELS if model["providerId"] == provider_id],
    }


def model_by_id(model_id: str) -> dict[str, Any] | None:
    return next((model for model in MODELS if model["id"] == model_id), None)


def _model_response(model: dict[str, Any]) -> dict[str, Any]:
    response = deepcopy(model)
    provider = provider_definition(str(model["providerId"]))
    group = provider.group_for(model["modality"]) if provider is not None else None
    response["source"] = "provider-catalog"
    response["assignable"] = group is not None
    if group is not None:
        response["integrationGroup"] = group.response()
    return response
