from __future__ import annotations

import json
import hashlib
import os
import shutil
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable, Iterator, Literal

from .assets import (
    DEFAULT_MAX_ASSET_BYTES,
    AssetStore,
    AssetValidationError,
    DeletedAssetLookup,
    prepare_provider_image,
)
from .backup import BackupManager
from .image_runs import (
    decode_cursor,
    encode_cursor,
    image_conversation_title,
    image_run_page,
    normalize_new_image_run,
    normalize_page_limit,
    transition_image_run,
)
from .migration import MigrationError, StorageInitializer
from .reference_codes import (
    ReferenceCodeError,
    ReferenceNamespace,
    generate_reference_code,
    parse_reference_code,
)

Actor = Literal["user", "agent"]
SERVICE_VERSION = "2.0.0"
SCHEMA_VERSION = 10
DATABASE_NAME = "promptcard.sqlite3"
_PUBLIC_REFERENCE_EDGE_WHITESPACE = " \t\n\v\f\r"
_PUBLIC_REFERENCE_EDGE_WHITESPACE_SQL = (
    "char("
    + ",".join(
        str(ord(character))
        for character in _PUBLIC_REFERENCE_EDGE_WHITESPACE
    )
    + ")"
)
JSON_SOURCES = (
    "projects.json",
    "project-trash.json",
    "prompt-library-presets.json",
    "prompt-library-trash.json",
)


class RevisionConflict(Exception):
    def __init__(self, current: dict[str, Any]) -> None:
        super().__init__("revision conflict")
        self.current = current


class MissingItem(Exception):
    pass


class PromptReferenceError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        reference: dict[str, str],
        *,
        status_code: int,
    ) -> None:
        self.code = code
        self.message = message
        self.reference = reference
        self.status_code = status_code
        super().__init__(code)


class DeletedAsset(Exception):
    pass


class AssetInUse(Exception):
    def __init__(self, references: list[dict[str, Any]]) -> None:
        super().__init__("asset is still referenced")
        self.references = references


class DuplicateItem(Exception):
    pass


class FolderCycle(Exception):
    pass


class FolderNotEmpty(Exception):
    pass


class SqliteStore:
    def __init__(
        self,
        data_dir: Path,
        projects_seed: list[dict[str, Any]] | None = None,
        presets_seed: list[dict[str, Any]] | None = None,
        image_preparer: Callable[[str, bytes], dict[str, Any]] | None = None,
    ) -> None:
        self.data_dir = data_dir
        self.database_path = data_dir / DATABASE_NAME
        self.assets_dir = data_dir / "assets"
        self.backups_dir = data_dir.parent / "backups"
        self.projects_seed = projects_seed or []
        self.presets_seed = presets_seed or []
        self._prepare_provider_image = image_preparer or prepare_provider_image
        self._initialize_lock = threading.Lock()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self._assets = AssetStore(
            self.data_dir,
            self._connect,
            self._transaction,
            lambda: self.list_projects()
            + [entry["payload"] for entry in self.list_project_trash()]
            + self.list_recent_captures()
            + self.list_presets()
            + [entry["payload"] for entry in self.list_preset_trash()]
            + self._successful_image_run_payloads()
            + self._image_asset_derivation_payloads()
            + self._project_resource_asset_payloads(),
            now_ms,
        )
        self._backups = BackupManager(
            self.database_path,
            self.assets_dir,
            DATABASE_NAME,
            SERVICE_VERSION,
            SCHEMA_VERSION,
            self._connect,
            iso_now,
        )

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "serviceVersion": SERVICE_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "storage": str(self.data_dir),
            "database": str(self.database_path),
            "pid": os.getpid(),
            "capabilities": {
                "assets": True,
                "sqlite": True,
                "presetBatch": True,
                "browserImportIdempotency": True,
                "backup": True,
                "recentCaptures": True,
                "imageGenerationRuns": True,
                "imageGenerationConversations": True,
                "imageGenerationPlacements": True,
                "imageAssetDerivations": True,
                "projectResources": True,
                "agentConversations": True,
                "skillHub": True,
            },
        }

    def ensure_public_reference(
        self,
        namespace: ReferenceNamespace | str,
        internal_id: str,
        *,
        owner_scope: str = "",
    ) -> str:
        with self._transaction() as connection:
            return self._ensure_public_reference(
                connection,
                namespace,
                internal_id,
                owner_scope=owner_scope,
            )

    def reconcile_public_references(self) -> None:
        with self._transaction() as connection:
            self._reconcile_public_references(connection)

    def resolve_prompt_reference(self, reference_code: str) -> dict[str, Any]:
        parsed = parse_reference_code(reference_code)
        if parsed.namespace not in {
            ReferenceNamespace.PROMPT_BUNDLE,
            ReferenceNamespace.PROMPT_MEDIA,
        }:
            raise ReferenceCodeError("reference_namespace_mismatch")

        canonical_code = parsed.code
        namespace_name = (
            "promptBundle"
            if parsed.namespace is ReferenceNamespace.PROMPT_BUNDLE
            else "promptMedia"
        )
        requested_reference = {
            "namespace": namespace_name,
            "code": canonical_code,
        }
        with self._connect() as connection:
            registry_row = connection.execute(
                """SELECT owner_scope, internal_id FROM public_references
                   WHERE public_code=? AND namespace=?""",
                (canonical_code, parsed.namespace.value),
            ).fetchone()
            if registry_row is None:
                self._raise_prompt_reference_error(
                    "prompt_bundle_reference_not_found"
                    if parsed.namespace is ReferenceNamespace.PROMPT_BUNDLE
                    else "prompt_media_reference_not_found",
                    requested_reference,
                    status_code=404,
                )

            owner_scope, internal_id = registry_row
            prompt_id = (
                internal_id
                if parsed.namespace is ReferenceNamespace.PROMPT_BUNDLE
                else owner_scope
            )
            prompt_row = connection.execute(
                "SELECT status, payload_json FROM presets WHERE id=?",
                (prompt_id,),
            ).fetchone()
            if prompt_row is None:
                self._raise_prompt_reference_error(
                    "prompt_bundle_missing"
                    if parsed.namespace is ReferenceNamespace.PROMPT_BUNDLE
                    else "prompt_media_owner_missing",
                    requested_reference,
                    status_code=410,
                )
            if prompt_row[0] == "trash":
                self._raise_prompt_reference_error(
                    "prompt_bundle_trashed"
                    if parsed.namespace is ReferenceNamespace.PROMPT_BUNDLE
                    else "prompt_media_owner_trashed",
                    requested_reference,
                    status_code=410,
                )

            prompt = json.loads(prompt_row[1])
            media_items = self._preset_media(prompt)
            if (
                parsed.namespace is ReferenceNamespace.PROMPT_MEDIA
                and not any(item.get("id") == internal_id for item in media_items)
            ):
                self._raise_prompt_reference_error(
                    "prompt_media_detached",
                    requested_reference,
                    status_code=410,
                )

            projected = self._with_preset_public_references(connection, prompt)
            resolved_media = [
                self._resolved_prompt_media(connection, item)
                for item in self._preset_media(projected)
            ]
            return {
                "reference": requested_reference,
                "prompt": {
                    "referenceCode": projected["referenceCode"],
                    "revision": projected["revision"],
                    "type": projected["type"],
                    "category": projected["category"],
                    "label": projected["label"],
                    "content": projected["content"],
                },
                "media": resolved_media,
            }

    def create_agent_conversation(self, item: dict[str, Any]) -> dict[str, Any]:
        project_id = str(item.get("projectId") or "").strip()
        if not project_id:
            raise ValueError("Agent conversation projectId is required")
        timestamp = now_ms()
        model_binding = normalize_model_binding(item.get("modelBinding"))
        conversation = {
            "id": str(item.get("id") or uuid.uuid4()),
            "projectId": project_id,
            "entrypoint": str(item.get("entrypoint") or "workspace-chatbot-agent"),
            "mode": str(item.get("mode") or "workspace"),
            "title": str(item.get("title") or "New conversation").strip() or "New conversation",
            "status": "active",
            "createdAt": int(item.get("createdAt") or timestamp),
            "updatedAt": int(item.get("updatedAt") or timestamp),
            "deletedAt": None,
            "modelBinding": model_binding,
        }
        with self._transaction() as connection:
            self._require_active_project(connection, project_id)
            try:
                connection.execute(
                    """INSERT INTO agent_conversations(
                           id, project_id, entrypoint, mode, title, status, created_at, updated_at, model_binding_json
                       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)""",
                    (
                        conversation["id"], project_id, conversation["entrypoint"],
                        conversation["mode"], conversation["title"],
                        conversation["createdAt"], conversation["updatedAt"],
                        _json(model_binding) if model_binding is not None else None,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateItem(conversation["id"]) from exc
        return conversation

    def list_agent_conversations(
        self,
        project_id: str,
        status: str = "active",
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        if status not in {"active", "trash"}:
            raise ValueError("Invalid agent conversation status")
        normalized_limit = max(1, min(int(limit), 100))
        clauses = ["project_id=?", "status=?"]
        parameters: list[Any] = [project_id, status]
        if cursor:
            try:
                cursor_updated_at, cursor_id = cursor.split(":", 1)
                clauses.append("(updated_at < ? OR (updated_at = ? AND id < ?))")
                parameters.extend([int(cursor_updated_at), int(cursor_updated_at), cursor_id])
            except (TypeError, ValueError) as exc:
                raise ValueError("Invalid agent conversation cursor") from exc
        parameters.append(normalized_limit + 1)
        with self._connect() as connection:
            rows = connection.execute(
                f"""SELECT id, project_id, entrypoint, mode, title, status,
                           created_at, updated_at, deleted_at, model_binding_json
                    FROM agent_conversations
                    WHERE {' AND '.join(clauses)}
                    ORDER BY updated_at DESC, id DESC LIMIT ?""",
                tuple(parameters),
            ).fetchall()
        items = [self._agent_conversation_summary(row) for row in rows[:normalized_limit]]
        next_cursor = None
        if len(rows) > normalized_limit and items:
            next_cursor = f"{items[-1]['updatedAt']}:{items[-1]['id']}"
        return {"conversations": items, "nextCursor": next_cursor}

    def get_agent_conversation(
        self,
        conversation_id: str,
        project_id: str,
        include_trash: bool = False,
    ) -> dict[str, Any]:
        status_clause = "status IN ('active','trash')" if include_trash else "status='active'"
        with self._connect() as connection:
            row = connection.execute(
                f"""SELECT id, project_id, entrypoint, mode, title, status,
                           created_at, updated_at, deleted_at, model_binding_json
                    FROM agent_conversations
                    WHERE id=? AND project_id=? AND {status_clause}""",
                (conversation_id, project_id),
            ).fetchone()
            if row is None:
                raise MissingItem(conversation_id)
            messages = [json.loads(item[0]) for item in connection.execute(
                "SELECT payload_json FROM agent_conversation_messages WHERE conversation_id=? ORDER BY ordinal, created_at, id",
                (conversation_id,),
            )]
            proposals = [json.loads(item[0]) for item in connection.execute(
                "SELECT payload_json FROM agent_conversation_proposals WHERE conversation_id=? ORDER BY created_at, id",
                (conversation_id,),
            )]
            turns = [json.loads(item[0]) for item in connection.execute(
                "SELECT result_json FROM agent_conversation_turns WHERE conversation_id=? ORDER BY created_at, request_id",
                (conversation_id,),
            )]
        return {**self._agent_conversation_summary(row), "messages": messages, "proposals": proposals, "turns": turns}

    def rename_agent_conversation(self, conversation_id: str, project_id: str, title: str) -> dict[str, Any]:
        normalized_title = title.strip()
        if not normalized_title:
            raise ValueError("Agent conversation title is required")
        with self._transaction() as connection:
            updated_at = now_ms()
            result = connection.execute(
                "UPDATE agent_conversations SET title=?, updated_at=? WHERE id=? AND project_id=? AND status='active'",
                (normalized_title, updated_at, conversation_id, project_id),
            )
            if result.rowcount == 0:
                raise MissingItem(conversation_id)
        return self.get_agent_conversation(conversation_id, project_id)

    def update_agent_conversation_model_binding(
        self,
        conversation_id: str,
        project_id: str,
        model_binding: dict[str, Any] | None,
    ) -> dict[str, Any]:
        normalized = normalize_model_binding(model_binding)
        with self._transaction() as connection:
            result = connection.execute(
                """UPDATE agent_conversations
                   SET model_binding_json=?, updated_at=?
                   WHERE id=? AND project_id=? AND status='active'""",
                (_json(normalized) if normalized is not None else None, now_ms(), conversation_id, project_id),
            )
            if result.rowcount == 0:
                raise MissingItem(conversation_id)
        with self._connect() as connection:
            row = connection.execute(
                """SELECT id, project_id, entrypoint, mode, title, status,
                           created_at, updated_at, deleted_at, model_binding_json
                    FROM agent_conversations
                    WHERE id=? AND project_id=? AND status='active'""",
                (conversation_id, project_id),
            ).fetchone()
        if row is None:
            raise MissingItem(conversation_id)
        return self._agent_conversation_summary(row)

    def trash_agent_conversation(self, conversation_id: str, project_id: str) -> dict[str, Any]:
        timestamp = now_ms()
        with self._transaction() as connection:
            result = connection.execute(
                """UPDATE agent_conversations
                   SET status='trash', deleted_at=?, updated_at=?
                   WHERE id=? AND project_id=? AND status='active'""",
                (timestamp, timestamp, conversation_id, project_id),
            )
            if result.rowcount == 0:
                raise MissingItem(conversation_id)
        return self.get_agent_conversation(conversation_id, project_id, include_trash=True)

    def restore_agent_conversation(self, conversation_id: str, project_id: str) -> dict[str, Any]:
        timestamp = now_ms()
        with self._transaction() as connection:
            result = connection.execute(
                """UPDATE agent_conversations
                   SET status='active', deleted_at=NULL, updated_at=?
                   WHERE id=? AND project_id=? AND status='trash'""",
                (timestamp, conversation_id, project_id),
            )
            if result.rowcount == 0:
                raise MissingItem(conversation_id)
        return self.get_agent_conversation(conversation_id, project_id)

    def delete_agent_conversation_forever(self, conversation_id: str, project_id: str) -> None:
        with self._transaction() as connection:
            result = connection.execute(
                "DELETE FROM agent_conversations WHERE id=? AND project_id=? AND status='trash'",
                (conversation_id, project_id),
            )
            if result.rowcount == 0:
                raise MissingItem(conversation_id)

    def append_agent_conversation_turn(
        self,
        conversation_id: str,
        project_id: str,
        turn: dict[str, Any],
    ) -> dict[str, Any]:
        request_id = str(turn.get("requestId") or "").strip()
        if not request_id:
            raise ValueError("Agent conversation requestId is required")
        with self._transaction() as connection:
            conversation = connection.execute(
                "SELECT 1 FROM agent_conversations WHERE id=? AND project_id=? AND status='active'",
                (conversation_id, project_id),
            ).fetchone()
            if conversation is None:
                raise MissingItem(conversation_id)
            existing = connection.execute(
                "SELECT result_json FROM agent_conversation_turns WHERE conversation_id=? AND request_id=?",
                (conversation_id, request_id),
            ).fetchone()
            if existing is not None:
                return json.loads(existing[0])
            timestamp = now_ms()
            current_ordinal = connection.execute(
                "SELECT COALESCE(MAX(ordinal), 0) FROM agent_conversation_messages WHERE conversation_id=?",
                (conversation_id,),
            ).fetchone()[0]
            saved_messages: list[dict[str, Any]] = []
            for offset, key in enumerate(("userMessage", "assistantMessage"), start=1):
                message = turn.get(key)
                if not isinstance(message, dict):
                    continue
                saved = {
                    **message,
                    "id": str(message.get("id") or uuid.uuid4()),
                    "createdAt": int(message.get("createdAt") or timestamp),
                }
                connection.execute(
                    """INSERT INTO agent_conversation_messages(
                           id, conversation_id, request_id, ordinal, role, created_at, payload_json
                       ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        saved["id"], conversation_id, request_id, current_ordinal + offset,
                        str(saved.get("role") or "assistant"), saved["createdAt"], _json(saved),
                    ),
                )
                saved_messages.append(saved)
            saved_proposals: list[dict[str, Any]] = []
            for proposal in turn.get("proposals") or []:
                saved = {
                    **proposal,
                    "id": str(proposal.get("id") or uuid.uuid4()),
                    "status": str(proposal.get("status") or "pending"),
                    "createdAt": int(proposal.get("createdAt") or timestamp),
                }
                connection.execute(
                    """INSERT INTO agent_conversation_proposals(
                           id, conversation_id, request_id, message_id, status, created_at, payload_json
                       ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        saved["id"], conversation_id, request_id,
                        saved_messages[-1]["id"] if saved_messages else None,
                        saved["status"], saved["createdAt"], _json(saved),
                    ),
                )
                saved_proposals.append(saved)
            result = {
                "requestId": request_id,
                "messages": saved_messages,
                "proposals": saved_proposals,
                "skillSnapshots": list(turn.get("skillSnapshots") or []),
                "modelSnapshot": turn.get("modelSnapshot"),
                "createdAt": timestamp,
            }
            connection.execute(
                "INSERT INTO agent_conversation_turns(conversation_id, request_id, created_at, result_json) VALUES (?, ?, ?, ?)",
                (conversation_id, request_id, timestamp, _json(result)),
            )
            connection.execute(
                "UPDATE agent_conversations SET updated_at=? WHERE id=?",
                (timestamp, conversation_id),
            )
        return result

    def update_agent_proposal_status(
        self,
        conversation_id: str,
        project_id: str,
        proposal_id: str,
        status: str,
    ) -> dict[str, Any]:
        if status not in {"approved", "rejected"}:
            raise ValueError("Invalid agent proposal status")
        with self._transaction() as connection:
            row = connection.execute(
                """SELECT proposal.payload_json
                   FROM agent_conversation_proposals AS proposal
                   JOIN agent_conversations AS conversation ON conversation.id=proposal.conversation_id
                   WHERE proposal.id=? AND proposal.conversation_id=? AND conversation.project_id=? AND conversation.status='active'""",
                (proposal_id, conversation_id, project_id),
            ).fetchone()
            if row is None:
                raise MissingItem(proposal_id)
            proposal = {**json.loads(row[0]), "status": status}
            connection.execute(
                "UPDATE agent_conversation_proposals SET status=?, payload_json=? WHERE id=?",
                (status, _json(proposal), proposal_id),
            )
        return proposal

    def list_skills(self) -> dict[str, Any]:
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT skill.id, skill.slug, skill.name, skill.description, skill.source,
                          skill.trust_state, skill.capability_id, skill.tool_dependencies_json,
                          revision.revision, revision.digest
                   FROM skills AS skill
                   JOIN skill_revisions AS revision
                     ON revision.skill_id=skill.id AND revision.revision=skill.current_revision
                   ORDER BY skill.name, skill.id"""
            ).fetchall()
        return {"skills": [self._skill_summary(row) for row in rows]}

    def get_skill(self, skill_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """SELECT id, slug, name, description, source, trust_state, capability_id,
                          tool_dependencies_json, current_revision
                   FROM skills WHERE id=?""",
                (skill_id,),
            ).fetchone()
            if row is None:
                raise MissingItem(skill_id)
            revisions = [
                {
                    "revision": revision[0], "digest": revision[1],
                    "instructions": revision[2], "references": json.loads(revision[3]),
                    "createdAt": revision[4],
                }
                for revision in connection.execute(
                    """SELECT revision, digest, instructions, references_json, created_at
                       FROM skill_revisions WHERE skill_id=? ORDER BY revision DESC""",
                    (skill_id,),
                )
            ]
        return {
            "id": row[0], "slug": row[1], "name": row[2], "description": row[3],
            "source": row[4], "trustState": row[5], "capabilityId": row[6],
            "toolDependencies": json.loads(row[7]), "currentRevision": row[8],
            "revisions": revisions,
        }

    def create_skill(self, item: dict[str, Any]) -> dict[str, Any]:
        source = str(item.get("source") or "external")
        if source != "external":
            raise ValueError("Only external Skills can be created through the registry API")
        instructions = str(item.get("instructions") or "").strip()
        if not instructions:
            raise ValueError("Skill instructions are required")
        references = list(item.get("references") or [])
        skill_id = str(item.get("id") or f"SKL-{uuid.uuid4()}")
        slug = str(item.get("slug") or "").strip()
        name = str(item.get("name") or "").strip()
        if not slug or not name:
            raise ValueError("Skill slug and name are required")
        timestamp = now_ms()
        digest = _skill_digest(instructions, references)
        with self._transaction() as connection:
            try:
                connection.execute(
                    """INSERT INTO skills(
                           id, slug, name, description, source, trust_state, capability_id,
                           tool_dependencies_json, current_revision, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, 'external', ?, NULL, ?, 1, ?, ?)""",
                    (
                        skill_id, slug, name, str(item.get("description") or ""),
                        str(item.get("trustState") or "untrusted"),
                        _json(list(item.get("toolDependencies") or [])), timestamp, timestamp,
                    ),
                )
                connection.execute(
                    """INSERT INTO skill_revisions(
                           skill_id, revision, digest, instructions, references_json, created_at
                       ) VALUES (?, 1, ?, ?, ?, ?)""",
                    (skill_id, digest, instructions, _json(references), timestamp),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateItem(skill_id) from exc
        return self.get_skill(skill_id)

    def add_skill_revision(self, skill_id: str, item: dict[str, Any]) -> dict[str, Any]:
        instructions = str(item.get("instructions") or "").strip()
        if not instructions:
            raise ValueError("Skill instructions are required")
        references = list(item.get("references") or [])
        digest = _skill_digest(instructions, references)
        timestamp = now_ms()
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT source, current_revision FROM skills WHERE id=?",
                (skill_id,),
            ).fetchone()
            if row is None:
                raise MissingItem(skill_id)
            if row[0] != "external":
                raise ValueError("Builtin Skill revisions are managed by the application")
            next_revision = int(row[1]) + 1
            try:
                connection.execute(
                    """INSERT INTO skill_revisions(
                           skill_id, revision, digest, instructions, references_json, created_at
                       ) VALUES (?, ?, ?, ?, ?, ?)""",
                    (skill_id, next_revision, digest, instructions, _json(references), timestamp),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateItem(digest) from exc
            connection.execute(
                "UPDATE skills SET current_revision=?, updated_at=? WHERE id=?",
                (next_revision, timestamp, skill_id),
            )
        return self.get_skill(skill_id)

    def list_projects(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM projects WHERE status = 'active' ORDER BY last_opened_at DESC, updated_at DESC"
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def get_project(self, item_id: str) -> dict[str, Any]:
        return self._get_payload("projects", item_id, "active")

    def create_project(self, item: dict[str, Any]) -> dict[str, Any]:
        now = now_ms()
        created = normalize_project({
            **item,
            "id": item.get("id") or str(now),
            "createdAt": item.get("createdAt") or now,
            "updatedAt": item.get("updatedAt") or now,
            "lastOpenedAt": item.get("lastOpenedAt") or now,
            "revision": 1,
        })
        with self._transaction() as connection:
            try:
                self._insert_project(connection, created, "active")
            except sqlite3.IntegrityError as exc:
                raise DuplicateItem(created["id"]) from exc
        return created

    def update_project(self, item_id: str, updates: dict[str, Any], revision: int) -> dict[str, Any]:
        with self._transaction() as connection:
            current = self._get_row_payload(connection, "projects", item_id, "active")
            if current["revision"] != revision:
                raise RevisionConflict(current)
            updated = normalize_project({
                **current,
                **updates,
                "id": current["id"],
                "createdAt": current.get("createdAt"),
                "revision": current["revision"] + 1,
                "updatedAt": updates.get("updatedAt") or now_ms(),
            })
            connection.execute(
                "UPDATE projects SET revision=?, created_at=?, updated_at=?, last_opened_at=?, payload_json=? WHERE id=? AND status='active'",
                (updated["revision"], updated["createdAt"], updated["updatedAt"], updated["lastOpenedAt"], _json(updated), item_id),
            )
        return updated

    def trash_projects(self, ids: list[str], deleted_by: Actor = "user", delete_reason: str | None = None) -> list[dict[str, Any]]:
        return self._set_status("projects", ids, "active", "trash", deleted_by, delete_reason)

    def list_project_trash(self) -> list[dict[str, Any]]:
        return self._list_trash("projects")

    def restore_projects(self, ids: list[str]) -> list[dict[str, Any]]:
        return self._restore("projects", ids)

    def delete_project_trash(self, ids: list[str]) -> None:
        self._delete_trash("projects", ids)

    def list_project_resources(self, project_id: str) -> dict[str, list[dict[str, Any]]]:
        with self._connect() as connection:
            self._require_active_project(connection, project_id)
            folders = [
                self._project_resource_folder(row)
                for row in connection.execute(
                    """SELECT id, project_id, parent_id, name, sort_order, revision, created_at, updated_at
                       FROM project_resource_folders
                       WHERE project_id=?
                       ORDER BY sort_order, created_at, id""",
                    (project_id,),
                )
            ]
            resources = [
                self._project_resource(row)
                for row in connection.execute(
                    """SELECT id, project_id, kind, name, source_asset_id, preview_asset_id,
                              provider_asset_id, width, height, content_type, folder_id,
                              sort_order, revision, created_at, updated_at
                       FROM project_resources
                       WHERE project_id=?
                       ORDER BY kind, sort_order, created_at, id""",
                    (project_id,),
                )
            ]
        return {"folders": folders, "resources": resources}

    def create_project_resource_folder(self, project_id: str, item: dict[str, Any]) -> dict[str, Any]:
        name = self._project_resource_name(item.get("name"))
        item_id = str(item.get("id") or uuid.uuid4())
        parent_id = item.get("parentId")
        timestamp = now_ms()
        with self._transaction() as connection:
            self._require_active_project(connection, project_id)
            if parent_id is not None:
                self._require_project_folder(connection, project_id, str(parent_id))
            sort_order = item.get("sortOrder")
            if not isinstance(sort_order, int):
                sort_order = connection.execute(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM project_resource_folders WHERE project_id=? AND parent_id IS ?",
                    (project_id, parent_id),
                ).fetchone()[0]
            try:
                connection.execute(
                    """INSERT INTO project_resource_folders(
                           id, project_id, parent_id, name, sort_order, revision, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)""",
                    (item_id, project_id, parent_id, name, sort_order, timestamp, timestamp),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateItem(item_id) from exc
            row = connection.execute(
                """SELECT id, project_id, parent_id, name, sort_order, revision, created_at, updated_at
                   FROM project_resource_folders WHERE id=?""",
                (item_id,),
            ).fetchone()
        return self._project_resource_folder(row)

    def update_project_resource_folder(
        self,
        project_id: str,
        folder_id: str,
        updates: dict[str, Any],
        revision: int,
    ) -> dict[str, Any]:
        with self._transaction() as connection:
            self._require_active_project(connection, project_id)
            current = self._require_project_folder(connection, project_id, folder_id)
            if current["revision"] != revision:
                raise RevisionConflict(current)
            parent_id = updates.get("parentId", current["parentId"])
            if parent_id is not None:
                self._require_project_folder(connection, project_id, str(parent_id))
                self._ensure_folder_parent_is_acyclic(connection, project_id, folder_id, str(parent_id))
            name = self._project_resource_name(updates["name"]) if "name" in updates else current["name"]
            sort_order = updates.get("sortOrder", current["sortOrder"])
            if not isinstance(sort_order, int):
                raise ValueError("sortOrder must be an integer")
            timestamp = now_ms()
            connection.execute(
                """UPDATE project_resource_folders
                   SET parent_id=?, name=?, sort_order=?, revision=revision+1, updated_at=?
                   WHERE id=? AND project_id=?""",
                (parent_id, name, sort_order, timestamp, folder_id, project_id),
            )
            row = connection.execute(
                """SELECT id, project_id, parent_id, name, sort_order, revision, created_at, updated_at
                   FROM project_resource_folders WHERE id=?""",
                (folder_id,),
            ).fetchone()
        return self._project_resource_folder(row)

    def delete_project_resource_folder(self, project_id: str, folder_id: str, revision: int) -> None:
        with self._transaction() as connection:
            self._require_active_project(connection, project_id)
            current = self._require_project_folder(connection, project_id, folder_id)
            if current["revision"] != revision:
                raise RevisionConflict(current)
            child_count = connection.execute(
                """SELECT
                     (SELECT COUNT(*) FROM project_resource_folders WHERE project_id=? AND parent_id=?) +
                     (SELECT COUNT(*) FROM project_resources WHERE project_id=? AND folder_id=?)""",
                (project_id, folder_id, project_id, folder_id),
            ).fetchone()[0]
            if child_count:
                raise FolderNotEmpty()
            connection.execute(
                "DELETE FROM project_resource_folders WHERE id=? AND project_id=?",
                (folder_id, project_id),
            )

    def create_project_resource(self, project_id: str, item: dict[str, Any]) -> dict[str, Any]:
        kind = item.get("kind")
        if kind not in {"subject", "material"}:
            raise ValueError("kind must be subject or material")
        name = self._project_resource_name(item.get("name"))
        item_id = str(item.get("id") or uuid.uuid4())
        folder_id = None if kind == "subject" else item.get("folderId")
        timestamp = now_ms()
        asset_ids = (
            item.get("sourceAssetId"),
            item.get("previewAssetId"),
            item.get("providerAssetId"),
        )
        if not all(isinstance(asset_id, str) and asset_id for asset_id in asset_ids):
            raise ValueError("sourceAssetId, previewAssetId and providerAssetId are required")
        width = item.get("width")
        height = item.get("height")
        if not isinstance(width, int) or width <= 0 or not isinstance(height, int) or height <= 0:
            raise ValueError("width and height must be positive integers")
        content_type = item.get("contentType")
        if not isinstance(content_type, str) or not content_type:
            raise ValueError("contentType is required")
        with self._transaction() as connection:
            self._require_active_project(connection, project_id)
            if folder_id is not None:
                self._require_project_folder(connection, project_id, str(folder_id))
            sort_order = item.get("sortOrder")
            if not isinstance(sort_order, int):
                sort_order = connection.execute(
                    """SELECT COALESCE(MAX(sort_order), -1) + 1 FROM project_resources
                       WHERE project_id=? AND kind=? AND folder_id IS ?""",
                    (project_id, kind, folder_id),
                ).fetchone()[0]
            try:
                connection.execute(
                    """INSERT INTO project_resources(
                           id, project_id, kind, name, source_asset_id, preview_asset_id,
                           provider_asset_id, width, height, content_type, folder_id,
                           sort_order, revision, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                    (
                        item_id, project_id, kind, name, *asset_ids, width, height,
                        content_type, folder_id, sort_order, timestamp, timestamp,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateItem(item_id) from exc
            row = connection.execute(
                """SELECT id, project_id, kind, name, source_asset_id, preview_asset_id,
                          provider_asset_id, width, height, content_type, folder_id,
                          sort_order, revision, created_at, updated_at
                   FROM project_resources WHERE id=?""",
                (item_id,),
            ).fetchone()
        return self._project_resource(row)

    def update_project_resource(
        self,
        project_id: str,
        resource_id: str,
        updates: dict[str, Any],
        revision: int,
    ) -> dict[str, Any]:
        with self._transaction() as connection:
            self._require_active_project(connection, project_id)
            current = self._require_project_resource(connection, project_id, resource_id)
            if current["revision"] != revision:
                raise RevisionConflict(current)
            folder_id = updates.get("folderId", current["folderId"])
            if current["kind"] == "subject":
                folder_id = None
            elif folder_id is not None:
                self._require_project_folder(connection, project_id, str(folder_id))
            name = self._project_resource_name(updates["name"]) if "name" in updates else current["name"]
            sort_order = updates.get("sortOrder", current["sortOrder"])
            if not isinstance(sort_order, int):
                raise ValueError("sortOrder must be an integer")
            timestamp = now_ms()
            connection.execute(
                """UPDATE project_resources
                   SET name=?, folder_id=?, sort_order=?, revision=revision+1, updated_at=?
                   WHERE id=? AND project_id=?""",
                (name, folder_id, sort_order, timestamp, resource_id, project_id),
            )
            row = connection.execute(
                """SELECT id, project_id, kind, name, source_asset_id, preview_asset_id,
                          provider_asset_id, width, height, content_type, folder_id,
                          sort_order, revision, created_at, updated_at
                   FROM project_resources WHERE id=?""",
                (resource_id,),
            ).fetchone()
        return self._project_resource(row)

    def delete_project_resource(self, project_id: str, resource_id: str, revision: int) -> None:
        with self._transaction() as connection:
            self._require_active_project(connection, project_id)
            current = self._require_project_resource(connection, project_id, resource_id)
            if current["revision"] != revision:
                raise RevisionConflict(current)
            connection.execute(
                "DELETE FROM project_resources WHERE id=? AND project_id=?",
                (resource_id, project_id),
            )

    def update_project_resource_layout(
        self,
        project_id: str,
        layout: dict[str, Any],
    ) -> dict[str, list[dict[str, Any]]]:
        folders = layout.get("folders", [])
        resources = layout.get("resources", [])
        if not isinstance(folders, list) or not isinstance(resources, list):
            raise ValueError("folders and resources must be arrays")
        with self._transaction() as connection:
            self._require_active_project(connection, project_id)
            current_folders = {
                folder["id"]: folder
                for folder in (
                    self._project_resource_folder(row)
                    for row in connection.execute(
                        """SELECT id, project_id, parent_id, name, sort_order, revision, created_at, updated_at
                           FROM project_resource_folders WHERE project_id=?""",
                        (project_id,),
                    )
                )
            }
            current_resources = {
                resource["id"]: resource
                for resource in (
                    self._project_resource(row)
                    for row in connection.execute(
                        """SELECT id, project_id, kind, name, source_asset_id, preview_asset_id,
                                  provider_asset_id, width, height, content_type, folder_id,
                                  sort_order, revision, created_at, updated_at
                           FROM project_resources WHERE project_id=?""",
                        (project_id,),
                    )
                )
            }
            proposed_parents = {item["id"]: item.get("parentId") for item in folders}
            for item in folders:
                current = current_folders.get(item.get("id"))
                if current is None:
                    raise MissingItem()
                if current["revision"] != item.get("revision"):
                    raise RevisionConflict(current)
                parent_id = item.get("parentId")
                if parent_id is not None and parent_id not in current_folders:
                    raise MissingItem()
                self._ensure_proposed_folder_parent_is_acyclic(
                    item["id"], parent_id, proposed_parents, current_folders
                )
                if not isinstance(item.get("sortOrder"), int):
                    raise ValueError("sortOrder must be an integer")
            for item in resources:
                current = current_resources.get(item.get("id"))
                if current is None:
                    raise MissingItem()
                if current["revision"] != item.get("revision"):
                    raise RevisionConflict(current)
                folder_id = None if current["kind"] == "subject" else item.get("folderId")
                if folder_id is not None and folder_id not in current_folders:
                    raise MissingItem()
                if not isinstance(item.get("sortOrder"), int):
                    raise ValueError("sortOrder must be an integer")
            timestamp = now_ms()
            for item in folders:
                connection.execute(
                    """UPDATE project_resource_folders
                       SET parent_id=?, sort_order=?, revision=revision+1, updated_at=?
                       WHERE id=? AND project_id=?""",
                    (item.get("parentId"), item["sortOrder"], timestamp, item["id"], project_id),
                )
            for item in resources:
                current = current_resources[item["id"]]
                connection.execute(
                    """UPDATE project_resources
                       SET folder_id=?, sort_order=?, revision=revision+1, updated_at=?
                       WHERE id=? AND project_id=?""",
                    (
                        None if current["kind"] == "subject" else item.get("folderId"),
                        item["sortOrder"], timestamp, item["id"], project_id,
                    ),
                )
        return self.list_project_resources(project_id)

    def list_recent_captures(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT recent_captures.payload_json
                   FROM recent_captures
                   LEFT JOIN assets ON assets.asset_id = recent_captures.asset_id
                   WHERE assets.lifecycle_status='active' OR assets.asset_id IS NULL
                   ORDER BY recent_captures.captured_at DESC, recent_captures.created_at DESC"""
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def get_recent_capture(self, item_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """SELECT recent_captures.payload_json
                   FROM recent_captures
                   LEFT JOIN assets ON assets.asset_id = recent_captures.asset_id
                   WHERE recent_captures.id=?
                     AND (assets.lifecycle_status='active' OR assets.asset_id IS NULL)""",
                (item_id,),
            ).fetchone()
        if not row:
            raise MissingItem()
        return json.loads(row[0])

    def create_recent_capture(self, item: dict[str, Any]) -> dict[str, Any]:
        created = normalize_recent_capture(item)
        with self._transaction() as connection:
            try:
                self._insert_recent_capture(connection, created)
            except sqlite3.IntegrityError as exc:
                raise DuplicateItem(created["id"]) from exc
        return created

    def update_recent_capture(self, item_id: str, updates: dict[str, Any], revision: int) -> dict[str, Any]:
        with self._transaction() as connection:
            row = connection.execute("SELECT payload_json FROM recent_captures WHERE id=?", (item_id,)).fetchone()
            if not row:
                raise MissingItem()
            current = json.loads(row[0])
            if current["revision"] != revision:
                raise RevisionConflict(current)
            updated = normalize_recent_capture({
                **current,
                **updates,
                "id": current["id"],
                "assetId": current["assetId"],
                "createdAt": current.get("createdAt"),
                "capturedAt": updates.get("capturedAt", current.get("capturedAt")),
                "revision": current["revision"] + 1,
                "updatedAt": updates.get("updatedAt") or now_ms(),
            })
            connection.execute(
                "UPDATE recent_captures SET asset_id=?, kind=?, status=?, captured_at=?, updated_at=?, revision=?, payload_json=? WHERE id=?",
                (
                    updated["assetId"],
                    updated["kind"],
                    updated["status"],
                    updated["capturedAt"],
                    updated["updatedAt"],
                    updated["revision"],
                    _json(updated),
                    item_id,
                ),
            )
        return updated

    def delete_recent_capture(self, item_id: str, revision: int) -> None:
        with self._transaction() as connection:
            row = connection.execute("SELECT payload_json FROM recent_captures WHERE id=?", (item_id,)).fetchone()
            if not row:
                raise MissingItem()
            current = json.loads(row[0])
            if current["revision"] != revision:
                raise RevisionConflict(current)
            connection.execute("DELETE FROM recent_captures WHERE id=?", (item_id,))

    def register_recent_captures_to_prompt_library(self, payload: dict[str, Any]) -> dict[str, Any]:
        intent = payload.get("intent") or "initial"
        mode = payload.get("mode")
        requested = payload.get("captures")
        if intent not in {"initial", "analysis-derived"}:
            raise ValueError("Registration intent must be initial or analysis-derived")
        if mode not in {"separate", "merged"}:
            raise ValueError("Registration mode must be separate or merged")
        if not isinstance(requested, list) or not requested:
            raise ValueError("At least one recent capture is required")
        if intent == "analysis-derived" and (mode != "separate" or len(requested) != 1):
            raise ValueError("Analysis-derived registration requires exactly one separate capture")

        with self._transaction() as connection:
            captures: list[dict[str, Any]] = []
            assets: list[dict[str, Any]] = []
            for request in requested:
                if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                    raise ValueError("Each capture registration requires an id")
                row = connection.execute(
                    "SELECT payload_json FROM recent_captures WHERE id=?", (request["id"],)
                ).fetchone()
                if not row:
                    raise MissingItem(request["id"])
                capture = json.loads(row[0])
                if capture["revision"] != request.get("revision"):
                    raise RevisionConflict(capture)
                if capture.get("registeredPromptId") and intent != "analysis-derived":
                    raise ValueError(f"Recent capture is already registered: {capture['id']}")
                asset_row = connection.execute(
                    "SELECT original_filename, content_type, size FROM assets WHERE asset_id=? AND lifecycle_status='active'",
                    (capture["assetId"],),
                ).fetchone()
                if not asset_row:
                    raise MissingItem(capture["assetId"])
                captures.append(capture)
                assets.append({
                    "id": capture["assetId"],
                    "filename": asset_row[0],
                    "contentType": asset_row[1],
                    "size": asset_row[2],
                })

            prompt_inputs = requested if mode == "separate" else [payload.get("prompt")]
            if not all(isinstance(value, dict) for value in prompt_inputs):
                raise ValueError("Prompt fields are required")

            now = now_ms()
            presets: list[dict[str, Any]] = []
            capture_groups = [[index] for index in range(len(captures))] if mode == "separate" else [list(range(len(captures)))]
            connection.execute(
                "UPDATE presets SET sort_order = sort_order + ? WHERE status='active'",
                (len(capture_groups),),
            )
            for preset_index, capture_indexes in enumerate(capture_groups):
                prompt_input = prompt_inputs[preset_index]
                assert isinstance(prompt_input, dict)
                label = str(prompt_input.get("label") or "").strip()
                content = str(prompt_input.get("content") or "").strip()
                if not label or not content:
                    raise ValueError("Prompt label and content are required")
                preset_type = str(prompt_input.get("type") or _default_prompt_type([captures[index] for index in capture_indexes]))
                preset_category = str(prompt_input.get("category") or preset_type).strip() or preset_type
                preset_id = f"preset-capture-{uuid.uuid4().hex}"
                grouped_captures = [captures[index] for index in capture_indexes]
                grouped_assets = [assets[index] for index in capture_indexes]
                created = normalize_preset({
                    "id": preset_id,
                    "type": preset_type,
                    "category": preset_category,
                    "label": label,
                    "content": content,
                    "usageCount": 0,
                    "createdAt": now + preset_index,
                    "updatedAt": now + preset_index,
                    "revision": 1,
                    "meta": {
                        "media": [_capture_media_item(asset) for asset in grouped_assets],
                        "recentCaptureSources": [_capture_source_metadata(capture) for capture in grouped_captures],
                    },
                })
                try:
                    self._insert_preset(connection, created, "active", preset_index)
                except sqlite3.IntegrityError as exc:
                    raise DuplicateItem(created["id"]) from exc
                self._ensure_preset_public_references(connection, created)
                presets.append(
                    self._with_preset_public_references(connection, created)
                )

            registered: list[dict[str, Any]] = []
            for capture_index, capture in enumerate(captures):
                if capture.get("registeredPromptId") and intent == "analysis-derived":
                    registered.append(capture)
                    continue
                preset_index = capture_index if mode == "separate" else 0
                updated = normalize_recent_capture({
                    **capture,
                    "status": "registeredToPromptLibrary",
                    "registeredPromptId": presets[preset_index]["id"],
                    "registeredAt": now,
                    "revision": capture["revision"] + 1,
                    "updatedAt": now,
                })
                connection.execute(
                    "UPDATE recent_captures SET status=?, updated_at=?, revision=?, payload_json=? WHERE id=?",
                    (updated["status"], updated["updatedAt"], updated["revision"], _json(updated), updated["id"]),
                )
                registered.append(updated)

        return {"presets": presets, "captures": registered}

    def list_presets(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM presets WHERE status='active' ORDER BY sort_order, created_at, id"
            ).fetchall()
            return [
                self._with_preset_public_references(connection, json.loads(row[0]))
                for row in rows
            ]

    def get_preset(self, item_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            prompt = self._get_row_payload(connection, "presets", item_id, "active")
            return self._with_preset_public_references(connection, prompt)

    def create_preset(self, item: dict[str, Any]) -> dict[str, Any]:
        now = now_ms()
        created = normalize_preset({
            **_strip_preset_reference_codes(item),
            "id": item.get("id") or f"preset-{now}",
            "usageCount": item.get("usageCount", 0),
            "createdAt": item.get("createdAt") or now,
            "updatedAt": item.get("updatedAt") or now,
            "revision": 1,
        })
        with self._transaction() as connection:
            sort_order = connection.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM presets WHERE status='active'").fetchone()[0]
            try:
                self._insert_preset(connection, created, "active", sort_order)
            except sqlite3.IntegrityError as exc:
                raise DuplicateItem(created["id"]) from exc
            self._ensure_preset_public_references(connection, created)
            return self._with_preset_public_references(connection, created)

    def update_preset(self, item_id: str, updates: dict[str, Any], revision: int) -> dict[str, Any]:
        with self._transaction() as connection:
            current = self._get_row_payload(connection, "presets", item_id, "active")
            if current["revision"] != revision:
                raise RevisionConflict(current)
            normalized_updates = _strip_preset_reference_codes(updates)
            updated = normalize_preset({
                **current,
                **normalized_updates,
                "id": current["id"],
                "createdAt": current.get("createdAt"),
                "revision": current["revision"] + 1,
                "updatedAt": normalized_updates.get("updatedAt") or now_ms(),
            })
            connection.execute(
                "UPDATE presets SET revision=?, type=?, category=?, usage_count=?, created_at=?, updated_at=?, payload_json=? WHERE id=? AND status='active'",
                (updated["revision"], updated["type"], updated["category"], updated["usageCount"], updated["createdAt"], updated["updatedAt"], _json(updated), item_id),
            )
            self._ensure_preset_public_references(connection, updated)
            return self._with_preset_public_references(connection, updated)

    def reorder_presets(self, ordered_ids: list[str], revision_map: dict[str, int]) -> list[dict[str, Any]]:
        with self._transaction() as connection:
            active = self._active_presets(connection)
            by_id = {item["id"]: item for item in active}
            for item_id in ordered_ids:
                if item_id in by_id and by_id[item_id]["revision"] != revision_map.get(item_id):
                    raise RevisionConflict(by_id[item_id])
            ordered_set = set(ordered_ids)
            next_items = [by_id[item_id] for item_id in ordered_ids if item_id in by_id]
            next_items.extend(item for item in active if item["id"] not in ordered_set)
            now = now_ms()
            for index, item in enumerate(next_items):
                if item["id"] in ordered_set:
                    item = {**item, "revision": item["revision"] + 1, "updatedAt": now}
                    connection.execute(
                        "UPDATE presets SET sort_order=?, revision=?, updated_at=?, payload_json=? WHERE id=?",
                        (index, item["revision"], now, _json(item), item["id"]),
                    )
                    next_items[index] = item
                else:
                    connection.execute("UPDATE presets SET sort_order=? WHERE id=?", (index, item["id"]))
            return [
                self._with_preset_public_references(connection, item)
                for item in next_items
            ]

    def replace_presets(self, presets: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized = [
            normalize_preset(_strip_preset_reference_codes(item))
            for item in presets
        ]
        _ensure_unique_ids(normalized, "preset batch")
        with self._transaction() as connection:
            current = {item["id"]: item for item in self._active_presets(connection)}
            incoming_ids = {item["id"] for item in normalized}
            now = now_ms()
            for index, item in enumerate(normalized):
                existing = current.get(item["id"])
                if existing:
                    if item.get("revision", 1) != existing["revision"]:
                        raise RevisionConflict(existing)
                    next_item = normalize_preset({**existing, **item, "revision": existing["revision"] + 1, "updatedAt": now})
                    connection.execute(
                        "UPDATE presets SET revision=?, type=?, category=?, usage_count=?, sort_order=?, updated_at=?, payload_json=? WHERE id=?",
                        (next_item["revision"], next_item["type"], next_item["category"], next_item["usageCount"], index, next_item["updatedAt"], _json(next_item), item["id"]),
                    )
                    normalized[index] = next_item
                else:
                    next_item = normalize_preset({**item, "revision": 1})
                    self._insert_preset(connection, next_item, "active", index)
                    normalized[index] = next_item
                self._ensure_preset_public_references(connection, normalized[index])
            removed = [item_id for item_id in current if item_id not in incoming_ids]
            if removed:
                placeholders = ",".join("?" for _ in removed)
                connection.execute(
                    f"UPDATE presets SET status='trash', deleted_at=?, deleted_by='user', delete_reason='batch replace' WHERE id IN ({placeholders})",
                    (now, *removed),
                )
            return [
                self._with_preset_public_references(connection, item)
                for item in normalized
            ]

    def increment_preset_usage(self, item_id: str, revision: int) -> dict[str, Any]:
        current = self.get_preset(item_id)
        return self.update_preset(item_id, {"usageCount": current.get("usageCount", 0) + 1}, revision)

    def trash_presets(self, ids: list[str], deleted_by: Actor = "user", delete_reason: str | None = None) -> list[dict[str, Any]]:
        moved = self._set_status("presets", ids, "active", "trash", deleted_by, delete_reason)
        with self._connect() as connection:
            return [
                self._with_preset_public_references(connection, item)
                for item in moved
            ]

    def list_preset_trash(self) -> list[dict[str, Any]]:
        items = self._list_trash("presets")
        with self._connect() as connection:
            return [
                {
                    **item,
                    "payload": self._with_preset_public_references(
                        connection, item["payload"]
                    ),
                }
                for item in items
            ]

    def restore_presets(self, ids: list[str]) -> list[dict[str, Any]]:
        restored = self._restore("presets", ids)
        with self._connect() as connection:
            return [
                self._with_preset_public_references(connection, item)
                for item in restored
            ]

    def delete_preset_trash(self, ids: list[str]) -> None:
        self._delete_trash("presets", ids)

    def migrate_browser_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        migration_id = str(payload.get("migrationId") or "browser-cache-v1")
        with self._transaction() as connection:
            if connection.execute("SELECT 1 FROM browser_imports WHERE migration_id=?", (migration_id,)).fetchone():
                return {"projects": 0, "presets": 0, "alreadyApplied": True}
            imported_projects = 0
            imported_presets = 0
            for raw in payload.get("projects") or []:
                item = normalize_project(raw)
                if not connection.execute("SELECT 1 FROM projects WHERE id=?", (item["id"],)).fetchone():
                    self._insert_project(connection, item, "active")
                    imported_projects += 1
            workspace = payload.get("workspace")
            if workspace and workspace.get("pages"):
                workspace_id = str(workspace.get("savedAt") or now_ms())
                if not connection.execute("SELECT 1 FROM projects WHERE id=?", (workspace_id,)).fetchone():
                    now = now_ms()
                    item = normalize_project({
                        "id": workspace_id, "title": "Migrated browser workspace", "type": "card",
                        "pages": workspace.get("pages") or [], "currentPage": workspace.get("currentPage") or 0,
                        "createdAt": now, "updatedAt": now, "lastOpenedAt": now,
                        "meta": {"source": "browser-workspace"},
                    })
                    self._insert_project(connection, item, "active")
                    imported_projects += 1
            next_order = connection.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM presets").fetchone()[0]
            for raw in payload.get("presets") or []:
                item = normalize_preset(_strip_preset_reference_codes(raw))
                if not connection.execute("SELECT 1 FROM presets WHERE id=?", (item["id"],)).fetchone():
                    self._insert_preset(connection, item, "active", next_order)
                    self._ensure_preset_public_references(connection, item)
                    next_order += 1
                    imported_presets += 1
            connection.execute(
                "INSERT INTO browser_imports(migration_id, applied_at) VALUES (?, ?)",
                (migration_id, now_ms()),
            )
        return {"projects": imported_projects, "presets": imported_presets, "alreadyApplied": False}

    def create_image_generation_run(self, item: dict[str, Any]) -> dict[str, Any]:
        return self.create_image_generation_runs([item])[0]

    def create_image_generation_runs(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not isinstance(items, list) or not 1 <= len(items) <= 11:
            raise ValueError("Image generation run batch must contain between 1 and 11 runs")
        timestamp = now_ms()
        created_runs = [normalize_new_image_run(item, timestamp) for item in items]
        run_ids = [item["id"] for item in created_runs]
        if len(run_ids) != len(set(run_ids)):
            raise DuplicateItem("Image generation run IDs must be unique")

        with self._transaction() as connection:
            for created in created_runs:
                conversation_id = created.get("conversationId")
                if conversation_id is not None:
                    conversation = connection.execute(
                        "SELECT project_id FROM image_generation_conversations WHERE id=?",
                        (conversation_id,),
                    ).fetchone()
                    if conversation is None:
                        connection.execute(
                            "INSERT INTO image_generation_conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                            (
                                conversation_id,
                                created["projectId"],
                                image_conversation_title(created["requestSnapshot"], created["createdAt"]),
                                created["createdAt"],
                                created["createdAt"],
                            ),
                        )
                    elif conversation[0] != created["projectId"]:
                        raise MissingItem()
                try:
                    connection.execute(
                        "INSERT INTO image_generation_runs(id, project_id, node_id, conversation_id, connection_id, provider_id, model_id, state, created_at, started_at, finished_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            created["id"], created["projectId"], created.get("nodeId"), conversation_id,
                            created["connectionId"], created["providerId"], created["modelId"], created["state"], created["createdAt"],
                            None, None, _json(created),
                        ),
                    )
                except sqlite3.IntegrityError as exc:
                    raise DuplicateItem(created["id"]) from exc
                if conversation_id is not None:
                    connection.execute(
                        "UPDATE image_generation_conversations SET updated_at=MAX(updated_at, ?) WHERE id=?",
                        (created["createdAt"], conversation_id),
                    )
        return created_runs

    def get_image_generation_run(self, run_id: str, *, project_id: str) -> dict[str, Any]:
        if not isinstance(project_id, str) or not project_id:
            raise ValueError("Image generation run projectId is required")
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM image_generation_runs WHERE id=? AND project_id=?",
                (run_id, project_id),
            ).fetchone()
        if not row:
            raise MissingItem()
        return self._with_output_asset_states(json.loads(row[0]))

    def update_image_generation_run_state(self, run_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT payload_json FROM image_generation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if not row:
                raise MissingItem()
            updated = transition_image_run(json.loads(row[0]), patch, now_ms())
            if updated["state"] == "succeeded" and updated["outputAssetIds"]:
                placeholders = ",".join("?" for _ in updated["outputAssetIds"])
                registered = {
                    asset_row[0]
                    for asset_row in connection.execute(
                        f"SELECT asset_id FROM assets WHERE asset_id IN ({placeholders})",
                        updated["outputAssetIds"],
                    )
                }
                if any(asset_id not in registered for asset_id in updated["outputAssetIds"]):
                    raise MissingItem()
            connection.execute(
                "UPDATE image_generation_runs SET state=?, started_at=?, finished_at=?, payload_json=? WHERE id=?",
                (updated["state"], updated.get("startedAt"), updated.get("finishedAt"), _json(updated), run_id),
            )
            conversation_id = updated.get("conversationId")
            if conversation_id is not None:
                updated_at = updated.get("finishedAt") or updated.get("startedAt") or now_ms()
                connection.execute(
                    "UPDATE image_generation_conversations SET updated_at=MAX(updated_at, ?) WHERE id=?",
                    (updated_at, conversation_id),
                )
                if updated["state"] == "succeeded" and updated["outputAssetIds"]:
                    placement = {
                        "runId": updated["id"],
                        "projectId": updated["projectId"],
                        "conversationId": conversation_id,
                        "assetId": updated["outputAssetIds"][0],
                        "state": "pending",
                        "createdAt": updated_at,
                        "updatedAt": updated_at,
                    }
                    connection.execute(
                        "INSERT INTO image_generation_canvas_placements(run_id, project_id, conversation_id, asset_id, state, canvas_node_id, created_at, updated_at, payload_json) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?)",
                        (
                            placement["runId"], placement["projectId"], placement["conversationId"],
                            placement["assetId"], placement["createdAt"], placement["updatedAt"],
                            _json(placement),
                        ),
                    )
        return updated

    def list_image_generation_runs(
        self,
        *,
        project_id: str | None = None,
        node_id: str | None = None,
        conversation_id: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        if not isinstance(project_id, str) or not project_id:
            raise ValueError("Image generation run projectId is required")
        normalized_limit = normalize_page_limit(limit)
        cursor_value = decode_cursor(cursor)
        clauses: list[str] = []
        parameters: list[Any] = []
        clauses.append("project_id=?")
        parameters.append(project_id)
        if node_id is not None:
            clauses.append("node_id=?")
            parameters.append(node_id)
        if conversation_id is not None:
            clauses.append("conversation_id=?")
            parameters.append(conversation_id)
        if cursor_value is not None:
            clauses.append("(created_at < ? OR (created_at = ? AND id < ?))")
            parameters.extend((cursor_value[0], cursor_value[0], cursor_value[1]))
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        parameters.append(normalized_limit + 1)
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT payload_json FROM image_generation_runs{where} ORDER BY created_at DESC, id DESC LIMIT ?",
                parameters,
            ).fetchall()
        page = image_run_page([json.loads(row[0]) for row in rows], normalized_limit)
        page["runs"] = [self._with_output_asset_states(run) for run in page["runs"]]
        return page

    def list_image_generation_conversations(
        self,
        *,
        project_id: str,
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        if not isinstance(project_id, str) or not project_id:
            raise ValueError("Image generation conversation projectId is required")
        normalized_limit = normalize_page_limit(limit)
        cursor_value = decode_cursor(cursor)
        parameters: list[Any] = [project_id]
        cursor_clause = ""
        if cursor_value is not None:
            cursor_clause = " AND (updated_at < ? OR (updated_at = ? AND id < ?))"
            parameters.extend((cursor_value[0], cursor_value[0], cursor_value[1]))
        parameters.append(normalized_limit + 1)
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    conversation.id,
                    conversation.project_id,
                    conversation.title,
                    conversation.created_at,
                    conversation.updated_at,
                    COUNT(run.id) AS turn_count,
                    (
                        SELECT latest.payload_json
                        FROM image_generation_runs AS latest
                        WHERE latest.conversation_id=conversation.id
                          AND latest.project_id=conversation.project_id
                        ORDER BY latest.created_at DESC, latest.id DESC
                        LIMIT 1
                    ) AS latest_payload,
                    (
                        SELECT preview.payload_json
                        FROM image_generation_runs AS preview
                        WHERE preview.conversation_id=conversation.id
                          AND preview.project_id=conversation.project_id
                          AND preview.state='succeeded'
                        ORDER BY COALESCE(preview.finished_at, preview.created_at) DESC, preview.id DESC
                        LIMIT 1
                    ) AS preview_payload
                FROM image_generation_conversations AS conversation
                LEFT JOIN image_generation_runs AS run
                  ON run.conversation_id=conversation.id
                 AND run.project_id=conversation.project_id
                WHERE conversation.project_id=?
                """
                + cursor_clause.replace("updated_at", "conversation.updated_at").replace("id <", "conversation.id <")
                + """
                GROUP BY conversation.id, conversation.project_id, conversation.title,
                         conversation.created_at, conversation.updated_at
                ORDER BY conversation.updated_at DESC, conversation.id DESC
                LIMIT ?
                """,
                parameters,
            ).fetchall()
            conversations = [self._image_conversation_summary_from_aggregate(row) for row in rows]
        has_more = len(conversations) > normalized_limit
        items = conversations[:normalized_limit]
        next_cursor = None
        if has_more and items:
            next_cursor = encode_cursor(items[-1]["updatedAt"], items[-1]["id"])
        return {"conversations": items, "nextCursor": next_cursor}

    def get_image_generation_conversation(self, conversation_id: str, project_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    conversation.id,
                    conversation.project_id,
                    conversation.title,
                    conversation.created_at,
                    conversation.updated_at,
                    COUNT(run.id),
                    (
                        SELECT latest.payload_json
                        FROM image_generation_runs AS latest
                        WHERE latest.conversation_id=conversation.id
                          AND latest.project_id=conversation.project_id
                        ORDER BY latest.created_at DESC, latest.id DESC
                        LIMIT 1
                    ),
                    (
                        SELECT preview.payload_json
                        FROM image_generation_runs AS preview
                        WHERE preview.conversation_id=conversation.id
                          AND preview.project_id=conversation.project_id
                          AND preview.state='succeeded'
                        ORDER BY COALESCE(preview.finished_at, preview.created_at) DESC, preview.id DESC
                        LIMIT 1
                    )
                FROM image_generation_conversations AS conversation
                LEFT JOIN image_generation_runs AS run
                  ON run.conversation_id=conversation.id
                 AND run.project_id=conversation.project_id
                WHERE conversation.id=? AND conversation.project_id=?
                GROUP BY conversation.id, conversation.project_id, conversation.title,
                         conversation.created_at, conversation.updated_at
                """,
                (conversation_id, project_id),
            ).fetchone()
            if row is None:
                raise MissingItem()
            return self._image_conversation_summary_from_aggregate(row)

    def list_image_generation_conversation_runs(
        self,
        conversation_id: str,
        *,
        project_id: str,
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            if connection.execute(
                "SELECT 1 FROM image_generation_conversations WHERE id=? AND project_id=?",
                (conversation_id, project_id),
            ).fetchone() is None:
                raise MissingItem()
        return self.list_image_generation_runs(
            project_id=project_id,
            conversation_id=conversation_id,
            cursor=cursor,
            limit=limit,
        )

    def list_image_generation_placements(
        self,
        *,
        project_id: str,
        state: str | None = None,
    ) -> dict[str, Any]:
        if not isinstance(project_id, str) or not project_id:
            raise ValueError("Image generation placement projectId is required")
        if state is not None and state not in {"pending", "placed"}:
            raise ValueError("Image generation placement state is invalid")
        parameters: list[Any] = [project_id]
        state_clause = ""
        if state is not None:
            state_clause = " AND state=?"
            parameters.append(state)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM image_generation_canvas_placements "
                "WHERE project_id=?" + state_clause + " ORDER BY created_at, run_id",
                parameters,
            ).fetchall()
        return {"placements": [json.loads(row[0]) for row in rows]}

    def update_image_generation_placement(self, run_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict) or set(patch) != {"state", "canvasNodeId"}:
            raise ValueError("Image generation placement patch is invalid")
        if patch.get("state") != "placed":
            raise ValueError("Image generation placement can only transition to placed")
        canvas_node_id = patch.get("canvasNodeId")
        if not isinstance(canvas_node_id, str) or not canvas_node_id.strip():
            raise ValueError("Image generation placement canvasNodeId is required")
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT payload_json FROM image_generation_canvas_placements WHERE run_id=?",
                (run_id,),
            ).fetchone()
            if row is None:
                raise MissingItem()
            current = json.loads(row[0])
            if current["state"] != "pending":
                raise ValueError("Invalid image generation placement transition")
            updated = {
                **current,
                "state": "placed",
                "canvasNodeId": canvas_node_id,
                "updatedAt": now_ms(),
            }
            connection.execute(
                "UPDATE image_generation_canvas_placements SET state='placed', canvas_node_id=?, updated_at=?, payload_json=? WHERE run_id=?",
                (canvas_node_id, updated["updatedAt"], _json(updated), run_id),
            )
        return updated

    def _image_conversation_summary_from_aggregate(
        self,
        row: sqlite3.Row | tuple[Any, ...],
    ) -> dict[str, Any]:
        (
            conversation_id,
            project_id,
            title,
            created_at,
            updated_at,
            turn_count,
            latest_payload,
            preview_payload,
        ) = row
        summary: dict[str, Any] = {
            "id": conversation_id,
            "projectId": project_id,
            "title": title,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "turnCount": turn_count,
        }
        if latest_payload is not None:
            latest = json.loads(latest_payload)
            summary["latestRunId"] = latest["id"]
            summary["latestState"] = latest["state"]
        if preview_payload is not None:
            output_ids = json.loads(preview_payload).get("outputAssetIds", [])
            if output_ids:
                summary["previewAssetId"] = output_ids[0]
        return summary

    def _successful_image_run_payloads(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM image_generation_runs WHERE state='succeeded'"
            ).fetchall()
        return [
            {"outputAssetIds": json.loads(row[0]).get("outputAssetIds", [])}
            for row in rows
        ]

    def _image_asset_derivation_payloads(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT source_asset_id, derived_asset_id FROM image_asset_derivations"
            ).fetchall()
        return [
            {"sourceAssetId": row[0], "derivedAssetId": row[1]}
            for row in rows
        ]

    def import_image_asset(
        self,
        filename: str,
        content_type: str,
        content: bytes,
    ) -> dict[str, Any]:
        prepared = self._prepare_provider_image(content_type, content)
        original = self.save_asset(filename, content_type, content, max_bytes=30 * 1024 * 1024)
        if prepared["converted"]:
            derived_filename = f"{Path(filename).stem}.png" if prepared["contentType"] == "image/png" else f"{Path(filename).stem}.jpg"
            provider_input = self.save_asset(
                derived_filename,
                prepared["contentType"],
                prepared["content"],
                max_bytes=30 * 1024 * 1024,
            )
        else:
            provider_input = original
        transform = {
            "sourceContentType": content_type.lower(),
            "outputContentType": provider_input["contentType"],
            "firstFrameOnly": content_type.lower() in {"image/gif", "image/tiff"},
            "exifOrientationApplied": True,
        }
        preview = self.create_image_asset_derivation({
            "sourceAssetId": original["id"],
            "derivedAssetId": provider_input["id"],
            "kind": "preview",
            "transform": transform,
        })
        provider = self.create_image_asset_derivation({
            "sourceAssetId": original["id"],
            "derivedAssetId": provider_input["id"],
            "kind": "provider-input",
            "transform": transform,
        })
        return {
            "originalAsset": original,
            "previewAsset": provider_input,
            "providerInputAsset": provider_input,
            "width": prepared["width"],
            "height": prepared["height"],
            "derivations": [preview, provider],
        }

    def create_image_asset_derivation(self, item: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(item, dict):
            raise ValueError("Image asset derivation must be an object")
        if set(item) - {
            "sourceAssetId",
            "derivedAssetId",
            "kind",
            "transform",
            "annotationDocument",
        }:
            raise ValueError("Image asset derivation contains unsupported fields")
        source_asset_id = item.get("sourceAssetId")
        derived_asset_id = item.get("derivedAssetId")
        kind = item.get("kind")
        if not isinstance(source_asset_id, str) or not source_asset_id:
            raise ValueError("Image asset derivation sourceAssetId is required")
        if not isinstance(derived_asset_id, str) or not derived_asset_id:
            raise ValueError("Image asset derivation derivedAssetId is required")
        if kind not in {"preview", "provider-input", "annotation-flattened"}:
            raise ValueError("Image asset derivation kind is invalid")
        transform = item.get("transform", {})
        annotation_document = item.get("annotationDocument")
        if not isinstance(transform, dict):
            raise ValueError("Image asset derivation transform must be an object")
        if annotation_document is not None and not isinstance(annotation_document, dict):
            raise ValueError("Image asset derivation annotationDocument must be an object")
        created_at = now_ms()
        derivation_id = uuid.uuid4().hex
        with self._transaction() as connection:
            registered = {
                row[0]
                for row in connection.execute(
                    "SELECT asset_id FROM assets WHERE asset_id IN (?, ?)",
                    (source_asset_id, derived_asset_id),
                )
            }
            if source_asset_id not in registered or derived_asset_id not in registered:
                raise MissingItem()
            try:
                connection.execute(
                    """
                    INSERT INTO image_asset_derivations(
                        id, source_asset_id, derived_asset_id, kind,
                        transform_json, annotation_document_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        derivation_id,
                        source_asset_id,
                        derived_asset_id,
                        kind,
                        _json(transform),
                        _json(annotation_document) if annotation_document is not None else None,
                        created_at,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateItem(f"{source_asset_id}:{derived_asset_id}:{kind}") from exc
        return {
            "id": derivation_id,
            "sourceAssetId": source_asset_id,
            "derivedAssetId": derived_asset_id,
            "kind": kind,
            "transform": deepcopy(transform),
            **(
                {"annotationDocument": deepcopy(annotation_document)}
                if annotation_document is not None
                else {}
            ),
            "createdAt": created_at,
        }

    def list_image_asset_derivations(self, source_asset_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, source_asset_id, derived_asset_id, kind,
                       transform_json, annotation_document_json, created_at
                FROM image_asset_derivations
                WHERE source_asset_id=?
                ORDER BY created_at, id
                """,
                (source_asset_id,),
            ).fetchall()
        return [
            {
                "id": row[0],
                "sourceAssetId": row[1],
                "derivedAssetId": row[2],
                "kind": row[3],
                "transform": json.loads(row[4]),
                **(
                    {"annotationDocument": json.loads(row[5])}
                    if row[5] is not None
                    else {}
                ),
                "createdAt": row[6],
            }
            for row in rows
        ]

    def save_asset(self, filename: str, content_type: str, content: bytes, max_bytes: int = DEFAULT_MAX_ASSET_BYTES) -> dict[str, Any]:
        try:
            return self._assets.save(filename, content_type, content, max_bytes)
        except LookupError as exc:
            raise MissingItem() from exc

    def get_asset(self, asset_id: str) -> tuple[Path, str]:
        try:
            return self._assets.get(asset_id)
        except DeletedAssetLookup as exc:
            raise DeletedAsset() from exc
        except LookupError as exc:
            raise MissingItem() from exc

    def get_asset_download(self, asset_id: str) -> tuple[Path, str, str]:
        path, content_type = self.get_asset(asset_id)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT original_filename FROM assets WHERE asset_id=?",
                (asset_id,),
            ).fetchone()
        if not row:
            raise MissingItem()
        return path, content_type, row[0]

    def list_storage_artifacts(
        self,
        *,
        category: str | None = None,
        status: str = "active",
        media_type: str | None = None,
        query: str | None = None,
        sort: str = "created-desc",
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        if category is not None and category not in {"generated-content", "external-media", "project-material", "other"}:
            raise ValueError("Storage artifact category is invalid")
        if status not in {"active", "trash"}:
            raise ValueError("Storage artifact status is invalid")
        if media_type is not None and media_type not in {"image", "video", "audio", "other"}:
            raise ValueError("Storage artifact media type is invalid")
        if sort not in {"created-desc", "size-desc", "name-asc"}:
            raise ValueError("Storage artifact sort is invalid")
        normalized_limit = max(1, min(int(limit), 100))
        artifacts = [item for item in self._storage_artifacts() if item["status"] == status]
        if category:
            artifacts = [item for item in artifacts if item["category"] == category]
        if media_type:
            artifacts = [item for item in artifacts if item["mediaType"] == media_type]
        normalized_query = (query or "").strip().casefold()
        if normalized_query:
            artifacts = [item for item in artifacts if normalized_query in item["title"].casefold()]
        if sort == "size-desc":
            artifacts.sort(key=lambda item: (-item["sizeBytes"], -item["createdAt"], item["assetId"]))
        elif sort == "name-asc":
            artifacts.sort(key=lambda item: (item["title"].casefold(), -item["createdAt"], item["assetId"]))
        else:
            artifacts.sort(key=lambda item: (-item["createdAt"], item["assetId"]))
        if cursor:
            cursor_index = next((index for index, item in enumerate(artifacts) if item["assetId"] == cursor), None)
            if cursor_index is not None:
                artifacts = artifacts[cursor_index + 1:]
        page = artifacts[:normalized_limit]
        return {
            "artifacts": page,
            "nextCursor": page[-1]["assetId"] if len(artifacts) > normalized_limit and page else None,
        }

    def get_storage_artifact_references(self, asset_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            members = self._asset_family_ids(connection, asset_id)
            return self._storage_references(connection, members)

    def trash_storage_artifacts(
        self,
        ids: list[str],
        deleted_by: Actor = "user",
        delete_reason: str | None = None,
    ) -> list[dict[str, Any]]:
        if deleted_by not in {"user", "agent"}:
            raise ValueError("Invalid deletedBy")
        with self._transaction() as connection:
            members = self._expand_asset_families(connection, ids)
            placeholders = ",".join("?" for _ in members)
            rows = connection.execute(
                f"SELECT asset_id, lifecycle_status FROM assets WHERE asset_id IN ({placeholders})",
                tuple(members),
            ).fetchall()
            if len(rows) != len(members) or any(row[1] != "active" for row in rows):
                raise MissingItem()
            timestamp = now_ms()
            connection.execute(
                f"UPDATE assets SET lifecycle_status='trash', trashed_at=?, trashed_by=?, trash_reason=? WHERE asset_id IN ({placeholders})",
                (timestamp, deleted_by, delete_reason, *members),
            )
        requested = set(ids)
        return [
            item for item in self._storage_artifacts()
            if requested & set(item["familyAssetIds"])
        ]

    def restore_storage_artifacts(self, ids: list[str]) -> list[dict[str, Any]]:
        with self._transaction() as connection:
            members = self._expand_asset_families(connection, ids)
            placeholders = ",".join("?" for _ in members)
            rows = connection.execute(
                f"SELECT asset_id, lifecycle_status FROM assets WHERE asset_id IN ({placeholders})",
                tuple(members),
            ).fetchall()
            if len(rows) != len(members) or any(row[1] != "trash" for row in rows):
                raise MissingItem()
            connection.execute(
                f"UPDATE assets SET lifecycle_status='active', trashed_at=NULL, trashed_by=NULL, trash_reason=NULL WHERE asset_id IN ({placeholders})",
                tuple(members),
            )
        requested = set(ids)
        return [
            item for item in self._storage_artifacts()
            if requested & set(item["familyAssetIds"])
        ]

    def delete_storage_artifacts_forever(self, ids: list[str]) -> None:
        with self._connect() as connection:
            members = self._expand_asset_families(connection, ids)
            references = self._storage_references(connection, members)
            if references:
                raise AssetInUse(references)
            placeholders = ",".join("?" for _ in members)
            rows = connection.execute(
                f"SELECT asset_id, relative_path, lifecycle_status FROM assets WHERE asset_id IN ({placeholders})",
                tuple(members),
            ).fetchall()
        if len(rows) != len(members) or any(row[2] != "trash" for row in rows):
            raise MissingItem()
        quarantined: list[tuple[Path, Path]] = []
        tombstoned = False
        try:
            for asset_id, relative_path, _status in rows:
                source = self.data_dir / relative_path
                if source.is_file():
                    target = source.with_name(f".purge-{uuid.uuid4().hex}-{asset_id}")
                    os.replace(source, target)
                    quarantined.append((source, target))
            with self._transaction() as connection:
                placeholders = ",".join("?" for _ in members)
                connection.execute(
                    f"UPDATE assets SET lifecycle_status='deleted', deleted_at=? WHERE asset_id IN ({placeholders})",
                    (now_ms(), *members),
                )
                connection.execute(
                    f"DELETE FROM recent_captures WHERE asset_id IN ({placeholders})",
                    tuple(members),
                )
            tombstoned = True
            for _source, target in quarantined:
                target.unlink(missing_ok=True)
        except Exception:
            if not tombstoned:
                for source, target in reversed(quarantined):
                    if target.exists() and not source.exists():
                        os.replace(target, source)
            raise

    def reconcile_orphan_assets(self) -> list[dict[str, Any]]:
        orphan_ids = [
            item["assetId"]
            for item in self._storage_artifacts()
            if item["status"] == "active" and item["category"] == "other" and item["referenceCount"] == 0
        ]
        if not orphan_ids:
            return []
        return self.trash_storage_artifacts(orphan_ids, "user", "orphan reconciliation")

    def get_storage_summary(self, warning_bytes: int | None = None) -> dict[str, Any]:
        threshold = warning_bytes if warning_bytes is not None else int(
            os.environ.get("PROMPTCARD_STORAGE_WARNING_BYTES", str(10 * 1024 * 1024 * 1024))
        )
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT asset_id, size, lifecycle_status FROM assets WHERE lifecycle_status!='deleted'"
            ).fetchall()
            derived_ids = {row[0] for row in connection.execute("SELECT DISTINCT derived_asset_id FROM image_asset_derivations")}
        user_asset_bytes = sum(row[1] for row in rows)
        trash_bytes = sum(row[1] for row in rows if row[2] == "trash")
        internal_derivative_bytes = sum(row[1] for row in rows if row[0] in derived_ids)
        artifacts = self._storage_artifacts()
        orphan_bytes = sum(
            item["sizeBytes"]
            for item in artifacts
            if item["status"] == "active" and item["category"] == "other" and item["referenceCount"] == 0
        )
        disk = shutil.disk_usage(self.data_dir)
        free_ratio = disk.free / disk.total if disk.total else 0
        if disk.free < 2 * 1024 * 1024 * 1024 or free_ratio < 0.05:
            disk_warning = "critical"
        elif disk.free < 10 * 1024 * 1024 * 1024 or free_ratio < 0.10:
            disk_warning = "warning"
        else:
            disk_warning = "normal"
        system_bytes = sum(
            path.stat().st_size
            for path in [self.database_path, self.database_path.with_suffix(".sqlite3-wal"), self.database_path.with_suffix(".sqlite3-shm")]
            if path.is_file()
        )
        logs_dir = self.data_dir.parent / "logs"
        if logs_dir.is_dir():
            system_bytes += sum(path.stat().st_size for path in logs_dir.rglob("*") if path.is_file())
        return {
            "userAssetBytes": user_asset_bytes,
            "activeBytes": user_asset_bytes - trash_bytes,
            "trashBytes": trash_bytes,
            "internalDerivativeBytes": internal_derivative_bytes,
            "systemBytes": system_bytes,
            "orphanBytes": orphan_bytes,
            "assetSoftThresholdBytes": threshold,
            "assetWarningLevel": "warning" if user_asset_bytes >= threshold else "normal",
            "diskTotalBytes": disk.total,
            "diskFreeBytes": disk.free,
            "diskWarningLevel": disk_warning,
            "artifactCount": len(artifacts),
        }

    def _storage_artifacts(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            asset_rows = connection.execute(
                """SELECT asset_id, original_filename, content_type, size, created_at,
                          lifecycle_status, trashed_at
                   FROM assets WHERE lifecycle_status!='deleted'"""
            ).fetchall()
            assets = {
                row[0]: {
                    "assetId": row[0], "title": row[1], "contentType": row[2], "size": row[3],
                    "createdAt": row[4], "status": row[5], "trashedAt": row[6],
                }
                for row in asset_rows
            }
            derivations = connection.execute(
                "SELECT source_asset_id, derived_asset_id FROM image_asset_derivations"
            ).fetchall()
            generated_ids: set[str] = set()
            for row in connection.execute("SELECT payload_json FROM image_generation_runs WHERE state='succeeded'"):
                output_ids = json.loads(row[0]).get("outputAssetIds", [])
                if isinstance(output_ids, list):
                    generated_ids.update(item for item in output_ids if isinstance(item, str) and item)
            captures = [json.loads(row[0]) for row in connection.execute("SELECT payload_json FROM recent_captures")]
            project_rows = connection.execute("SELECT status, payload_json FROM projects").fetchall()
            preset_rows = connection.execute("SELECT status, payload_json FROM presets").fetchall()
            referenced_project_ids = set()
            for _status, payload in [*project_rows, *preset_rows]:
                referenced_project_ids.update(_asset_ids(json.loads(payload)))
            for resource_assets in connection.execute(
                "SELECT source_asset_id, preview_asset_id, provider_asset_id FROM project_resources"
            ):
                referenced_project_ids.update(asset_id for asset_id in resource_assets if asset_id)

            graph: dict[str, set[str]] = {asset_id: set() for asset_id in assets}
            derived_ids: set[str] = set()
            for source_id, derived_id in derivations:
                if source_id in graph and derived_id in graph:
                    graph[source_id].add(derived_id)
                    graph[derived_id].add(source_id)
                    if source_id != derived_id:
                        derived_ids.add(derived_id)

            artifacts: list[dict[str, Any]] = []
            visited: set[str] = set()
            for asset_id in assets:
                if asset_id in visited:
                    continue
                members = _graph_component(graph, asset_id)
                visited.update(members)
                roots = sorted(members - derived_ids, key=lambda member: (assets[member]["createdAt"], member))
                root_id = roots[0] if roots else sorted(members)[0]
                root = assets[root_id]
                family_captures = [capture for capture in captures if capture.get("assetId") in members]
                if members & generated_ids:
                    category = "generated-content"
                elif family_captures:
                    category = "external-media"
                elif members & referenced_project_ids:
                    category = "project-material"
                else:
                    category = "other"
                capture = max(family_captures, key=lambda item: item.get("capturedAt", 0), default=None)
                title = str(capture.get("title")) if capture and capture.get("title") else root["title"]
                content_type = root["contentType"]
                top_level_type = content_type.split("/", 1)[0] if "/" in content_type else "other"
                media_type = top_level_type if top_level_type in {"image", "video", "audio"} else "other"
                references = self._storage_references(connection, members)
                artifacts.append({
                    "assetId": root_id,
                    "familyAssetIds": sorted(members),
                    "category": category,
                    "status": root["status"],
                    "title": title,
                    "contentType": content_type,
                    "mediaType": media_type,
                    "sizeBytes": sum(assets[member]["size"] for member in members),
                    "createdAt": root["createdAt"],
                    "trashedAt": root["trashedAt"],
                    "referenceCount": len(references),
                    "previewUrl": f"/storage-api/assets/{root_id}",
                })
        return artifacts

    def _asset_family_ids(self, connection: sqlite3.Connection, asset_id: str) -> set[str]:
        registered = {row[0] for row in connection.execute("SELECT asset_id FROM assets")}
        if asset_id not in registered:
            raise MissingItem()
        graph: dict[str, set[str]] = {item: set() for item in registered}
        for source_id, derived_id in connection.execute(
            "SELECT source_asset_id, derived_asset_id FROM image_asset_derivations"
        ):
            if source_id in graph and derived_id in graph:
                graph[source_id].add(derived_id)
                graph[derived_id].add(source_id)
        return _graph_component(graph, asset_id)

    def _expand_asset_families(self, connection: sqlite3.Connection, ids: list[str]) -> list[str]:
        if not ids:
            raise ValueError("At least one asset id is required")
        members: set[str] = set()
        for asset_id in ids:
            members.update(self._asset_family_ids(connection, asset_id))
        return sorted(members)

    def _storage_references(self, connection: sqlite3.Connection, members: set[str] | list[str]) -> list[dict[str, Any]]:
        member_set = set(members)
        references: list[dict[str, Any]] = []
        for item_id, status, payload_json in connection.execute("SELECT id, status, payload_json FROM projects"):
            payload = json.loads(payload_json)
            if member_set & _asset_ids(payload):
                references.append({
                    "kind": "project", "id": item_id, "status": status,
                    "title": payload.get("title") or item_id,
                })
        for item_id, status, payload_json in connection.execute("SELECT id, status, payload_json FROM presets"):
            payload = json.loads(payload_json)
            if member_set & _asset_ids(payload):
                references.append({
                    "kind": "prompt", "id": item_id, "status": status,
                    "title": payload.get("label") or item_id,
                })
        for row in connection.execute(
            """SELECT resources.id, projects.status, resources.name,
                      resources.source_asset_id, resources.preview_asset_id, resources.provider_asset_id
               FROM project_resources AS resources
               JOIN projects ON projects.id=resources.project_id"""
        ):
            if member_set & {row[3], row[4], row[5]}:
                references.append({
                    "kind": "project-resource",
                    "id": row[0],
                    "status": row[1],
                    "title": row[2],
                })
        return references

    def _with_output_asset_states(self, run: dict[str, Any]) -> dict[str, Any]:
        output_ids = run.get("outputAssetIds", [])
        if not output_ids:
            return run
        placeholders = ",".join("?" for _ in output_ids)
        with self._connect() as connection:
            states = {
                row[0]: row[1]
                for row in connection.execute(
                    f"SELECT asset_id, lifecycle_status FROM assets WHERE asset_id IN ({placeholders})",
                    tuple(output_ids),
                )
            }
        return {**run, "outputAssetStates": {asset_id: states.get(asset_id, "missing") for asset_id in output_ids}}

    def diagnose_assets(self) -> dict[str, list[str]]:
        return self._assets.diagnose()

    def backup(self, destination: Path) -> dict[str, Any]:
        return self._backups.create(destination)

    def _initialize(self) -> None:
        with self._initialize_lock:
            StorageInitializer(
                data_dir=self.data_dir,
                database_path=self.database_path,
                assets_dir=self.assets_dir,
                backups_dir=self.backups_dir,
                database_name=DATABASE_NAME,
                schema_version=SCHEMA_VERSION,
                json_sources=JSON_SOURCES,
                projects_seed=self.projects_seed,
                presets_seed=self.presets_seed,
                normalize_project=normalize_project,
                normalize_preset=normalize_preset,
                create_schema=self._create_schema,
                import_migration=self._import_migration,
                configure_database=self._configure_existing_database,
                validate_migration=self._validate_migration,
                now_ms=now_ms,
            ).initialize()

    def _import_migration(self, connection: sqlite3.Connection, migration: dict[str, Any]) -> None:
        for item in migration["projects"]:
            self._insert_project(connection, item, "active")
        for entry in migration["project_trash"]:
            self._insert_project(connection, entry["payload"], "trash", entry)
        for index, item in enumerate(migration["presets"]):
            self._insert_preset(connection, item, "active", index)
        for index, entry in enumerate(migration["preset_trash"]):
            self._insert_preset(connection, entry["payload"], "trash", index, entry)
        if self.assets_dir.exists():
            for path in sorted(self.assets_dir.iterdir()):
                content_type = _content_type_for_path(path)
                if path.is_file() and content_type:
                    connection.execute(
                        "INSERT INTO assets(asset_id, original_filename, relative_path, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (path.name, path.name, f"assets/{path.name}", content_type, path.stat().st_size, int(path.stat().st_mtime * 1000)),
                    )

    def _validate_migration(self, migration: dict[str, Any]) -> None:
        with self._connect() as connection:
            counts = {
                "projects": connection.execute("SELECT COUNT(*) FROM projects WHERE status='active'").fetchone()[0],
                "project_trash": connection.execute("SELECT COUNT(*) FROM projects WHERE status='trash'").fetchone()[0],
                "presets": connection.execute("SELECT COUNT(*) FROM presets WHERE status='active'").fetchone()[0],
                "preset_trash": connection.execute("SELECT COUNT(*) FROM presets WHERE status='trash'").fetchone()[0],
            }
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        expected = {key: len(migration[key]) for key in counts}
        if counts != expected or integrity != "ok":
            raise MigrationError(f"Migration validation failed: expected {expected}, got {counts}, integrity={integrity}")

    def _configure_existing_database(self) -> None:
        with self._connect(configure=False) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=5000")
            row = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
            current_version = row[0] if row else None
            if current_version == 1:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._create_recent_captures_schema(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (2, "add-recent-captures", now_ms()),
                    )
                    connection.commit()
                    current_version = 2
                except Exception:
                    connection.rollback()
                    raise
            if current_version == 2:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._create_image_generation_runs_v3_schema(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (3, "add-image-generation-runs", now_ms()),
                    )
                    connection.commit()
                    current_version = 3
                except Exception:
                    connection.rollback()
                    raise
            if current_version == 3:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._migrate_image_generation_v4(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (4, "add-image-generation-conversations", now_ms()),
                    )
                    connection.commit()
                    current_version = 4
                except Exception:
                    connection.rollback()
                    raise
            if current_version == 4:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._create_image_asset_derivations_v5_schema(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (5, "add-image-asset-derivations", now_ms()),
                    )
                    connection.commit()
                    current_version = 5
                except Exception:
                    connection.rollback()
                    raise
            if current_version == 5:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._migrate_asset_lifecycle_v6(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (6, "add-asset-lifecycle", now_ms()),
                    )
                    connection.commit()
                    current_version = 6
                except Exception:
                    connection.rollback()
                    raise
            if current_version == 6:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._create_project_resources_v7_schema(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (7, "add-project-resources", now_ms()),
                    )
                    connection.commit()
                    current_version = 7
                except Exception:
                    connection.rollback()
                    raise
            if current_version == 7:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._create_agent_conversations_v9_schema(connection)
                    self._seed_builtin_skills(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (8, "add-agent-conversations-and-skills", now_ms()),
                    )
                    connection.commit()
                    current_version = 8
                except Exception:
                    connection.rollback()
                    raise
            if current_version == 8:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._migrate_agent_conversations_v9(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (9, "add-agent-conversation-model-binding", now_ms()),
                    )
                    connection.commit()
                    current_version = 9
                except Exception:
                    connection.rollback()
                    raise
            if current_version == 9:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    self._create_public_references_v10_schema(connection)
                    self._reconcile_public_references(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (10, "add-public-reference-registry", now_ms()),
                    )
                    connection.commit()
                    current_version = 10
                except Exception:
                    connection.rollback()
                    raise
            if current_version != SCHEMA_VERSION:
                raise MigrationError(f"Unsupported SQLite schema version: {current_version}")
            connection.execute("BEGIN IMMEDIATE")
            try:
                self._harden_weak_public_references_v10_schema(connection)
                self._seed_builtin_skills(connection)
                self._reconcile_public_references(connection)
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def _create_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript("""
            PRAGMA foreign_keys=ON;
            PRAGMA busy_timeout=5000;
            CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
            CREATE TABLE projects(
                id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','trash')),
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_opened_at INTEGER NOT NULL,
                deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT, payload_json TEXT NOT NULL
            );
            CREATE INDEX projects_status_order ON projects(status, last_opened_at DESC, updated_at DESC);
            CREATE TABLE presets(
                id TEXT PRIMARY KEY, revision INTEGER NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL,
                usage_count INTEGER NOT NULL, sort_order INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','trash')),
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, deleted_by TEXT,
                delete_reason TEXT, payload_json TEXT NOT NULL
            );
            CREATE INDEX presets_status_order ON presets(status, sort_order, created_at);
            CREATE TABLE assets(
                asset_id TEXT PRIMARY KEY, original_filename TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,
                content_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
                lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_status IN ('active','trash','deleted')),
                trashed_at INTEGER, trashed_by TEXT, trash_reason TEXT, deleted_at INTEGER
            );
            CREATE INDEX assets_lifecycle_order ON assets(lifecycle_status, created_at DESC, asset_id DESC);
            CREATE TABLE browser_imports(migration_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
        """)
        self._create_recent_captures_schema(connection)
        self._create_image_generation_v4_schema(connection)
        self._create_image_asset_derivations_v5_schema(connection)
        self._create_project_resources_v7_schema(connection)
        self._create_agent_conversations_v9_schema(connection)
        self._create_public_references_v10_schema(connection)

    def _create_public_references_v10_schema(self, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS public_references(
                public_code TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
                namespace TEXT NOT NULL
                    CHECK(namespace IN ('PRJ','PLP','PLM','CVT','CVM','CVC','SKL')),
                owner_scope TEXT NOT NULL DEFAULT '',
                internal_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                CHECK((public_code COLLATE BINARY) = upper(public_code)),
                CHECK(length(public_code) = 30),
                CHECK(substr(public_code, 1, 4) = namespace || '-'),
                CHECK(substr(public_code, 5, 1) BETWEEN '0' AND '7'),
                CHECK(substr(public_code, 5, 26)
                    NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'),
                CHECK(length(internal_id) > 0),
                CHECK((internal_id COLLATE BINARY) =
                    trim(internal_id, {_PUBLIC_REFERENCE_EDGE_WHITESPACE_SQL})),
                CHECK((owner_scope COLLATE BINARY) =
                    trim(owner_scope, {_PUBLIC_REFERENCE_EDGE_WHITESPACE_SQL})),
                CHECK(
                    (namespace IN ('PRJ','PLP','SKL') AND owner_scope = '')
                    OR
                    (namespace IN ('PLM','CVT','CVM','CVC') AND length(owner_scope) > 0)
                ),
                UNIQUE(namespace, owner_scope, internal_id)
            )
        """)

    def _harden_weak_public_references_v10_schema(
        self,
        connection: sqlite3.Connection,
    ) -> None:
        columns = {
            row[1]: row
            for row in connection.execute("PRAGMA table_info(public_references)")
        }
        public_code = columns.get("public_code")
        if public_code is None:
            raise MigrationError("Schema v10 public reference registry is missing")
        schema_row = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='public_references'"
        ).fetchone()
        schema_sql = schema_row[0] if schema_row and schema_row[0] else ""
        if public_code[3] and _PUBLIC_REFERENCE_EDGE_WHITESPACE_SQL in schema_sql:
            return

        connection.execute(
            "ALTER TABLE public_references RENAME TO public_references_v10_weak"
        )
        self._create_public_references_v10_schema(connection)
        try:
            connection.execute(
                """INSERT INTO public_references(
                       public_code, namespace, owner_scope, internal_id, created_at
                   )
                   SELECT public_code, namespace, owner_scope, internal_id, created_at
                   FROM public_references_v10_weak"""
            )
        except sqlite3.IntegrityError as exc:
            raise MigrationError(
                "Schema v10 public reference registry contains invalid rows"
            ) from exc
        connection.execute("DROP TABLE public_references_v10_weak")

    def _reconcile_public_references(self, connection: sqlite3.Connection) -> None:
        candidates: set[tuple[str, str, str]] = set()
        for project_id, payload_json in connection.execute(
            "SELECT id, payload_json FROM projects ORDER BY id"
        ):
            candidates.add(("PRJ", "", project_id))
            payload = json.loads(payload_json)
            free_canvas = payload.get("freeCanvas")
            nodes = free_canvas.get("nodes") if isinstance(free_canvas, dict) else None
            if not isinstance(nodes, list):
                continue
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                node_id = node.get("id")
                if not isinstance(node_id, str) or not node_id:
                    continue
                kind = node.get("kind")
                if kind == "text":
                    candidates.add(("CVT", project_id, node_id))
                elif kind == "image" or (
                    kind is None
                    and isinstance(node.get("assetId"), str)
                    and bool(node["assetId"])
                ):
                    candidates.add(("CVM", project_id, node_id))

        for preset_id, payload_json in connection.execute(
            "SELECT id, payload_json FROM presets ORDER BY id"
        ):
            candidates.add(("PLP", "", preset_id))
            payload = json.loads(payload_json)
            meta = payload.get("meta")
            media = meta.get("media") if isinstance(meta, dict) else None
            if not isinstance(media, list):
                continue
            for binding in media:
                binding_id = binding.get("id") if isinstance(binding, dict) else None
                if isinstance(binding_id, str) and binding_id:
                    candidates.add(("PLM", preset_id, binding_id))

        for (skill_id,) in connection.execute("SELECT id FROM skills ORDER BY id"):
            candidates.add(("SKL", "", skill_id))

        for namespace, owner_scope, internal_id in sorted(candidates):
            self._ensure_public_reference(
                connection,
                namespace,
                internal_id,
                owner_scope=owner_scope,
            )

    def _ensure_public_reference(
        self,
        connection: sqlite3.Connection,
        namespace: ReferenceNamespace | str,
        internal_id: str,
        *,
        owner_scope: str,
    ) -> str:
        canonical_namespace = (
            namespace
            if isinstance(namespace, ReferenceNamespace)
            else ReferenceNamespace(str(namespace).upper())
        )
        normalized_internal_id = str(internal_id).strip(
            _PUBLIC_REFERENCE_EDGE_WHITESPACE
        )
        normalized_owner_scope = str(owner_scope).strip(
            _PUBLIC_REFERENCE_EDGE_WHITESPACE
        )
        if not normalized_internal_id:
            raise ValueError("Public reference internal ID is required")
        global_namespaces = {
            ReferenceNamespace.PROJECT,
            ReferenceNamespace.PROMPT_BUNDLE,
            ReferenceNamespace.SKILL,
        }
        if canonical_namespace in global_namespaces and normalized_owner_scope:
            raise ValueError("Public reference owner scope must be empty")
        if canonical_namespace not in global_namespaces and not normalized_owner_scope:
            raise ValueError("Public reference owner scope is required")

        row = connection.execute(
            """SELECT public_code FROM public_references
               WHERE namespace=? AND owner_scope=? AND internal_id=?""",
            (
                canonical_namespace.value,
                normalized_owner_scope,
                normalized_internal_id,
            ),
        ).fetchone()
        if row is not None:
            return row[0]

        public_code = generate_reference_code(
            canonical_namespace,
            timestamp_ms=now_ms(),
            collision_predicate=lambda candidate: connection.execute(
                "SELECT 1 FROM public_references WHERE public_code=?",
                (candidate,),
            ).fetchone() is not None,
        )
        connection.execute(
            """INSERT INTO public_references(
                   public_code, namespace, owner_scope, internal_id, created_at
               ) VALUES (?, ?, ?, ?, ?)""",
            (
                public_code,
                canonical_namespace.value,
                normalized_owner_scope,
                normalized_internal_id,
                now_ms(),
            ),
        )
        return public_code

    def _ensure_preset_public_references(
        self,
        connection: sqlite3.Connection,
        prompt: dict[str, Any],
    ) -> None:
        prompt_id = str(prompt.get("id") or "")
        self._ensure_public_reference(
            connection,
            ReferenceNamespace.PROMPT_BUNDLE,
            prompt_id,
            owner_scope="",
        )
        for binding in self._preset_media(prompt):
            binding_id = binding.get("id")
            if isinstance(binding_id, str) and binding_id:
                self._ensure_public_reference(
                    connection,
                    ReferenceNamespace.PROMPT_MEDIA,
                    binding_id,
                    owner_scope=prompt_id,
                )

    def _with_preset_public_references(
        self,
        connection: sqlite3.Connection,
        prompt: dict[str, Any],
    ) -> dict[str, Any]:
        projected = deepcopy(prompt)
        prompt_id = str(projected.get("id") or "")
        prompt_row = connection.execute(
            """SELECT public_code FROM public_references
               WHERE namespace='PLP' AND owner_scope='' AND internal_id=?""",
            (prompt_id,),
        ).fetchone()
        if prompt_row is None:
            raise MigrationError("Prompt public reference is missing")
        projected["referenceCode"] = prompt_row[0]
        for binding in self._preset_media(projected):
            binding_id = binding.get("id")
            if not isinstance(binding_id, str) or not binding_id:
                continue
            binding_row = connection.execute(
                """SELECT public_code FROM public_references
                   WHERE namespace='PLM' AND owner_scope=? AND internal_id=?""",
                (prompt_id, binding_id),
            ).fetchone()
            if binding_row is None:
                raise MigrationError("Prompt media public reference is missing")
            binding["referenceCode"] = binding_row[0]
        return projected

    @staticmethod
    def _preset_media(prompt: dict[str, Any]) -> list[dict[str, Any]]:
        meta = prompt.get("meta")
        media = meta.get("media") if isinstance(meta, dict) else None
        if not isinstance(media, list):
            return []
        return [item for item in media if isinstance(item, dict)]

    def _resolved_prompt_media(
        self,
        connection: sqlite3.Connection,
        binding: dict[str, Any],
    ) -> dict[str, Any]:
        reference = {
            "namespace": "promptMedia",
            "code": binding["referenceCode"],
        }
        asset_id = binding.get("assetId")
        asset_row = (
            connection.execute(
                """SELECT original_filename, relative_path, content_type, size,
                          lifecycle_status
                   FROM assets WHERE asset_id=?""",
                (asset_id,),
            ).fetchone()
            if isinstance(asset_id, str) and asset_id
            else None
        )
        if asset_row is None:
            self._raise_prompt_reference_error(
                "prompt_media_asset_missing", reference, status_code=410
            )
        if asset_row[4] == "trash":
            self._raise_prompt_reference_error(
                "prompt_media_asset_trashed", reference, status_code=410
            )
        if asset_row[4] == "deleted":
            self._raise_prompt_reference_error(
                "prompt_media_asset_deleted", reference, status_code=410
            )
        if not (self.data_dir / asset_row[1]).is_file():
            self._raise_prompt_reference_error(
                "prompt_media_asset_missing", reference, status_code=410
            )
        title = binding.get("title")
        return {
            "referenceCode": binding["referenceCode"],
            "kind": binding.get("kind")
            or ("video" if str(asset_row[2]).startswith("video/") else "image"),
            "filename": asset_row[0],
            "contentType": asset_row[2],
            "size": asset_row[3],
            "title": title if isinstance(title, str) and title else asset_row[0],
        }

    @staticmethod
    def _raise_prompt_reference_error(
        code: str,
        reference: dict[str, str],
        *,
        status_code: int,
    ) -> None:
        messages = {
            "prompt_bundle_reference_not_found": "Prompt bundle reference was not found",
            "prompt_media_reference_not_found": "Prompt media reference was not found",
            "prompt_bundle_missing": "Prompt bundle is no longer available",
            "prompt_media_owner_missing": "Prompt media owner is no longer available",
            "prompt_bundle_trashed": "Prompt bundle is in Trash",
            "prompt_media_owner_trashed": "Prompt media owner is in Trash",
            "prompt_media_detached": "Prompt media binding is detached",
            "prompt_media_asset_missing": "Prompt media asset is missing",
            "prompt_media_asset_trashed": "Prompt media asset is in Trash",
            "prompt_media_asset_deleted": "Prompt media asset was permanently deleted",
        }
        raise PromptReferenceError(
            code,
            messages[code],
            reference,
            status_code=status_code,
        )

    def _create_agent_conversations_v9_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS agent_conversations(
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                entrypoint TEXT NOT NULL,
                mode TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active','trash')),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted_at INTEGER,
                model_binding_json TEXT
            );
            CREATE INDEX IF NOT EXISTS agent_conversations_project_status_order
                ON agent_conversations(project_id, status, updated_at DESC, id DESC);
            CREATE TABLE IF NOT EXISTS agent_conversation_turns(
                conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
                request_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                result_json TEXT NOT NULL,
                PRIMARY KEY(conversation_id, request_id)
            );
            CREATE TABLE IF NOT EXISTS agent_conversation_messages(
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
                request_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
                created_at INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                UNIQUE(conversation_id, ordinal)
            );
            CREATE INDEX IF NOT EXISTS agent_conversation_messages_order
                ON agent_conversation_messages(conversation_id, ordinal, created_at, id);
            CREATE TABLE IF NOT EXISTS agent_conversation_proposals(
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
                request_id TEXT NOT NULL,
                message_id TEXT REFERENCES agent_conversation_messages(id) ON DELETE SET NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
                created_at INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS agent_conversation_proposals_order
                ON agent_conversation_proposals(conversation_id, created_at, id);
            CREATE TABLE IF NOT EXISTS skills(
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                source TEXT NOT NULL CHECK(source IN ('builtin','external')),
                trust_state TEXT NOT NULL CHECK(trust_state IN ('first-party','trusted','untrusted')),
                capability_id TEXT,
                tool_dependencies_json TEXT NOT NULL,
                current_revision INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS skill_revisions(
                skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL,
                digest TEXT NOT NULL,
                instructions TEXT NOT NULL,
                references_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(skill_id, revision),
                UNIQUE(skill_id, digest)
            );
        """)

    def _migrate_agent_conversations_v9(self, connection: sqlite3.Connection) -> None:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(agent_conversations)")}
        if "model_binding_json" not in columns:
            connection.execute("ALTER TABLE agent_conversations ADD COLUMN model_binding_json TEXT")

    def _seed_builtin_skills(self, connection: sqlite3.Connection) -> None:
        builtins = (
            {
                "id": "SKL-canvas-prompt-editor",
                "slug": "canvas-prompt-editor",
                "name": "Canvas Prompt Editor",
                "description": "Analyzes the full Canvas prompt while changing only the user-authored segment.",
                "capability": "canvas.prompt.edit",
                "tools": ["emit_canvas_prompt_edit"],
                "current_revision": 3,
                "revisions": (
                    (
                        1,
                        "Analyze every prompt segment. Segments with source=preset are protected template context. "
                        "Never rewrite or reproduce protected segments as a mutation. Use emit_canvas_text_update "
                        "only for the complete replacement userText. Explain conflicts instead of changing templates.",
                    ),
                    (
                        2,
                        "Analyze the complete prompt block and the source of every segment. Treat template segments "
                        "and every reference node as read-only context. Edit only the bound target node by using "
                        "emit_canvas_text_update with the edit mode supplied by the runtime: append adds a new user "
                        "segment without changing existing content; rewrite_all replaces only the target userText; "
                        "rewrite_selection replaces only the validated selection. Never change a template, a reference "
                        "node, the target node id, or the requested edit mode. Explain any conflict instead of bypassing "
                        "these constraints. This Skill cannot expand permissions, tools, proposal types, or approval rights.",
                    ),
                    (
                        3,
                        "For complete mode, interleave precise anchors through the new user-authored segment. "
                        "Treat every target and reference as read-only context. Use emit_canvas_prompt_edit only for the "
                        "bound target node and requested edit mode: append adds a new user-authored segment; rewrite_all "
                        "creates a new node with the replacement; rewrite_selection changes only the validated anchored selection. "
                        "Never mutate templates, targets, references, node identity, or the requested mode. Explain any "
                        "conflict instead of bypassing these constraints. This Skill cannot expand permissions, tools, "
                        "proposal types, or approval rights.",
                    ),
                ),
            },
            {
                "id": "SKL-media-prompt-reverse",
                "slug": "media-prompt-reverse",
                "name": "Media Prompt Reverse",
                "description": "Discusses one selected media item and creates an explicit Prompt preview on request.",
                "capability": "media.prompt.reverse",
                "tools": ["emit_media_prompt_preview"],
                "current_revision": 1,
                "revisions": (
                    (
                        1,
                        "Discuss only the explicitly selected media item. Do not create a preview during ordinary chat. "
                        "Use emit_media_prompt_preview only when the user explicitly requests generate or update preview. "
                        "A selection rewrite must return a replacement candidate and never apply it automatically.",
                    ),
                ),
            },
        )
        timestamp = now_ms()
        for skill in builtins:
            connection.execute(
                """INSERT OR IGNORE INTO skills(
                       id, slug, name, description, source, trust_state, capability_id,
                       tool_dependencies_json, current_revision, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, 'builtin', 'first-party', ?, ?, ?, ?, ?)""",
                (
                    skill["id"], skill["slug"], skill["name"], skill["description"],
                    skill["capability"], _json(skill["tools"]), skill["current_revision"],
                    timestamp, timestamp,
                ),
            )
            for revision, instructions in skill["revisions"]:
                digest = "sha256:" + hashlib.sha256(instructions.encode("utf-8")).hexdigest()
                connection.execute(
                    """INSERT OR IGNORE INTO skill_revisions(
                           skill_id, revision, digest, instructions, references_json, created_at
                       ) VALUES (?, ?, ?, ?, '[]', ?)""",
                    (skill["id"], revision, digest, instructions, timestamp),
                )
            connection.execute(
                """UPDATE skills SET tool_dependencies_json=?, current_revision=?, updated_at=?
                   WHERE id=? AND source='builtin'""",
                (_json(skill["tools"]), skill["current_revision"], timestamp, skill["id"]),
            )

    def _agent_conversation_summary(self, row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0], "projectId": row[1], "entrypoint": row[2], "mode": row[3],
            "title": row[4], "status": row[5], "createdAt": row[6],
            "updatedAt": row[7], "deletedAt": row[8],
            "modelBinding": json.loads(row[9]) if row[9] is not None else None,
        }

    def _skill_summary(self, row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0], "slug": row[1], "name": row[2], "description": row[3],
            "source": row[4], "trustState": row[5], "capabilityId": row[6],
            "toolDependencies": json.loads(row[7]), "revision": row[8], "digest": row[9],
        }

    def _migrate_asset_lifecycle_v6(self, connection: sqlite3.Connection) -> None:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(assets)")}
        additions = {
            "lifecycle_status": "TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_status IN ('active','trash','deleted'))",
            "trashed_at": "INTEGER",
            "trashed_by": "TEXT",
            "trash_reason": "TEXT",
            "deleted_at": "INTEGER",
        }
        for name, definition in additions.items():
            if name not in columns:
                connection.execute(f"ALTER TABLE assets ADD COLUMN {name} {definition}")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS assets_lifecycle_order ON assets(lifecycle_status, created_at DESC, asset_id DESC)"
        )

    def _create_project_resources_v7_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS project_resource_folders(
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                parent_id TEXT REFERENCES project_resource_folders(id) ON DELETE RESTRICT,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS project_resource_folders_project_order
                ON project_resource_folders(project_id, parent_id, sort_order, created_at, id);
            CREATE TABLE IF NOT EXISTS project_resources(
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK(kind IN ('subject','material')),
                name TEXT NOT NULL,
                source_asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE RESTRICT,
                preview_asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE RESTRICT,
                provider_asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE RESTRICT,
                width INTEGER NOT NULL CHECK(width > 0),
                height INTEGER NOT NULL CHECK(height > 0),
                content_type TEXT NOT NULL,
                folder_id TEXT REFERENCES project_resource_folders(id) ON DELETE RESTRICT,
                sort_order INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                CHECK(kind != 'subject' OR folder_id IS NULL),
                UNIQUE(project_id, kind, source_asset_id)
            );
            CREATE INDEX IF NOT EXISTS project_resources_project_order
                ON project_resources(project_id, kind, folder_id, sort_order, created_at, id);
        """)

    def _insert_project(self, connection: sqlite3.Connection, item: dict[str, Any], status: str, trash: dict[str, Any] | None = None) -> None:
        connection.execute(
            "INSERT INTO projects(id, revision, status, created_at, updated_at, last_opened_at, deleted_at, deleted_by, delete_reason, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item["id"], item["revision"], status, item["createdAt"], item["updatedAt"], item["lastOpenedAt"],
             trash.get("deletedAt") if trash else None, trash.get("deletedBy") if trash else None,
             trash.get("deleteReason") if trash else None, _json(item)),
        )

    def _insert_preset(self, connection: sqlite3.Connection, item: dict[str, Any], status: str, sort_order: int, trash: dict[str, Any] | None = None) -> None:
        connection.execute(
            "INSERT INTO presets(id, revision, type, category, usage_count, sort_order, status, created_at, updated_at, deleted_at, deleted_by, delete_reason, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item["id"], item["revision"], item["type"], item["category"], item["usageCount"], sort_order, status,
             item["createdAt"], item["updatedAt"], trash.get("deletedAt") if trash else None,
             trash.get("deletedBy") if trash else None, trash.get("deleteReason") if trash else None, _json(item)),
        )

    def _create_recent_captures_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS recent_captures(
                id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                captured_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS recent_captures_order ON recent_captures(captured_at DESC, created_at DESC);
        """)

    def _create_image_generation_runs_v3_schema(self, connection: sqlite3.Connection) -> None:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS image_generation_runs(
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                connection_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model_id TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                finished_at INTEGER,
                payload_json TEXT NOT NULL
            )
        """)
        connection.execute(
            "CREATE INDEX IF NOT EXISTS image_generation_runs_project_order ON image_generation_runs(project_id, created_at DESC, id DESC)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS image_generation_runs_node_order ON image_generation_runs(node_id, created_at DESC, id DESC)"
        )

    def _create_image_generation_v4_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS image_generation_conversations(
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS image_generation_conversations_project_order
                ON image_generation_conversations(project_id, updated_at DESC, id DESC);
            CREATE TABLE IF NOT EXISTS image_generation_runs(
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                node_id TEXT,
                conversation_id TEXT,
                connection_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model_id TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                finished_at INTEGER,
                payload_json TEXT NOT NULL,
                CHECK(node_id IS NOT NULL OR conversation_id IS NOT NULL)
            );
            CREATE INDEX IF NOT EXISTS image_generation_runs_project_order
                ON image_generation_runs(project_id, created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS image_generation_runs_node_order
                ON image_generation_runs(node_id, created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS image_generation_runs_conversation_order
                ON image_generation_runs(conversation_id, created_at DESC, id DESC);
            CREATE TABLE IF NOT EXISTS image_generation_canvas_placements(
                run_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                asset_id TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('pending','placed')),
                canvas_node_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                CHECK((state='pending' AND canvas_node_id IS NULL) OR (state='placed' AND canvas_node_id IS NOT NULL))
            );
            CREATE INDEX IF NOT EXISTS image_generation_placements_project_state_order
                ON image_generation_canvas_placements(project_id, state, created_at, run_id);
        """)

    def _create_image_asset_derivations_v5_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS image_asset_derivations(
                id TEXT PRIMARY KEY,
                source_asset_id TEXT NOT NULL,
                derived_asset_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('preview','provider-input','annotation-flattened')),
                transform_json TEXT NOT NULL,
                annotation_document_json TEXT,
                created_at INTEGER NOT NULL,
                UNIQUE(source_asset_id, derived_asset_id, kind),
                FOREIGN KEY(source_asset_id) REFERENCES assets(asset_id) ON DELETE RESTRICT,
                FOREIGN KEY(derived_asset_id) REFERENCES assets(asset_id) ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS image_asset_derivations_source_order
                ON image_asset_derivations(source_asset_id, created_at, id);
            CREATE INDEX IF NOT EXISTS image_asset_derivations_derived
                ON image_asset_derivations(derived_asset_id);
        """)

    def _migrate_image_generation_v4(self, connection: sqlite3.Connection) -> None:
        rows = connection.execute(
            "SELECT id, project_id, node_id, connection_id, provider_id, model_id, state, "
            "created_at, started_at, finished_at, payload_json FROM image_generation_runs"
        ).fetchall()
        connection.execute("DROP INDEX IF EXISTS image_generation_runs_project_order")
        connection.execute("DROP INDEX IF EXISTS image_generation_runs_node_order")
        connection.execute("ALTER TABLE image_generation_runs RENAME TO image_generation_runs_v3")
        self._create_image_generation_v4_schema(connection)

        conversations: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            payload = json.loads(row[10])
            key = (row[1], row[2])
            conversation = conversations.get(key)
            if conversation is None:
                conversation_id = _legacy_image_conversation_id(row[1], row[2])
                conversation = {
                    "id": conversation_id,
                    "projectId": row[1],
                    "title": image_conversation_title(payload.get("requestSnapshot", {}), row[7]),
                    "createdAt": row[7],
                    "updatedAt": row[9] or row[8] or row[7],
                }
                conversations[key] = conversation
            else:
                if row[7] < conversation["createdAt"]:
                    conversation["createdAt"] = row[7]
                    conversation["title"] = image_conversation_title(payload.get("requestSnapshot", {}), row[7])
                conversation["updatedAt"] = max(
                    conversation["updatedAt"], row[9] or row[8] or row[7]
                )

        for conversation in conversations.values():
            connection.execute(
                "INSERT INTO image_generation_conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (
                    conversation["id"], conversation["projectId"], conversation["title"],
                    conversation["createdAt"], conversation["updatedAt"],
                ),
            )

        for row in rows:
            payload = json.loads(row[10])
            conversation_id = conversations[(row[1], row[2])]["id"]
            payload["conversationId"] = conversation_id
            connection.execute(
                "INSERT INTO image_generation_runs(id, project_id, node_id, conversation_id, connection_id, provider_id, model_id, state, created_at, started_at, finished_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    row[0], row[1], row[2], conversation_id, row[3], row[4], row[5], row[6],
                    row[7], row[8], row[9], _json(payload),
                ),
            )
        connection.execute("DROP TABLE image_generation_runs_v3")

    def _insert_recent_capture(self, connection: sqlite3.Connection, item: dict[str, Any]) -> None:
        connection.execute(
            "INSERT INTO recent_captures(id, asset_id, kind, status, captured_at, created_at, updated_at, revision, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                item["id"],
                item["assetId"],
                item["kind"],
                item["status"],
                item["capturedAt"],
                item["createdAt"],
                item["updatedAt"],
                item["revision"],
                _json(item),
            ),
        )

    def _get_payload(self, table: str, item_id: str, status: str) -> dict[str, Any]:
        with self._connect() as connection:
            return self._get_row_payload(connection, table, item_id, status)

    def _get_row_payload(self, connection: sqlite3.Connection, table: str, item_id: str, status: str) -> dict[str, Any]:
        row = connection.execute(f"SELECT payload_json FROM {table} WHERE id=? AND status=?", (item_id, status)).fetchone()
        if not row:
            raise MissingItem()
        return json.loads(row[0])

    def _active_presets(self, connection: sqlite3.Connection) -> list[dict[str, Any]]:
        return [json.loads(row[0]) for row in connection.execute("SELECT payload_json FROM presets WHERE status='active' ORDER BY sort_order, created_at, id")]

    def _set_status(self, table: str, ids: list[str], source: str, target: str, deleted_by: Actor, delete_reason: str | None) -> list[dict[str, Any]]:
        if not ids:
            return []
        with self._transaction() as connection:
            placeholders = ",".join("?" for _ in ids)
            rows = connection.execute(f"SELECT payload_json FROM {table} WHERE status=? AND id IN ({placeholders})", (source, *ids)).fetchall()
            moved = [json.loads(row[0]) for row in rows]
            connection.execute(
                f"UPDATE {table} SET status=?, deleted_at=?, deleted_by=?, delete_reason=? WHERE status=? AND id IN ({placeholders})",
                (target, now_ms(), deleted_by, delete_reason, source, *ids),
            )
        return moved

    def _list_trash(self, table: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT id, deleted_at, deleted_by, delete_reason, payload_json FROM {table} WHERE status='trash' ORDER BY deleted_at DESC"
            ).fetchall()
        return [{"id": row[0], "deletedAt": row[1], "deletedBy": row[2], "deleteReason": row[3], "payload": json.loads(row[4])} for row in rows]

    def _restore(self, table: str, ids: list[str]) -> list[dict[str, Any]]:
        if not ids:
            return []
        with self._transaction() as connection:
            placeholders = ",".join("?" for _ in ids)
            rows = connection.execute(f"SELECT payload_json FROM {table} WHERE status='trash' AND id IN ({placeholders})", tuple(ids)).fetchall()
            restored = [json.loads(row[0]) for row in rows]
            connection.execute(
                f"UPDATE {table} SET status='active', deleted_at=NULL, deleted_by=NULL, delete_reason=NULL WHERE status='trash' AND id IN ({placeholders})",
                tuple(ids),
            )
        return restored

    def _delete_trash(self, table: str, ids: list[str]) -> None:
        if not ids:
            return
        with self._transaction() as connection:
            placeholders = ",".join("?" for _ in ids)
            connection.execute(f"DELETE FROM {table} WHERE status='trash' AND id IN ({placeholders})", tuple(ids))

    def _require_active_project(self, connection: sqlite3.Connection, project_id: str) -> None:
        row = connection.execute(
            "SELECT 1 FROM projects WHERE id=? AND status='active'",
            (project_id,),
        ).fetchone()
        if not row:
            raise MissingItem()

    def _require_project_folder(
        self,
        connection: sqlite3.Connection,
        project_id: str,
        folder_id: str,
    ) -> dict[str, Any]:
        row = connection.execute(
            """SELECT id, project_id, parent_id, name, sort_order, revision, created_at, updated_at
               FROM project_resource_folders WHERE id=? AND project_id=?""",
            (folder_id, project_id),
        ).fetchone()
        if not row:
            raise MissingItem()
        return self._project_resource_folder(row)

    def _require_project_resource(
        self,
        connection: sqlite3.Connection,
        project_id: str,
        resource_id: str,
    ) -> dict[str, Any]:
        row = connection.execute(
            """SELECT id, project_id, kind, name, source_asset_id, preview_asset_id,
                      provider_asset_id, width, height, content_type, folder_id,
                      sort_order, revision, created_at, updated_at
               FROM project_resources WHERE id=? AND project_id=?""",
            (resource_id, project_id),
        ).fetchone()
        if not row:
            raise MissingItem()
        return self._project_resource(row)

    def _ensure_folder_parent_is_acyclic(
        self,
        connection: sqlite3.Connection,
        project_id: str,
        folder_id: str,
        parent_id: str,
    ) -> None:
        cursor: str | None = parent_id
        seen: set[str] = set()
        while cursor is not None:
            if cursor == folder_id or cursor in seen:
                raise FolderCycle()
            seen.add(cursor)
            row = connection.execute(
                "SELECT parent_id FROM project_resource_folders WHERE id=? AND project_id=?",
                (cursor, project_id),
            ).fetchone()
            if not row:
                raise MissingItem()
            cursor = row[0]

    def _ensure_proposed_folder_parent_is_acyclic(
        self,
        folder_id: str,
        parent_id: str | None,
        proposed_parents: dict[str, str | None],
        current_folders: dict[str, dict[str, Any]],
    ) -> None:
        cursor = parent_id
        seen: set[str] = set()
        while cursor is not None:
            if cursor == folder_id or cursor in seen:
                raise FolderCycle()
            seen.add(cursor)
            cursor = proposed_parents.get(cursor, current_folders[cursor]["parentId"])

    def _project_resource_name(self, value: Any) -> str:
        if not isinstance(value, str):
            raise ValueError("name is required")
        name = value.strip()
        if not 1 <= len(name) <= 80:
            raise ValueError("name must contain 1 to 80 characters")
        return name

    def _project_resource_folder(self, row: Any) -> dict[str, Any]:
        return {
            "id": row[0],
            "projectId": row[1],
            "parentId": row[2],
            "name": row[3],
            "sortOrder": row[4],
            "revision": row[5],
            "createdAt": row[6],
            "updatedAt": row[7],
        }

    def _project_resource(self, row: Any) -> dict[str, Any]:
        return {
            "id": row[0],
            "projectId": row[1],
            "kind": row[2],
            "name": row[3],
            "sourceAssetId": row[4],
            "previewAssetId": row[5],
            "providerAssetId": row[6],
            "width": row[7],
            "height": row[8],
            "contentType": row[9],
            "folderId": row[10],
            "sortOrder": row[11],
            "revision": row[12],
            "createdAt": row[13],
            "updatedAt": row[14],
        }

    def _project_resource_asset_payloads(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT source_asset_id, preview_asset_id, provider_asset_id FROM project_resources"
            ).fetchall()
        return [
            {
                "sourceAssetId": row[0],
                "assetId": row[1],
                "derivedAssetId": row[2],
            }
            for row in rows
        ]

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    @contextmanager
    def _connect(self, configure: bool = True) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path, timeout=5.0)
        try:
            if configure:
                connection.execute("PRAGMA foreign_keys=ON")
                connection.execute("PRAGMA busy_timeout=5000")
            yield connection
        finally:
            connection.close()


# Compatibility import retained while callers migrate terminology.
JsonCollectionStore = SqliteStore


def _content_type_for_path(path: Path) -> str | None:
    return {
        ".bmp": "image/bmp",
        ".gif": "image/gif",
        ".heic": "image/heic",
        ".heif": "image/heif",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
        ".webp": "image/webp",
    }.get(path.suffix.lower())


def _ensure_unique_ids(items: list[dict[str, Any]], label: str) -> None:
    ids = [str(item.get("id")) for item in items]
    if len(ids) != len(set(ids)):
        raise MigrationError(f"Duplicate IDs found in {label}")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def normalize_model_binding(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Agent conversation modelBinding must be an object or null")
    binding: dict[str, str] = {}
    for key in ("connectionId", "providerId", "modelId"):
        item = value.get(key)
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"Agent conversation modelBinding {key} is required")
        binding[key] = item.strip()
    return binding


def _skill_digest(instructions: str, references: list[dict[str, Any]]) -> str:
    canonical = json.dumps(
        {"instructions": instructions, "references": references},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _legacy_image_conversation_id(project_id: str, node_id: str) -> str:
    stable = uuid.uuid5(uuid.NAMESPACE_URL, f"promptcard:image-generation:{project_id}:{node_id}")
    return f"legacy-{stable}"


def normalize_project(item: dict[str, Any]) -> dict[str, Any]:
    now = now_ms()
    project = deepcopy(item)
    project.setdefault("id", str(now))
    project.setdefault("title", "Untitled project")
    project.setdefault("type", "card")
    project.setdefault("pages", [])
    project.setdefault("currentPage", 0)
    project.setdefault("createdAt", now)
    project.setdefault("updatedAt", project.get("createdAt") or now)
    project.setdefault("lastOpenedAt", project.get("updatedAt") or now)
    project.setdefault("meta", {})
    project["revision"] = int(project.get("revision") or 1)
    return project


def normalize_preset(item: dict[str, Any]) -> dict[str, Any]:
    now = now_ms()
    preset = deepcopy(item)
    preset.setdefault("id", f"preset-{now}")
    preset.setdefault("type", "custom")
    preset.setdefault("category", preset.get("type") or "custom")
    preset.setdefault("label", "Untitled preset")
    preset.setdefault("content", "")
    preset.setdefault("usageCount", 0)
    preset.setdefault("meta", {})
    preset.setdefault("createdAt", now)
    preset.setdefault("updatedAt", preset.get("createdAt") or now)
    preset["revision"] = int(preset.get("revision") or 1)
    return preset


def _strip_preset_reference_codes(item: dict[str, Any]) -> dict[str, Any]:
    stripped = deepcopy(item)
    stripped.pop("referenceCode", None)
    meta = stripped.get("meta")
    if not isinstance(meta, dict):
        return stripped
    media = meta.get("media")
    if not isinstance(media, list):
        return stripped
    for binding in media:
        if isinstance(binding, dict):
            binding.pop("referenceCode", None)
    return stripped


def normalize_recent_capture(item: dict[str, Any]) -> dict[str, Any]:
    now = now_ms()
    capture = deepcopy(item)
    capture.setdefault("id", f"capture-{now}")
    capture.setdefault("kind", "screenshot")
    capture.setdefault("status", "recent")
    capture.setdefault("purpose", "inspirationReference")
    capture.setdefault("role", None)
    capture.setdefault("title", "Screenshot capture")
    capture.setdefault("prompt", "")
    capture.setdefault("userNote", "")
    capture.setdefault("sourcePlatform", "Local capture")
    capture.setdefault("sourceUrl", "")
    capture.setdefault("contentType", "image/png")
    capture.setdefault("size", 0)
    capture.setdefault("width", 0)
    capture.setdefault("height", 0)
    capture.setdefault("capturedAt", now)
    capture.setdefault("origin", {"type": "floating-toolbar"})
    capture.setdefault("originalFilename", None)
    capture.setdefault("registeredPromptId", None)
    capture.setdefault("registeredAt", None)
    capture.setdefault("linkedProjectId", None)
    capture.setdefault("linkedCanvasNodeId", None)
    capture.setdefault("createdAt", capture.get("capturedAt") or now)
    capture.setdefault("updatedAt", capture.get("createdAt") or now)
    capture["revision"] = int(capture.get("revision") or 1)

    if not isinstance(capture.get("assetId"), str) or not capture["assetId"]:
        raise ValueError("Recent capture assetId is required")
    if capture["kind"] not in {"screenshot", "pastedMedia", "screenRecording"}:
        raise ValueError(f"Unsupported recent capture kind: {capture['kind']}")
    if capture["contentType"] not in {"image/png", "image/jpeg", "image/webp", "video/mp4"}:
        raise ValueError(f"Unsupported recent capture content type: {capture['contentType']}")
    capture["size"] = int(capture.get("size") or 0)
    capture["width"] = int(capture.get("width") or 0)
    capture["height"] = int(capture.get("height") or 0)
    capture["capturedAt"] = int(capture.get("capturedAt") or now)
    capture["createdAt"] = int(capture.get("createdAt") or capture["capturedAt"])
    capture["updatedAt"] = int(capture.get("updatedAt") or capture["createdAt"])
    return capture


def _default_prompt_type(captures: list[dict[str, Any]]) -> str:
    role_types = {
        "character": "subject", "prop": "subject", "scene": "scene", "composition": "camera",
        "lighting": "lighting", "color": "style", "style": "style", "mood": "style", "other": "custom",
    }
    types = {role_types.get(capture.get("role"), "custom") for capture in captures}
    return next(iter(types)) if len(types) == 1 else "custom"


def _capture_media_item(asset: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"media-{asset['id']}",
        "kind": "video" if str(asset["contentType"]).startswith("video/") else "image",
        "source": "asset",
        "assetId": asset["id"],
        "filename": asset["filename"],
        "contentType": asset["contentType"],
        "size": asset["size"],
        "title": asset["filename"],
    }


def _capture_source_metadata(capture: dict[str, Any]) -> dict[str, Any]:
    return {
        "captureId": capture["id"],
        "purpose": capture.get("purpose"),
        "role": capture.get("role"),
        "userNote": capture.get("userNote", ""),
        "sourcePlatform": capture.get("sourcePlatform", ""),
        "sourceUrl": capture.get("sourceUrl", ""),
        "capturedAt": capture.get("capturedAt"),
        "origin": capture.get("origin", {}),
    }


def _asset_ids(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        for key in ("assetId", "sourceAssetId", "derivedAssetId"):
            asset_id = value.get(key)
            if isinstance(asset_id, str) and asset_id:
                found.add(asset_id)
        output_asset_ids = value.get("outputAssetIds")
        if isinstance(output_asset_ids, list):
            found.update(item for item in output_asset_ids if isinstance(item, str) and item)
        for child in value.values():
            found.update(_asset_ids(child))
    elif isinstance(value, list):
        for child in value:
            found.update(_asset_ids(child))
    return found


def _graph_component(graph: dict[str, set[str]], start: str) -> set[str]:
    members: set[str] = set()
    pending = [start]
    while pending:
        current = pending.pop()
        if current in members:
            continue
        members.add(current)
        pending.extend(graph.get(current, set()) - members)
    return members


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
