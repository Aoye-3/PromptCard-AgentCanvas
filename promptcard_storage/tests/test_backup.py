import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from promptcard_storage import maintenance as maintenance_module
from promptcard_storage.maintenance import restore_backup
from promptcard_storage.store import (
    DATABASE_NAME,
    SCHEMA_VERSION,
    JsonCollectionStore,
    MigrationError,
)


TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / ".test-tmp" / "task3-backup"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
PROTECTED_PNG = b"\x89PNG\r\n\x1a\nprotected-bytes"
ORIGINAL_PNG = b"\x89PNG\r\n\x1a\noriginal-bytes"
REPLACEMENT_PNG = b"\x89PNG\r\n\x1a\nreplacement-bytes"


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

    @staticmethod
    def storage_snapshot(data_dir: Path) -> tuple[tuple[str, ...], dict[str, bytes]]:
        connection = sqlite3.connect(data_dir / DATABASE_NAME)
        try:
            database = tuple(connection.iterdump())
        finally:
            connection.close()
        assets_dir = data_dir / "assets"
        assets = {
            str(path.relative_to(assets_dir)): path.read_bytes()
            for path in assets_dir.rglob("*")
            if path.is_file()
        } if assets_dir.exists() else {}
        return database, assets

    def assert_no_restore_artifacts(self, data_dir: Path) -> None:
        sibling_prefix = f".{data_dir.name}.restore-"
        sibling_leftovers = [
            path.name for path in data_dir.parent.iterdir()
            if path.name.startswith(sibling_prefix)
        ]
        local_leftovers = [
            path.name for path in data_dir.iterdir()
            if ".rollback-" in path.name or ".restore-" in path.name
        ] if data_dir.exists() else []
        self.assertEqual(sibling_leftovers + local_leftovers, [])

    def assert_restore_rejected_without_touching_target(
        self, source: Path, name: str
    ) -> None:
        target = self.root / f"protected-{name}" / "data"
        target_store = JsonCollectionStore(target)
        target_store.create_project({
            "id": "must-survive", "title": "Protected", "type": "free-canvas",
            "pages": [], "currentPage": 0, "meta": {},
        })
        target_store.save_asset("protected.png", "image/png", PROTECTED_PNG)
        before = self.storage_snapshot(target)

        with self.assertRaises(MigrationError):
            restore_backup(target, source)

        self.assertEqual(self.storage_snapshot(target), before)
        self.assert_no_restore_artifacts(target)

    def test_restore_real_v5_asset_schema_is_migrated_in_staging_before_commit(self) -> None:
        asset = self.store.save_asset(
            "legacy-v5.png", "image/png", b"\x89PNG\r\n\x1a\nlegacy-v5"
        )
        source = self.root / "legacy-v5"
        target = self.root / "restored-v5"
        self.store.backup(source)
        connection = sqlite3.connect(source / DATABASE_NAME)
        try:
            connection.execute("PRAGMA foreign_keys=OFF")
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
                """INSERT INTO assets(
                       asset_id, original_filename, relative_path, content_type, size, created_at
                   ) SELECT asset_id, original_filename, relative_path, content_type, size, created_at
                     FROM assets_v6"""
            )
            connection.execute("DROP TABLE assets_v6")
            connection.execute("DROP TABLE public_references")
            connection.execute("DELETE FROM schema_migrations")
            connection.execute(
                "INSERT INTO schema_migrations VALUES (5, 'add-image-asset-derivations', 1)"
            )
            connection.commit()
        finally:
            connection.close()
        self.write_manifest(source, 5)

        restore_backup(target, source)

        self.assertEqual(self.latest_version(target / DATABASE_NAME), SCHEMA_VERSION)
        restored = JsonCollectionStore(target)
        self.assertEqual(
            restored.get_asset(asset["id"])[0].read_bytes(),
            b"\x89PNG\r\n\x1a\nlegacy-v5",
        )
        self.assert_no_restore_artifacts(target)

    def test_restore_rejects_invalid_or_mismatched_schema_before_touching_target(self) -> None:
        cases: list[tuple[str, object, int | None, bool]] = [
            ("missing-table", 1, None, False),
            ("missing-version", 1, None, True),
            ("manifest-string", "10", 10, True),
            ("manifest-boolean", True, 1, True),
            ("manifest-float", 10.0, 10, True),
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

    def test_restore_rejects_corrupt_history_fake_v10_and_weak_registry(self) -> None:
        for name in ("missing-chain", "duplicate", "non-integer"):
            source = self.root / f"invalid-history-{name}"
            source.mkdir()
            connection = sqlite3.connect(source / DATABASE_NAME)
            try:
                connection.execute(
                    "CREATE TABLE schema_migrations(version, name, applied_at)"
                )
                rows = {
                    "missing-chain": [(8, "v8", 1), (10, "v10", 2)],
                    "duplicate": [(10, "v10-a", 1), (10, "v10-b", 2)],
                    "non-integer": [(8, "v8", 1), (9.5, "bad", 2), (10, "v10", 3)],
                }[name]
                connection.executemany(
                    "INSERT INTO schema_migrations VALUES (?, ?, ?)", rows
                )
                connection.commit()
            finally:
                connection.close()
            self.write_manifest(source, 10)
            with self.subTest(case=name):
                self.assert_restore_rejected_without_touching_target(source, name)

        fake_v10 = self.root / "fake-v10"
        fake_v10.mkdir()
        connection = sqlite3.connect(fake_v10 / DATABASE_NAME)
        try:
            connection.execute(
                """CREATE TABLE schema_migrations(
                       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
                   )"""
            )
            connection.execute(
                "INSERT INTO schema_migrations VALUES (10, 'json-v1-to-sqlite', 1)"
            )
            connection.commit()
        finally:
            connection.close()
        self.write_manifest(fake_v10, 10)
        with self.subTest(case="fake-v10"):
            self.assert_restore_rejected_without_touching_target(fake_v10, "fake-v10")

        weak_v10 = self.root / "weak-v10"
        self.store.backup(weak_v10)
        connection = sqlite3.connect(weak_v10 / DATABASE_NAME)
        try:
            connection.execute("DROP TABLE public_references")
            connection.execute(
                """CREATE TABLE public_references(
                       public_code TEXT PRIMARY KEY,
                       namespace TEXT NOT NULL,
                       owner_scope TEXT NOT NULL,
                       internal_id TEXT NOT NULL,
                       created_at INTEGER NOT NULL
                   )"""
            )
            connection.commit()
        finally:
            connection.close()
        with self.subTest(case="weak-v10"):
            self.assert_restore_rejected_without_touching_target(weak_v10, "weak-v10")

    def test_restore_commit_failures_roll_back_database_and_assets_without_artifacts(self) -> None:
        for fail_at in range(1, 5):
            with self.subTest(replace_call=fail_at):
                case_root = self.root / f"atomic-{fail_at}"
                source_store = JsonCollectionStore(case_root / "source-data")
                source_store.create_project({
                    "id": "replacement", "title": "Replacement", "type": "free-canvas",
                    "pages": [], "currentPage": 0, "meta": {},
                })
                source_store.save_asset(
                    "replacement.png", "image/png", REPLACEMENT_PNG
                )
                source = case_root / "source-backup"
                source_store.backup(source)

                target = case_root / "target"
                target_store = JsonCollectionStore(target)
                target_store.create_project({
                    "id": "original", "title": "Original", "type": "free-canvas",
                    "pages": [], "currentPage": 0, "meta": {},
                })
                target_store.save_asset("original.png", "image/png", ORIGINAL_PNG)
                before = self.storage_snapshot(target)

                real_replace = os.replace
                replace_calls = 0

                def fail_one_replace(source_path: object, target_path: object) -> None:
                    nonlocal replace_calls
                    replace_calls += 1
                    if replace_calls == fail_at:
                        raise OSError(f"injected replace failure {fail_at}")
                    real_replace(source_path, target_path)

                with patch.object(
                    maintenance_module.os, "replace", side_effect=fail_one_replace
                ):
                    with self.assertRaises(MigrationError):
                        restore_backup(target, source)

                self.assertEqual(self.storage_snapshot(target), before)
                self.assert_no_restore_artifacts(target)

    def test_restore_assets_successfully_replace_or_preserve_as_source_requires(self) -> None:
        replacement_store = JsonCollectionStore(self.root / "replacement-data")
        replacement_asset = replacement_store.save_asset(
            "replacement.png", "image/png", REPLACEMENT_PNG
        )
        replacement_source = self.root / "replacement-backup"
        replacement_store.backup(replacement_source)
        replacement_target = self.root / "replacement-target"
        replacement_target_store = JsonCollectionStore(replacement_target)
        original_asset = replacement_target_store.save_asset(
            "original.png", "image/png", ORIGINAL_PNG
        )

        restore_backup(replacement_target, replacement_source)

        self.assertFalse((replacement_target / "assets" / original_asset["id"]).exists())
        self.assertEqual(
            (replacement_target / "assets" / replacement_asset["id"]).read_bytes(),
            REPLACEMENT_PNG,
        )
        self.assert_no_restore_artifacts(replacement_target)

        no_assets_store = JsonCollectionStore(self.root / "no-assets-data")
        no_assets_source = self.root / "no-assets-backup"
        no_assets_store.backup(no_assets_source)
        preserved_target = self.root / "preserved-target"
        preserved_store = JsonCollectionStore(preserved_target)
        preserved_asset = preserved_store.save_asset(
            "preserved.png", "image/png", PROTECTED_PNG
        )

        restore_backup(preserved_target, no_assets_source)

        self.assertEqual(
            (preserved_target / "assets" / preserved_asset["id"]).read_bytes(),
            PROTECTED_PNG,
        )
        self.assert_no_restore_artifacts(preserved_target)

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

        self.assertEqual(self.latest_version(target / DATABASE_NAME), SCHEMA_VERSION)
        restored = JsonCollectionStore(target)
        self.assertEqual(restored.get_project("legacy-project")["title"], "Legacy")
        self.assertEqual(
            self.latest_version(target / DATABASE_NAME), SCHEMA_VERSION
        )


if __name__ == "__main__":
    unittest.main()
