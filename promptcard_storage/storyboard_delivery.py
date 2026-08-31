"""Reviewable Bridge Storyboard create/change proposals."""

from __future__ import annotations

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
_STORYBOARD_KINDS = {"storyboard.create", "storyboard.change"}
_SEQUENCE_FIELDS = {"name", "description", "style", "constraints"}
_ROW_FIELDS = (
    "cutLabel", "timeRange", "subject", "action", "scene",
    "camera", "lighting", "audio", "duration",
)
_ROW_FIELD_SET = set(_ROW_FIELDS)


class BridgeStoryboardDeliveryService:
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
        normalized = _storyboard_preview_request(request)
        _require_scope(operation_context, "bridge:deliver:storyboard")
        _validate_storyboard_authority(self._resolve_context, normalized)
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
                    "message": "Storyboard proposal preview is ready.",
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
        _require_scope(operation_context, "bridge:deliver:storyboard")
        profile_id = _profile_id(operation_context)
        preview = self._ledger.find_preview(profile_id, normalized["proposalId"])
        if (
            preview is None
            or preview["request"].get("kind") not in _STORYBOARD_KINDS
        ):
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        if preview["state"] != "previewed":
            raise BridgeDeliveryValidationError("delivery_preview_unavailable")
        _validate_storyboard_authority(self._resolve_context, preview["request"])
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
                    "message": "Storyboard proposal is waiting for user review.",
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
                or preview["request"].get("kind") not in _STORYBOARD_KINDS
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
            record for record in records
            if (record.get("result") or {}).get("proposalId") == proposal_id
        ]
        if len(matches) != 1:
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        record = matches[0]
        profile_id = record["operationContext"]["profileId"]
        preview = self._ledger.find_preview(profile_id, proposal_id)
        if (
            preview is None
            or preview["request"].get("kind") not in _STORYBOARD_KINDS
        ):
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        normalized_codes = _result_codes(result_codes, decision)
        updated = self._ledger.transition(
            profile_id,
            record["clientRequestId"],
            proposal_id,
            decision,
            normalized_codes,
            "Storyboard proposal was accepted by the user."
            if decision == "accepted"
            else "Storyboard proposal was rejected by the user.",
            expected_result_namespace="CVS",
        )
        return _delivery_view(updated, preview["request"])


def _storyboard_preview_request(value: Any) -> dict[str, Any]:
    required = {
        "clientRequestId", "normalizedRequestDigest", "kind", "target",
        "sourceCodes", "skillPins", "rationale", "provenance", "payload",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise BridgeDeliveryValidationError("delivery_request_invalid")
    kind = value.get("kind")
    if kind not in _STORYBOARD_KINDS:
        raise BridgeDeliveryValidationError("delivery_kind_unavailable")
    if value.get("provenance") != "promptcard-bridge":
        raise BridgeDeliveryValidationError("bridge_provenance_invalid")
    _client_request(value.get("clientRequestId"))
    _digest(value.get("normalizedRequestDigest"))
    target = _target(kind, value.get("target"))
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
        _create_payload(value.get("payload"))
        if kind == "storyboard.create"
        else _change_payload(value.get("payload"))
    )
    return {
        **value,
        "target": target,
        "sourceCodes": canonical_sources,
        "skillPins": normalized_pins,
        "payload": payload,
    }


def _target(kind: str, value: Any) -> dict[str, Any]:
    expected = {"cvcCode"} if kind == "storyboard.create" else {
        "cvcCode", "storyboardCode", "baseRevision", "baseDigest",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise BridgeDeliveryValidationError("delivery_target_invalid")
    try:
        target = {
            "cvcCode": parse_reference_code(
                value.get("cvcCode"), expected_namespace="CVC"
            ).code
        }
        if kind == "storyboard.change":
            target["storyboardCode"] = parse_reference_code(
                value.get("storyboardCode"), expected_namespace="CVS"
            ).code
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_target_invalid") from exc
    if kind == "storyboard.change":
        revision = value.get("baseRevision")
        digest = value.get("baseDigest")
        if type(revision) is not int or revision < 0:
            raise BridgeDeliveryValidationError("delivery_target_invalid")
        if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
            raise BridgeDeliveryValidationError("delivery_target_invalid")
        target.update({"baseRevision": revision, "baseDigest": digest})
    return target


def _create_payload(value: Any) -> dict[str, Any]:
    expected = {
        "title", "sourceDocumentCode", "sourceDocumentRevision",
        "sourceDocumentDigest", "sequence",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    title = _text(value.get("title"), nonempty=True, maximum=500)
    try:
        document_code = parse_reference_code(
            value.get("sourceDocumentCode"), expected_namespace="CVD"
        ).code
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_payload_invalid") from exc
    revision = value.get("sourceDocumentRevision")
    digest = value.get("sourceDocumentDigest")
    if type(revision) is not int or revision < 0:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    return {
        "title": title,
        "sourceDocumentCode": document_code,
        "sourceDocumentRevision": revision,
        "sourceDocumentDigest": digest,
        "sequence": _sequence(value.get("sequence")),
    }


def _sequence(value: Any) -> dict[str, Any]:
    expected = {*_SEQUENCE_FIELDS, "rows"}
    if not isinstance(value, dict) or set(value) != expected:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    rows = value.get("rows")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 200:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    return {
        "name": _text(value.get("name"), nonempty=True),
        "description": _text(value.get("description")),
        "style": _text(value.get("style")),
        "constraints": _text(value.get("constraints")),
        "rows": [_row(row) for row in rows],
    }


def _row(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != _ROW_FIELD_SET:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    return {field: _text(value.get(field)) for field in _ROW_FIELDS}


def _change_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"changes"}:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    changes = value.get("changes")
    if not isinstance(changes, list) or not 1 <= len(changes) <= 32:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    normalized: list[dict[str, Any]] = []
    identities: set[str] = set()
    for change in changes:
        if not isinstance(change, dict) or change.get("scope") not in {
            "sequence", "row"
        }:
            raise BridgeDeliveryValidationError("delivery_payload_invalid")
        if change["scope"] == "sequence":
            if set(change) != {"scope", "field", "value"}:
                raise BridgeDeliveryValidationError("delivery_payload_invalid")
            field = change.get("field")
            if field not in _SEQUENCE_FIELDS:
                raise BridgeDeliveryValidationError("delivery_payload_invalid")
            item = {"scope": "sequence", "field": field, "value": _text(change.get("value"))}
            identity = f"sequence:{field}"
        else:
            if set(change) != {"scope", "rowOrdinal", "field", "value"}:
                raise BridgeDeliveryValidationError("delivery_payload_invalid")
            ordinal = change.get("rowOrdinal")
            field = change.get("field")
            if type(ordinal) is not int or not 0 <= ordinal <= 199 or field not in _ROW_FIELD_SET:
                raise BridgeDeliveryValidationError("delivery_payload_invalid")
            item = {
                "scope": "row", "rowOrdinal": ordinal,
                "field": field, "value": _text(change.get("value")),
            }
            identity = f"row:{ordinal}:{field}"
        if identity in identities:
            raise BridgeDeliveryValidationError("storyboard_change_conflict")
        identities.add(identity)
        normalized.append(item)
    return {"changes": normalized}


def _text(value: Any, *, nonempty: bool = False, maximum: int = 10_000) -> str:
    if not isinstance(value, str) or len(value) > maximum or (nonempty and not value):
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    return unicodedata.normalize("NFC", value)


def _validate_storyboard_authority(
    resolve_context: Callable[[str], dict[str, Any]],
    request: dict[str, Any],
) -> None:
    resolved = resolve_context(request["target"]["cvcCode"])
    entries = resolved.get("entries", [])
    if request["kind"] == "storyboard.create":
        payload = request["payload"]
        content = _entry_content(entries, payload["sourceDocumentCode"])
        if content.get("kind") != "document":
            raise BridgeDeliveryValidationError("storyboard_source_invalid")
        if (
            content.get("revision") != payload["sourceDocumentRevision"]
            or content.get("digest") != payload["sourceDocumentDigest"]
        ):
            raise BridgeDeliveryValidationError("delivery_source_stale")
        return
    target = request["target"]
    content = _entry_content(entries, target["storyboardCode"])
    if content.get("kind") != "storyboard":
        raise BridgeDeliveryValidationError("storyboard_target_invalid")
    if (
        content.get("revision") != target["baseRevision"]
        or content.get("digest") != target["baseDigest"]
    ):
        raise BridgeDeliveryValidationError("delivery_target_stale")
    sequence = content.get("sequence")
    rows = sequence.get("rows") if isinstance(sequence, dict) else None
    if not isinstance(rows, list):
        raise BridgeDeliveryValidationError("storyboard_target_invalid")
    pending = content.get("pendingFieldChanges", [])
    if not isinstance(pending, list):
        raise BridgeDeliveryValidationError("storyboard_target_invalid")
    pending_identities = {
        _change_identity(change) for change in pending if isinstance(change, dict)
    }
    for change in request["payload"]["changes"]:
        if change["scope"] == "row" and change["rowOrdinal"] >= len(rows):
            raise BridgeDeliveryValidationError("storyboard_row_not_found")
        if _change_identity(change) in pending_identities:
            raise BridgeDeliveryValidationError("storyboard_change_conflict")


def _entry_content(entries: Any, code: str) -> dict[str, Any]:
    if not isinstance(entries, list):
        raise BridgeDeliveryValidationError("reference_outside_context")
    entry = next((
        item for item in entries
        if isinstance(item, dict)
        and isinstance(item.get("reference"), dict)
        and item["reference"].get("code") == code
    ), None)
    if entry is None:
        raise BridgeDeliveryValidationError("reference_outside_context")
    try:
        content = json.loads(entry["content"])
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise BridgeDeliveryValidationError("storyboard_target_invalid") from exc
    if not isinstance(content, dict):
        raise BridgeDeliveryValidationError("storyboard_target_invalid")
    return content


def _change_identity(change: dict[str, Any]) -> str:
    if change.get("scope") == "sequence":
        return f"sequence:{change.get('field')}"
    return f"row:{change.get('rowOrdinal')}:{change.get('field')}"


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
        len(canonical) != 1 or not canonical[0].startswith("CVS-")
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
        "kind": "storyboard_create"
        if request["kind"] == "storyboard.create"
        else "storyboard_changes",
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
    if request["kind"] == "storyboard.create":
        proposal.update({
            "title": payload["title"],
            "sourceDocumentCode": payload["sourceDocumentCode"],
            "sourceDocumentRevision": payload["sourceDocumentRevision"],
            "sourceDocumentDigest": payload["sourceDocumentDigest"],
            "sequence": payload["sequence"],
        })
    else:
        proposal.update({
            "storyboardCode": target["storyboardCode"],
            "baseRevision": target["baseRevision"],
            "baseDigest": target["baseDigest"],
            "changes": payload["changes"],
        })
    return proposal
