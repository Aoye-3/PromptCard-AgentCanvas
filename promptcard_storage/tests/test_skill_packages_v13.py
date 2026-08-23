import base64
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

from promptcard_storage.maintenance import restore_backup
from promptcard_storage.store import DuplicateItem, JsonCollectionStore


SKILL_CODE = re.compile(r"^SKL-[0-7][0-9A-HJKMNP-TV-Z]{25}$")


def package_entry(entry_type: str, path: str, content: bytes, content_type: str) -> dict:
    return {
        "type": entry_type,
        "path": path,
        "contentType": content_type,
        "contentBase64": base64.b64encode(content).decode("ascii"),
    }


def external_skill(legacy_id: str, slug: str, entries: list[dict]) -> dict:
    return {
        "id": legacy_id,
        "slug": slug,
        "name": slug.replace("-", " ").title(),
        "description": "Canonical package test fixture",
        "source": "external",
        "trustState": "trusted",
        "instructions": "Legacy compatibility instructions.",
        "entries": entries,
    }


class SkillPackagesV13Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.store = JsonCollectionStore(self.data_dir)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_canonical_digest_is_order_independent_and_covers_type_path_and_exact_bytes(self) -> None:
        entries = [
            package_entry("instruction", "SKILL.md", b"# Exact\n", "text/markdown"),
            package_entry("reference", "references/guide.md", b"guide", "text/markdown"),
        ]
        reordered = self.store.create_skill(external_skill("legacy-order", "order", list(reversed(entries))))
        baseline = self.store.create_skill(external_skill("legacy-base", "base", entries))
        byte_changed = self.store.create_skill(external_skill(
            "legacy-byte", "byte", [entries[0], package_entry("reference", "references/guide.md", b"guidf", "text/markdown")]
        ))
        path_changed = self.store.create_skill(external_skill(
            "legacy-path", "path", [entries[0], package_entry("reference", "references/other.md", b"guide", "text/markdown")]
        ))
        type_changed = self.store.create_skill(external_skill(
            "legacy-type", "type", [entries[0], package_entry("asset", "references/guide.md", b"guide", "text/markdown")]
        ))

        baseline_digest = baseline["revisions"][0]["digest"]
        self.assertEqual(reordered["revisions"][0]["digest"], baseline_digest)
        self.assertNotEqual(byte_changed["revisions"][0]["digest"], baseline_digest)
        self.assertNotEqual(path_changed["revisions"][0]["digest"], baseline_digest)
        self.assertNotEqual(type_changed["revisions"][0]["digest"], baseline_digest)
        self.assertEqual(baseline["revisions"][0]["digestVersion"], "skill-package-v1")

    def test_fresh_v13_schema_contains_canonical_entry_columns_and_immutability_triggers(self) -> None:
        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            self.assertEqual(connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0], 13)
            entry_columns = {
                row[1]: row[2] for row in connection.execute("PRAGMA table_info(skill_package_entries)")
            }
            self.assertEqual(entry_columns["content"].upper(), "BLOB")
            self.assertEqual(entry_columns["canonical_path"].upper(), "TEXT")
            revision_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(skill_revisions)")
            }
            self.assertTrue({
                "digest_version", "legacy_digest", "provenance_json",
                "declared_capabilities_json",
            }.issubset(revision_columns))
            triggers = {
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'skill_%'"
                )
            }
            self.assertEqual(triggers, {
                "skill_revisions_prevent_replace", "skill_revisions_immutable_update",
                "skill_revisions_immutable_delete", "skill_package_entries_prevent_replace",
                "skill_package_entries_immutable_update", "skill_package_entries_immutable_delete",
            })
        finally:
            connection.close()

    def test_paths_are_posix_nfc_and_binary_entries_round_trip_losslessly(self) -> None:
        binary = b"\x00\xff\x80script-never-runs"
        created = self.store.create_skill(external_skill("legacy-binary", "binary", [
            package_entry("instruction", "SKILL.md", b"# Binary\n", "text/markdown"),
            package_entry("script", "scripts\\tool.py", binary, "application/x-python"),
            package_entry("asset", "assets/cafe\u0301.bin", b"asset", "application/octet-stream"),
        ]))

        self.assertIn("entries", created["revisions"][0])
        entries = created["revisions"][0]["entries"]
        self.assertEqual([entry["path"] for entry in entries], ["SKILL.md", "assets/caf\u00e9.bin", "scripts/tool.py"])
        script = entries[2]
        self.assertEqual(base64.b64decode(script["contentBase64"], validate=True), binary)
        self.assertEqual(script["size"], len(binary))
        self.assertRegex(script["digest"], r"^sha256:[0-9a-f]{64}$")

    def test_normalized_path_collision_rolls_back_skill_registry_and_entries(self) -> None:
        payload = external_skill("legacy-collision", "collision", [
            package_entry("instruction", "SKILL.md", b"# Collision", "text/markdown"),
            package_entry("asset", "assets/caf\u00e9.bin", b"one", "application/octet-stream"),
            package_entry("asset", "assets/cafe\u0301.bin", b"two", "application/octet-stream"),
        ])

        with self.assertRaisesRegex(ValueError, "canonical path"):
            self.store.create_skill(payload)

        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            self.assertIsNone(connection.execute("SELECT 1 FROM skills WHERE id='legacy-collision'").fetchone())
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM skill_package_entries").fetchone()[0], 4)
        finally:
            connection.close()

    def test_public_skill_identity_is_stable_across_revisions_archive_and_legacy_reads(self) -> None:
        created = self.store.create_skill(external_skill("legacy-readable", "readable", [
            package_entry("instruction", "SKILL.md", b"# One", "text/markdown"),
        ]))
        self.assertIn("referenceCode", created)
        skill_code = created["referenceCode"]
        self.assertRegex(skill_code, SKILL_CODE)
        self.assertEqual(created["id"], "legacy-readable")
        self.assertNotEqual(created["id"], skill_code)

        revised = self.store.add_skill_revision("legacy-readable", {
            "instructions": "Legacy fallback revision.",
            "entries": [package_entry("instruction", "SKILL.md", b"# Two", "text/markdown")],
        })
        self.assertEqual(revised["referenceCode"], skill_code)
        self.assertEqual(self.store.get_skill(skill_code), self.store.get_skill("legacy-readable"))
        self.assertEqual(self.store.get_skill("readable"), revised)
        summary = next(
            skill for skill in self.store.list_skills()["skills"]
            if skill["referenceCode"] == skill_code
        )
        self.assertEqual(summary["id"], "legacy-readable")
        self.assertNotIn("entries", summary)

        self.assertTrue(hasattr(self.store, "archive_skill"))
        archived = self.store.archive_skill(skill_code)
        self.assertEqual(archived["lifecycleStatus"], "archived")
        self.assertEqual(archived["referenceCode"], skill_code)
        restored = self.store.restore_skill("legacy-readable")
        self.assertEqual(restored["lifecycleStatus"], "active")
        self.assertEqual(restored["revisions"], revised["revisions"])

    def test_legacy_identity_and_slug_cross_collisions_roll_back_registry_atomically(self) -> None:
        first = self.store.create_skill(external_skill("legacy-first", "shared-name", [
            package_entry("instruction", "SKILL.md", b"# First", "text/markdown"),
        ]))
        with self.assertRaises(DuplicateItem):
            self.store.create_skill(external_skill("shared-name", "second-name", [
                package_entry("instruction", "SKILL.md", b"# Second", "text/markdown"),
            ]))
        with self.assertRaises(DuplicateItem):
            self.store.create_skill(external_skill("legacy-third", "legacy-first", [
                package_entry("instruction", "SKILL.md", b"# Third", "text/markdown"),
            ]))

        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM skills").fetchone()[0], 3)
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM public_references WHERE namespace='SKL'"
            ).fetchone()[0], 3)
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM skill_package_entries WHERE skill_id='legacy-first'"
            ).fetchone()[0], 1)
        finally:
            connection.close()
        self.assertEqual(self.store.get_skill(first["referenceCode"]), first)

    def test_provenance_and_declared_capabilities_are_closed_normalized_and_do_not_grant_hosts(self) -> None:
        created = self.store.create_skill({
            **external_skill("legacy-policy", "policy", [
                package_entry("instruction", "SKILL.md", b"# Policy", "text/markdown"),
            ]),
            "provenance": {"originLabel": "reviewed import"},
            "declaredCapabilities": {
                "tools": ["search_prompt_library", "search_prompt_library"],
                "network": ["example.invalid"],
                "executables": ["python"],
                "models": ["vision"],
                "other": ["large-context"],
            },
        })

        revision = created["revisions"][0]
        self.assertIn("provenance", revision)
        self.assertEqual(revision["provenance"], {"source": "external", "originLabel": "reviewed import"})
        self.assertEqual(revision["declaredCapabilities"]["tools"], ["search_prompt_library"])
        self.assertNotIn("hostPins", created)
        self.assertNotIn("permissions", created)

        invalid_provenance = external_skill("legacy-secret", "secret", [
            package_entry("instruction", "SKILL.md", b"# Secret", "text/markdown"),
        ])
        invalid_provenance["provenance"] = {"originLabel": "F:\\private\\token.txt"}
        with self.assertRaises(ValueError):
            self.store.create_skill(invalid_provenance)

        invalid_capability = external_skill("legacy-capability", "capability", [
            package_entry("instruction", "SKILL.md", b"# Capability", "text/markdown"),
        ])
        invalid_capability["declaredCapabilities"] = {"tools": [], "hostPins": ["codex"]}
        with self.assertRaises(ValueError):
            self.store.create_skill(invalid_capability)

    def test_invalid_relative_paths_and_noncanonical_base64_are_rejected_atomically(self) -> None:
        invalid_paths = ["", "/SKILL.md", "C:\\SKILL.md", "./SKILL.md", "../SKILL.md", "a//b", "a/../b", "a\x00b"]
        for index, path in enumerate(invalid_paths):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.store.create_skill(external_skill(
                    f"legacy-invalid-{index}", f"invalid-{index}",
                    [package_entry("instruction", path, b"content", "text/markdown")],
                ))
        invalid_base64 = external_skill("legacy-base64", "invalid-base64", [
            package_entry("instruction", "SKILL.md", b"content", "text/markdown"),
        ])
        invalid_base64["entries"][0]["contentBase64"] = "YQ==\n"
        with self.assertRaises(ValueError):
            self.store.create_skill(invalid_base64)

        self.assertNotIn("invalid", " ".join(skill["slug"] for skill in self.store.list_skills()["skills"]))

    def test_revision_and_entry_sql_bypass_matrix_is_rejected_even_with_recursive_triggers_off(self) -> None:
        created = self.store.create_skill(external_skill("legacy-sql", "sql", [
            package_entry("instruction", "SKILL.md", b"# Immutable", "text/markdown"),
            package_entry("asset", "assets/blob.bin", b"blob", "application/octet-stream"),
        ]))
        database = self.data_dir / "promptcard.sqlite3"
        attacks = [
            ("UPDATE skill_revisions SET digest='sha256:evil' WHERE skill_id='legacy-sql'", ()),
            ("DELETE FROM skill_revisions WHERE skill_id='legacy-sql'", ()),
            (
                """INSERT OR REPLACE INTO skill_revisions(
                       skill_id, revision, digest, instructions, references_json, created_at,
                       digest_version, legacy_digest, provenance_json, declared_capabilities_json
                   ) SELECT skill_id, revision, 'sha256:evil', instructions, references_json,
                            created_at, digest_version, legacy_digest, provenance_json,
                            declared_capabilities_json
                     FROM skill_revisions WHERE skill_id='legacy-sql' AND revision=1""",
                (),
            ),
            ("UPDATE skill_package_entries SET content=X'00' WHERE skill_id='legacy-sql'", ()),
            ("DELETE FROM skill_package_entries WHERE skill_id='legacy-sql'", ()),
            (
                """INSERT OR REPLACE INTO skill_package_entries(
                       skill_id, revision, canonical_index, entry_type, canonical_path,
                       content_type, size, entry_digest, content
                   ) SELECT skill_id, revision, canonical_index, entry_type, canonical_path,
                            content_type, size, entry_digest, content
                     FROM skill_package_entries
                    WHERE skill_id='legacy-sql' AND canonical_index=0""",
                (),
            ),
        ]
        for statement, parameters in attacks:
            connection = sqlite3.connect(database)
            try:
                connection.execute("PRAGMA recursive_triggers=OFF")
                with self.subTest(statement=statement), self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                    connection.execute(statement, parameters)
                    connection.commit()
            finally:
                connection.close()
        self.assertEqual(self.store.get_skill("legacy-sql"), created)

    def test_v12_skill_slice_migrates_deterministically_and_preserves_legacy_digests(self) -> None:
        legacy = self.store.create_skill({
            "id": "legacy-v12", "slug": "legacy-v12", "name": "Legacy V12",
            "source": "external", "instructions": "Legacy instructions",
            "references": [{"name": "guide", "content": "Reference"}],
        })
        database = self.data_dir / "promptcard.sqlite3"
        connection = sqlite3.connect(database)
        try:
            connection.execute("PRAGMA foreign_keys=OFF")
            for trigger in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'skill_%'"
            ).fetchall():
                connection.execute(f"DROP TRIGGER {trigger[0]}")
            connection.execute("DROP TABLE skill_package_entries")
            connection.execute("ALTER TABLE skill_revisions RENAME TO skill_revisions_v13")
            connection.execute("""CREATE TABLE skill_revisions(
                skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL, digest TEXT NOT NULL, instructions TEXT NOT NULL,
                references_json TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY(skill_id, revision), UNIQUE(skill_id, digest)
            )""")
            connection.execute("""INSERT INTO skill_revisions
                SELECT skill_id, revision, COALESCE(legacy_digest, digest), instructions,
                       references_json, created_at FROM skill_revisions_v13""")
            connection.execute("DROP TABLE skill_revisions_v13")
            connection.execute("ALTER TABLE skills RENAME TO skills_v13")
            connection.execute("""CREATE TABLE skills(
                id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                description TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('builtin','external')),
                trust_state TEXT NOT NULL CHECK(trust_state IN ('first-party','trusted','untrusted')),
                capability_id TEXT, tool_dependencies_json TEXT NOT NULL,
                current_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            )""")
            connection.execute("""INSERT INTO skills
                SELECT id, slug, name, description, source, trust_state, capability_id,
                       tool_dependencies_json, current_revision, created_at, updated_at FROM skills_v13""")
            connection.execute("DROP TABLE skills_v13")
            connection.execute("DELETE FROM schema_migrations")
            connection.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (12, 'legacy-v12', 1)"
            )
            connection.commit()
        finally:
            connection.close()

        migrated = JsonCollectionStore(self.data_dir).get_skill("legacy-v12")
        revision = migrated["revisions"][0]
        self.assertEqual(revision["legacyDigest"], legacy["revisions"][0]["legacyDigest"] or legacy["revisions"][0]["digest"])
        self.assertEqual(revision["digestVersion"], "skill-package-v1")
        self.assertIn("legacyMetadata", revision["provenance"])
        self.assertEqual(revision["provenance"]["legacyMetadata"], {
            "revision": 1,
            "digest": revision["legacyDigest"],
        })
        self.assertEqual([entry["path"] for entry in revision["entries"]], ["SKILL.md", "references/reference-0001.json"])
        self.assertEqual(JsonCollectionStore(self.data_dir).get_skill("legacy-v12"), migrated)
        self.assertTrue(all(skill["referenceCode"].startswith("SKL-") for skill in JsonCollectionStore(self.data_dir).list_skills()["skills"]))
        connection = sqlite3.connect(database)
        try:
            raw_entries = connection.execute(
                """SELECT canonical_path, typeof(content), content
                   FROM skill_package_entries WHERE skill_id='legacy-v12'
                   ORDER BY canonical_index"""
            ).fetchall()
            self.assertEqual(raw_entries[0], ("SKILL.md", "blob", b"Legacy instructions"))
            self.assertEqual(raw_entries[1][0:2], ("references/reference-0001.json", "blob"))
            triggers = {
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'skill_%'"
                )
            }
            self.assertIn("skill_revisions_prevent_replace", triggers)
            self.assertIn("skill_package_entries_prevent_replace", triggers)
            connection.execute("PRAGMA recursive_triggers=OFF")
            with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                connection.execute(
                    "UPDATE skill_revisions SET provenance_json='{}' WHERE skill_id='legacy-v12'"
                )
        finally:
            connection.close()

    def test_real_backup_restore_preserves_binary_package_and_public_identity(self) -> None:
        created = self.store.create_skill(external_skill("legacy-backup", "backup", [
            package_entry("instruction", "SKILL.md", b"# Backup", "text/markdown"),
            package_entry("asset", "assets/raw.bin", b"\x00\xffbackup", "application/octet-stream"),
        ]))
        backup = self.data_dir.parent / "skill-backup"
        target = self.data_dir.parent / "skill-restored"
        self.store.backup(backup)

        restore_backup(target, backup)
        restored = JsonCollectionStore(target).get_skill(created["referenceCode"])

        self.assertEqual(restored, created)
        self.assertEqual(
            base64.b64decode(restored["revisions"][0]["entries"][1]["contentBase64"], validate=True),
            b"\x00\xffbackup",
        )
        connection = sqlite3.connect(target / "promptcard.sqlite3")
        try:
            self.assertEqual(
                connection.execute(
                    """SELECT content FROM skill_package_entries
                       WHERE skill_id='legacy-backup' AND canonical_path='assets/raw.bin'"""
                ).fetchone()[0],
                b"\x00\xffbackup",
            )
            self.assertIsNotNone(connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='skill_package_entries_prevent_replace'"
            ).fetchone())
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
