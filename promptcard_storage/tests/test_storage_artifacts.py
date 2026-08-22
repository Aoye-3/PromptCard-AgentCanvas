import sqlite3
import tempfile
import unittest
from pathlib import Path

from promptcard_storage.store import AssetInUse, DeletedAsset, SqliteStore


PNG = b"\x89PNG\r\n\x1a\nasset"


def project_with_asset(item_id: str, asset_id: str) -> dict:
    return {
        "id": item_id,
        "title": "Canvas",
        "type": "free-canvas",
        "revision": 1,
        "pages": [],
        "currentPage": 0,
        "freeCanvas": {
            "nodes": [{
                "id": "image-one",
                "kind": "image",
                "title": "Project image",
                "width": 640,
                "height": 480,
                "assetId": asset_id,
            }],
            "edges": [],
            "selectedNodeId": "image-one",
        },
        "createdAt": 1,
        "updatedAt": 1,
        "lastOpenedAt": 1,
        "meta": {},
    }


class StorageArtifactLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.store = SqliteStore(self.data_dir)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_schema_v7_assets_default_to_active_without_losing_metadata(self) -> None:
        asset = self.store.save_asset("legacy.png", "image/png", PNG)

        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            row = connection.execute(
                "SELECT lifecycle_status, original_filename, size FROM assets WHERE asset_id=?",
                (asset["id"],),
            ).fetchone()
            version = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        finally:
            connection.close()

        self.assertEqual(version, 10)
        self.assertEqual(row, ("active", "legacy.png", len(PNG)))

    def test_schema_v5_migrates_existing_asset_to_active_without_changing_metadata(self) -> None:
        asset = self.store.save_asset("legacy-v5.png", "image/png", PNG)
        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            connection.execute("PRAGMA legacy_alter_table=ON")
            connection.execute("DROP INDEX assets_lifecycle_order")
            connection.execute("ALTER TABLE assets RENAME TO assets_v6")
            connection.execute(
                """CREATE TABLE assets(
                       asset_id TEXT PRIMARY KEY, original_filename TEXT NOT NULL,
                       relative_path TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL,
                       size INTEGER NOT NULL, created_at INTEGER NOT NULL
                   )"""
            )
            connection.execute(
                """INSERT INTO assets(asset_id, original_filename, relative_path, content_type, size, created_at)
                   SELECT asset_id, original_filename, relative_path, content_type, size, created_at FROM assets_v6"""
            )
            connection.execute("DROP TABLE assets_v6")
            connection.execute("DELETE FROM schema_migrations WHERE version>=6")
            connection.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (5, 'add-image-asset-derivations', 1)"
            )
            connection.commit()
        finally:
            connection.close()

        migrated = SqliteStore(self.data_dir)

        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            row = connection.execute(
                "SELECT lifecycle_status, original_filename, size FROM assets WHERE asset_id=?",
                (asset["id"],),
            ).fetchone()
            version = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(version, 10)
        self.assertEqual(row, ("active", "legacy-v5.png", len(PNG)))
        self.assertTrue(migrated.get_asset(asset["id"])[0].is_file())

    def test_unrecognized_content_type_is_grouped_as_other(self) -> None:
        asset = self.store.save_asset("other.png", "image/png", PNG)
        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            connection.execute(
                "UPDATE assets SET content_type='application/octet-stream' WHERE asset_id=?",
                (asset["id"],),
            )
            connection.commit()
        finally:
            connection.close()

        artifact = self.store.list_storage_artifacts(media_type="other")["artifacts"][0]

        self.assertEqual(artifact["assetId"], asset["id"])
        self.assertEqual(artifact["mediaType"], "other")

    def test_generated_output_wins_over_recent_capture_classification(self) -> None:
        asset = self.store.save_asset("generated.png", "image/png", PNG)
        run = self.store.create_image_generation_run({
            "id": "run-one",
            "projectId": "project-one",
            "nodeId": "node-one",
            "connectionId": "connection-one",
            "providerId": "volcengine-ark",
            "modelId": "seedream",
            "state": "queued",
            "requestSnapshot": {"mode": "text-to-image"},
            "outputAssetIds": [],
            "createdAt": 1,
        })
        self.store.update_image_generation_run_state(run["id"], {"state": "running", "startedAt": 2})
        self.store.update_image_generation_run_state(run["id"], {
            "state": "succeeded", "outputAssetIds": [asset["id"]], "finishedAt": 3,
        })
        self.store.create_recent_capture({
            "id": "capture-generated",
            "assetId": asset["id"],
            "kind": "pastedMedia",
            "purpose": "generatedResult",
            "title": "Generated",
            "contentType": "image/png",
            "capturedAt": 3,
        })

        generated = self.store.list_storage_artifacts(category="generated-content")
        external = self.store.list_storage_artifacts(category="external-media")

        self.assertEqual([item["assetId"] for item in generated["artifacts"]], [asset["id"]])
        self.assertEqual(external["artifacts"], [])

    def test_trash_hides_external_media_and_restore_returns_it(self) -> None:
        asset = self.store.save_asset("capture.png", "image/png", PNG)
        self.store.create_recent_capture({
            "id": "capture-one",
            "assetId": asset["id"],
            "kind": "screenshot",
            "contentType": "image/png",
            "capturedAt": 10,
        })

        self.store.trash_storage_artifacts([asset["id"]])

        self.assertEqual(self.store.list_recent_captures(), [])
        self.assertEqual(self.store.list_storage_artifacts(category="external-media")["artifacts"], [])
        self.assertEqual(
            self.store.list_storage_artifacts(category="external-media", status="trash")["artifacts"][0]["assetId"],
            asset["id"],
        )
        path, _content_type = self.store.get_asset(asset["id"])
        self.assertTrue(path.is_file())

        self.store.restore_storage_artifacts([asset["id"]])

        self.assertEqual(self.store.list_recent_captures()[0]["id"], "capture-one")

    def test_permanent_delete_is_blocked_by_restorable_project_reference(self) -> None:
        asset = self.store.save_asset("project.png", "image/png", PNG)
        self.store.create_project(project_with_asset("project-one", asset["id"]))
        self.store.trash_projects(["project-one"])
        self.store.trash_storage_artifacts([asset["id"]])

        with self.assertRaises(AssetInUse) as raised:
            self.store.delete_storage_artifacts_forever([asset["id"]])

        self.assertEqual(raised.exception.references[0]["kind"], "project")
        self.assertEqual(raised.exception.references[0]["status"], "trash")
        self.assertTrue((self.data_dir / "assets" / asset["id"]).is_file())

    def test_permanent_delete_keeps_generation_history_as_deleted_tombstone(self) -> None:
        asset = self.store.save_asset("generated.png", "image/png", PNG)
        run = self.store.create_image_generation_run({
            "id": "run-delete",
            "projectId": "project-gone",
            "nodeId": "node-gone",
            "connectionId": "connection-one",
            "providerId": "volcengine-ark",
            "modelId": "seedream",
            "state": "queued",
            "requestSnapshot": {"mode": "text-to-image"},
            "outputAssetIds": [],
            "createdAt": 1,
        })
        self.store.update_image_generation_run_state(run["id"], {"state": "running", "startedAt": 2})
        self.store.update_image_generation_run_state(run["id"], {
            "state": "succeeded", "outputAssetIds": [asset["id"]], "finishedAt": 3,
        })
        self.store.trash_storage_artifacts([asset["id"]])

        self.store.delete_storage_artifacts_forever([asset["id"]])

        with self.assertRaises(DeletedAsset):
            self.store.get_asset(asset["id"])
        stored_run = self.store.get_image_generation_run(run["id"], project_id="project-gone")
        self.assertEqual(stored_run["outputAssetIds"], [asset["id"]])
        self.assertEqual(stored_run["outputAssetStates"], {asset["id"]: "deleted"})
        self.assertNotIn(asset["id"], self.store.diagnose_assets()["missingFiles"])

    def test_summary_reports_soft_threshold_without_blocking_writes(self) -> None:
        self.store.save_asset("one.png", "image/png", PNG)

        summary = self.store.get_storage_summary(warning_bytes=1)
        second = self.store.save_asset("two.png", "image/png", PNG)

        self.assertEqual(summary["assetWarningLevel"], "warning")
        self.assertGreaterEqual(summary["userAssetBytes"], len(PNG))
        self.assertTrue(second["id"])


if __name__ == "__main__":
    unittest.main()
