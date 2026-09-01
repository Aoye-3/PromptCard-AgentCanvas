import tempfile
import unittest
from pathlib import Path

from promptcard_storage.store import JsonCollectionStore, RevisionConflict
from promptcard_storage.tests.workspace_paths import workspace_test_root


TEST_ROOT = workspace_test_root("store")


class JsonCollectionStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.store = JsonCollectionStore(
            Path(self.temp_dir.name),
            presets_seed=[
                {
                    "id": "seed-preset",
                    "type": "subject",
                    "category": "scene",
                    "label": "Seed",
                    "content": "Seed content",
                    "usageCount": 0,
                    "meta": {},
                }
            ],
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_project_crud_increments_revision_and_rejects_stale_writes(self) -> None:
        created = self.store.create_project(
            {
                "title": "Three stage",
                "type": "three-stage",
                "pages": [],
                "currentPage": 0,
                "meta": {},
            }
        )
        self.assertEqual(created["revision"], 1)

        updated = self.store.update_project(created["id"], {"title": "Renamed"}, revision=1)
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["title"], "Renamed")

        with self.assertRaises(RevisionConflict):
            self.store.update_project(created["id"], {"title": "Stale"}, revision=1)

    def test_project_trash_restore_and_permanent_delete(self) -> None:
        first = self.store.create_project({"title": "A", "type": "card", "pages": [], "currentPage": 0, "meta": {}})
        second = self.store.create_project({"title": "B", "type": "card", "pages": [], "currentPage": 0, "meta": {}})

        moved = self.store.trash_projects([first["id"], second["id"]], deleted_by="user")
        self.assertEqual({item["id"] for item in moved}, {first["id"], second["id"]})
        self.assertEqual(self.store.list_projects(), [])
        self.assertEqual(len(self.store.list_project_trash()), 2)

        restored = self.store.restore_projects([first["id"]])
        self.assertEqual(restored[0]["id"], first["id"])
        self.assertEqual(len(self.store.list_projects()), 1)

        self.store.delete_project_trash([second["id"]])
        self.assertEqual(self.store.list_project_trash(), [])

    def test_preset_seed_crud_reorder_usage_and_trash(self) -> None:
        seeded = self.store.list_presets()
        self.assertEqual(seeded[0]["id"], "seed-preset")
        self.assertEqual(seeded[0]["revision"], 1)

        created = self.store.create_preset(
            {
                "type": "camera",
                "category": "lens",
                "label": "Wide",
                "content": "Wide shot",
                "meta": {},
            }
        )
        used = self.store.increment_preset_usage(created["id"], created["revision"])
        self.assertEqual(used["usageCount"], 1)
        self.assertEqual(used["revision"], 2)

        reordered = self.store.reorder_presets(
            [used["id"], "seed-preset"],
            {used["id"]: used["revision"], "seed-preset": 1},
        )
        self.assertEqual(reordered[0]["id"], used["id"])

        self.store.trash_presets([used["id"]], deleted_by="agent", delete_reason="test")
        self.assertNotIn(used["id"], {preset["id"] for preset in self.store.list_presets()})
        self.assertEqual(self.store.list_preset_trash()[0]["deletedBy"], "agent")

if __name__ == "__main__":
    unittest.main()
