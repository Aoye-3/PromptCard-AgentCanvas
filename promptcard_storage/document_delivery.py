"""Reviewable Bridge Document create/change proposals."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime
from typing import Any, Callable

from .delivery_ledger import BridgeDeliveryLedger, BridgeDeliveryValidationError
from .prompt_delivery import (
    _client_request,
    _commit_request,
    _delivery_view,
    _digest,
    _profile_id,
    _proposal_id,
    _require_scope,
    _skill_pin,
)
from .reference_codes import parse_reference_code


_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_DOCUMENT_KINDS = {"document.create", "document.change"}


class BridgeDocumentDeliveryService:
    def __init__(
        self,
        ledger: BridgeDeliveryLedger,
        resolve_context: Callable[[str], dict[str, Any]],
    ) -> None:
        self._ledger = ledger
        self._resolve_context = resolve_context

    def preview(
        self, operation_context: dict[str, Any], request: dict[str, Any]
    ) -> dict[str, Any]:
        normalized = _document_preview_request(request)
        _require_scope(operation_context, "bridge:deliver:document")
        if normalized["kind"] == "document.change":
            _validate_change_target(self._resolve_context, normalized)
        record = self._ledger.begin(
            operation_context, "delivery.preview", normalized
        )
        if record["state"] == "processing":
            proposal_id = _proposal_id(
                record["operationContext"]["profileId"],
                normalized["clientRequestId"],
                normalized["normalizedRequestDigest"],
            )
            record = self._ledger.finish(
                record["operationContext"]["profileId"],
                normalized["clientRequestId"],
                normalized["normalizedRequestDigest"],
                "previewed",
                {
                    "proposalId": proposal_id,
                    "resultCodes": [],
                    "message": "Document proposal preview is ready.",
                    "visualProposal": _visual_proposal(
                        proposal_id,
                        record["operationContext"],
                        normalized,
                        record["createdAt"],
                    ),
                },
            )
        return _delivery_view(record, normalized)

    def commit(
        self, operation_context: dict[str, Any], request: dict[str, Any]
    ) -> dict[str, Any]:
        normalized = _commit_request(request)
        _require_scope(operation_context, "bridge:deliver:document")
        profile_id = _profile_id(operation_context)
        preview = self._ledger.find_preview(profile_id, normalized["proposalId"])
        if (
            preview is None
            or preview["request"].get("kind") not in _DOCUMENT_KINDS
        ):
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        if preview["state"] != "previewed":
            raise BridgeDeliveryValidationError("delivery_preview_unavailable")
        if preview["request"].get("kind") == "document.change":
            _validate_change_target(self._resolve_context, preview["request"])
        record = self._ledger.begin(
            operation_context,
            "delivery.commit",
            normalized,
            target_manifest=preview["targetManifest"],
            source_manifest=preview["sourceManifest"],
        )
        if record["state"] == "processing":
            preview_result = preview.get("result") or {}
            record = self._ledger.finish(
                profile_id,
                normalized["clientRequestId"],
                normalized["normalizedRequestDigest"],
                "pending_review",
                {
                    "proposalId": normalized["proposalId"],
                    "previewClientRequestId": preview["clientRequestId"],
                    "resultCodes": [],
                    "message": "Document proposal is waiting for user review.",
                    "visualProposal": dict(
                        preview_result.get("visualProposal") or {}
                    ),
                },
            )
        return _delivery_view(record, preview["request"])

    def list(
        self,
        cvc_code: str,
        *,
        state: str | None = None,
        profile_id: str | None = None,
    ) -> list[dict[str, Any]]:
        records = self._ledger.list_records(
            cvc_code,
            operation="delivery.commit",
            state=state,
            profile_id=profile_id,
        )
        deliveries = []
        for record in records:
            profile = record["operationContext"]["profileId"]
            proposal_id = (record.get("result") or {}).get("proposalId")
            preview = self._ledger.find_preview(profile, proposal_id)
            if (
                preview is None
                or preview["request"].get("kind") not in _DOCUMENT_KINDS
            ):
                continue
            deliveries.append(_delivery_view(record, preview["request"]))
        return deliveries

    def decide(
        self,
        cvc_code: str,
        proposal_id: str,
        decision: str,
        result_codes: list[str],
    ) -> dict[str, Any]:
        if decision not in {"accepted", "rejected"}:
            raise BridgeDeliveryValidationError("delivery_decision_invalid")
        records = self._ledger.list_records(cvc_code, operation="delivery.commit")
        matches = [
            record
            for record in records
            if (record.get("result") or {}).get("proposalId") == proposal_id
        ]
        if len(matches) != 1:
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        record = matches[0]
        profile_id = record["operationContext"]["profileId"]
        preview = self._ledger.find_preview(profile_id, proposal_id)
        if (
            preview is None
            or preview["request"].get("kind") not in _DOCUMENT_KINDS
        ):
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        normalized_codes = _result_codes(result_codes, decision)
        updated = self._ledger.transition(
            profile_id,
            record["clientRequestId"],
            proposal_id,
            decision,
            normalized_codes,
            "Document proposal was accepted by the user."
            if decision == "accepted"
            else "Document proposal was rejected by the user.",
            expected_result_namespace="CVD",
        )
        return _delivery_view(updated, preview["request"])


def _document_preview_request(value: Any) -> dict[str, Any]:
    required = {
        "clientRequestId",
        "normalizedRequestDigest",
        "kind",
        "target",
        "sourceCodes",
        "skillPins",
        "rationale",
        "provenance",
        "payload",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise BridgeDeliveryValidationError("delivery_request_invalid")
    kind = value.get("kind")
    if kind not in _DOCUMENT_KINDS:
        raise BridgeDeliveryValidationError("delivery_kind_unavailable")
    if value.get("provenance") != "promptcard-bridge":
        raise BridgeDeliveryValidationError("bridge_provenance_invalid")
    _client_request(value.get("clientRequestId"))
    _digest(value.get("normalizedRequestDigest"))
    target = _document_target(kind, value.get("target"))
    sources = value.get("sourceCodes")
    if (
        not isinstance(sources, list)
        or len(sources) > 32
        or any(not isinstance(code, str) for code in sources)
    ):
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    try:
        canonical_sources = [parse_reference_code(code).code for code in sources]
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError(
            "delivery_source_manifest_invalid"
        ) from exc
    if len(canonical_sources) != len(set(canonical_sources)):
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    pins = value.get("skillPins")
    if not isinstance(pins, list) or len(pins) > 8:
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    normalized_pins = [_skill_pin(pin) for pin in pins]
    if len({pin["skillCode"] for pin in normalized_pins}) != len(normalized_pins):
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    rationale = value.get("rationale")
    if not isinstance(rationale, str) or not 1 <= len(rationale) <= 4000:
        raise BridgeDeliveryValidationError("delivery_rationale_invalid")
    payload = (
        _document_create_payload(value.get("payload"))
        if kind == "document.create"
        else _document_change_payload(value.get("payload"))
    )
    return {
        **value,
        "target": target,
        "sourceCodes": canonical_sources,
        "skillPins": normalized_pins,
        "payload": payload,
    }


def _document_target(kind: str, value: Any) -> dict[str, Any]:
    expected = {"cvcCode"} if kind == "document.create" else {
        "cvcCode", "documentCode", "baseRevision", "baseDigest"
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise BridgeDeliveryValidationError("delivery_target_invalid")
    try:
        target = {
            "cvcCode": parse_reference_code(
                value.get("cvcCode"), expected_namespace="CVC"
            ).code
        }
        if kind == "document.change":
            target["documentCode"] = parse_reference_code(
                value.get("documentCode"), expected_namespace="CVD"
            ).code
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_target_invalid") from exc
    if kind == "document.change":
        revision = value.get("baseRevision")
        digest = value.get("baseDigest")
        if type(revision) is not int or revision < 0:
            raise BridgeDeliveryValidationError("delivery_target_invalid")
        if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
            raise BridgeDeliveryValidationError("delivery_target_invalid")
        target.update({"baseRevision": revision, "baseDigest": digest})
    return target


def _document_create_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"title", "blocks"}:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    title = value.get("title")
    blocks = value.get("blocks")
    if not isinstance(title, str) or not 1 <= len(title) <= 500:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    if not isinstance(blocks, list) or not 1 <= len(blocks) <= 500:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    seen: set[str] = set()
    return {
        "title": unicodedata.normalize("NFC", title),
        "blocks": [_simple_block(block, seen) for block in blocks],
    }


def _simple_block(value: Any, seen: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("type") not in {
        "paragraph", "blockquote", "heading"
    }:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    expected = {"id", "type", "content"}
    if value["type"] == "heading":
        expected.add("level")
    if set(value) != expected:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    block_id = value.get("id")
    if (
        not isinstance(block_id, str)
        or not 1 <= len(block_id) <= 128
        or block_id in seen
    ):
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    if value["type"] == "heading" and value.get("level") not in {1, 2, 3}:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    content = value.get("content")
    if not isinstance(content, list) or len(content) > 200:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    seen.add(block_id)
    normalized = {
        "id": unicodedata.normalize("NFC", block_id),
        "type": value["type"],
        "content": [_inline(item) for item in content],
    }
    if value["type"] == "heading":
        normalized["level"] = value["level"]
    return normalized


def _inline(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or "text" not in value or not set(value) <= {
        "text", "bold", "italic", "href"
    }:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    text = value.get("text")
    if not isinstance(text, str) or len(text) > 10_000:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    normalized: dict[str, Any] = {"text": unicodedata.normalize("NFC", text)}
    for flag in ("bold", "italic"):
        if flag in value:
            if value[flag] is not True:
                raise BridgeDeliveryValidationError("delivery_payload_invalid")
            normalized[flag] = True
    if "href" in value:
        href = value["href"]
        if not isinstance(href, str) or not 1 <= len(href) <= 2048:
            raise BridgeDeliveryValidationError("delivery_payload_invalid")
        normalized["href"] = unicodedata.normalize("NFC", href)
    return normalized


def _document_change_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"operations"}:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    operations = value.get("operations")
    if not isinstance(operations, list) or not 1 <= len(operations) <= 32:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    return {"operations": [_operation(item) for item in operations]}


def _operation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("kind") not in {
        "insert", "delete", "replace"
    }:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    kind = value["kind"]
    expected = {"kind", "blockId", "expectedTextDigest"}
    expected.update(
        {"utf8Offset", "text"}
        if kind == "insert"
        else {"utf8Start", "utf8End"}
    )
    if kind == "replace":
        expected.add("text")
    if set(value) != expected:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    block_id = value.get("blockId")
    digest = value.get("expectedTextDigest")
    if not isinstance(block_id, str) or not 1 <= len(block_id) <= 128:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    normalized = dict(value)
    normalized["blockId"] = unicodedata.normalize("NFC", block_id)
    if kind == "insert":
        if type(value.get("utf8Offset")) is not int or value["utf8Offset"] < 0:
            raise BridgeDeliveryValidationError("delivery_payload_invalid")
    else:
        start = value.get("utf8Start")
        end = value.get("utf8End")
        if type(start) is not int or type(end) is not int or start < 0 or end < start:
            raise BridgeDeliveryValidationError("delivery_payload_invalid")
    if "text" in value:
        text = value["text"]
        if not isinstance(text, str) or not 1 <= len(text) <= 10_000:
            raise BridgeDeliveryValidationError("delivery_payload_invalid")
        normalized["text"] = unicodedata.normalize("NFC", text)
    return normalized


def _validate_change_target(
    resolve_context: Callable[[str], dict[str, Any]],
    request: dict[str, Any],
) -> None:
    target = request["target"]
    resolved = resolve_context(target["cvcCode"])
    entry = next((
        item for item in resolved.get("entries", [])
        if item.get("reference", {}).get("code") == target["documentCode"]
    ), None)
    if entry is None:
        raise BridgeDeliveryValidationError("reference_outside_context")
    try:
        content = json.loads(entry["content"])
        document = content["document"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise BridgeDeliveryValidationError("document_target_invalid") from exc
    if (
        content.get("kind") != "document"
        or content.get("revision") != target["baseRevision"]
        or content.get("digest") != target["baseDigest"]
    ):
        raise BridgeDeliveryValidationError("delivery_target_stale")
    pending_leaf_ids = {
        suggestion.get("blockId")
        for suggestion in document.get("suggestions", [])
        if isinstance(suggestion, dict)
    }
    leaves = _document_leaves(document.get("blocks"))
    ranges: dict[str, list[tuple[int, int]]] = {}
    for operation in request["payload"]["operations"]:
        block_id = operation["blockId"]
        text = leaves.get(block_id)
        if text is None:
            raise BridgeDeliveryValidationError("document_block_not_found")
        if block_id in pending_leaf_ids:
            raise BridgeDeliveryValidationError("document_suggestion_conflict")
        if operation["expectedTextDigest"] != _text_digest(text):
            raise BridgeDeliveryValidationError("document_text_conflict")
        start = operation.get("utf8Offset", operation.get("utf8Start"))
        end = operation.get("utf8Offset", operation.get("utf8End"))
        assert isinstance(start, int) and isinstance(end, int)
        boundaries = _utf8_boundaries(text)
        if start not in boundaries or end not in boundaries:
            raise BridgeDeliveryValidationError("document_offset_invalid")
        prior = ranges.setdefault(block_id, [])
        if any(not (end <= left or start >= right) for left, right in prior):
            raise BridgeDeliveryValidationError("document_operation_conflict")
        prior.append((start, end))


def _document_leaves(value: Any) -> dict[str, str]:
    if not isinstance(value, list):
        raise BridgeDeliveryValidationError("document_target_invalid")
    leaves: dict[str, str] = {}
    for block in value:
        if not isinstance(block, dict):
            raise BridgeDeliveryValidationError("document_target_invalid")
        if isinstance(block.get("content"), list):
            leaves[str(block.get("id"))] = _inline_text(block["content"])
        for item in block.get("items", []) if isinstance(block.get("items"), list) else []:
            if isinstance(item, dict) and isinstance(item.get("content"), list):
                leaves[str(item.get("id"))] = _inline_text(item["content"])
        for row in block.get("rows", []) if isinstance(block.get("rows"), list) else []:
            if not isinstance(row, dict):
                continue
            for cell in row.get("cells", []) if isinstance(row.get("cells"), list) else []:
                if isinstance(cell, dict) and isinstance(cell.get("content"), list):
                    leaves[str(cell.get("id"))] = _inline_text(cell["content"])
    return leaves


def _inline_text(value: list[Any]) -> str:
    if any(not isinstance(item, dict) or not isinstance(item.get("text"), str) for item in value):
        raise BridgeDeliveryValidationError("document_target_invalid")
    return unicodedata.normalize("NFC", "".join(item["text"] for item in value))


def _text_digest(value: str) -> str:
    return "sha256:" + hashlib.sha256(
        unicodedata.normalize("NFC", value).encode("utf-8")
    ).hexdigest()


def _utf8_boundaries(value: str) -> set[int]:
    boundaries = {0}
    length = 0
    for character in value:
        length += len(character.encode("utf-8"))
        boundaries.add(length)
    return boundaries


def _result_codes(values: Any, decision: str) -> list[str]:
    if (
        not isinstance(values, list)
        or len(values) > 32
        or len(values) != len(set(values))
    ):
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid")
    if decision == "rejected" and values:
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid")
    try:
        canonical = [parse_reference_code(code).code for code in values]
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid") from exc
    if decision == "accepted" and (
        len(canonical) != 1 or not canonical[0].startswith("CVD-")
    ):
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid")
    return canonical


def _visual_proposal(
    proposal_id: str,
    operation_context: dict[str, Any],
    request: dict[str, Any],
    created_at: str,
) -> dict[str, Any]:
    payload = request["payload"]
    target = request["target"]
    client = operation_context.get("clientInfo") or {}
    proposal = {
        "kind": "document_create"
        if request["kind"] == "document.create"
        else "document_changes",
        "id": proposal_id,
        "agentName": client.get("name") or operation_context["profileId"],
        "rationale": request["rationale"],
        "status": "pending",
        "createdAt": int(datetime.fromisoformat(
            created_at.replace("Z", "+00:00")
        ).timestamp() * 1000),
        "bridgeDelivery": {
            "profileId": operation_context["profileId"],
            "cvcCode": target["cvcCode"],
            "clientRequestId": request["clientRequestId"],
            "normalizedRequestDigest": request["normalizedRequestDigest"],
            "sourceCodes": list(request["sourceCodes"]),
            "skillPins": list(request["skillPins"]),
        },
    }
    if request["kind"] == "document.create":
        proposal.update({
            "title": payload["title"],
            "blocks": payload["blocks"],
        })
    else:
        proposal.update({
            "documentCode": target["documentCode"],
            "baseRevision": target["baseRevision"],
            "baseDigest": target["baseDigest"],
            "operations": payload["operations"],
        })
    return proposal
