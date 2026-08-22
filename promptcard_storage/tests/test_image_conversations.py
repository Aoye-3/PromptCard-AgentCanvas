import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

try:
    from fastapi.testclient import TestClient
    from promptcard_storage.app import create_app
except ModuleNotFoundError:
    TestClient = None
    create_app = None

from promptcard_storage.store import SCHEMA_VERSION, JsonCollectionStore, MissingItem


TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / ".test-tmp" / "image-conversations"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


def run_payload(
    run_id: str,
    *,
    project_id: str = "project-one",
    conversation_id: str | None = "conversation-one",
    node_id: str | None = None,
    prompt: str = "Design a silver platform with cinematic light and fog",
    created_at: int = 100,
) -> dict:
    payload = {
        "id": run_id,
        "projectId": project_id,
        "connectionId": "connection-one",
        "providerId": "volcengine-ark",
        "modelId": "doubao-seedream-5-0-pro-260628",
        "state": "queued",
        "requestSnapshot": {
            "mode": "generate",
            "promptDocument": {"version": 1, "segments": [{"type": "text", "text": prompt}]},
            "inputs": [],
            "regions": [],
            "settings": {"resolution": "1K", "aspectRatio": "1:1", "outputFormat": "png"},
        },
        "outputAssetIds": [],
        "createdAt": created_at,
    }
    if conversation_id is not None:
        payload["conversationId"] = conversation_id
    if node_id is not None:
        payload["nodeId"] = node_id
    return payload


def downgrade_database_to_v3(database_path: Path) -> None:
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("DROP INDEX IF EXISTS image_generation_runs_project_order")
        connection.execute("DROP INDEX IF EXISTS image_generation_runs_node_order")
        connection.execute("DROP INDEX IF EXISTS image_generation_runs_conversation_order")
        connection.execute("ALTER TABLE image_generation_runs RENAME TO image_generation_runs_newer")
        connection.execute("""
            CREATE TABLE image_generation_runs(
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
        connection.execute("""
            INSERT INTO image_generation_runs(
                id, project_id, node_id, connection_id, provider_id, model_id,
                state, created_at, started_at, finished_at, payload_json
            )
            SELECT id, project_id, node_id, connection_id, provider_id, model_id,
                   state, created_at, started_at, finished_at, payload_json
            FROM image_generation_runs_newer
        """)
        connection.execute("DROP TABLE image_generation_runs_newer")
        connection.execute("DROP TABLE IF EXISTS image_generation_canvas_placements")
        connection.execute("DROP TABLE IF EXISTS image_generation_conversations")
        connection.execute("DELETE FROM schema_migrations WHERE version >= 4")
        connection.execute(
            "INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (3, 'legacy-v3', 1)"
        )
        connection.commit()
    finally:
        connection.close()


class ImageConversationMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.data_dir = Path(self.temp_dir.name, "data")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_v3_runs_are_grouped_deterministically_without_placements(self) -> None:
        legacy = JsonCollectionStore(self.data_dir)
        legacy.create_image_generation_run(run_payload(
            "legacy-one", conversation_id=None, node_id="node-one", created_at=100
        ))
        legacy.create_image_generation_run(run_payload(
            "legacy-two", conversation_id=None, node_id="node-one", created_at=200
        ))
        legacy.create_image_generation_run(run_payload(
            "legacy-three", conversation_id=None, node_id="node-two", created_at=300
        ))
        downgrade_database_to_v3(self.data_dir / "promptcard.sqlite3")

        migrated = JsonCollectionStore(self.data_dir)
        first_ids = {
            run["conversationId"]
            for run in migrated.list_image_generation_runs(project_id="project-one")["runs"]
            if run["nodeId"] == "node-one"
        }
        conversations = migrated.list_image_generation_conversations(project_id="project-one")

        self.assertEqual(migrated.health()["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(len(first_ids), 1)
        self.assertEqual(len(conversations["conversations"]), 2)
        self.assertEqual(migrated.list_image_generation_placements(project_id="project-one")["placements"], [])

        reopened = JsonCollectionStore(self.data_dir)
        reopened_ids = {
            run["conversationId"]
            for run in reopened.list_image_generation_runs(project_id="project-one")["runs"]
            if run["nodeId"] == "node-one"
        }
        self.assertEqual(reopened_ids, first_ids)

        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            columns = {row[1]: row[3] for row in connection.execute("PRAGMA table_info(image_generation_runs)")}
            placement_count = connection.execute(
                "SELECT COUNT(*) FROM image_generation_canvas_placements"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(columns["node_id"], 0)
        self.assertEqual(columns["conversation_id"], 0)
        self.assertEqual(placement_count, 0)


class ImageConversationStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.data_dir = Path(self.temp_dir.name, "data")
        self.store = JsonCollectionStore(self.data_dir)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_first_run_atomically_creates_conversation_and_preserves_first_title(self) -> None:
        prompt = "  Design   a silver platform with cinematic light and fog  "
        first = self.store.create_image_generation_run(run_payload("run-one", prompt=prompt, created_at=100))
        conversation = self.store.get_image_generation_conversation("conversation-one", "project-one")

        self.assertEqual(first["conversationId"], "conversation-one")
        self.assertEqual(conversation["title"], "Design a silver platform with ci")
        self.assertEqual(conversation["turnCount"], 1)
        self.assertEqual(conversation["latestRunId"], "run-one")
        self.assertEqual(conversation["latestState"], "queued")

        self.store.create_image_generation_run(run_payload(
            "run-two", prompt="A title that must not replace the first one", created_at=200
        ))
        updated = self.store.get_image_generation_conversation("conversation-one", "project-one")
        self.assertEqual(updated["title"], conversation["title"])
        self.assertEqual(updated["turnCount"], 2)
        self.assertEqual(updated["latestRunId"], "run-two")

    def test_empty_visible_prompt_uses_dated_fallback_title(self) -> None:
        payload = run_payload("run-fallback", conversation_id="fallback", prompt="", created_at=1704067200000)
        payload["requestSnapshot"]["promptDocument"]["segments"] = [
            {"type": "reference", "referenceId": "reference-one"}
        ]
        self.store.create_image_generation_run(payload)

        conversation = self.store.get_image_generation_conversation("fallback", "project-one")
        self.assertEqual(conversation["title"], "图片创作 2024-01-01")

    def test_conversation_scope_is_not_disclosed_across_projects(self) -> None:
        self.store.create_image_generation_run(run_payload("run-one"))

        with self.assertRaises(MissingItem):
            self.store.get_image_generation_conversation("conversation-one", "project-two")
        with self.assertRaises(MissingItem):
            self.store.list_image_generation_conversation_runs(
                "conversation-one", project_id="project-two"
            )
        with self.assertRaises(MissingItem):
            self.store.create_image_generation_run(run_payload(
                "run-cross-project", project_id="project-two"
            ))
        with self.assertRaises(MissingItem):
            self.store.get_image_generation_run(
                "run-cross-project", project_id="project-two"
            )

    def test_conversation_and_run_pagination_are_project_scoped(self) -> None:
        for fixture in (
            run_payload("run-a", conversation_id="conversation-a", created_at=100),
            run_payload("run-b", conversation_id="conversation-b", created_at=200),
            run_payload("run-c", conversation_id="conversation-c", project_id="project-two", created_at=300),
            run_payload("run-a2", conversation_id="conversation-a", created_at=400),
        ):
            self.store.create_image_generation_run(fixture)

        first = self.store.list_image_generation_conversations(project_id="project-one", limit=1)
        self.assertEqual([item["id"] for item in first["conversations"]], ["conversation-a"])
        second = self.store.list_image_generation_conversations(
            project_id="project-one", cursor=first["nextCursor"], limit=1
        )
        self.assertEqual([item["id"] for item in second["conversations"]], ["conversation-b"])
        self.assertIsNone(second["nextCursor"])

        runs = self.store.list_image_generation_conversation_runs(
            "conversation-a", project_id="project-one", limit=1
        )
        self.assertEqual([item["id"] for item in runs["runs"]], ["run-a2"])
        next_runs = self.store.list_image_generation_conversation_runs(
            "conversation-a", project_id="project-one", cursor=runs["nextCursor"], limit=1
        )
        self.assertEqual([item["id"] for item in next_runs["runs"]], ["run-a"])

    def test_success_creates_one_pending_placement_and_only_pending_can_be_placed(self) -> None:
        run = self.store.create_image_generation_run(run_payload("run-place"))
        output = self.store.save_asset("output.png", "image/png", b"\x89PNG\r\n\x1a\noutput")
        self.store.update_image_generation_run_state(run["id"], {"state": "running", "startedAt": 110})
        self.store.update_image_generation_run_state(run["id"], {
            "state": "succeeded", "outputAssetIds": [output["id"]], "finishedAt": 120,
        })

        pending = self.store.list_image_generation_placements(project_id="project-one", state="pending")
        self.assertEqual(len(pending["placements"]), 1)
        self.assertEqual(pending["placements"][0]["runId"], "run-place")
        self.assertEqual(pending["placements"][0]["conversationId"], "conversation-one")
        self.assertEqual(pending["placements"][0]["assetId"], output["id"])

        placed = self.store.update_image_generation_placement(
            "run-place", {"state": "placed", "canvasNodeId": "image-node-one"}
        )
        self.assertEqual(placed["state"], "placed")
        self.assertEqual(placed["canvasNodeId"], "image-node-one")
        self.assertEqual(
            self.store.list_image_generation_placements(project_id="project-one", state="pending")["placements"],
            [],
        )
        with self.assertRaises(ValueError):
            self.store.update_image_generation_placement(
                "run-place", {"state": "placed", "canvasNodeId": "image-node-two"}
            )

    def test_legacy_node_only_success_does_not_create_placement(self) -> None:
        run = self.store.create_image_generation_run(run_payload(
            "node-run", conversation_id=None, node_id="legacy-node"
        ))
        output = self.store.save_asset("output.png", "image/png", b"\x89PNG\r\n\x1a\noutput")
        self.store.update_image_generation_run_state(run["id"], {"state": "running"})
        self.store.update_image_generation_run_state(run["id"], {
            "state": "succeeded", "outputAssetIds": [output["id"]],
        })

        self.assertEqual(
            self.store.list_image_generation_placements(project_id="project-one")["placements"], []
        )


@unittest.skipUnless(TestClient and create_app, "FastAPI contract dependencies are not installed")
class ImageConversationAppContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.store = JsonCollectionStore(Path(self.temp_dir.name, "data"))
        self.client = TestClient(create_app(self.store))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_project_scoped_conversation_and_placement_routes(self) -> None:
        created = self.client.post("/api/image-generation-runs", json=run_payload("run-api"))
        self.assertEqual(created.status_code, 200)

        conversations = self.client.get(
            "/api/image-generation-conversations", params={"projectId": "project-one"}
        )
        self.assertEqual(conversations.status_code, 200)
        self.assertEqual(conversations.json()["conversations"][0]["id"], "conversation-one")
        detail = self.client.get(
            "/api/image-generation-conversations/conversation-one", params={"projectId": "project-one"}
        )
        self.assertEqual(detail.status_code, 200)
        runs = self.client.get(
            "/api/image-generation-conversations/conversation-one/runs",
            params={"projectId": "project-one"},
        )
        self.assertEqual([item["id"] for item in runs.json()["runs"]], ["run-api"])
        self.assertEqual(self.client.get(
            "/api/image-generation-conversations/conversation-one", params={"projectId": "project-two"}
        ).status_code, 404)

        output = self.store.save_asset("output.png", "image/png", b"\x89PNG\r\n\x1a\noutput")
        self.client.patch("/api/image-generation-runs/run-api/state", json={"state": "running"})
        self.client.patch("/api/image-generation-runs/run-api/state", json={
            "state": "succeeded", "outputAssetIds": [output["id"]],
        })
        placements = self.client.get(
            "/api/image-generation-placements", params={"projectId": "project-one", "state": "pending"}
        )
        self.assertEqual(placements.status_code, 200)
        self.assertEqual(placements.json()["placements"][0]["runId"], "run-api")
        placed = self.client.patch("/api/image-generation-placements/run-api", json={
            "state": "placed", "canvasNodeId": "node-output",
        })
        self.assertEqual(placed.status_code, 200)
        self.assertEqual(placed.json()["canvasNodeId"], "node-output")
        self.assertEqual(self.client.delete("/api/image-generation-placements/run-api").status_code, 405)

    def test_run_list_accepts_conversation_filter(self) -> None:
        self.client.post("/api/image-generation-runs", json=run_payload("run-one"))
        self.client.post("/api/image-generation-runs", json=run_payload(
            "run-two", conversation_id="conversation-two"
        ))

        response = self.client.get(
            "/api/image-generation-runs",
            params={"projectId": "project-one", "conversationId": "conversation-one"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["id"] for item in response.json()["runs"]], ["run-one"])


if __name__ == "__main__":
    unittest.main()
