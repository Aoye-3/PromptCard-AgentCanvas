"""Durable, profile-isolated idempotency ledger for Bridge write proposals."""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any, Callable

from .reference_codes import ReferenceNamespace, parse_reference_code


_PROFILE_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_OPERATIONS = {"delivery.preview", "delivery.commit", "asset.stage"}
_SCOPES = {
    "bridge:read",
    "bridge:deliver:document",
    "bridge:deliver:storyboard",
    "bridge:deliver:prompt",
    "bridge:deliver:image",
    "bridge:status",
}
_RESULT_STATES = {"previewed", "pending_review", "accepted", "rejected", "failed"}
_FORBIDDEN_REQUEST_FIELDS = {"profileId", "scopes", "operationContext", "clientInfo"}
_MAX_REQUEST_BYTES = 1_000_000
_MAX_RESULT_BYTES = 1_000_000


class BridgeDeliveryValidationError(ValueError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class BridgeDeliveryConflict(RuntimeError):
    def __init__(self, existing_digest: str) -> None:
        self.code = "delivery_conflict"
        self.existing_digest = existing_digest
        super().__init__(self.code)


def create_bridge_delivery_schema(connection: sqlite3.Connection) -> None:
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS bridge_delivery_ledger(
            profile_id TEXT NOT NULL,
            client_request_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN (
                'delivery.preview', 'delivery.commit', 'asset.stage'
            )),
            normalized_request_digest TEXT NOT NULL,
            cvc_code TEXT NOT NULL COLLATE NOCASE,
            operation_context_json TEXT NOT NULL,
            request_json TEXT NOT NULL,
            target_manifest_json TEXT NOT NULL,
            source_manifest_json TEXT NOT NULL,
            provenance TEXT NOT NULL CHECK(provenance='promptcard-bridge'),
            state TEXT NOT NULL CHECK(state IN (
                'processing', 'previewed', 'pending_review',
                'accepted', 'rejected', 'failed'
            )),
            result_json TEXT,
            created_at INTEGER NOT NULL CHECK(created_at >= 0),
            updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
            PRIMARY KEY(profile_id, client_request_id),
            CHECK(length(profile_id) BETWEEN 1 AND 64),
            CHECK(length(client_request_id) BETWEEN 1 AND 128),
            CHECK(length(normalized_request_digest) = 71),
            CHECK(length(cvc_code) = 30),
            CHECK(substr(cvc_code, 1, 4) = 'CVC-')
        );
        CREATE INDEX IF NOT EXISTS bridge_delivery_state_updated
            ON bridge_delivery_ledger(state, updated_at, profile_id, client_request_id);
        CREATE INDEX IF NOT EXISTS bridge_delivery_context_updated
            ON bridge_delivery_ledger(cvc_code, updated_at DESC, profile_id, client_request_id);
    """)


class BridgeDeliveryLedger:
    def __init__(
        self,
        transaction: Callable[..., Any],
        connect: Callable[..., Any],
        now_ms: Callable[[], int],
    ) -> None:
        self._transaction = transaction
        self._connect = connect
        self._now_ms = now_ms

    def begin(
        self,
        operation_context: dict[str, Any],
        operation: str,
        request: dict[str, Any],
    ) -> dict[str, Any]:
        trusted_context = _normalize_operation_context(operation_context)
        normalized_operation = _normalize_operation(operation)
        normalized_request = _normalize_request(request)
        target_manifest = _target_manifest(normalized_request)
        source_manifest = _source_manifest(normalized_request)
        profile_id = trusted_context["profileId"]
        request_id = normalized_request["clientRequestId"]
        digest = normalized_request["normalizedRequestDigest"]

        with self._transaction() as connection:
            existing = self._row(connection, profile_id, request_id)
            if existing is not None:
                if existing[3] != digest or existing[2] != normalized_operation:
                    raise BridgeDeliveryConflict(existing[3])
                return _record(existing, disposition="replay")

            _require_writable_context(connection, target_manifest["cvcCode"])
            timestamp = self._now_ms()
            connection.execute(
                """INSERT INTO bridge_delivery_ledger(
                       profile_id, client_request_id, operation,
                       normalized_request_digest, cvc_code,
                       operation_context_json, request_json,
                       target_manifest_json, source_manifest_json,
                       provenance, state, result_json, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'promptcard-bridge',
                             'processing', NULL, ?, ?)""",
                (
                    profile_id,
                    request_id,
                    normalized_operation,
                    digest,
                    target_manifest["cvcCode"],
                    _json(trusted_context),
                    _json(normalized_request),
                    _json(target_manifest),
                    _json(source_manifest),
                    timestamp,
                    timestamp,
                ),
            )
            created = self._row(connection, profile_id, request_id)
            if created is None:
                raise RuntimeError("bridge delivery insert failed")
            return _record(created, disposition="original")

    def finish(
        self,
        profile_id: str,
        client_request_id: str,
        normalized_request_digest: str,
        state: str,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        profile = _normalize_profile_id(profile_id)
        request_id = _normalize_request_id(client_request_id)
        digest = _normalize_digest(normalized_request_digest)
        if state not in _RESULT_STATES:
            raise BridgeDeliveryValidationError("delivery_state_invalid")
        result_json = _bounded_json(result, _MAX_RESULT_BYTES, "delivery_result_invalid")

        with self._transaction() as connection:
            existing = self._row(connection, profile, request_id)
            if existing is None:
                raise KeyError((profile, request_id))
            if existing[3] != digest:
                raise BridgeDeliveryConflict(existing[3])
            if existing[10] != "processing":
                return _record(existing, disposition="replay")
            timestamp = max(self._now_ms(), existing[13])
            connection.execute(
                """UPDATE bridge_delivery_ledger
                   SET state=?, result_json=?, updated_at=?
                   WHERE profile_id=? AND client_request_id=? AND state='processing'""",
                (state, result_json, timestamp, profile, request_id),
            )
            finished = self._row(connection, profile, request_id)
            if finished is None:
                raise RuntimeError("bridge delivery finish failed")
            return _record(finished, disposition="original")

    def get(self, profile_id: str, client_request_id: str) -> dict[str, Any] | None:
        profile = _normalize_profile_id(profile_id)
        request_id = _normalize_request_id(client_request_id)
        with self._connect() as connection:
            row = self._row(connection, profile, request_id)
        return _record(row, disposition="original") if row is not None else None

    def reconcile_processing(self, stale_before_ms: int, *, limit: int = 100) -> int:
        if type(stale_before_ms) is not int or stale_before_ms < 0:
            raise BridgeDeliveryValidationError("recovery_cutoff_invalid")
        if type(limit) is not int or not 1 <= limit <= 500:
            raise BridgeDeliveryValidationError("recovery_limit_invalid")
        result_json = _json({
            "error": {
                "code": "delivery_interrupted",
                "retryable": True,
            }
        })
        with self._transaction() as connection:
            rows = connection.execute(
                """SELECT profile_id, client_request_id
                   FROM bridge_delivery_ledger
                   WHERE state='processing' AND updated_at<=?
                   ORDER BY updated_at, profile_id, client_request_id
                   LIMIT ?""",
                (stale_before_ms, limit),
            ).fetchall()
            timestamp = self._now_ms()
            for profile_id, request_id in rows:
                connection.execute(
                    """UPDATE bridge_delivery_ledger
                       SET state='failed', result_json=?, updated_at=?
                       WHERE profile_id=? AND client_request_id=? AND state='processing'""",
                    (result_json, timestamp, profile_id, request_id),
                )
            return len(rows)

    @staticmethod
    def _row(
        connection: sqlite3.Connection,
        profile_id: str,
        client_request_id: str,
    ) -> tuple[Any, ...] | None:
        return connection.execute(
            """SELECT profile_id, client_request_id, operation,
                      normalized_request_digest, cvc_code,
                      operation_context_json, request_json,
                      target_manifest_json, source_manifest_json,
                      provenance, state, result_json, created_at, updated_at
               FROM bridge_delivery_ledger
               WHERE profile_id=? AND client_request_id=?""",
            (profile_id, client_request_id),
        ).fetchone()


def _normalize_operation_context(value: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or not set(value) <= {
        "profileId", "scopes", "provenance", "clientInfo"
    }:
        raise BridgeDeliveryValidationError("operation_context_invalid")
    profile_id = _normalize_profile_id(value.get("profileId"))
    scopes = value.get("scopes")
    if (
        not isinstance(scopes, list)
        or not 1 <= len(scopes) <= 6
        or len(scopes) != len(set(scopes))
        or any(scope not in _SCOPES for scope in scopes)
    ):
        raise BridgeDeliveryValidationError("bridge_scopes_invalid")
    if value.get("provenance") != "promptcard-bridge":
        raise BridgeDeliveryValidationError("bridge_provenance_invalid")
    result: dict[str, Any] = {
        "profileId": profile_id,
        "scopes": list(scopes),
        "provenance": "promptcard-bridge",
    }
    client_info = value.get("clientInfo")
    if client_info is not None:
        if (
            not isinstance(client_info, dict)
            or set(client_info) != {"name", "version"}
            or not all(
                isinstance(client_info[key], str) and 1 <= len(client_info[key]) <= 120
                for key in ("name", "version")
            )
        ):
            raise BridgeDeliveryValidationError("client_info_invalid")
        result["clientInfo"] = dict(client_info)
    return result


def _normalize_request(value: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BridgeDeliveryValidationError("delivery_request_invalid")
    if _FORBIDDEN_REQUEST_FIELDS.intersection(value):
        raise BridgeDeliveryValidationError("bridge_authority_in_request")
    request_id = _normalize_request_id(value.get("clientRequestId"))
    digest = _normalize_digest(value.get("normalizedRequestDigest"))
    if value.get("provenance") != "promptcard-bridge":
        raise BridgeDeliveryValidationError("bridge_provenance_invalid")
    _bounded_json(value, _MAX_REQUEST_BYTES, "delivery_request_invalid")
    return {
        **value,
        "clientRequestId": request_id,
        "normalizedRequestDigest": digest,
    }


def _target_manifest(request: dict[str, Any]) -> dict[str, Any]:
    target = request.get("target")
    if not isinstance(target, dict):
        raise BridgeDeliveryValidationError("delivery_target_invalid")
    if "cvcCode" not in target:
        raise BridgeDeliveryValidationError("delivery_target_invalid")
    try:
        cvc_code = parse_reference_code(
            target["cvcCode"], expected_namespace=ReferenceNamespace.CANVAS_CONTEXT
        ).code
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError("delivery_target_invalid") from exc
    return {**target, "cvcCode": cvc_code}


def _source_manifest(request: dict[str, Any]) -> dict[str, Any]:
    source_codes = request.get("sourceCodes")
    skill_pins = request.get("skillPins")
    if not isinstance(source_codes, list) or not isinstance(skill_pins, list):
        raise BridgeDeliveryValidationError("delivery_source_manifest_invalid")
    return {"skillPins": skill_pins, "sourceCodes": source_codes}


def _require_writable_context(connection: sqlite3.Connection, cvc_code: str) -> None:
    row = connection.execute(
        """SELECT context.project_revision, context.revoked_at,
                  project.revision, project.status
           FROM context_packs AS context
           LEFT JOIN public_references AS reference
             ON reference.public_code=context.project_code
            AND reference.namespace='PRJ' AND reference.owner_scope=''
           LEFT JOIN projects AS project ON project.id=reference.internal_id
           WHERE context.cvc_code=?""",
        (cvc_code,),
    ).fetchone()
    if row is None:
        raise BridgeDeliveryValidationError("context_not_found")
    if row[1] is not None:
        raise BridgeDeliveryValidationError("context_revoked")
    if row[2] is None or row[3] != "active":
        raise BridgeDeliveryValidationError("project_unavailable")
    if row[0] != row[2]:
        raise BridgeDeliveryValidationError("context_stale")


def _normalize_profile_id(value: Any) -> str:
    if not isinstance(value, str) or _PROFILE_ID.fullmatch(value) is None:
        raise BridgeDeliveryValidationError("bridge_profile_invalid")
    return value


def _normalize_request_id(value: Any) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        raise BridgeDeliveryValidationError("client_request_id_invalid")
    return value


def _normalize_digest(value: Any) -> str:
    if not isinstance(value, str) or _DIGEST.fullmatch(value) is None:
        raise BridgeDeliveryValidationError("normalized_digest_invalid")
    return value


def _normalize_operation(value: Any) -> str:
    if value not in _OPERATIONS:
        raise BridgeDeliveryValidationError("delivery_operation_invalid")
    return value


def _bounded_json(value: Any, maximum: int, code: str) -> str:
    if not isinstance(value, dict):
        raise BridgeDeliveryValidationError(code)
    try:
        serialized = _json(value)
    except (TypeError, ValueError) as exc:
        raise BridgeDeliveryValidationError(code) from exc
    if len(serialized.encode("utf-8")) > maximum:
        raise BridgeDeliveryValidationError(code)
    return serialized


def _record(row: tuple[Any, ...], *, disposition: str) -> dict[str, Any]:
    return {
        "operationContext": json.loads(row[5]),
        "operation": row[2],
        "clientRequestId": row[1],
        "normalizedRequestDigest": row[3],
        "cvcCode": row[4],
        "request": json.loads(row[6]),
        "targetManifest": json.loads(row[7]),
        "sourceManifest": json.loads(row[8]),
        "provenance": row[9],
        "state": row[10],
        "disposition": disposition,
        "result": json.loads(row[11]) if row[11] is not None else None,
        "createdAt": _iso(row[12]),
        "updatedAt": _iso(row[13]),
    }


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _iso(timestamp_ms: int) -> str:
    return (
        datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
