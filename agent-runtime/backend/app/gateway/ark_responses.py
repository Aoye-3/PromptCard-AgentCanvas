from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from volcenginesdkarkruntime import Ark

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResolvedDocumentAsset:
    resource_id: str
    filename: str
    content_type: str
    content: bytes
    normalized_text: str | None = None


CleanupEnqueuer = Callable[[str, str, str], Any]


class ArkResponsesError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def complete_ark_response(
    payload: dict[str, Any],
    *,
    api_base: str,
    credential: str,
    model_id: str,
    pdf_assets: list[ResolvedDocumentAsset],
    connection_id: str | None = None,
    enqueue_cleanup: CleanupEnqueuer | None = None,
) -> dict[str, Any]:
    client = Ark(api_key=credential, base_url=api_base)
    remote_file_ids: list[str] = []
    try:
        for asset in pdf_assets:
            try:
                uploaded = client.files.create(
                    file=(asset.filename, asset.content, asset.content_type),
                    purpose="user_data",
                    expire_at=int(time.time()) + 3600,
                )
            except Exception:
                raise ArkResponsesError("provider_file_upload_failed") from None
            remote_file_ids.append(str(uploaded.id))

        request: dict[str, Any] = {
            "model": model_id,
            "input": _response_input(payload.get("messages") or [], remote_file_ids),
            "instructions": str(payload.get("systemPrompt") or "") or None,
            "store": False,
        }
        tools = _response_tools(payload.get("tools") or [])
        if tools:
            request["tools"] = tools
            request["tool_choice"] = "auto"
        if isinstance(payload.get("temperature"), (int, float)):
            request["temperature"] = payload["temperature"]
        if isinstance(payload.get("maxTokens"), int):
            request["max_output_tokens"] = payload["maxTokens"]

        try:
            response = client.responses.create(**request)
        except Exception:
            raise ArkResponsesError("provider_response_failed") from None
        return _normalize_response(response)
    finally:
        for remote_file_id in remote_file_ids:
            try:
                client.files.delete(remote_file_id)
            except Exception:
                _enqueue_failed_delete(
                    enqueue_cleanup,
                    connection_id,
                    remote_file_id,
                )


def _enqueue_failed_delete(
    enqueue_cleanup: CleanupEnqueuer | None,
    connection_id: str | None,
    remote_file_id: str,
) -> None:
    if not connection_id:
        logger.warning("Ark provider file cleanup could not be persisted: cleanup_context_missing")
        return
    try:
        if enqueue_cleanup is None:
            from app.gateway.provider_file_cleanup import enqueue_provider_file_cleanup

            enqueue_cleanup = enqueue_provider_file_cleanup
        enqueue_cleanup("volcengine-ark", connection_id, remote_file_id)
    except Exception:
        logger.warning("Ark provider file cleanup could not be persisted: cleanup_enqueue_failed")


def _response_input(
    messages: list[dict[str, Any]],
    remote_file_ids: list[str],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    last_user_index: int | None = None
    for message in messages:
        role = message.get("role")
        if role == "user":
            content = _user_content(message.get("content"))
            result.append({"role": "user", "content": content})
            last_user_index = len(result) - 1
        elif role == "assistant":
            content = message.get("content") or []
            text = "\n".join(
                str(item.get("text"))
                for item in content
                if isinstance(item, dict) and item.get("type") == "text"
            )
            if text:
                result.append({"role": "assistant", "content": text})
            for item in content:
                if not isinstance(item, dict) or item.get("type") != "toolCall":
                    continue
                result.append(
                    {
                        "type": "function_call",
                        "call_id": str(item.get("id") or ""),
                        "name": str(item.get("name") or ""),
                        "arguments": json.dumps(
                            item.get("arguments") or {},
                            ensure_ascii=False,
                        ),
                    }
                )
        elif role == "toolResult":
            result.append(
                {
                    "type": "function_call_output",
                    "call_id": str(message.get("toolCallId") or ""),
                    "output": _text_content(message.get("content")),
                }
            )

    files = [{"type": "input_file", "file_id": remote_id} for remote_id in remote_file_ids]
    if files:
        if last_user_index is None:
            result.append({"role": "user", "content": files})
        else:
            existing = result[last_user_index]["content"]
            if isinstance(existing, str):
                existing = [{"type": "input_text", "text": existing}]
            result[last_user_index]["content"] = [*existing, *files]
    return result


def _user_content(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, str):
        return [{"type": "input_text", "text": value}]
    blocks: list[dict[str, Any]] = []
    for item in value or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text":
            blocks.append({"type": "input_text", "text": str(item.get("text") or "")})
        elif item.get("type") == "image":
            mime_type = str(item.get("mimeType") or "image/png")
            data = str(item.get("data") or "")
            blocks.append(
                {
                    "type": "input_image",
                    "detail": "auto",
                    "image_url": f"data:{mime_type};base64,{data}",
                }
            )
    return blocks


def _response_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for tool in tools:
        name = str(tool.get("name") or "").strip()
        if not name:
            continue
        result.append(
            {
                "type": "function",
                "name": name,
                "description": str(tool.get("description") or ""),
                "parameters": tool.get("parameters")
                or {"type": "object", "properties": {}},
            }
        )
    return result


def _normalize_response(response: Any) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    for output in _value(response, "output", []) or []:
        output_type = _value(output, "type", "")
        if output_type == "message":
            for part in _value(output, "content", []) or []:
                if _value(part, "type", "") == "output_text":
                    text = str(_value(part, "text", ""))
                    if text:
                        content.append({"type": "text", "text": text})
        elif output_type == "function_call":
            raw_arguments = _value(output, "arguments", "{}")
            try:
                arguments = json.loads(raw_arguments)
            except (TypeError, json.JSONDecodeError):
                arguments = {}
            if not isinstance(arguments, dict):
                arguments = {}
            content.append(
                {
                    "type": "toolCall",
                    "id": str(_value(output, "call_id", "")),
                    "name": str(_value(output, "name", "")),
                    "arguments": arguments,
                }
            )
    usage = _value(response, "usage", None)
    input_details = _value(usage, "input_tokens_details", None)
    return {
        "content": content,
        "stopReason": (
            "toolUse" if any(item["type"] == "toolCall" for item in content) else "stop"
        ),
        "usage": {
            "input": int(_value(usage, "input_tokens", 0) or 0),
            "output": int(_value(usage, "output_tokens", 0) or 0),
            "cacheRead": int(_value(input_details, "cached_tokens", 0) or 0),
            "cacheWrite": 0,
        },
    }


def _text_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    return "\n".join(
        str(item.get("text"))
        for item in value or []
        if isinstance(item, dict) and item.get("type") == "text"
    )


def _value(value: Any, name: str, default: Any) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)
