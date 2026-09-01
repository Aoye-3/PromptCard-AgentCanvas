import tempfile
import unittest
import sqlite3
from pathlib import Path

from promptcard_storage.store import (
    SCHEMA_VERSION,
    FolderCycle,
    FolderNotEmpty,
    MissingItem,
    RevisionConflict,
    SqliteStore,
)
from promptcard_storage.tests.workspace_paths import workspace_test_root


TEST_ROOT = workspace_test_root("project-resources")


def project(item_id: str) -> dict:
    return {
        "id": item_id,
        "title": item_id,
        "type": "free-canvas",
        "pages": [],
        "currentPage": 0,
        "meta": {},
    }


class ProjectResourcesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.store = SqliteStore(Path(self.temp_dir.name))
        self.project_a = self.store.create_project(project("project-a"))
        self.project_b = self.store.create_project(project("project-b"))
        self.asset = self.store.save_asset(
            "subject.png",
            "image/png",
            b"\x89PNG\r\n\x1a\nproject-resource",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def create_resource(self, project_id: str, **overrides: object) -> dict:
        return self.store.create_project_resource(project_id, {
            "id": overrides.pop("id", "resource-one"),
            "kind": overrides.pop("kind", "material"),
            "name": overrides.pop("name", "Reference"),
            "sourceAssetId": self.asset["id"],
            "previewAssetId": self.asset["id"],
            "providerAssetId": self.asset["id"],
            "width": 640,
            "height": 480,
            "contentType": "image/png",
            **overrides,
        })

    def test_health_and_fresh_schema_expose_project_resources(self) -> None:
        health = self.store.health()

        self.assertEqual(health["schemaVersion"], SCHEMA_VERSION)
        self.assertTrue(health["capabilities"]["projectResources"])

    def test_schema_v6_is_upgraded_transactionally(self) -> None:
        database_path = Path(self.temp_dir.name, "promptcard.sqlite3")
        connection = sqlite3.connect(database_path)
        try:
            connection.execute("DROP TABLE project_resources")
            connection.execute("DROP TABLE project_resource_folders")
            connection.execute("DELETE FROM schema_migrations WHERE version>=7")
            connection.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (6, 'add-asset-lifecycle', 1)"
            )
            connection.commit()
        finally:
            connection.close()

        migrated = SqliteStore(Path(self.temp_dir.name))

        self.assertEqual(migrated.health()["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(migrated.list_project_resources("project-a"), {"folders": [], "resources": []})

    def test_resources_are_isolated_by_active_project(self) -> None:
        folder = self.store.create_project_resource_folder("project-a", {"id": "folder-a", "name": " Mood "})
        resource = self.create_resource("project-a", folderId=folder["id"])

        snapshot = self.store.list_project_resources("project-a")

        self.assertEqual(snapshot["folders"][0]["name"], "Mood")
        self.assertEqual(snapshot["resources"][0]["id"], resource["id"])
        self.assertEqual(self.store.list_project_resources("project-b"), {"folders": [], "resources": []})
        with self.assertRaises(MissingItem):
            self.store.update_project_resource("project-b", resource["id"], {"name": "Leaked"}, resource["revision"])

    def test_folder_cycle_and_non_empty_delete_are_rejected(self) -> None:
        parent = self.store.create_project_resource_folder("project-a", {"id": "parent", "name": "Parent"})
        child = self.store.create_project_resource_folder(
            "project-a", {"id": "child", "name": "Child", "parentId": parent["id"]}
        )
        resource = self.create_resource("project-a", folderId=child["id"])

        with self.assertRaises(FolderCycle):
            self.store.update_project_resource_folder(
                "project-a", parent["id"], {"parentId": child["id"]}, parent["revision"]
            )
        with self.assertRaises(FolderNotEmpty):
            self.store.delete_project_resource_folder("project-a", child["id"], child["revision"])

        self.store.delete_project_resource("project-a", resource["id"], resource["revision"])
        self.store.delete_project_resource_folder("project-a", child["id"], child["revision"])

    def test_layout_revision_conflict_rolls_back_every_change(self) -> None:
        first = self.store.create_project_resource_folder("project-a", {"id": "first", "name": "First"})
        second = self.store.create_project_resource_folder("project-a", {"id": "second", "name": "Second"})

        with self.assertRaises(RevisionConflict):
            self.store.update_project_resource_layout("project-a", {
                "folders": [
                    {"id": first["id"], "revision": first["revision"], "parentId": None, "sortOrder": 8},
                    {"id": second["id"], "revision": 999, "parentId": None, "sortOrder": 9},
                ],
                "resources": [],
            })

        snapshot = self.store.list_project_resources("project-a")
        self.assertEqual([folder["sortOrder"] for folder in snapshot["folders"]], [0, 1])

    def test_trash_restore_and_hard_delete_follow_project_lifecycle(self) -> None:
        resource = self.create_resource("project-a")
        self.store.trash_projects(["project-a"])

        with self.assertRaises(MissingItem):
            self.store.list_project_resources("project-a")

        self.store.restore_projects(["project-a"])
        self.assertEqual(self.store.list_project_resources("project-a")["resources"][0]["id"], resource["id"])

        self.store.trash_projects(["project-a"])
        self.store.delete_project_trash(["project-a"])
        with self.store._connect() as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM project_resources WHERE project_id='project-a'"
            ).fetchone()[0]
        self.assertEqual(count, 0)
        self.assertIsNotNone(self.store.get_asset(self.asset["id"]))

    def test_resource_assets_are_strong_references(self) -> None:
        self.create_resource("project-a")

        diagnostics = self.store.diagnose_assets()
        references = self.store.get_storage_artifact_references(self.asset["id"])

        self.assertNotIn(self.asset["id"], diagnostics["unreferencedAssets"])
        self.assertIn("project-resource", {reference["kind"] for reference in references})


if __name__ == "__main__":
    unittest.main()
