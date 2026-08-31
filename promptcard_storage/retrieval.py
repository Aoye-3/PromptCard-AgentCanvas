from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import uuid
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Callable

MAX_QUERY_CHARS = 256
MAX_RESULTS = 20
MAX_RESULT_SUMMARY_CHARS = 600
MAX_EVIDENCE_CHARS = 12_000
_QUERY_TOKEN = re.compile(r"[^\W_]+", re.UNICODE)


def prompt_retrieval_digest(payload_json: str) -> str:
    payload = json.loads(payload_json)
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def create_prompt_retrieval_schema(connection: sqlite3.Connection) -> None:
    drop_prompt_retrieval_preset_triggers(connection)
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS prompt_retrieval_documents(
            row_id INTEGER PRIMARY KEY,
            preset_id TEXT NOT NULL UNIQUE REFERENCES presets(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL CHECK(revision >= 1),
            digest TEXT NOT NULL CHECK(length(digest) = 71 AND substr(digest, 1, 7) = 'sha256:'),
            type TEXT NOT NULL,
            category TEXT NOT NULL,
            label TEXT NOT NULL,
            content TEXT NOT NULL,
            usage_count INTEGER NOT NULL CHECK(usage_count >= 0),
            status TEXT NOT NULL CHECK(status IN ('active','trash')),
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS prompt_retrieval_documents_status
            ON prompt_retrieval_documents(status, preset_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS prompt_retrieval_fts USING fts5(
            label, content, category, type,
            content='prompt_retrieval_documents', content_rowid='row_id',
            tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS prompt_retrieval_documents_ai
        AFTER INSERT ON prompt_retrieval_documents BEGIN
            INSERT INTO prompt_retrieval_fts(rowid, label, content, category, type)
            VALUES (new.row_id, new.label, new.content, new.category, new.type);
        END;
        CREATE TRIGGER IF NOT EXISTS prompt_retrieval_documents_ad
        AFTER DELETE ON prompt_retrieval_documents BEGIN
            INSERT INTO prompt_retrieval_fts(prompt_retrieval_fts, rowid, label, content, category, type)
            VALUES ('delete', old.row_id, old.label, old.content, old.category, old.type);
        END;
        CREATE TRIGGER IF NOT EXISTS prompt_retrieval_documents_au
        AFTER UPDATE ON prompt_retrieval_documents BEGIN
            INSERT INTO prompt_retrieval_fts(prompt_retrieval_fts, rowid, label, content, category, type)
            VALUES ('delete', old.row_id, old.label, old.content, old.category, old.type);
            INSERT INTO prompt_retrieval_fts(rowid, label, content, category, type)
            VALUES (new.row_id, new.label, new.content, new.category, new.type);
        END;
        CREATE TRIGGER IF NOT EXISTS presets_prompt_retrieval_ai
        AFTER INSERT ON presets BEGIN
            INSERT INTO prompt_retrieval_documents(
                preset_id, revision, digest, type, category, label, content,
                usage_count, status, updated_at
            ) VALUES (
                new.id, new.revision, new.retrieval_digest,
                new.type, new.category,
                COALESCE(json_extract(new.payload_json, '$.label'), ''),
                COALESCE(json_extract(new.payload_json, '$.content'), ''),
                new.usage_count, new.status, new.updated_at
            );
        END;
        CREATE TRIGGER IF NOT EXISTS presets_prompt_retrieval_au
        AFTER UPDATE ON presets BEGIN
            UPDATE prompt_retrieval_documents SET
                revision=new.revision,
                digest=new.retrieval_digest,
                type=new.type,
                category=new.category,
                label=COALESCE(json_extract(new.payload_json, '$.label'), ''),
                content=COALESCE(json_extract(new.payload_json, '$.content'), ''),
                usage_count=new.usage_count,
                status=new.status,
                updated_at=new.updated_at
            WHERE preset_id=new.id;
        END;
        CREATE TRIGGER IF NOT EXISTS presets_prompt_retrieval_ad
        AFTER DELETE ON presets BEGIN
            DELETE FROM prompt_retrieval_documents WHERE preset_id=old.id;
        END;
        CREATE TABLE IF NOT EXISTS prompt_retrieval_audits(
            audit_id TEXT PRIMARY KEY,
            caller_kind TEXT NOT NULL CHECK(caller_kind IN ('bridge','local-agent','maintenance')),
            caller_id TEXT NOT NULL,
            query_digest TEXT NOT NULL CHECK(length(query_digest) = 71),
            filters_json TEXT NOT NULL,
            result_codes_json TEXT NOT NULL,
            result_count INTEGER NOT NULL CHECK(result_count >= 0),
            stale_rejected_count INTEGER NOT NULL CHECK(stale_rejected_count >= 0),
            degraded INTEGER NOT NULL CHECK(degraded IN (0,1)),
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS prompt_retrieval_audits_created
            ON prompt_retrieval_audits(created_at DESC, audit_id DESC);
        """
    )


def drop_prompt_retrieval_preset_triggers(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        DROP TRIGGER IF EXISTS presets_prompt_retrieval_ai;
        DROP TRIGGER IF EXISTS presets_prompt_retrieval_au;
        DROP TRIGGER IF EXISTS presets_prompt_retrieval_ad;
        """
    )


def rebuild_prompt_retrieval(connection: sqlite3.Connection) -> int:
    connection.execute("DELETE FROM prompt_retrieval_documents")
    connection.execute(
        """INSERT INTO prompt_retrieval_documents(
               preset_id, revision, digest, type, category, label, content,
               usage_count, status, updated_at
           )
           SELECT id, revision, retrieval_digest, type, category,
                  COALESCE(json_extract(payload_json, '$.label'), ''),
                  COALESCE(json_extract(payload_json, '$.content'), ''),
                  usage_count, status, updated_at
           FROM presets ORDER BY id"""
    )
    return connection.execute("SELECT COUNT(*) FROM prompt_retrieval_documents").fetchone()[0]


def ensure_prompt_retrieval_digest_column(connection: sqlite3.Connection) -> None:
    columns = {
        row[1]
        for row in connection.execute("PRAGMA table_info(presets)").fetchall()
    }
    if "retrieval_digest" not in columns:
        connection.execute("ALTER TABLE presets ADD COLUMN retrieval_digest TEXT")
    rows = connection.execute(
        "SELECT id, payload_json FROM presets WHERE retrieval_digest IS NULL"
    ).fetchall()
    connection.executemany(
        "UPDATE presets SET retrieval_digest=? WHERE id=?",
        [(prompt_retrieval_digest(payload_json), item_id) for item_id, payload_json in rows],
    )


class PromptRetrievalRepository:
    def __init__(
        self,
        data_dir: Path,
        connect: Callable[[], AbstractContextManager[sqlite3.Connection]],
        transaction: Callable[[], AbstractContextManager[sqlite3.Connection]],
        now_ms: Callable[[], int],
    ) -> None:
        self.data_dir = data_dir
        self._connect = connect
        self._transaction = transaction
        self._now_ms = now_ms

    def search(
        self,
        query: str,
        *,
        types: list[str] | None = None,
        categories: list[str] | None = None,
        limit: int = 8,
        caller_kind: str,
        caller_id: str,
    ) -> dict[str, Any]:
        normalized_query, match_query, terms = _normalize_query(query)
        normalized_types = _normalize_filters(types, "types")
        normalized_categories = _normalize_filters(categories, "categories")
        if type(limit) is not int or not 1 <= limit <= MAX_RESULTS:
            raise ValueError("Prompt retrieval limit is invalid")
        if caller_kind not in {"bridge", "local-agent", "maintenance"}:
            raise ValueError("Prompt retrieval callerKind is invalid")
        if not isinstance(caller_id, str) or not caller_id.strip() or len(caller_id.strip()) > 128:
            raise ValueError("Prompt retrieval callerId is invalid")

        with self._transaction() as connection:
            clauses = ["prompt_retrieval_fts MATCH ?", "d.status='active'", "p.status='active'"]
            parameters: list[Any] = [match_query]
            if normalized_types:
                placeholders = ",".join("?" for _ in normalized_types)
                clauses.append(f"d.type IN ({placeholders})")
                parameters.extend(normalized_types)
            if normalized_categories:
                placeholders = ",".join("?" for _ in normalized_categories)
                clauses.append(f"d.category IN ({placeholders})")
                parameters.extend(normalized_categories)
            parameters.append(min(limit * 3, 60))
            rows = connection.execute(
                f"""SELECT d.preset_id, d.revision, d.digest, d.type, d.category,
                           d.label, d.content, d.usage_count, p.payload_json,
                           refs.public_code,
                           bm25(prompt_retrieval_fts, 8.0, 4.0, 2.0, 1.0) AS lexical_rank
                    FROM prompt_retrieval_fts
                    JOIN prompt_retrieval_documents d ON d.row_id=prompt_retrieval_fts.rowid
                    JOIN presets p ON p.id=d.preset_id
                    JOIN public_references refs
                      ON refs.namespace='PLP' AND refs.owner_scope=''
                     AND refs.internal_id=d.preset_id
                    WHERE {' AND '.join(clauses)}
                    ORDER BY lexical_rank ASC, d.usage_count DESC, refs.public_code ASC
                    LIMIT ?""",
                tuple(parameters),
            ).fetchall()

            results: list[dict[str, Any]] = []
            stale_rejected_count = 0
            evidence_chars = 0
            for row in rows:
                payload = json.loads(row[8])
                if payload.get("revision") != row[1] or prompt_retrieval_digest(row[8]) != row[2]:
                    stale_rejected_count += 1
                    continue
                matched_fields = _matched_fields(terms, row[5], row[6], row[4], row[3])
                summary = str(row[6])[:MAX_RESULT_SUMMARY_CHARS]
                if evidence_chars + len(row[5]) + len(summary) > MAX_EVIDENCE_CHARS:
                    break
                media = self._safe_media(connection, row[0], payload)
                lexical = round(max(0.0, -float(row[10])), 8)
                usage = round(min(1.0, math.log1p(row[7]) / 10.0), 8)
                total = round(lexical + usage * 0.05, 8)
                results.append(
                    {
                        "reference": {"namespace": "promptBundle", "code": row[9]},
                        "revision": row[1],
                        "digest": row[2],
                        "title": str(row[5])[:500],
                        "summary": summary,
                        "type": row[3],
                        "category": row[4],
                        "matchedFields": matched_fields,
                        "score": total,
                        "scoreComponents": {"lexical": lexical, "usage": usage},
                        "reason": "Matched " + ", ".join(matched_fields),
                        "media": media,
                    }
                )
                evidence_chars += len(row[5]) + len(summary)
                if len(results) == limit:
                    break

            query_digest = "sha256:" + hashlib.sha256(normalized_query.encode("utf-8")).hexdigest()
            audit_id = str(uuid.uuid4())
            filters = {"types": normalized_types, "categories": normalized_categories, "limit": limit}
            connection.execute(
                """INSERT INTO prompt_retrieval_audits(
                       audit_id, caller_kind, caller_id, query_digest, filters_json,
                       result_codes_json, result_count, stale_rejected_count,
                       degraded, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    audit_id, caller_kind, caller_id.strip(), query_digest,
                    _json(filters), _json([item["reference"]["code"] for item in results]),
                    len(results), stale_rejected_count,
                    1 if stale_rejected_count else 0, self._now_ms(),
                ),
            )
            return {
                "queryDigest": query_digest,
                "results": results,
                "auditId": audit_id,
                "degraded": stale_rejected_count > 0,
                "staleRejectedCount": stale_rejected_count,
            }

    def rebuild(self) -> dict[str, Any]:
        with self._transaction() as connection:
            count = rebuild_prompt_retrieval(connection)
        return {"ok": True, "documents": count}

    def health(self) -> dict[str, Any]:
        with self._connect() as connection:
            active = connection.execute("SELECT COUNT(*) FROM presets WHERE status='active'").fetchone()[0]
            indexed = connection.execute("SELECT COUNT(*) FROM prompt_retrieval_documents WHERE status='active'").fetchone()[0]
            fts = connection.execute("SELECT COUNT(*) FROM prompt_retrieval_fts").fetchone()[0]
            documents = connection.execute("SELECT COUNT(*) FROM prompt_retrieval_documents").fetchone()[0]
        healthy = active == indexed and fts == documents
        return {
            "state": "healthy" if healthy else "degraded",
            "activePrompts": active,
            "indexedActivePrompts": indexed,
            "indexedDocuments": documents,
            "ftsDocuments": fts,
        }

    def _safe_media(self, connection: sqlite3.Connection, preset_id: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        meta = payload.get("meta")
        bindings = meta.get("media") if isinstance(meta, dict) else None
        if not isinstance(bindings, list):
            return []
        result = []
        for binding in bindings[:8]:
            if not isinstance(binding, dict):
                continue
            binding_id = binding.get("id")
            asset_id = binding.get("assetId")
            if not isinstance(binding_id, str) or not isinstance(asset_id, str):
                continue
            reference = connection.execute(
                """SELECT public_code FROM public_references
                   WHERE namespace='PLM' AND owner_scope=? AND internal_id=?""",
                (preset_id, binding_id),
            ).fetchone()
            asset = connection.execute(
                """SELECT relative_path, content_type, size, lifecycle_status
                   FROM assets WHERE asset_id=?""",
                (asset_id,),
            ).fetchone()
            if reference is None or asset is None or asset[3] != "active" or not (self.data_dir / asset[0]).is_file():
                continue
            result.append(
                {
                    "referenceCode": reference[0],
                    "kind": binding.get("kind", "image"),
                    "contentType": asset[1],
                    "size": asset[2],
                }
            )
        return result


def _normalize_query(value: str) -> tuple[str, str, list[str]]:
    if not isinstance(value, str):
        raise ValueError("Prompt retrieval query is invalid")
    normalized = " ".join(value.split())
    if not normalized or len(normalized) > MAX_QUERY_CHARS:
        raise ValueError("Prompt retrieval query is invalid")
    terms = _QUERY_TOKEN.findall(normalized)[:8]
    if not terms or any(len(term) > 64 for term in terms):
        raise ValueError("Prompt retrieval query is invalid")
    match = " OR ".join('"' + term.replace('"', '""') + '"' for term in terms)
    return normalized, match, terms


def _normalize_filters(values: list[str] | None, label: str) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list) or len(values) > 16:
        raise ValueError(f"Prompt retrieval {label} are invalid")
    normalized = []
    for value in values:
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 80:
            raise ValueError(f"Prompt retrieval {label} are invalid")
        normalized.append(value.strip())
    if len(normalized) != len(set(normalized)):
        raise ValueError(f"Prompt retrieval {label} are invalid")
    return normalized


def _matched_fields(terms: list[str], label: str, content: str, category: str, kind: str) -> list[str]:
    values = {"label": label, "content": content, "category": category, "type": kind}
    matched = [field for field, value in values.items() if any(term.casefold() in str(value).casefold() for term in terms)]
    return matched or ["content"]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
