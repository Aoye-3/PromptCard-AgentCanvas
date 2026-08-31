"""Typed Prompt proposals built on the durable Bridge delivery ledger."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Any

from .delivery_ledger import (
    BridgeDeliveryLedger,
    BridgeDeliveryValidationError,
)
from .reference_codes import parse_reference_code


_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_PROPOSAL = re.compile(r"^DVP-[0-7][0-9A-HJKMNP-TV-Z]{25}$")
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


class BridgePromptDeliveryService:
    def __init__(self, ledger: BridgeDeliveryLedger) -> None:
        self._ledger = ledger

    def preview(
        self, operation_context: dict[str, Any], request: dict[str, Any]
    ) -> dict[str, Any]:
        normalized = _prompt_preview_request(request)
        _require_scope(operation_context, "bridge:deliver:prompt")
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
                    "message": "Prompt proposal preview is ready.",
                    "visualProposal": _visual_proposal(
                        proposal_id, record["operationContext"], normalized,
                        record["createdAt"],
                    ),
                },
            )
        return _delivery_view(record, normalized)

    def commit(
        self, operation_context: dict[str, Any], request: dict[str, Any]
    ) -> dict[str, Any]:
        normalized = _commit_request(request)
        _require_scope(operation_context, "bridge:deliver:prompt")
        profile_id = _profile_id(operation_context)
        preview = self._ledger.find_preview(profile_id, normalized["proposalId"])
        if preview is None:
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        if preview["state"] != "previewed":
            raise BridgeDeliveryValidationError("delivery_preview_unavailable")
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
                    "message": "Prompt proposal is waiting for user review.",
                    "visualProposal": dict(preview_result.get("visualProposal") or {}),
                },
            )
        return _delivery_view(record, preview["request"])

    def status(self, profile_id: str, client_request_id: str) -> dict[str, Any]:
        record = self._ledger.get(profile_id, client_request_id)
        if record is None:
            raise KeyError((profile_id, client_request_id))
        preview_request = record["request"]
        if record["operation"] == "delivery.commit":
            result = record.get("result") or {}
            preview = self._ledger.find_preview(profile_id, result.get("proposalId"))
            if preview is None:
                raise BridgeDeliveryValidationError("delivery_preview_unavailable")
            preview_request = preview["request"]
        return _delivery_view(record, preview_request)

    def list(
        self,
        cvc_code: str,
        *,
        state: str | None = None,
        profile_id: str | None = None,
    ) -> list[dict[str, Any]]:
        records = self._ledger.list_records(
            cvc_code, operation="delivery.commit", state=state, profile_id=profile_id
        )
        result = []
        for record in records:
            profile_id = record["operationContext"]["profileId"]
            proposal_id = (record.get("result") or {}).get("proposalId")
            preview = self._ledger.find_preview(profile_id, proposal_id)
            if preview is None or preview["request"].get("kind") != "prompt.create":
                continue
            result.append(_delivery_view(record, preview["request"]))
        return result

    def decide(
        self,
        cvc_code: str,
        proposal_id: str,
        decision: str,
        result_codes: list[str],
    ) -> dict[str, Any]:
        if decision not in {"accepted", "rejected"}:
            raise BridgeDeliveryValidationError("delivery_decision_invalid")
        records = self._ledger.list_records(
            cvc_code, operation="delivery.commit"
        )
        matches = [
            record
            for record in records
            if (record.get("result") or {}).get("proposalId") == proposal_id
        ]
        if len(matches) != 1:
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        record = matches[0]
        preview = self._ledger.find_preview(
            record["operationContext"]["profileId"], proposal_id
        )
        if preview is None or preview["request"].get("kind") != "prompt.create":
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        normalized_codes = _result_codes(result_codes, decision)
        updated = self._ledger.transition(
            record["operationContext"]["profileId"],
            record["clientRequestId"],
            proposal_id,
            decision,
            normalized_codes,
            "Prompt proposal was accepted by the user."
            if decision == "accepted"
            else "Prompt proposal was rejected by the user.",
            expected_result_namespace="CVT",
        )
        return _delivery_view(updated, preview["request"])


def _prompt_preview_request(value: Any) -> dict[str, Any]:
    required = {
        "clientRequestId", "normalizedRequestDigest", "kind", "target",
        "sourceCodes", "skillPins", "rationale", "provenance", "payload",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise BridgeDeliveryValidationError("delivery_request_invalid")
    if value.get("kind") != "prompt.create":
        raise BridgeDeliveryValidationError("delivery_kind_unavailable")
    if value.get("provenance") != "promptcard-bridge":
        raise BridgeDeliveryValidationError("bridge_provenance_invalid")
    _client_request(value.get("clientRequestId"))
    _digest(value.get("normalizedRequestDigest"))
    target = value.get("target")
    if not isinstance(target, dict) or set(target) != {"cvcCode"}:
        raise BridgeDeliveryValidationError("delivery_target_invalid")
    try:
        cvc_code = parse_reference_code(target["cvcCode"], expected_namespace="CVC").code
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_target_invalid") from exc
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
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid") from exc
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
    payload = value.get("payload")
    if not isinstance(payload, dict) or set(payload) != {"title", "userText"}:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    title = payload.get("title")
    user_text = payload.get("userText")
    if not isinstance(title, str) or not 1 <= len(title) <= 500:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    if not isinstance(user_text, str) or not 1 <= len(user_text) <= 100_000:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    return {
        **value,
        "target": {"cvcCode": cvc_code},
        "sourceCodes": canonical_sources,
        "skillPins": normalized_pins,
    }


def _commit_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "clientRequestId", "normalizedRequestDigest", "proposalId"
    }:
        raise BridgeDeliveryValidationError("delivery_request_invalid")
    _client_request(value.get("clientRequestId"))
    _digest(value.get("normalizedRequestDigest"))
    if not isinstance(value.get("proposalId"), str) or _PROPOSAL.fullmatch(value["proposalId"]) is None:
        raise BridgeDeliveryValidationError("delivery_proposal_invalid")
    return dict(value)


def _skill_pin(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "skillCode", "revision", "digest", "projectionHealth"
    }:
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    try:
        code = parse_reference_code(value["skillCode"], expected_namespace="SKL").code
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid") from exc
    revision = value.get("revision")
    if type(revision) is not int or revision < 1:
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    _digest(value.get("digest"))
    projection_health = value.get("projectionHealth")
    if projection_health not in {"healthy", "stale", "missing", "untrusted", "archived"}:
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    return {
        "skillCode": code,
        "revision": revision,
        "digest": value["digest"],
        "projectionHealth": projection_health,
    }


def _result_codes(values: Any, decision: str) -> list[str]:
    if not isinstance(values, list) or len(values) > 32 or len(values) != len(set(values)):
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid")
    if decision == "rejected" and values:
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid")
    try:
        canonical = [parse_reference_code(code).code for code in values]
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid") from exc
    if decision == "accepted" and (
        len(canonical) != 1 or not canonical[0].startswith("CVT-")
    ):
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid")
    return canonical


def _delivery_view(record: dict[str, Any], preview_request: dict[str, Any]) -> dict[str, Any]:
    result = dict(record.get("result") or {})
    return {
        "operationContext": record["operationContext"],
        "request": preview_request,
        "proposalId": result["proposalId"],
        "state": record["state"],
        "disposition": record["disposition"],
        "resultCodes": list(result.get("resultCodes") or []),
        "message": str(result.get("message") or ""),
        "createdAt": record["createdAt"],
        "updatedAt": record["updatedAt"],
        "visualProposal": dict(result.get("visualProposal") or {}),
    }


def _visual_proposal(
    proposal_id: str,
    operation_context: dict[str, Any],
    request: dict[str, Any],
    created_at: str,
) -> dict[str, Any]:
    payload = request["payload"]
    client = operation_context.get("clientInfo") or {}
    return {
        "kind": "free_canvas_text_create",
        "id": proposal_id,
        "agentName": client.get("name") or operation_context["profileId"],
        "title": payload["title"],
        "userText": payload["userText"],
        "segments": [{"source": "user", "text": payload["userText"]}],
        "rationale": request["rationale"],
        "status": "pending",
        "createdAt": int(datetime.fromisoformat(
            created_at.replace("Z", "+00:00")
        ).timestamp() * 1000),
        "bridgeDelivery": {
            "profileId": operation_context["profileId"],
            "cvcCode": request["target"]["cvcCode"],
            "clientRequestId": request["clientRequestId"],
            "normalizedRequestDigest": request["normalizedRequestDigest"],
            "sourceCodes": list(request["sourceCodes"]),
            "skillPins": list(request["skillPins"]),
        },
    }


def _proposal_id(profile_id: str, request_id: str, digest: str) -> str:
    raw = hashlib.sha256(f"{profile_id}\0{request_id}\0{digest}".encode("utf-8")).digest()[:16]
    value = int.from_bytes(raw, "big")
    encoded = ["0"] * 26
    for index in range(25, -1, -1):
        encoded[index] = _CROCKFORD[value & 31]
        value >>= 5
    return "DVP-" + "".join(encoded)


def _require_scope(operation_context: Any, scope: str) -> None:
    if not isinstance(operation_context, dict) or scope not in operation_context.get("scopes", []):
        raise BridgeDeliveryValidationError("bridge_scope_required")


def _profile_id(operation_context: Any) -> str:
    if not isinstance(operation_context, dict) or not isinstance(operation_context.get("profileId"), str):
        raise BridgeDeliveryValidationError("bridge_profile_invalid")
    return operation_context["profileId"]


def _client_request(value: Any) -> None:
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        raise BridgeDeliveryValidationError("client_request_id_invalid")


def _digest(value: Any) -> None:
    if not isinstance(value, str) or _DIGEST.fullmatch(value) is None:
        raise BridgeDeliveryValidationError("normalized_digest_invalid")
