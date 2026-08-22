from __future__ import annotations

import shutil
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

import promptcard_storage.store as store_module
from promptcard_storage.reference_codes import ReferenceCodeError
from promptcard_storage.store import JsonCollectionStore


TEST_ROOT = (
    Path(__file__).resolve().parents[2]
    / ".test-tmp"
    / "task5-public-references"
)


def project(item_id: str, nodes: list[dict] | None = None) -> dict:
    return {
        "id": item_id,
        "title": f"Project {item_id}",
        "type": "free-canvas",
        "revision": 1,
        "pages": [],
        "currentPage": 0,
        "createdAt": 10,
        "updatedAt": 10,
        "lastOpenedAt": 10,
        "freeCanvas": {"nodes": nodes or [], "edges": [], "selectedNodeId": None},
        "meta": {},
    }


def preset(item_id: str, media: list[dict] | None = None) -> dict:
    return {
        "id": item_id,
        "type": "custom",
        "category": "custom",
        "label": f"Prompt {item_id}",
        "content": "Prompt content",
        "usageCount": 0,
        "revision": 1,
        "createdAt": 10,
        "updatedAt": 10,
        "meta": {"media": media or []},
    }


class PublicReferencesV10Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        shutil.rmtree(TEST_ROOT, ignore_errors=True)
        TEST_ROOT.mkdir(parents=True)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_ROOT, ignore_errors=True)

    def setUp(self) -> None:
        self.data_dir = TEST_ROOT / self._testMethodName / "data"
        self.data_dir.mkdir(parents=True)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def assert_reference_insert_rejected(
        self,
        connection: sqlite3.Connection,
        row: tuple[str | None, str, str, str, int],
    ) -> None:
        count_before = connection.execute(
            "SELECT COUNT(*) FROM public_references"
        ).fetchone()[0]
        connection.execute("SAVEPOINT invalid_public_reference")
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    """INSERT INTO public_references(
                           public_code, namespace, owner_scope, internal_id, created_at
                       ) VALUES (?, ?, ?, ?, ?)""",
                    row,
                )
            self.assertEqual(
                count_before,
                connection.execute(
                    "SELECT COUNT(*) FROM public_references"
                ).fetchone()[0],
            )
        finally:
            connection.execute("ROLLBACK TO invalid_public_reference")
            connection.execute("RELEASE invalid_public_reference")

    def registry_rows(self) -> list[tuple[str, str, str, str]]:
        with self.connect() as connection:
            return connection.execute(
                """SELECT public_code, namespace, owner_scope, internal_id
                   FROM public_references
                   ORDER BY namespace, owner_scope, internal_id"""
            ).fetchall()

    def payload_rows(self) -> list[tuple[str, str, str]]:
        with self.connect() as connection:
            return connection.execute(
                """SELECT 'project', id, payload_json FROM projects
                   UNION ALL
                   SELECT 'preset', id, payload_json FROM presets
                   ORDER BY 1, 2"""
            ).fetchall()

    def downgrade_to_manual_v9(self) -> None:
        with self.connect() as connection:
            connection.execute("DROP TABLE public_references")
            connection.execute("DELETE FROM schema_migrations")
            connection.execute(
                """INSERT INTO schema_migrations(version, name, applied_at)
                   VALUES (9, 'manual-v9-fixture', 10)"""
            )
            connection.commit()

    def test_fresh_schema_is_v10_and_registry_enforces_uniqueness_and_scope(self) -> None:
        store = JsonCollectionStore(self.data_dir)

        self.assertEqual(10, store.health()["schemaVersion"])
        with self.connect() as connection:
            columns = [
                row[1]
                for row in connection.execute("PRAGMA table_info(public_references)")
            ]
            self.assertEqual(
                ["public_code", "namespace", "owner_scope", "internal_id", "created_at"],
                columns,
            )
            connection.execute(
                """INSERT INTO public_references(
                       public_code, namespace, owner_scope, internal_id, created_at
                   ) VALUES ('PRJ-00000000000000000000000001', 'PRJ', '', 'manual-project', 10)"""
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    """INSERT INTO public_references(
                           public_code, namespace, owner_scope, internal_id, created_at
                       ) VALUES ('PRJ-00000000000000000000000001', 'PRJ', '', 'other-project', 10)"""
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    """INSERT INTO public_references(
                           public_code, namespace, owner_scope, internal_id, created_at
                       ) VALUES ('PRJ-00000000000000000000000002', 'PRJ', '', 'manual-project', 10)"""
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    """INSERT INTO public_references(
                           public_code, namespace, owner_scope, internal_id, created_at
                       ) VALUES ('CVT-00000000000000000000000001', 'CVT', '', 'text-node', 10)"""
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    """INSERT INTO public_references(
                           public_code, namespace, owner_scope, internal_id, created_at
                       ) VALUES ('CVM-00000000000000000000000001', 'CVM', '', 'image-node', 10)"""
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    """INSERT INTO public_references(
                           public_code, namespace, owner_scope, internal_id, created_at
                       ) VALUES ('CVT-00000000000000000000000002', 'CVT', '   ', 'text-node', 10)"""
                )

        with self.assertRaisesRegex(ValueError, "owner scope"):
            store.ensure_public_reference("CVT", "text-node")
        with self.assertRaisesRegex(ValueError, "owner scope"):
            store.ensure_public_reference("CVM", "image-node", owner_scope="")

    def test_registry_ddl_rejects_noncanonical_codes_without_partial_rows(self) -> None:
        JsonCollectionStore(self.data_dir)
        invalid_rows = (
            ("null-code-one", (None, "PRJ", "", "null-code-one", 10)),
            ("null-code-two", (None, "PRJ", "", "null-code-two", 10)),
            ("lowercase-body", ("PRJ-0000000000000000000000000a", "PRJ", "", "lowercase", 10)),
            ("prohibited-I", ("PRJ-0000000000000000000000000I", "PRJ", "", "letter-i", 10)),
            ("prohibited-L", ("PRJ-0000000000000000000000000L", "PRJ", "", "letter-l", 10)),
            ("prohibited-O", ("PRJ-0000000000000000000000000O", "PRJ", "", "letter-o", 10)),
            ("prohibited-U", ("PRJ-0000000000000000000000000U", "PRJ", "", "letter-u", 10)),
            ("punctuation", ("PRJ-0000000000000000000000000!", "PRJ", "", "punctuation", 10)),
            ("overflow", ("PRJ-80000000000000000000000000", "PRJ", "", "overflow", 10)),
            ("namespace-mismatch", ("PLP-00000000000000000000000001", "PRJ", "", "mismatch", 10)),
        )
        with self.connect() as connection:
            for label, row in invalid_rows:
                with self.subTest(label=label):
                    self.assert_reference_insert_rejected(connection, row)

    def test_registry_ddl_rejects_noncanonical_identities_and_wrong_scopes(self) -> None:
        JsonCollectionStore(self.data_dir)
        invalid_rows = (
            ("blank-identity", ("PRJ-00000000000000000000000010", "PRJ", "", "", 10)),
            ("whitespace-identity", ("PRJ-00000000000000000000000011", "PRJ", "", "   ", 10)),
            ("padded-identity", ("PRJ-00000000000000000000000012", "PRJ", "", " same-id ", 10)),
            ("padded-scope", ("CVM-00000000000000000000000010", "CVM", " project-a ", "image-node", 10)),
            ("project-global-scope", ("PRJ-00000000000000000000000013", "PRJ", "project-a", "project-a", 10)),
            ("prompt-global-scope", ("PLP-00000000000000000000000010", "PLP", "prompt-a", "prompt-a", 10)),
            ("skill-global-scope", ("SKL-00000000000000000000000010", "SKL", "skill-owner", "skill-a", 10)),
            ("prompt-media-blank-scope", ("PLM-00000000000000000000000010", "PLM", "", "binding-a", 10)),
            ("canvas-text-blank-scope", ("CVT-00000000000000000000000010", "CVT", "", "text-a", 10)),
            ("canvas-media-blank-scope", ("CVM-00000000000000000000000011", "CVM", "", "image-a", 10)),
            ("canvas-context-blank-scope", ("CVC-00000000000000000000000010", "CVC", "", "context-a", 10)),
        )
        with self.connect() as connection:
            for label, row in invalid_rows:
                with self.subTest(label=label):
                    self.assert_reference_insert_rejected(connection, row)

    def test_registry_ddl_rejects_all_ascii_edge_whitespace_without_partial_rows(self) -> None:
        JsonCollectionStore(self.data_dir)
        edge_whitespace = (
            ("space", " "),
            ("tab", "\t"),
            ("lf", "\n"),
            ("vt", "\v"),
            ("ff", "\f"),
            ("cr", "\r"),
        )
        with self.connect() as connection:
            for whitespace_name, character in edge_whitespace:
                invalid_rows = (
                    ("internal-leading", (
                        "PRJ-00000000000000000000000021", "PRJ", "",
                        f"{character}entity", 10,
                    )),
                    ("internal-trailing", (
                        "PRJ-00000000000000000000000022", "PRJ", "",
                        f"entity{character}", 10,
                    )),
                    ("scope-leading", (
                        "PLM-00000000000000000000000021", "PLM",
                        f"{character}prompt", "binding", 10,
                    )),
                    ("scope-trailing", (
                        "PLM-00000000000000000000000022", "PLM",
                        f"prompt{character}", "binding", 10,
                    )),
                    ("scope-only", (
                        "PLM-00000000000000000000000023", "PLM",
                        character, "binding", 10,
                    )),
                )
                for position, row in invalid_rows:
                    with self.subTest(
                        whitespace=whitespace_name,
                        position=position,
                    ):
                        self.assert_reference_insert_rejected(connection, row)

    def test_python_normalizes_identity_and_enforces_namespace_scope_rules(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        first = store.ensure_public_reference("PRJ", " normalized-project ")
        second = store.ensure_public_reference("prj", "normalized-project")
        ascii_trimmed = store.ensure_public_reference(
            "PLM",
            " \t\n\v\f\rbinding \t\n\v\f\r",
            owner_scope=" \t\n\v\f\rprompt \t\n\v\f\r",
        )
        unicode_preserved = store.ensure_public_reference(
            "PLM",
            "\u00a0binding\u00a0",
            owner_scope="\u00a0prompt\u00a0",
        )

        self.assertEqual(first, second)
        with self.connect() as connection:
            self.assertEqual(
                ("PRJ", "", "normalized-project"),
                connection.execute(
                    """SELECT namespace, owner_scope, internal_id
                       FROM public_references WHERE public_code=?""",
                    (first,),
                ).fetchone(),
            )
            self.assertEqual(
                ("prompt", "binding"),
                connection.execute(
                    """SELECT owner_scope, internal_id
                       FROM public_references WHERE public_code=?""",
                    (ascii_trimmed,),
                ).fetchone(),
            )
            self.assertEqual(
                ("\u00a0prompt\u00a0", "\u00a0binding\u00a0"),
                connection.execute(
                    """SELECT owner_scope, internal_id
                       FROM public_references WHERE public_code=?""",
                    (unicode_preserved,),
                ).fetchone(),
            )
        for namespace in ("PRJ", "PLP", "SKL"):
            with self.subTest(namespace=namespace, rule="global"):
                with self.assertRaisesRegex(ValueError, "owner scope"):
                    store.ensure_public_reference(namespace, "entity", owner_scope="wrong-owner")
        for namespace in ("PLM", "CVT", "CVM", "CVC"):
            with self.subTest(namespace=namespace, rule="scoped"):
                with self.assertRaisesRegex(ValueError, "owner scope"):
                    store.ensure_public_reference(namespace, "entity", owner_scope="")

    def test_current_weak_v10_schema_is_hardened_without_replacing_codes(self) -> None:
        JsonCollectionStore(self.data_dir)
        with self.connect() as connection:
            connection.execute("DROP TABLE public_references")
            connection.execute("""
                CREATE TABLE public_references(
                    public_code TEXT PRIMARY KEY COLLATE NOCASE,
                    namespace TEXT NOT NULL,
                    owner_scope TEXT NOT NULL DEFAULT '',
                    internal_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(namespace, owner_scope, internal_id)
                )
            """)
            connection.execute(
                """INSERT INTO public_references(
                       public_code, namespace, owner_scope, internal_id, created_at
                   ) VALUES ('PRJ-00000000000000000000000020', 'PRJ', '', 'preserved-project', 10)"""
            )
            connection.commit()

        JsonCollectionStore(self.data_dir)

        with self.connect() as connection:
            self.assertEqual(
                "PRJ-00000000000000000000000020",
                connection.execute(
                    """SELECT public_code FROM public_references
                       WHERE namespace='PRJ' AND owner_scope='' AND internal_id='preserved-project'"""
                ).fetchone()[0],
            )
            self.assert_reference_insert_rejected(
                connection,
                (None, "PRJ", "", "null-after-reopen", 10),
            )

    def test_current_space_trim_v10_schema_is_hardened_on_reopen(self) -> None:
        JsonCollectionStore(self.data_dir)
        with self.connect() as connection:
            connection.execute("DROP TABLE public_references")
            connection.execute("""
                CREATE TABLE public_references(
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
                    CHECK((internal_id COLLATE BINARY) = trim(internal_id)),
                    CHECK((owner_scope COLLATE BINARY) = trim(owner_scope)),
                    CHECK(
                        (namespace IN ('PRJ','PLP','SKL') AND owner_scope = '')
                        OR
                        (namespace IN ('PLM','CVT','CVM','CVC') AND length(owner_scope) > 0)
                    ),
                    UNIQUE(namespace, owner_scope, internal_id)
                )
            """)
            connection.execute(
                """INSERT INTO public_references(
                       public_code, namespace, owner_scope, internal_id, created_at
                   ) VALUES ('PLM-00000000000000000000000024', 'PLM', 'prompt-a', 'binding-a', 10)"""
            )
            connection.commit()

        JsonCollectionStore(self.data_dir)

        with self.connect() as connection:
            self.assertEqual(
                "PLM-00000000000000000000000024",
                connection.execute(
                    """SELECT public_code FROM public_references
                       WHERE namespace='PLM' AND owner_scope='prompt-a' AND internal_id='binding-a'"""
                ).fetchone()[0],
            )
            self.assert_reference_insert_rejected(
                connection,
                ("PLM-00000000000000000000000025", "PLM", "\t", "binding-b", 10),
            )

    def test_manual_v9_migration_backfills_active_trash_and_business_identities(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("active-project", [
            {"id": "same-node", "kind": "text", "segments": []},
            {"id": "image-a", "kind": "image", "assetId": "shared-asset"},
            {"id": "image-b", "kind": "image", "assetId": "shared-asset"},
        ]))
        store.create_project(project("trash-project", [
            {"id": "same-node", "kind": "text", "segments": []},
            {"id": "image-a", "kind": "image", "assetId": "shared-asset"},
        ]))
        store.trash_projects(["trash-project"])
        store.create_preset(preset("active-prompt", [{
            "id": "binding-active", "kind": "image", "assetId": "shared-asset",
        }]))
        store.create_preset(preset("trash-prompt", [{
            "id": "binding-trash", "kind": "image", "assetId": "shared-asset",
        }]))
        store.trash_presets(["trash-prompt"])
        store.create_skill({
            "id": "SKL-legacy-readable-id",
            "slug": "legacy-readable-id",
            "name": "Legacy Skill",
            "source": "external",
            "instructions": "Keep the legacy identity.",
        })
        payloads_before = self.payload_rows()
        self.downgrade_to_manual_v9()

        migrated = JsonCollectionStore(self.data_dir)

        self.assertEqual(10, migrated.health()["schemaVersion"])
        rows = self.registry_rows()
        identities = {(namespace, scope, internal_id) for _, namespace, scope, internal_id in rows}
        self.assertTrue({
            ("PRJ", "", "active-project"),
            ("PRJ", "", "trash-project"),
            ("PLP", "", "active-prompt"),
            ("PLP", "", "trash-prompt"),
            ("PLM", "active-prompt", "binding-active"),
            ("PLM", "trash-prompt", "binding-trash"),
            ("CVT", "active-project", "same-node"),
            ("CVT", "trash-project", "same-node"),
            ("CVM", "active-project", "image-a"),
            ("CVM", "active-project", "image-b"),
            ("CVM", "trash-project", "image-a"),
            ("SKL", "", "SKL-legacy-readable-id"),
        }.issubset(identities))
        self.assertNotIn(("PLM", "active-prompt", "shared-asset"), identities)
        self.assertEqual(payloads_before, self.payload_rows())

    def test_repeated_configure_and_reconcile_keep_codes_and_payloads_unchanged(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        created = store.create_project(project("stable-project", [
            {"id": "stable-text", "kind": "text", "segments": []},
            {"id": "stable-image", "kind": "image", "assetId": "stable-asset"},
        ]))
        prompt = store.create_preset(preset("stable-prompt", [{
            "id": "stable-binding", "kind": "image", "assetId": "stable-asset",
        }]))
        store.reconcile_public_references()
        rows_before = self.registry_rows()
        payloads_before = self.payload_rows()

        store.update_project(created["id"], {"title": "Renamed"}, created["revision"])
        store.update_preset(prompt["id"], {"label": "Revised"}, prompt["revision"])
        store.trash_projects([created["id"]])
        store.trash_presets([prompt["id"]])
        store.reconcile_public_references()
        JsonCollectionStore(self.data_dir).reconcile_public_references()

        self.assertEqual(rows_before, self.registry_rows())
        changed_payloads = self.payload_rows()
        self.assertNotEqual(payloads_before, changed_payloads)
        JsonCollectionStore(self.data_dir).reconcile_public_references()
        self.assertEqual(changed_payloads, self.payload_rows())

    def test_collision_is_retried_against_registry_codes(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO public_references(
                       public_code, namespace, owner_scope, internal_id, created_at
                   ) VALUES ('PRJ-00000000000000000000000003', 'PRJ', '', 'occupied', 10)"""
            )
            connection.commit()
        candidates = iter([
            "PRJ-00000000000000000000000003",
            "PRJ-00000000000000000000000004",
        ])
        attempts: list[str] = []

        def collision_aware_generator(namespace, *, timestamp_ms, collision_predicate):
            del namespace, timestamp_ms
            for candidate in candidates:
                attempts.append(candidate)
                if not collision_predicate(candidate):
                    return candidate
            raise ReferenceCodeError("reference_code_collision")

        with patch.object(store_module, "generate_reference_code", collision_aware_generator):
            code = store.ensure_public_reference("PRJ", "new-project")

        self.assertEqual("PRJ-00000000000000000000000004", code)
        self.assertEqual(2, len(attempts))

    def test_failed_v10_migration_rolls_back_schema_row_and_partial_registry(self) -> None:
        store = JsonCollectionStore(self.data_dir)
        store.create_project(project("rollback-project"))
        self.downgrade_to_manual_v9()
        calls = 0

        def fail_after_first(namespace, *, timestamp_ms, collision_predicate):
            nonlocal calls
            del namespace, timestamp_ms, collision_predicate
            calls += 1
            if calls == 1:
                return "PRJ-00000000000000000000000005"
            raise RuntimeError("injected migration failure")

        with patch.object(store_module, "generate_reference_code", fail_after_first):
            with self.assertRaisesRegex(RuntimeError, "injected migration failure"):
                JsonCollectionStore(self.data_dir)

        with self.connect() as connection:
            self.assertEqual(
                [(9, "manual-v9-fixture")],
                connection.execute(
                    "SELECT version, name FROM schema_migrations ORDER BY version"
                ).fetchall(),
            )
            self.assertEqual(
                [],
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='public_references'"
                ).fetchall(),
            )


if __name__ == "__main__":
    unittest.main()
