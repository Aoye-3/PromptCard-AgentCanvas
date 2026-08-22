import errno
import json
import multiprocessing
import os
import shutil
import sqlite3
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from promptcard_storage import maintenance as maintenance_module
from promptcard_storage import store as store_module
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


def _hold_restore_lock(
    data_dir: str,
    ready: object,
    release: object,
) -> None:
    with maintenance_module._restore_target_lock(Path(data_dir)):
        ready.set()
        if not release.wait(15):
            raise TimeoutError("holder release was not signalled")


def _wait_for_restore_lock(
    data_dir: str,
    acquired: object,
) -> None:
    with maintenance_module._restore_target_lock(Path(data_dir)):
        acquired.set()


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

    def test_restore_rejects_noncanonical_v10_tables_and_registry_rows(self) -> None:
        bad_browser_imports = self.root / "bad-browser-imports"
        self.store.backup(bad_browser_imports)
        connection = sqlite3.connect(bad_browser_imports / DATABASE_NAME)
        try:
            connection.execute("DROP TABLE browser_imports")
            connection.execute("CREATE TABLE browser_imports(foo TEXT)")
            connection.commit()
        finally:
            connection.close()
        with self.subTest(case="browser-imports-foo"):
            self.assert_restore_rejected_without_touching_target(
                bad_browser_imports, "browser-imports-foo"
            )

        substring_weak_registry = self.root / "substring-weak-registry"
        self.store.backup(substring_weak_registry)
        connection = sqlite3.connect(substring_weak_registry / DATABASE_NAME)
        try:
            connection.execute("DROP TABLE public_references")
            connection.execute(f"""CREATE TABLE public_references(
                public_code TEXT NOT NULL,
                namespace TEXT NOT NULL,
                owner_scope TEXT NOT NULL,
                internal_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                CHECK(length({store_module._PUBLIC_REFERENCE_EDGE_WHITESPACE_SQL}) > 0)
            )""")
            connection.commit()
        finally:
            connection.close()
        with self.subTest(case="substring-weak-registry"):
            self.assert_restore_rejected_without_touching_target(
                substring_weak_registry, "substring-weak-registry"
            )

        bad_registry_rows = self.root / "bad-registry-rows"
        self.store.backup(bad_registry_rows)
        connection = sqlite3.connect(bad_registry_rows / DATABASE_NAME)
        try:
            connection.execute("PRAGMA ignore_check_constraints=ON")
            connection.executemany(
                """INSERT INTO public_references(
                       public_code, namespace, owner_scope, internal_id, created_at
                   ) VALUES (?, ?, ?, ?, ?)""",
                [
                    ("BAD-00000000000000000000000001", "PRJ", "", "bad-prefix", 1),
                    ("PRJ-00000000000000000000000002", "BAD", "", "bad-kind", 1),
                    ("PRJ-00000000000000000000000003", "PRJ", "scoped", "bad-scope", 1),
                ],
            )
            connection.commit()
        finally:
            connection.close()
        with self.subTest(case="bad-registry-rows"):
            self.assert_restore_rejected_without_touching_target(
                bad_registry_rows, "bad-registry-rows"
            )

    def test_restore_rejects_extra_schema_objects_and_changed_quoted_literal(self) -> None:
        mutations = {
            "extra-view": "CREATE VIEW leaked_projects AS SELECT payload_json FROM projects",
            "extra-trigger": """CREATE TRIGGER mutate_projects AFTER INSERT ON projects
                                BEGIN
                                    UPDATE projects SET revision=revision WHERE id=NEW.id;
                                END""",
        }
        for name, statement in mutations.items():
            source = self.root / name
            self.store.backup(source)
            connection = sqlite3.connect(source / DATABASE_NAME)
            try:
                connection.execute(statement)
                connection.commit()
            finally:
                connection.close()
            with self.subTest(case=name):
                self.assert_restore_rejected_without_touching_target(source, name)

        quoted_literal = self.root / "changed-quoted-literal"
        self.store.backup(quoted_literal)
        connection = sqlite3.connect(quoted_literal / DATABASE_NAME)
        try:
            connection.execute("PRAGMA writable_schema=ON")
            cursor = connection.execute(
                """UPDATE sqlite_master
                   SET sql=replace(sql, '''pending''', '''pen ding''')
                   WHERE type='table' AND name='agent_conversation_proposals'"""
            )
            self.assertEqual(cursor.rowcount, 1)
            connection.execute("PRAGMA writable_schema=OFF")
            connection.commit()
        finally:
            connection.close()
        with self.subTest(case="changed-quoted-literal"):
            self.assert_restore_rejected_without_touching_target(
                quoted_literal, "changed-quoted-literal"
            )

    def test_schema_sql_normalizer_preserves_quotes_and_escaped_quotes(self) -> None:
        normalize = maintenance_module._normalize_schema_sql

        self.assertEqual(
            normalize("CREATE  TABLE  sample (value TEXT CHECK(value = 'pending'))"),
            normalize("create table sample(value text check(value='pending'))"),
        )
        self.assertNotEqual(
            normalize("CHECK(value='it''s pending')"),
            normalize("CHECK(value='it''s pen ding')"),
        )
        self.assertNotEqual(
            normalize('CREATE TABLE "spaced name"(value TEXT)'),
            normalize('CREATE TABLE "spacedname"(value TEXT)'),
        )

    def test_restore_rejects_assets_file_without_touching_target(self) -> None:
        source = self.root / "assets-file"
        self.store.backup(source)
        (source / "assets").write_bytes(b"not-a-directory")

        self.assert_restore_rejected_without_touching_target(source, "assets-file")

    def test_assets_validator_rejects_root_and_nested_reparse_points(self) -> None:
        assets = self.root / "reparse-assets"
        assets.mkdir()
        nested = assets / "ordinary.png"
        nested.write_bytes(ORIGINAL_PNG)
        real_lstat = os.lstat
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

        for name, reparse_path in (("root", assets), ("nested", nested)):
            def fake_lstat(path: object, *, dir_fd: object = None) -> object:
                result = real_lstat(path, dir_fd=dir_fd)
                if Path(path) == reparse_path:
                    return SimpleNamespace(
                        st_mode=result.st_mode,
                        st_file_attributes=reparse_flag,
                    )
                return result

            with self.subTest(case=name), patch.object(
                maintenance_module.os, "lstat", side_effect=fake_lstat
            ):
                with self.assertRaises(MigrationError):
                    maintenance_module._validate_assets_path(assets)

    def test_assets_validator_rejects_nested_symlink_when_supported(self) -> None:
        assets = self.root / "linked-assets"
        assets.mkdir()
        outside = self.root / "outside.png"
        outside.write_bytes(PROTECTED_PNG)
        linked = assets / "linked.png"
        try:
            linked.symlink_to(outside)
        except OSError as exc:
            self.skipTest(f"workspace cannot create symlinks: {exc}")

        with self.assertRaises(MigrationError):
            maintenance_module._validate_assets_path(assets)

    def test_same_target_restores_are_serialized_and_remain_consistent(self) -> None:
        sources: dict[str, Path] = {}
        source_snapshots = {}
        for name, content in (("a", ORIGINAL_PNG), ("b", REPLACEMENT_PNG)):
            store = JsonCollectionStore(self.root / f"source-{name}-data")
            store.create_project({
                "id": f"project-{name}", "title": name.upper(),
                "type": "free-canvas", "pages": [], "currentPage": 0, "meta": {},
            })
            store.save_asset(f"{name}.png", "image/png", content)
            source = self.root / f"source-{name}-backup"
            store.backup(source)
            sources[name] = source
            source_snapshots[name] = self.storage_snapshot(source)

        target = self.root / "serialized-target"
        JsonCollectionStore(target)
        first_at_commit = threading.Event()
        release_first = threading.Event()
        second_at_commit = threading.Event()
        call_guard = threading.Lock()
        commit_calls = 0
        errors: list[BaseException] = []
        real_commit = maintenance_module._commit_staged_restore

        def controlled_commit(*args: object, **kwargs: object) -> None:
            nonlocal commit_calls
            with call_guard:
                commit_calls += 1
                call_number = commit_calls
            if call_number == 1:
                first_at_commit.set()
                if not release_first.wait(15):
                    raise AssertionError("timed out waiting to release first restore")
            else:
                second_at_commit.set()
            real_commit(*args, **kwargs)

        def run_restore(source: Path) -> None:
            try:
                restore_backup(target, source)
            except BaseException as exc:
                errors.append(exc)

        with patch.object(
            maintenance_module, "_commit_staged_restore", side_effect=controlled_commit
        ):
            first = threading.Thread(target=run_restore, args=(sources["a"],))
            second = threading.Thread(target=run_restore, args=(sources["b"],))
            first.start()
            self.assertTrue(first_at_commit.wait(15))
            second.start()
            overlapped = second_at_commit.wait(4)
            release_first.set()
            first.join(20)
            second.join(20)

        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertFalse(overlapped, "second restore entered commit while first was blocked")
        self.assertEqual(errors, [])
        connection = sqlite3.connect(target / DATABASE_NAME)
        try:
            project_ids = tuple(row[0] for row in connection.execute(
                "SELECT id FROM projects WHERE id LIKE 'project-%' ORDER BY id"
            ))
        finally:
            connection.close()
        asset_bytes = tuple(sorted(
            path.read_bytes() for path in (target / "assets").iterdir() if path.is_file()
        ))
        self.assertIn(
            (project_ids, asset_bytes),
            {
                (("project-a",), (ORIGINAL_PNG,)),
                (("project-b",), (REPLACEMENT_PNG,)),
            },
        )
        self.assertTrue((target.parent / f".{target.name}.restore.lock").is_file())
        for name, source in sources.items():
            self.assertEqual(self.storage_snapshot(source), source_snapshots[name])

    def test_restore_lock_is_released_after_validation_failure(self) -> None:
        source = self.root / "lock-release-source"
        self.store.backup(source)
        valid_source = self.root / "lock-release-valid"
        self.store.backup(valid_source)
        self.write_manifest(source, "not-an-integer")
        target = self.root / "lock-release-target"

        with self.assertRaises(MigrationError):
            restore_backup(target, source)

        errors: list[BaseException] = []

        def restore_after_failure() -> None:
            try:
                restore_backup(target, valid_source)
            except BaseException as exc:
                errors.append(exc)

        retry = threading.Thread(target=restore_after_failure)
        retry.start()
        retry.join(20)
        self.assertFalse(retry.is_alive(), "restore lock remained held after failure")
        self.assertEqual(errors, [])
        self.assertTrue((target / DATABASE_NAME).is_file())

    @unittest.skipUnless(os.name == "nt", "Windows file-lock semantics")
    def test_windows_restore_lock_waits_across_processes_until_release(self) -> None:
        context = multiprocessing.get_context("spawn")
        holder_ready = context.Event()
        holder_release = context.Event()
        waiter_acquired = context.Event()
        target = self.root / "cross-process-lock-target"
        holder = context.Process(
            target=_hold_restore_lock,
            args=(str(target), holder_ready, holder_release),
        )
        waiter = context.Process(
            target=_wait_for_restore_lock,
            args=(str(target), waiter_acquired),
        )
        holder.start()
        try:
            self.assertTrue(holder_ready.wait(10))
            waiter.start()
            self.assertFalse(waiter_acquired.wait(0.5))
            self.assertTrue(waiter.is_alive())
            holder_release.set()
            self.assertTrue(waiter_acquired.wait(10))
            holder.join(10)
            waiter.join(10)
        finally:
            holder_release.set()
            for process in (holder, waiter):
                if process.is_alive():
                    process.terminate()
                process.join(5)

        self.assertEqual(holder.exitcode, 0)
        self.assertEqual(waiter.exitcode, 0)

    @unittest.skipUnless(os.name == "nt", "Windows file-lock semantics")
    def test_windows_lock_retries_contention_but_fails_other_io_errors(self) -> None:
        import msvcrt

        target = self.root / "windows-lock-retry"
        target.mkdir()
        lock_path = target / "lock"
        contention_attempts = 0

        def contend_then_acquire(*args: object) -> None:
            nonlocal contention_attempts
            contention_attempts += 1
            if contention_attempts <= 12:
                error = OSError(errno.EACCES, "lock is held")
                error.winerror = 33
                raise error

        with lock_path.open("a+b") as lock_file, patch.object(
            msvcrt, "locking", side_effect=contend_then_acquire
        ), patch.object(maintenance_module.time, "sleep", return_value=None):
            maintenance_module._lock_restore_file(lock_file)
        self.assertEqual(contention_attempts, 13)

        fatal_error = OSError(errno.EIO, "device failure")
        with lock_path.open("a+b") as lock_file, patch.object(
            msvcrt, "locking", side_effect=[fatal_error, AssertionError("retried")]
        ), patch.object(maintenance_module.time, "sleep", return_value=None):
            with self.assertRaisesRegex(MigrationError, "acquiring restore lock"):
                maintenance_module._lock_restore_file(lock_file)

    def test_secondary_database_rollback_failure_uses_copy_fallback(self) -> None:
        case_root = self.root / "rollback-fallback"
        source_store = JsonCollectionStore(case_root / "source-data")
        source_store.create_project({
            "id": "replacement", "title": "Replacement", "type": "free-canvas",
            "pages": [], "currentPage": 0, "meta": {},
        })
        source_store.save_asset("replacement.png", "image/png", REPLACEMENT_PNG)
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

        def fail_install_and_database_rollback(
            source_path: object, target_path: object
        ) -> None:
            nonlocal replace_calls
            if (
                Path(source_path).parent != target
                and Path(target_path).parent != target
            ):
                real_replace(source_path, target_path)
                return
            replace_calls += 1
            if replace_calls in {4, 5}:
                raise OSError(f"injected replace failure {replace_calls}")
            real_replace(source_path, target_path)

        with patch.object(
            maintenance_module.os,
            "replace",
            side_effect=fail_install_and_database_rollback,
        ):
            with self.assertRaisesRegex(MigrationError, "commit failed"):
                restore_backup(target, source)

        self.assertEqual(self.storage_snapshot(target), before)
        self.assert_no_restore_artifacts(target)

    def test_failed_rollback_fallback_reports_disaster_and_keeps_rescue_copy(self) -> None:
        case_root = self.root / "rollback-disaster"
        source_store = JsonCollectionStore(case_root / "source-data")
        source_store.save_asset("replacement.png", "image/png", REPLACEMENT_PNG)
        source = case_root / "source-backup"
        source_store.backup(source)
        source_before = self.storage_snapshot(source)
        target = case_root / "target"
        target_store = JsonCollectionStore(target)
        target_store.create_project({
            "id": "original", "title": "Original", "type": "free-canvas",
            "pages": [], "currentPage": 0, "meta": {},
        })
        target_store.save_asset("original.png", "image/png", ORIGINAL_PNG)
        real_replace = os.replace
        real_copy2 = shutil.copy2
        replace_calls = 0

        def fail_install_and_database_rollback(
            source_path: object, target_path: object
        ) -> None:
            nonlocal replace_calls
            if (
                Path(source_path).parent != target
                and Path(target_path).parent != target
            ):
                real_replace(source_path, target_path)
                return
            replace_calls += 1
            if replace_calls in {4, 5}:
                raise OSError(f"injected replace failure {replace_calls}")
            real_replace(source_path, target_path)

        def fail_database_fallback(
            source_path: object, target_path: object, *args: object, **kwargs: object
        ) -> object:
            source_name = Path(str(source_path)).name
            if ".rollback-" in source_name and DATABASE_NAME in source_name:
                raise OSError("injected database fallback failure")
            return real_copy2(source_path, target_path, *args, **kwargs)

        with patch.object(
            maintenance_module.os,
            "replace",
            side_effect=fail_install_and_database_rollback,
        ), patch.object(
            maintenance_module.shutil,
            "copy2",
            side_effect=fail_database_fallback,
        ):
            with self.assertRaisesRegex(MigrationError, "recovery failed"):
                restore_backup(target, source)

        rollback_databases = list(target.glob(f".{DATABASE_NAME}.rollback-*"))
        self.assertEqual(len(rollback_databases), 1)
        self.assertTrue(rollback_databases[0].is_file())
        self.assertEqual(self.storage_snapshot(source), source_before)

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
                    if (
                        Path(source_path).parent != target
                        and Path(target_path).parent != target
                    ):
                        real_replace(source_path, target_path)
                        return
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
