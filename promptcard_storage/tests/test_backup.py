import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from promptcard_storage.maintenance import restore_backup
from promptcard_storage.store import (
    DATABASE_NAME,
    SCHEMA_VERSION,
    JsonCollectionStore,
    MigrationError,
)


TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / ".test-tmp" / "task3-backup"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


class ImageRunBackupTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.assertTrue(Path(self.temp_dir.name).is_relative_to(TEST_TEMP_ROOT))
        self.store = JsonCollectionStore(Path(self.temp_dir.name, "data"))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_backup_contains_schema_v5_run_and_its_output_asset(self) -> None:
        content = b"\x89PNG\r\n\x1a\ngenerated"
        asset = self.store.save_asset("generated.png", "image/png", content)
        run = self.store.create_image_generation_run({
            "id": "run-backup",
            "projectId": "project-deleted",
            "nodeId": "node-deleted",
            "connectionId": "connection-one",
            "providerId": "volcengine-ark",
            "modelId": "doubao-seedream-5-0-pro-260628",
            "state": "queued",
            "requestSnapshot": {"mode": "generate"},
            "outputAssetIds": [],
            "createdAt": 1,
        })
        self.store.update_image_generation_run_state(run["id"], {"state": "running", "startedAt": 2})
        self.store.update_image_generation_run_state(
            run["id"], {"state": "succeeded", "outputAssetIds": [asset["id"]], "finishedAt": 3}
        )
        destination = Path(self.temp_dir.name, "backup")

        manifest = self.store.backup(destination)

        self.assertEqual(manifest["schemaVersion"], 10)
        self.assertEqual((destination / "assets" / asset["id"]).read_bytes(), content)
        connection = sqlite3.connect(destination / "promptcard.sqlite3")
        try:
            row = connection.execute(
                "SELECT state, payload_json FROM image_generation_runs WHERE id='run-backup'"
            ).fetchone()
            version = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(row[0], "succeeded")
        self.assertIn(asset["id"], row[1])
        self.assertEqual(version, 10)

    def test_backup_preserves_original_derived_assets_and_relationship(self) -> None:
        source = self.store.save_asset(
            "source.png", "image/png", b"\x89PNG\r\n\x1a\nsource"
        )
        derived = self.store.save_asset(
            "derived.png", "image/png", b"\x89PNG\r\n\x1a\nderived"
        )
        relationship = self.store.create_image_asset_derivation({
            "sourceAssetId": source["id"],
            "derivedAssetId": derived["id"],
            "kind": "annotation-flattened",
            "transform": {"format": "png"},
            "annotationDocument": {"version": 1, "marks": []},
        })
        destination = Path(self.temp_dir.name, "derivation-backup")

        self.store.backup(destination)

        self.assertTrue((destination / "assets" / source["id"]).is_file())
        self.assertTrue((destination / "assets" / derived["id"]).is_file())
        connection = sqlite3.connect(destination / "promptcard.sqlite3")
        try:
            row = connection.execute(
                """
                SELECT source_asset_id, derived_asset_id, kind
                FROM image_asset_derivations WHERE id=?
                """,
                (relationship["id"],),
            ).fetchone()
        finally:
            connection.close()
        self.assertEqual(row, (source["id"], derived["id"], "annotation-flattened"))


class BackupRestoreValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.root = Path(self.temp_dir.name)
        self.store = JsonCollectionStore(self.root / "data")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def write_manifest(source: Path, version: object) -> None:
        (source / "manifest.json").write_text(
            json.dumps({"schemaVersion": version}), encoding="utf-8"
        )

    @staticmethod
    def latest_version(database: Path) -> int | None:
        connection = sqlite3.connect(database)
        try:
            row = connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()
        finally:
            connection.close()
        return row[0]

    def test_restore_accepts_each_migratable_schema_version_when_manifest_matches_database(self) -> None:
        for version in range(1, SCHEMA_VERSION + 1):
            with self.subTest(version=version):
                source = self.root / f"source-v{version}"
                target = self.root / f"target-v{version}"
                self.store.backup(source)
                connection = sqlite3.connect(source / DATABASE_NAME)
                try:
                    connection.execute(
                        "UPDATE schema_migrations SET version=?, name='legacy-fixture'",
                        (version,),
                    )
                    connection.commit()
                finally:
                    connection.close()
                self.write_manifest(source, version)

                restore_backup(target, source)

                self.assertEqual(
                    self.latest_version(target / DATABASE_NAME), version
                )

    def test_restore_rejects_invalid_or_mismatched_schema_before_touching_target(self) -> None:
        cases: list[tuple[str, object, int | None, bool]] = [
            ("missing-table", 1, None, False),
            ("missing-version", 1, None, True),
            ("manifest-string", "10", 10, True),
            ("manifest-boolean", True, 1, True),
            ("manifest-object", {"version": 10}, 10, True),
            ("manifest-mismatch", 9, 10, True),
            ("future-version", SCHEMA_VERSION + 1, SCHEMA_VERSION + 1, True),
        ]
        for name, manifest_version, database_version, include_table in cases:
            with self.subTest(case=name):
                source = self.root / f"invalid-{name}"
                source.mkdir()
                connection = sqlite3.connect(source / DATABASE_NAME)
                try:
                    if include_table:
                        connection.execute(
                            """CREATE TABLE schema_migrations(
                                   version INTEGER PRIMARY KEY,
                                   name TEXT NOT NULL,
                                   applied_at INTEGER NOT NULL
                               )"""
                        )
                        if database_version is not None:
                            connection.execute(
                                "INSERT INTO schema_migrations VALUES (?, 'fixture', 1)",
                                (database_version,),
                            )
                    connection.commit()
                finally:
                    connection.close()
                self.write_manifest(source, manifest_version)
                target = self.root / f"protected-{name}" / "data"
                target_store = JsonCollectionStore(target)
                target_store.create_project({
                    "id": "must-survive", "title": "Protected", "type": "free-canvas",
                    "pages": [], "currentPage": 0, "meta": {},
                })
                before = (target / DATABASE_NAME).read_bytes()

                with self.assertRaises(MigrationError):
                    restore_backup(target, source)

                self.assertEqual((target / DATABASE_NAME).read_bytes(), before)
                self.assertEqual(
                    JsonCollectionStore(target).get_project("must-survive")["title"],
                    "Protected",
                )

    def test_restore_real_v9_database_then_storage_migrates_it_to_current(self) -> None:
        self.store.create_project({
            "id": "legacy-project", "title": "Legacy", "type": "free-canvas",
            "pages": [], "currentPage": 0, "meta": {},
        })
        source = self.root / "legacy-v9"
        target = self.root / "restored-v9"
        self.store.backup(source)
        connection = sqlite3.connect(source / DATABASE_NAME)
        try:
            connection.execute("DROP TABLE public_references")
            connection.execute(
                "UPDATE schema_migrations SET version=9, name='legacy-v9-fixture'"
            )
            connection.commit()
        finally:
            connection.close()
        self.write_manifest(source, 9)

        restore_backup(target, source)
        restored = JsonCollectionStore(target)

        self.assertEqual(restored.get_project("legacy-project")["title"], "Legacy")
        self.assertEqual(
            self.latest_version(target / DATABASE_NAME), SCHEMA_VERSION
        )


if __name__ == "__main__":
    unittest.main()
