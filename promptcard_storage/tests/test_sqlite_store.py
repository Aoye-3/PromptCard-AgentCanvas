import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from promptcard_storage.store import (
    SCHEMA_VERSION,
    DuplicateItem,
    JsonCollectionStore,
    MigrationError,
    MissingItem,
    RevisionConflict,
)


TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / ".test-tmp" / "task15-8-sqlite"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


def project(item_id: str, title: str) -> dict:
    return {
        "id": item_id,
        "title": title,
        "type": "card",
        "revision": 1,
        "pages": [],
        "currentPage": 0,
        "createdAt": 1,
        "updatedAt": 1,
        "lastOpenedAt": 1,
        "meta": {},
    }


def preset(item_id: str, label: str) -> dict:
    return {
        "id": item_id,
        "type": "subject",
        "category": "scene",
        "label": label,
        "content": label,
        "usageCount": 0,
        "revision": 1,
        "createdAt": 1,
        "updatedAt": 1,
        "meta": {},
    }


class SqliteStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.data_dir = Path(self.temp_dir.name, "data")
        self.data_dir.mkdir()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_migrates_json_and_keeps_read_only_sources_with_backup(self) -> None:
        self.write_json("projects.json", {"schemaVersion": 1, "projects": [project("p1", "One")]})
        self.write_json("project-trash.json", {"schemaVersion": 1, "items": [{
            "id": "p2", "deletedAt": 2, "deletedBy": "user", "deleteReason": None,
            "payload": project("p2", "Two"),
        }]})
        self.write_json("prompt-library-presets.json", {"schemaVersion": 1, "presets": [preset("x", "X")]})
        self.write_json("prompt-library-trash.json", {"schemaVersion": 1, "items": []})
        original = (self.data_dir / "projects.json").read_bytes()

        store = JsonCollectionStore(self.data_dir)

        self.assertEqual([item["id"] for item in store.list_projects()], ["p1"])
        self.assertEqual([item["id"] for item in store.list_project_trash()], ["p2"])
        self.assertEqual((self.data_dir / "projects.json").read_bytes(), original)
        self.assertTrue((self.data_dir / "promptcard.sqlite3").is_file())
        backups = list((self.data_dir.parent / "backups").glob("storage-json-v1-*"))
        self.assertEqual(len(backups), 1)
        self.assertTrue((backups[0] / "projects.json").is_file())

    def test_rejects_corrupt_json_without_creating_database(self) -> None:
        (self.data_dir / "projects.json").write_text("{broken", encoding="utf-8")

        with self.assertRaises(MigrationError):
            JsonCollectionStore(self.data_dir)

        self.assertFalse((self.data_dir / "promptcard.sqlite3").exists())

    def test_rejects_duplicate_ids_across_active_and_trash(self) -> None:
        self.write_json("projects.json", {"projects": [project("same", "Active")]})
        self.write_json("project-trash.json", {"items": [{
            "id": "same", "deletedAt": 2, "deletedBy": "user", "payload": project("same", "Trash")
        }]})

        with self.assertRaises(MigrationError):
            JsonCollectionStore(self.data_dir)

    def test_deduplicates_identical_active_and_trash_payloads_in_favor_of_active(self) -> None:
        active = preset("same", "Same")
        trashed = {**active, "revision": 2, "updatedAt": 2}
        self.write_json("prompt-library-presets.json", {"presets": [active]})
        self.write_json("prompt-library-trash.json", {"items": [{
            "id": "same", "deletedAt": 2, "deletedBy": "user", "payload": trashed
        }]})

        store = JsonCollectionStore(self.data_dir)

        self.assertEqual([item["id"] for item in store.list_presets()], ["same"])
        self.assertEqual(store.list_preset_trash(), [])

    def test_different_project_updates_do_not_lose_data(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        a = store.create_project(project("a", "A"))
        b = store.create_project(project("b", "B"))
        barrier = threading.Barrier(2)
        errors: list[Exception] = []

        def update(item_id: str, revision: int, title: str) -> None:
            try:
                barrier.wait()
                store.update_project(item_id, {"title": title}, revision)
            except Exception as error:
                errors.append(error)

        threads = [
            threading.Thread(target=update, args=("a", a["revision"], "A2")),
            threading.Thread(target=update, args=("b", b["revision"], "B2")),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual({item["id"]: item["title"] for item in store.list_projects()}, {"a": "A2", "b": "B2"})

    def test_trash_and_restore_are_single_transaction_updates(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("p1", "One"))

        store.trash_projects(["p1"])
        self.assertEqual(store.list_projects(), [])
        self.assertEqual(store.list_project_trash()[0]["id"], "p1")

        store.restore_projects(["p1"])
        self.assertEqual(store.list_projects()[0]["id"], "p1")
        self.assertEqual(store.list_project_trash(), [])

    def test_duplicate_create_returns_domain_error(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("p1", "One"))
        with self.assertRaises(DuplicateItem):
            store.create_project(project("p1", "Again"))

    def test_browser_import_is_idempotent_by_migration_id(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        payload = {"migrationId": "browser-v1", "projects": [project("p1", "One")], "presets": []}
        first = store.migrate_browser_payload(payload)
        second = store.migrate_browser_payload(payload)

        self.assertEqual(first, {"projects": 1, "presets": 0, "alreadyApplied": False})
        self.assertEqual(second, {"projects": 0, "presets": 0, "alreadyApplied": True})

    def test_replaces_presets_atomically(self) -> None:
        store = JsonCollectionStore(self.data_dir, presets_seed=[preset("seed", "Seed")])
        current = store.list_presets()
        result = store.replace_presets([
            {**current[0], "label": "Changed"},
            preset("new", "New"),
        ])

        self.assertEqual([item["label"] for item in result], ["Changed", "New"])
        self.assertEqual(store.list_preset_trash(), [])

    def test_health_exposes_sqlite_identity_and_capabilities(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        health = store.health()

        self.assertEqual(health["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(health["serviceVersion"], "2.0.0")
        self.assertTrue(health["capabilities"]["sqlite"])
        self.assertTrue(health["capabilities"]["presetBatch"])
        self.assertTrue(health["capabilities"]["recentCaptures"])
        self.assertTrue(health["capabilities"]["agentConversations"])
        self.assertTrue(health["capabilities"]["skillHub"])
        self.assertTrue(health["capabilities"]["projectDocumentResources"])
        self.assertIsInstance(health["pid"], int)

        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
            self.assertEqual(journal_mode.lower(), "wal")
        finally:
            connection.close()

    def test_fresh_schema_v16_contains_document_and_cleanup_tables(self) -> None:
        store = JsonCollectionStore(self.data_dir)

        self.assertEqual(SCHEMA_VERSION, 16)
        connection = sqlite3.connect(store.database_path)
        try:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            migration = connection.execute(
                "SELECT version, name FROM schema_migrations"
            ).fetchall()
        finally:
            connection.close()

        self.assertIn("project_document_resources", tables)
        self.assertIn("provider_file_cleanup", tables)
        self.assertEqual(migration, [(16, "json-v1-to-sqlite")])

    def test_v15_migrates_both_v16_tables_and_then_repairs_conversation_columns(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        connection = sqlite3.connect(store.database_path)
        try:
            connection.execute("DROP TABLE IF EXISTS project_document_resources")
            connection.execute("DROP TABLE IF EXISTS provider_file_cleanup")
            for column in ("interaction_mode", "bound_skill_ids_json", "revision"):
                connection.execute(f"ALTER TABLE agent_conversations DROP COLUMN {column}")
            connection.execute("DELETE FROM schema_migrations")
            connection.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (15, 'legacy-v15', 1)"
            )
            connection.commit()
        finally:
            connection.close()

        migrated = JsonCollectionStore(self.data_dir)
        connection = sqlite3.connect(migrated.database_path)
        try:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(agent_conversations)")
            }
            migrations = connection.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
        finally:
            connection.close()

        self.assertIn("project_document_resources", tables)
        self.assertIn("provider_file_cleanup", tables)
        self.assertTrue({"interaction_mode", "bound_skill_ids_json", "revision"} <= columns)
        self.assertEqual(
            migrations,
            [
                (15, "legacy-v15"),
                (16, "add-project-document-resources-and-provider-file-cleanup"),
            ],
        )

    def test_v15_to_v16_rolls_back_both_tables_when_the_second_create_fails(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        connection = sqlite3.connect(store.database_path)
        try:
            connection.execute("DROP TABLE project_document_resources")
            connection.execute("DROP TABLE provider_file_cleanup")
            connection.execute("DELETE FROM schema_migrations")
            connection.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (15, 'legacy-v15', 1)"
            )
            connection.execute("CREATE VIEW provider_file_cleanup AS SELECT 1 AS incompatible")
            connection.commit()
        finally:
            connection.close()

        with self.assertRaises(sqlite3.OperationalError):
            JsonCollectionStore(self.data_dir)

        connection = sqlite3.connect(store.database_path)
        try:
            document_table = connection.execute(
                """SELECT 1 FROM sqlite_master
                   WHERE type='table' AND name='project_document_resources'"""
            ).fetchone()
            version = connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertIsNone(document_table)
        self.assertEqual(version, 15)

    def test_backup_contains_consistent_database_assets_and_manifest(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("p1", "One"))
        store.save_asset("image.png", "image/png", b"\x89PNG\r\n\x1a\nimage")
        destination = Path(self.temp_dir.name, "snapshot")

        manifest = store.backup(destination)

        self.assertEqual(manifest["schemaVersion"], SCHEMA_VERSION)
        self.assertTrue((destination / "promptcard.sqlite3").is_file())
        self.assertTrue((destination / "manifest.json").is_file())
        self.assertEqual(len(list((destination / "assets").iterdir())), 1)

    def test_agent_conversation_persists_messages_proposals_and_idempotent_requests(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("p1", "One"))
        store.create_project(project("p2", "Two"))
        conversation = store.create_agent_conversation({
            "id": "conversation-1",
            "projectId": "p1",
            "entrypoint": "workspace-chatbot-agent",
            "mode": "free-canvas",
            "title": "Canvas discussion",
        })

        first = store.append_agent_conversation_turn(
            conversation["id"],
            "p1",
            {
                "requestId": "request-1",
                "userMessage": {"id": "message-user", "role": "user", "text": "Improve it"},
                "assistantMessage": {"id": "message-agent", "role": "assistant", "text": "Here is a proposal"},
                "proposals": [{"id": "proposal-1", "kind": "free_canvas_text_update", "status": "pending"}],
                "skillSnapshots": [{"skillId": "SKL-canvas", "revision": 1, "digest": "sha256:test"}],
                "modelSnapshot": {"connectionId": "connection-a", "providerId": "ark", "modelId": "model-a"},
            },
        )
        replay = store.append_agent_conversation_turn(
            conversation["id"],
            "p1",
            {
                "requestId": "request-1",
                "userMessage": {"id": "ignored", "role": "user", "text": "duplicate"},
                "assistantMessage": {"id": "ignored-2", "role": "assistant", "text": "duplicate"},
            },
        )

        self.assertEqual(first["requestId"], "request-1")
        self.assertEqual(replay, first)
        detail = store.get_agent_conversation("conversation-1", "p1")
        self.assertEqual([message["role"] for message in detail["messages"]], ["user", "assistant"])
        self.assertEqual(detail["proposals"][0]["id"], "proposal-1")
        self.assertEqual(detail["turns"][0]["skillSnapshots"][0]["skillId"], "SKL-canvas")
        self.assertEqual(detail["turns"][0]["modelSnapshot"]["modelId"], "model-a")
        with self.assertRaises(MissingItem):
            store.append_agent_conversation_turn(
                conversation["id"], "p2", {"requestId": "request-1"}
            )

    def test_agent_conversation_model_binding_is_project_scoped_and_persisted(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("p1", "One"))
        store.create_project(project("p2", "Two"))
        created = store.create_agent_conversation({
            "id": "conversation-model", "projectId": "p1", "entrypoint": "workspace-chatbot-agent",
            "mode": "card", "modelBinding": {"connectionId": "connection-a", "providerId": "ark", "modelId": "model-a"},
        })

        self.assertEqual(created["modelBinding"]["modelId"], "model-a")
        self.assertEqual(store.list_agent_conversations("p1")["conversations"][0]["modelBinding"], created["modelBinding"])
        updated = store.update_agent_conversation_model_binding(
            "conversation-model", "p1", {"connectionId": "connection-b", "providerId": "openai", "modelId": "model-b"}
        )
        self.assertEqual(updated["modelBinding"]["connectionId"], "connection-b")
        self.assertEqual(store.get_agent_conversation("conversation-model", "p1")["modelBinding"], updated["modelBinding"])
        with self.assertRaises(MissingItem):
            store.update_agent_conversation_model_binding("conversation-model", "p2", None)

    def test_agent_conversation_interaction_defaults_and_optimistic_update_persist(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("p1", "One"))
        store.create_project(project("p2", "Two"))
        created = store.create_agent_conversation({
            "id": "conversation-interaction",
            "projectId": "p1",
            "entrypoint": "workspace-chatbot-agent",
            "mode": "free-canvas",
        })

        self.assertEqual(created["interactionMode"], "prompt-edit")
        self.assertEqual(created["boundSkillIds"], [])
        self.assertEqual(created["revision"], 1)

        updated = store.update_agent_conversation_interaction(
            "conversation-interaction",
            "p1",
            "chat-experimental",
            ["SKL-one", "SKL-two"],
            expected_revision=1,
        )

        self.assertEqual(updated["interactionMode"], "chat-experimental")
        self.assertEqual(updated["boundSkillIds"], ["SKL-one", "SKL-two"])
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(
            store.get_agent_conversation("conversation-interaction", "p1")["boundSkillIds"],
            ["SKL-one", "SKL-two"],
        )
        with self.assertRaises(RevisionConflict):
            store.update_agent_conversation_interaction(
                "conversation-interaction",
                "p1",
                "prompt-edit",
                [],
                expected_revision=1,
            )
        with self.assertRaises(MissingItem):
            store.update_agent_conversation_interaction(
                "conversation-interaction",
                "p2",
                "prompt-edit",
                [],
                expected_revision=2,
            )

    def test_v8_agent_conversations_migrate_model_binding_column(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("p1", "One"))
        store.create_agent_conversation({
            "id": "conversation-v8", "projectId": "p1", "entrypoint": "workspace-chatbot-agent", "mode": "card",
        })
        database_path = self.data_dir / "promptcard.sqlite3"
        connection = sqlite3.connect(database_path)
        try:
            connection.execute("ALTER TABLE agent_conversations DROP COLUMN model_binding_json")
            connection.execute("DELETE FROM schema_migrations WHERE version>8")
            connection.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (8, 'legacy-v8', 1)"
            )
            connection.commit()
        finally:
            connection.close()

        migrated = JsonCollectionStore(self.data_dir)
        self.assertEqual(migrated.health()["schemaVersion"], SCHEMA_VERSION)
        self.assertIsNone(migrated.get_agent_conversation("conversation-v8", "p1")["modelBinding"])

    def test_agent_conversation_trash_restore_and_permanent_delete_are_project_scoped(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("p1", "One"))
        store.create_project(project("p2", "Two"))
        store.create_agent_conversation({"id": "conversation-1", "projectId": "p1", "entrypoint": "workspace-chatbot-agent", "mode": "card"})

        with self.assertRaises(MissingItem):
            store.get_agent_conversation("conversation-1", "p2")
        store.trash_agent_conversation("conversation-1", "p1")
        self.assertEqual(store.list_agent_conversations("p1", status="active")["conversations"], [])
        self.assertEqual(store.list_agent_conversations("p1", status="trash")["conversations"][0]["id"], "conversation-1")
        store.restore_agent_conversation("conversation-1", "p1")
        store.trash_agent_conversation("conversation-1", "p1")
        store.delete_agent_conversation_forever("conversation-1", "p1")
        with self.assertRaises(MissingItem):
            store.get_agent_conversation("conversation-1", "p1", include_trash=True)

    def test_skill_hub_seeds_immutable_builtin_revisions(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        skills = store.list_skills()["skills"]

        self.assertEqual({skill["slug"] for skill in skills}, {"canvas-prompt-editor", "media-prompt-reverse"})
        canvas = store.get_skill(skills[0]["id"])
        self.assertEqual(canvas["currentRevision"], 3)
        self.assertEqual([revision["revision"] for revision in canvas["revisions"]], [3, 2, 1])
        self.assertEqual(canvas["toolDependencies"], ["emit_canvas_prompt_edit"])
        self.assertTrue(all(revision["digest"].startswith("sha256:") for revision in canvas["revisions"]))
        self.assertEqual(canvas["trustState"], "first-party")

        current = canvas["revisions"][0]
        self.assertIn("append", current["instructions"])
        self.assertIn("rewrite_all", current["instructions"])
        self.assertIn("rewrite_selection", current["instructions"])
        self.assertIn("template", current["instructions"])
        self.assertIn("reference", current["instructions"])
        self.assertIn("Explain", current["instructions"])
        self.assertIn("cannot expand permissions", current["instructions"])
        self.assertIn("complete", current["instructions"])
        self.assertIn("anchor", current["instructions"])
        self.assertIn("new node", current["instructions"])
        self.assertIn("read-only", current["instructions"])

        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                connection.execute(
                    "UPDATE skill_revisions SET instructions='tampered' WHERE skill_id=? AND revision=1",
                    (canvas["id"],),
                )
            with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                connection.execute(
                    "DELETE FROM skill_revisions WHERE skill_id=? AND revision=3",
                    (canvas["id"],),
                )
        finally:
            connection.close()

        reopened = JsonCollectionStore(self.data_dir).get_skill(canvas["id"])
        self.assertEqual(reopened["currentRevision"], 3)
        self.assertEqual([revision["revision"] for revision in reopened["revisions"]], [3, 2, 1])
        self.assertEqual(reopened["revisions"], canvas["revisions"])

        reopened_again = JsonCollectionStore(self.data_dir).get_skill(canvas["id"])
        self.assertEqual(reopened_again["revisions"], reopened["revisions"])

    def test_external_skill_revisions_are_append_only(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        created = store.create_skill({
            "id": "SKL-external", "slug": "tone-helper", "name": "Tone Helper",
            "description": "Adjusts tone", "source": "external", "trustState": "trusted",
            "toolDependencies": ["search_prompt_library"], "instructions": "Use a warm tone.",
        })
        updated = store.add_skill_revision("SKL-external", {
            "instructions": "Use a concise warm tone.", "references": [{"name": "guide", "content": "Short sentences."}]
        })

        self.assertEqual(created["currentRevision"], 1)
        self.assertEqual(updated["currentRevision"], 2)
        self.assertEqual([item["revision"] for item in updated["revisions"]], [2, 1])
        self.assertEqual(store.list_skills()["skills"][-1]["source"], "external")

    def test_recent_captures_are_persisted_and_ordered(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        asset = store.save_asset("shot.png", "image/png", b"\x89PNG\r\n\x1a\nimage")

        first = store.create_recent_capture({
            "id": "capture-one",
            "assetId": asset["id"],
            "kind": "screenshot",
            "contentType": "image/png",
            "width": 640,
            "height": 360,
            "capturedAt": 10,
        })
        second = store.create_recent_capture({
            "id": "capture-two",
            "assetId": asset["id"],
            "kind": "screenshot",
            "contentType": "image/png",
            "width": 800,
            "height": 450,
            "capturedAt": 20,
        })

        self.assertEqual(first["revision"], 1)
        self.assertEqual([item["id"] for item in store.list_recent_captures()], [second["id"], first["id"]])
        updated = store.update_recent_capture(first["id"], {"status": "placedOnCanvas"}, first["revision"])
        self.assertEqual(updated["status"], "placedOnCanvas")
        self.assertEqual(updated["revision"], 2)

    def test_recent_capture_assets_are_counted_as_referenced(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        asset = store.save_asset("shot.png", "image/png", b"\x89PNG\r\n\x1a\nimage")
        store.create_recent_capture({
            "id": "capture-one",
            "assetId": asset["id"],
            "kind": "screenshot",
            "contentType": "image/png",
        })

        diagnostics = store.diagnose_assets()

        self.assertNotIn(asset["id"], diagnostics["unreferencedAssets"])

    def test_deletes_recent_capture_without_deleting_its_asset(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        asset = store.save_asset("shot.png", "image/png", b"\x89PNG\r\n\x1a\nimage")
        capture = store.create_recent_capture({
            "id": "capture-delete",
            "assetId": asset["id"],
            "kind": "screenshot",
            "contentType": "image/png",
        })

        delete_capture = getattr(store, "delete_recent_capture", None)
        self.assertIsNotNone(delete_capture)
        if delete_capture is None:
            return
        delete_capture(capture["id"], capture["revision"])

        with self.assertRaises(MissingItem):
            store.get_recent_capture(capture["id"])
        self.assertTrue((self.data_dir / "assets" / asset["id"]).is_file())
        self.assertIn(asset["id"], store.diagnose_assets()["unreferencedAssets"])

    def test_rejects_deleting_a_stale_recent_capture(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        capture = store.create_recent_capture({"id": "capture-stale", "assetId": "asset-stale.png"})
        current = store.update_recent_capture(capture["id"], {"title": "Updated"}, capture["revision"])

        delete_capture = getattr(store, "delete_recent_capture", None)
        self.assertIsNotNone(delete_capture)
        if delete_capture is None:
            return
        with self.assertRaises(RevisionConflict):
            delete_capture(capture["id"], capture["revision"])
        self.assertEqual(store.get_recent_capture(capture["id"])["revision"], current["revision"])

    def test_registers_recent_captures_as_separate_prompts_without_copying_assets(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        first_asset = store.save_asset("character.png", "image/png", b"\x89PNG\r\n\x1a\ncharacter")
        second_asset = store.save_asset("scene.webp", "image/webp", b"RIFF\x04\x00\x00\x00WEBPscene")
        first = store.create_recent_capture({
            "id": "capture-character", "assetId": first_asset["id"], "kind": "pastedMedia",
            "contentType": "image/png", "title": "Hero", "prompt": "A determined hero",
            "role": "character", "sourcePlatform": "Clipboard", "origin": {"type": "clipboard"},
        })
        second = store.create_recent_capture({
            "id": "capture-scene", "assetId": second_asset["id"], "kind": "pastedMedia",
            "contentType": "image/webp", "title": "Station", "prompt": "An empty station",
            "role": "scene", "sourcePlatform": "Clipboard", "origin": {"type": "clipboard"},
        })

        result = store.register_recent_captures_to_prompt_library({
            "mode": "separate",
            "captures": [
                {"id": first["id"], "revision": first["revision"], "label": "Hero", "content": "A determined hero", "type": "subject", "category": "cinematic-characters"},
                {"id": second["id"], "revision": second["revision"], "label": "Station", "content": "An empty station", "type": "scene"},
            ],
        })

        self.assertEqual([item["type"] for item in result["presets"]], ["subject", "scene"])
        self.assertEqual([item["category"] for item in result["presets"]], ["cinematic-characters", "scene"])
        self.assertEqual(
            [item["meta"]["media"][0]["assetId"] for item in result["presets"]],
            [first_asset["id"], second_asset["id"]],
        )
        self.assertEqual(result["presets"][0]["meta"]["recentCaptureSources"][0]["captureId"], first["id"])
        self.assertEqual(result["captures"][0]["registeredPromptId"], result["presets"][0]["id"])
        self.assertEqual(result["captures"][0]["status"], "registeredToPromptLibrary")
        self.assertEqual(len(list((self.data_dir / "assets").iterdir())), 2)

    def test_merges_recent_captures_into_one_prompt_with_all_media(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        assets = [
            store.save_asset("one.png", "image/png", b"\x89PNG\r\n\x1a\none"),
            store.save_asset("two.jpg", "image/jpeg", b"\xff\xd8\xfftwo"),
        ]
        captures = [store.create_recent_capture({
            "id": f"capture-{index}", "assetId": asset["id"], "kind": "pastedMedia",
            "contentType": asset["contentType"], "title": f"Capture {index}", "role": role,
        }) for index, (asset, role) in enumerate(zip(assets, ["character", "lighting"]))]

        result = store.register_recent_captures_to_prompt_library({
            "mode": "merged",
            "captures": [{"id": item["id"], "revision": item["revision"]} for item in captures],
            "prompt": {"label": "Reference group", "content": "Use both references", "type": "custom"},
        })

        self.assertEqual(len(result["presets"]), 1)
        self.assertEqual(result["presets"][0]["type"], "custom")
        self.assertEqual([item["assetId"] for item in result["presets"][0]["meta"]["media"]], [asset["id"] for asset in assets])
        self.assertTrue(all(item["registeredPromptId"] == result["presets"][0]["id"] for item in result["captures"]))

    def test_registration_rolls_back_every_change_on_stale_capture(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        asset = store.save_asset("one.png", "image/png", b"\x89PNG\r\n\x1a\none")
        first = store.create_recent_capture({"id": "first", "assetId": asset["id"]})
        second = store.create_recent_capture({"id": "second", "assetId": asset["id"]})
        store.update_recent_capture(second["id"], {"title": "newer"}, second["revision"])

        with self.assertRaises(RevisionConflict):
            store.register_recent_captures_to_prompt_library({
                "mode": "separate",
                "captures": [
                    {"id": first["id"], "revision": first["revision"], "label": "One", "content": "One", "type": "custom"},
                    {"id": second["id"], "revision": second["revision"], "label": "Two", "content": "Two", "type": "custom"},
                ],
            })

        self.assertEqual(store.list_presets(), [])
        self.assertIsNone(store.get_recent_capture(first["id"])["registeredPromptId"])

    def test_registration_rejects_missing_assets_and_already_registered_captures(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        missing = store.create_recent_capture({"id": "missing", "assetId": "does-not-exist.png"})
        with self.assertRaises(MissingItem):
            store.register_recent_captures_to_prompt_library({
                "mode": "separate",
                "captures": [{"id": missing["id"], "revision": missing["revision"], "label": "Missing", "content": "Missing", "type": "custom"}],
            })

        asset = store.save_asset("one.png", "image/png", b"\x89PNG\r\n\x1a\none")
        capture = store.create_recent_capture({"id": "registered", "assetId": asset["id"]})
        store.register_recent_captures_to_prompt_library({
            "mode": "separate",
            "captures": [{"id": capture["id"], "revision": capture["revision"], "label": "One", "content": "One", "type": "custom"}],
        })
        current = store.get_recent_capture(capture["id"])
        with self.assertRaises(ValueError):
            store.register_recent_captures_to_prompt_library({
                "mode": "separate",
                "captures": [{"id": current["id"], "revision": current["revision"], "label": "Again", "content": "Again", "type": "custom"}],
            })

    def test_prompt_media_assets_remain_referenced_in_active_and_trash_presets(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        asset = store.save_asset("one.png", "image/png", b"\x89PNG\r\n\x1a\none")
        created = store.create_preset({
            "id": "media-preset", "type": "custom", "category": "custom", "label": "Media", "content": "Media",
            "meta": {"media": [{"id": "media-one", "kind": "image", "source": "asset", "assetId": asset["id"]}]},
        })
        self.assertNotIn(asset["id"], store.diagnose_assets()["unreferencedAssets"])
        store.trash_presets([created["id"]])
        self.assertNotIn(asset["id"], store.diagnose_assets()["unreferencedAssets"])

    def test_recent_capture_prompt_and_canvas_share_one_physical_asset(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        asset = store.save_asset("shared.png", "image/png", b"\x89PNG\r\n\x1a\nshared")
        capture = store.create_recent_capture({
            "id": "capture-shared", "assetId": asset["id"], "kind": "screenshot",
            "contentType": "image/png", "title": "Shared", "prompt": "Shared prompt",
        })
        registered = store.register_recent_captures_to_prompt_library({
            "mode": "separate",
            "captures": [{
                "id": capture["id"], "revision": capture["revision"],
                "label": "Shared", "content": "Shared prompt", "type": "custom",
            }],
        })
        current = registered["captures"][0]
        project = store.create_project({
            "id": "canvas-project", "title": "Canvas", "type": "free-canvas", "pages": [], "currentPage": 0,
            "freeCanvas": {"nodes": [{"id": "canvas-node", "assetId": asset["id"]}], "edges": [], "selectedNodeId": "canvas-node"},
            "meta": {},
        })
        linked = store.update_recent_capture(current["id"], {
            "linkedProjectId": project["id"], "linkedCanvasNodeId": "canvas-node",
        }, current["revision"])

        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 1)
        finally:
            connection.close()
        self.assertEqual(len(list((self.data_dir / "assets").iterdir())), 1)
        self.assertEqual(linked["assetId"], asset["id"])
        self.assertEqual(registered["presets"][0]["meta"]["media"][0]["assetId"], asset["id"])
        self.assertEqual(project["freeCanvas"]["nodes"][0]["assetId"], asset["id"])

    def write_json(self, name: str, payload: dict) -> None:
        (self.data_dir / name).write_text(json.dumps(payload), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
