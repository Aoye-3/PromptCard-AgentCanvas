from __future__ import annotations

import re
import uuid
from typing import Any, Callable, ContextManager


MAX_CLEANUP_BATCH = 100
MAX_ERROR_CODE_LENGTH = 64
_SAFE_ERROR_CODE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")


class ProviderFileCleanupRepository:
    def __init__(
        self,
        connect: Callable[[], ContextManager[Any]],
        transaction: Callable[[], ContextManager[Any]],
        now_ms: Callable[[], int],
    ) -> None:
        self._connect = connect
        self._transaction = transaction
        self._now_ms = now_ms

    def enqueue(
        self,
        provider_id: str,
        connection_id: str,
        remote_file_id: str,
    ) -> dict[str, Any]:
        provider = _opaque_identity(provider_id, "provider_id")
        connection = _opaque_identity(connection_id, "connection_id")
        remote = _opaque_identity(remote_file_id, "remote_file_id", max_length=512)
        created_at = self._now_ms()
        cleanup_id = uuid.uuid4().hex
        with self._transaction() as database:
            database.execute(
                """INSERT OR IGNORE INTO provider_file_cleanup(
                       cleanup_id, provider_id, connection_id, remote_file_id,
                       created_at, last_attempt_at, attempt_count,
                       next_attempt_at, last_error_code
                   ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, NULL)""",
                (
                    cleanup_id,
                    provider,
                    connection,
                    remote,
                    created_at,
                    created_at,
                ),
            )
            row = database.execute(
                f"""SELECT {_CLEANUP_COLUMNS} FROM provider_file_cleanup
                    WHERE provider_id=? AND connection_id=? AND remote_file_id=?""",
                (provider, connection, remote),
            ).fetchone()
        return _projection(row)

    def get_due(self, now: int, limit: int) -> list[dict[str, Any]]:
        if type(now) is not int or now < 0:
            raise ValueError("cleanup now is invalid")
        if type(limit) is not int or not 1 <= limit <= MAX_CLEANUP_BATCH:
            raise ValueError("cleanup limit is invalid")
        with self._connect() as database:
            rows = database.execute(
                f"""SELECT {_CLEANUP_COLUMNS} FROM provider_file_cleanup
                    WHERE next_attempt_at<=?
                    ORDER BY next_attempt_at, created_at, cleanup_id
                    LIMIT ?""",
                (now, limit),
            ).fetchall()
        return [_projection(row) for row in rows]

    def mark_succeeded(self, cleanup_id: str) -> None:
        cleanup = _opaque_identity(cleanup_id, "cleanup_id")
        with self._transaction() as database:
            database.execute(
                "DELETE FROM provider_file_cleanup WHERE cleanup_id=?", (cleanup,)
            )

    def mark_retry(
        self,
        cleanup_id: str,
        next_attempt_at: int,
        redacted_error_code: str,
    ) -> dict[str, Any] | None:
        cleanup = _opaque_identity(cleanup_id, "cleanup_id")
        if type(next_attempt_at) is not int or next_attempt_at < 0:
            raise ValueError("cleanup retry time is invalid")
        error_code = _redacted_error_code(redacted_error_code)
        attempted_at = self._now_ms()
        with self._transaction() as database:
            database.execute(
                """UPDATE provider_file_cleanup
                   SET last_attempt_at=CASE
                           WHEN next_attempt_at=? AND last_error_code=? THEN last_attempt_at
                           ELSE ?
                       END,
                       attempt_count=CASE
                           WHEN next_attempt_at=? AND last_error_code=? THEN attempt_count
                           ELSE attempt_count+1
                       END,
                       next_attempt_at=?, last_error_code=?
                   WHERE cleanup_id=?""",
                (
                    next_attempt_at,
                    error_code,
                    attempted_at,
                    next_attempt_at,
                    error_code,
                    next_attempt_at,
                    error_code,
                    cleanup,
                ),
            )
            row = database.execute(
                f"SELECT {_CLEANUP_COLUMNS} FROM provider_file_cleanup WHERE cleanup_id=?",
                (cleanup,),
            ).fetchone()
        return _projection(row) if row is not None else None

    def diagnostics(self, now: int) -> dict[str, int]:
        if type(now) is not int or now < 0:
            raise ValueError("cleanup now is invalid")
        with self._connect() as database:
            pending = database.execute(
                "SELECT COUNT(*) FROM provider_file_cleanup"
            ).fetchone()[0]
            due = database.execute(
                "SELECT COUNT(*) FROM provider_file_cleanup WHERE next_attempt_at<=?",
                (now,),
            ).fetchone()[0]
        return {"pending": pending, "due": due}


def _opaque_identity(value: str, label: str, *, max_length: int = 200) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or len(value) > max_length:
        raise ValueError(f"{label} is invalid")
    if any(ord(character) < 32 for character in value):
        raise ValueError(f"{label} is invalid")
    return value


def _redacted_error_code(value: str) -> str:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if len(normalized) <= MAX_ERROR_CODE_LENGTH and _SAFE_ERROR_CODE.fullmatch(normalized):
            return normalized
    return "provider_cleanup_failed"


_CLEANUP_COLUMNS = """cleanup_id, provider_id, connection_id, remote_file_id,
created_at, last_attempt_at, attempt_count, next_attempt_at, last_error_code"""


def _projection(row: Any) -> dict[str, Any]:
    return {
        "cleanupId": row[0],
        "providerId": row[1],
        "connectionId": row[2],
        "remoteFileId": row[3],
        "createdAt": row[4],
        "lastAttemptAt": row[5],
        "attemptCount": row[6],
        "nextAttemptAt": row[7],
        "lastErrorCode": row[8],
    }
