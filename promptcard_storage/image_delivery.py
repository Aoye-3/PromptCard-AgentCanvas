"""Staged Bridge images and reviewable Canvas placement proposals."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any, Callable

from .delivery_ledger import BridgeDeliveryLedger, BridgeDeliveryValidationError
from .prompt_delivery import (
    _commit_request,
    _delivery_view,
    _profile_id,
    _require_scope,
)
from .reference_codes import parse_reference_code


_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_MEDIA_TYPES = {"image/png", "image/jpeg", "image/webp"}
_MAX_STAGE_BYTES = 30 * 1024 * 1024


class BridgeImageDeliveryService:
    def __init__(
        self,
        ledger: BridgeDeliveryLedger,
        save_image: Callable[[str, str, bytes], dict[str, Any]],
        resolve_context: Callable[[str], dict[str, Any]],
    ) -> None:
        self._ledger = ledger
        self._save_image = save_image
        self._resolve_context = resolve_context

    def stage(
        self,
        operation_context: dict[str, Any],
        request: dict[str, Any],
        content: bytes,
    ) -> dict[str, Any]:
        normalized = _stage_request(request, content)
        _require_scope(operation_context, "bridge:deliver:image")
        profile_id = _profile_id(operation_context)
        ledger_digest = _canonical_digest(normalized)
        ledger_request = {
            "clientRequestId": normalized["clientRequestId"],
            "normalizedRequestDigest": ledger_digest,
            "provenance": "promptcard-bridge",
            "target": {"cvcCode": normalized["cvcCode"]},
            "sourceCodes": [],
            "skillPins": [],
            "stageRequest": normalized,
        }
        record = self._ledger.begin(
            operation_context, "asset.stage", ledger_request
        )
        if record["state"] == "processing":
            handle = _opaque_id(
                "AST", profile_id, normalized["clientRequestId"], ledger_digest
            )
            try:
                stored = self._save_image(
                    PurePosixPath(normalized["workspaceRelativePath"]).name,
                    normalized["mediaType"],
                    content,
                )
                asset = stored["asset"]
                record = self._ledger.finish(
                    profile_id,
                    normalized["clientRequestId"],
                    ledger_digest,
                    "accepted",
                    {
                        "stagedAssetHandle": handle,
                        "assetId": asset["id"],
                        "filename": asset["filename"],
                        "contentType": asset["contentType"],
                        "size": asset["size"],
                        "width": stored["width"],
                        "height": stored["height"],
                        "contentDigest": normalized["contentDigest"],
                        "preparedDigest": stored["preparedDigest"],
                    },
                )
            except Exception:
                self._ledger.finish(
                    profile_id,
                    normalized["clientRequestId"],
                    ledger_digest,
                    "failed",
                    {"error": {"code": "asset_stage_failed", "retryable": True}},
                )
                raise
        return _stage_view(record, normalized)

    def preview(
        self,
        operation_context: dict[str, Any],
        request: dict[str, Any],
    ) -> dict[str, Any]:
        normalized = _image_preview_request(request)
        _require_scope(operation_context, "bridge:deliver:image")
        profile_id = _profile_id(operation_context)
        stage = self._ledger.find_stage(
            profile_id, normalized["payload"]["stagedAssetHandle"]
        )
        if stage is None or stage["state"] != "accepted":
            raise BridgeDeliveryValidationError("staged_asset_unavailable")
        stage_request = stage["request"].get("stageRequest") or {}
        if stage_request.get("cvcCode") != normalized["target"]["cvcCode"]:
            raise BridgeDeliveryValidationError("staged_asset_context_mismatch")
        self._validate_target(normalized)
        record = self._ledger.begin(
            operation_context, "delivery.preview", normalized
        )
        if record["state"] == "processing":
            proposal_id = _opaque_id(
                "DVP",
                profile_id,
                normalized["clientRequestId"],
                normalized["normalizedRequestDigest"],
            )
            record = self._ledger.finish(
                profile_id,
                normalized["clientRequestId"],
                normalized["normalizedRequestDigest"],
                "previewed",
                {
                    "proposalId": proposal_id,
                    "resultCodes": [],
                    "message": "Image placement preview is ready.",
                    "visualProposal": _visual_proposal(
                        proposal_id,
                        record["operationContext"],
                        normalized,
                        stage["result"],
                        record["createdAt"],
                    ),
                },
            )
        return _delivery_view(record, normalized)

    def commit(
        self,
        operation_context: dict[str, Any],
        request: dict[str, Any],
    ) -> dict[str, Any]:
        normalized = _commit_request(request)
        _require_scope(operation_context, "bridge:deliver:image")
        profile_id = _profile_id(operation_context)
        preview = self._ledger.find_preview(profile_id, normalized["proposalId"])
        if preview is None or preview["request"].get("kind") != "image.place":
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
                    "message": "Image placement is waiting for user review.",
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
        result = []
        for record in records:
            profile = record["operationContext"]["profileId"]
            proposal_id = (record.get("result") or {}).get("proposalId")
            preview = self._ledger.find_preview(profile, proposal_id)
            if preview is None or preview["request"].get("kind") != "image.place":
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
        if preview is None or preview["request"].get("kind") != "image.place":
            raise BridgeDeliveryValidationError("delivery_proposal_not_found")
        normalized_codes = _result_codes(result_codes, decision)
        updated = self._ledger.transition(
            profile_id,
            record["clientRequestId"],
            proposal_id,
            decision,
            normalized_codes,
            "Image placement was accepted by the user."
            if decision == "accepted"
            else "Image placement was rejected by the user.",
            expected_result_namespace="CVM",
        )
        return _delivery_view(updated, preview["request"])

    def _validate_target(self, request: dict[str, Any]) -> None:
        target = request["target"]
        storyboard_code = target.get("storyboardCode")
        if storyboard_code is None:
            return
        resolved = self._resolve_context(target["cvcCode"])
        entry = next(
            (
                item
                for item in resolved.get("entries", [])
                if item.get("reference", {}).get("code") == storyboard_code
            ),
            None,
        )
        if entry is None:
            raise BridgeDeliveryValidationError("reference_outside_context")
        try:
            content = json.loads(entry["content"])
            rows = content["sequence"]["rows"]
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise BridgeDeliveryValidationError("storyboard_target_invalid") from exc
        if (
            content.get("kind") != "storyboard"
            or content.get("revision") != target["baseRevision"]
            or content.get("digest") != target["baseDigest"]
        ):
            raise BridgeDeliveryValidationError("revision_conflict")
        if target["shotOrdinal"] >= len(rows):
            raise BridgeDeliveryValidationError("storyboard_shot_not_found")


def _stage_request(value: Any, content: bytes) -> dict[str, Any]:
    required = {
        "clientRequestId",
        "cvcCode",
        "workspaceRelativePath",
        "contentDigest",
        "mediaType",
        "byteLength",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise BridgeDeliveryValidationError("asset_stage_request_invalid")
    request_id = value.get("clientRequestId")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
        raise BridgeDeliveryValidationError("client_request_id_invalid")
    try:
        cvc_code = parse_reference_code(
            value.get("cvcCode"), expected_namespace="CVC"
        ).code
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_target_invalid") from exc
    path = value.get("workspaceRelativePath")
    if not isinstance(path, str) or not 1 <= len(path) <= 1024 or "\x00" in path:
        raise BridgeDeliveryValidationError("workspace_path_invalid")
    canonical_path = path.replace("\\", "/")
    parts = PurePosixPath(canonical_path).parts
    filename = PurePosixPath(canonical_path).name
    if (
        canonical_path.startswith("/")
        or ":" in canonical_path
        or ".." in parts
        or filename in {"", "."}
    ):
        raise BridgeDeliveryValidationError("workspace_path_invalid")
    digest = value.get("contentDigest")
    if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
        raise BridgeDeliveryValidationError("normalized_digest_invalid")
    media_type = value.get("mediaType")
    if media_type not in _MEDIA_TYPES:
        raise BridgeDeliveryValidationError("asset_media_type_invalid")
    byte_length = value.get("byteLength")
    if type(byte_length) is not int or not 1 <= byte_length <= _MAX_STAGE_BYTES:
        raise BridgeDeliveryValidationError("asset_size_invalid")
    if len(content) != byte_length:
        raise BridgeDeliveryValidationError("asset_size_mismatch")
    actual_digest = "sha256:" + hashlib.sha256(content).hexdigest()
    if actual_digest != digest:
        raise BridgeDeliveryValidationError("asset_digest_mismatch")
    return {
        **value,
        "cvcCode": cvc_code,
        "workspaceRelativePath": canonical_path,
    }


def _image_preview_request(value: Any) -> dict[str, Any]:
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
    if value.get("kind") != "image.place":
        raise BridgeDeliveryValidationError("delivery_kind_unavailable")
    if value.get("provenance") != "promptcard-bridge":
        raise BridgeDeliveryValidationError("bridge_provenance_invalid")
    request_id = value.get("clientRequestId")
    digest = value.get("normalizedRequestDigest")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
        raise BridgeDeliveryValidationError("client_request_id_invalid")
    if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
        raise BridgeDeliveryValidationError("normalized_digest_invalid")
    target = value.get("target")
    if not isinstance(target, dict) or not set(target) <= {
        "cvcCode", "storyboardCode", "baseRevision", "baseDigest", "shotOrdinal"
    }:
        raise BridgeDeliveryValidationError("delivery_target_invalid")
    try:
        cvc_code = parse_reference_code(
            target.get("cvcCode"), expected_namespace="CVC"
        ).code
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_target_invalid") from exc
    storyboard_fields = {"storyboardCode", "baseRevision", "baseDigest", "shotOrdinal"}
    present = storyboard_fields.intersection(target)
    normalized_target: dict[str, Any] = {"cvcCode": cvc_code}
    if present:
        if present != storyboard_fields:
            raise BridgeDeliveryValidationError("delivery_target_invalid")
        try:
            normalized_target["storyboardCode"] = parse_reference_code(
                target["storyboardCode"], expected_namespace="CVS"
            ).code
        except (TypeError, ValueError) as exc:
            raise BridgeDeliveryValidationError("delivery_target_invalid") from exc
        if type(target["baseRevision"]) is not int or target["baseRevision"] < 0:
            raise BridgeDeliveryValidationError("delivery_target_invalid")
        if not isinstance(target["baseDigest"], str) or _DIGEST.fullmatch(target["baseDigest"]) is None:
            raise BridgeDeliveryValidationError("delivery_target_invalid")
        if type(target["shotOrdinal"]) is not int or not 0 <= target["shotOrdinal"] <= 199:
            raise BridgeDeliveryValidationError("delivery_target_invalid")
        normalized_target.update({
            "baseRevision": target["baseRevision"],
            "baseDigest": target["baseDigest"],
            "shotOrdinal": target["shotOrdinal"],
        })
    sources = value.get("sourceCodes")
    pins = value.get("skillPins")
    if not isinstance(sources, list) or len(sources) > 32:
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    try:
        canonical_sources = [parse_reference_code(code).code for code in sources]
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid") from exc
    if len(canonical_sources) != len(set(canonical_sources)):
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    if not isinstance(pins, list) or len(pins) > 8:
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    normalized_pins = []
    seen_pins: set[str] = set()
    for pin in pins:
        if not isinstance(pin, dict) or set(pin) != {"skillCode", "revision", "digest"}:
            raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
        try:
            skill_code = parse_reference_code(
                pin.get("skillCode"), expected_namespace="SKL"
            ).code
        except (TypeError, ValueError) as exc:
            raise BridgeDeliveryValidationError("delivery_source_manifest_invalid") from exc
        if (
            skill_code in seen_pins
            or type(pin.get("revision")) is not int
            or pin["revision"] < 1
            or not isinstance(pin.get("digest"), str)
            or _DIGEST.fullmatch(pin["digest"]) is None
        ):
            raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
        seen_pins.add(skill_code)
        normalized_pins.append({**pin, "skillCode": skill_code})
    rationale = value.get("rationale")
    if not isinstance(rationale, str) or not 1 <= len(rationale) <= 4000:
        raise BridgeDeliveryValidationError("delivery_rationale_invalid")
    payload = value.get("payload")
    if not isinstance(payload, dict) or not set(payload) <= {"stagedAssetHandle", "altText"}:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    handle = payload.get("stagedAssetHandle")
    if not isinstance(handle, str) or re.fullmatch(r"AST-[0-7][0-9A-HJKMNP-TV-Z]{25}", handle) is None:
        raise BridgeDeliveryValidationError("staged_asset_handle_invalid")
    alt_text = payload.get("altText", "")
    if not isinstance(alt_text, str) or len(alt_text) > 1000:
        raise BridgeDeliveryValidationError("delivery_payload_invalid")
    return {
        **value,
        "target": normalized_target,
        "sourceCodes": canonical_sources,
        "skillPins": normalized_pins,
        "payload": {"stagedAssetHandle": handle, **({"altText": alt_text} if alt_text else {})},
    }


def _result_codes(values: Any, decision: str) -> list[str]:
    if not isinstance(values, list) or len(values) > 32:
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid")
    try:
        canonical = [parse_reference_code(code).code for code in values]
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid") from exc
    if decision == "rejected" and canonical:
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid")
    if decision == "accepted" and (
        len(canonical) != 1 or not canonical[0].startswith("CVM-")
    ):
        raise BridgeDeliveryValidationError("delivery_result_codes_invalid")
    return canonical


def _stage_view(record: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    result = dict(record.get("result") or {})
    return {
        "operationContext": record["operationContext"],
        "request": request,
        "state": record["state"],
        "disposition": record["disposition"],
        **result,
        "createdAt": record["createdAt"],
        "updatedAt": record["updatedAt"],
    }


def _visual_proposal(
    proposal_id: str,
    operation_context: dict[str, Any],
    request: dict[str, Any],
    stage_result: dict[str, Any],
    created_at: str,
) -> dict[str, Any]:
    client = operation_context.get("clientInfo") or {}
    return {
        "kind": "free_canvas_image_place",
        "id": proposal_id,
        "agentName": client.get("name") or operation_context["profileId"],
        "title": stage_result["filename"],
        "altText": request["payload"].get("altText", ""),
        "assetId": stage_result["assetId"],
        "contentType": stage_result["contentType"],
        "width": stage_result["width"],
        "height": stage_result["height"],
        "rationale": request["rationale"],
        "status": "pending",
        "createdAt": int(
            datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
            * 1000
        ),
        "bridgeDelivery": {
            "profileId": operation_context["profileId"],
            "cvcCode": request["target"]["cvcCode"],
            "clientRequestId": request["clientRequestId"],
            "normalizedRequestDigest": request["normalizedRequestDigest"],
            "sourceCodes": list(request["sourceCodes"]),
            "skillPins": list(request["skillPins"]),
            "target": dict(request["target"]),
            "stagedAssetHandle": request["payload"]["stagedAssetHandle"],
        },
    }


def _canonical_digest(value: dict[str, Any]) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _opaque_id(prefix: str, profile_id: str, request_id: str, digest: str) -> str:
    raw = hashlib.sha256(
        f"{prefix}\0{profile_id}\0{request_id}\0{digest}".encode("utf-8")
    ).digest()[:16]
    value = int.from_bytes(raw, "big")
    encoded = ["0"] * 26
    for index in range(25, -1, -1):
        encoded[index] = _CROCKFORD[value & 31]
        value >>= 5
    return prefix + "-" + "".join(encoded)
