from __future__ import annotations

import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx
from volcenginesdkarkruntime import Ark

from app.gateway.internal_auth import create_internal_auth_headers
from app.gateway.model_management.connection_store import get_connection_store

MAX_CLEANUP_RETRY_BATCH = 20
DEFAULT_CLEANUP_BATCH_BUDGET_SECONDS = 10.0
PROVIDER_DELETE_TIMEOUT_SECONDS = 2.0
_BASE_RETRY_DELAY_MS = 60_000
_MAX_RETRY_DELAY_MS = 60 * 60 * 1000


class ProviderCleanupStorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class CleanupSummary:
    attempted: int
    succeeded: int
    retry_scheduled: int


class ProviderCleanupStorageClient:
    def __init__(
        self,
        base_url: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        resolved_base_url = (
            base_url
            or os.getenv("PROMPTCARD_STORAGE_URL")
            or "http://127.0.0.1:8002"
        ).rstrip("/")
        self._client = client or httpx.Client(
            base_url=resolved_base_url,
            timeout=httpx.Timeout(10.0),
            follow_redirects=False,
        )
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def enqueue(
        self,
        provider_id: str,
        connection_id: str,
        remote_file_id: str,
    ) -> str:
        payload = self._json(
            "POST",
            "/api/internal/provider-file-cleanup",
            json={
                "providerId": provider_id,
                "connectionId": connection_id,
                "remoteFileId": remote_file_id,
            },
        )
        cleanup_id = payload.get("cleanupId")
        if not isinstance(cleanup_id, str) or not cleanup_id:
            raise ProviderCleanupStorageError("provider_cleanup_storage_invalid")
        return cleanup_id

    def get_due(self, *, now: int, limit: int) -> list[dict[str, Any]]:
        payload = self._json(
            "GET",
            "/api/internal/provider-file-cleanup/due",
            params={"now": now, "limit": limit},
        )
        items = payload.get("items")
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise ProviderCleanupStorageError("provider_cleanup_storage_invalid")
        return items

    def mark_succeeded(self, cleanup_id: str) -> None:
        self._json(
            "POST",
            "/api/internal/provider-file-cleanup/"
            f"{quote(cleanup_id, safe='')}/succeeded",
        )

    def mark_retry(
        self,
        cleanup_id: str,
        *,
        next_attempt_at: int,
        error_code: str,
    ) -> None:
        self._json(
            "POST",
            "/api/internal/provider-file-cleanup/"
            f"{quote(cleanup_id, safe='')}/retry",
            json={"nextAttemptAt": next_attempt_at, "errorCode": error_code},
        )

    def _json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            response = self._client.request(
                method,
                path,
                headers=create_internal_auth_headers(),
                **kwargs,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError
            return payload
        except (httpx.HTTPError, ValueError):
            raise ProviderCleanupStorageError("provider_cleanup_storage_unavailable") from None


def enqueue_provider_file_cleanup(
    provider_id: str,
    connection_id: str,
    remote_file_id: str,
) -> str:
    storage = ProviderCleanupStorageClient()
    try:
        return storage.enqueue(provider_id, connection_id, remote_file_id)
    finally:
        storage.close()


def mark_provider_file_cleanup_succeeded(cleanup_id: str) -> None:
    storage = ProviderCleanupStorageClient()
    try:
        storage.mark_succeeded(cleanup_id)
    finally:
        storage.close()


def retry_provider_file_cleanup(
    *,
    limit: int = MAX_CLEANUP_RETRY_BATCH,
    storage: ProviderCleanupStorageClient | Any | None = None,
    connection_store: Any | None = None,
    ark_factory: Callable[..., Any] = Ark,
    now_ms: Callable[[], int] | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    batch_budget_seconds: float = DEFAULT_CLEANUP_BATCH_BUDGET_SECONDS,
) -> CleanupSummary:
    if type(limit) is not int or not 1 <= limit <= MAX_CLEANUP_RETRY_BATCH:
        raise ValueError("provider cleanup limit is invalid")
    if batch_budget_seconds <= 0:
        raise ValueError("provider cleanup budget is invalid")
    current_time = now_ms or (lambda: int(time.time() * 1000))
    now = current_time()
    deadline = monotonic() + batch_budget_seconds
    owned_storage = storage is None
    cleanup_storage = storage or ProviderCleanupStorageClient()
    store = connection_store or get_connection_store()
    attempted = 0
    succeeded = 0
    retry_scheduled = 0
    try:
        due_items = cleanup_storage.get_due(now=now, limit=limit)[:limit]
        for item in due_items:
            remaining_seconds = deadline - monotonic()
            if remaining_seconds <= 0:
                break
            attempted += 1
            cleanup_id = str(item.get("cleanupId") or "")
            error_code: str | None = None
            try:
                connection_id = str(item.get("connectionId") or "")
                if item.get("providerId") != "volcengine-ark":
                    error_code = "provider_unsupported"
                    raise RuntimeError
                connection = store.get_connection_config(connection_id)
                if (
                    connection.get("providerId") != "volcengine-ark"
                    or connection.get("enabled") is not True
                ):
                    error_code = "connection_unavailable"
                    raise RuntimeError
                credential = store.credential_store.get(connection_id)
                if not credential:
                    error_code = "credential_missing"
                    raise RuntimeError
                client = ark_factory(
                    api_key=credential,
                    base_url=str(connection.get("apiBase") or ""),
                    timeout=min(PROVIDER_DELETE_TIMEOUT_SECONDS, remaining_seconds),
                    max_retries=0,
                )
                try:
                    client.files.delete(str(item.get("remoteFileId") or ""))
                except Exception as exc:
                    if getattr(exc, "status_code", None) != 404:
                        raise
                cleanup_storage.mark_succeeded(cleanup_id)
                succeeded += 1
            except Exception:
                attempt_count = item.get("attemptCount")
                attempt_count = attempt_count if type(attempt_count) is int else 0
                delay = min(
                    _BASE_RETRY_DELAY_MS * (2 ** min(attempt_count, 6)),
                    _MAX_RETRY_DELAY_MS,
                )
                cleanup_storage.mark_retry(
                    cleanup_id,
                    next_attempt_at=now + delay,
                    error_code=error_code or "provider_cleanup_failed",
                )
                retry_scheduled += 1
    finally:
        if owned_storage:
            cleanup_storage.close()
    return CleanupSummary(
        attempted=attempted,
        succeeded=succeeded,
        retry_scheduled=retry_scheduled,
    )
