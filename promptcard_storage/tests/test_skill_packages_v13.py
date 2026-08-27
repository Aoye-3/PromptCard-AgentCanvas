import base64
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from promptcard_storage.maintenance import restore_backup
from promptcard_storage.migration import MigrationError
from promptcard_storage.reference_codes import (
    ReferenceCodeError,
    ReferenceNamespace,
    generate_reference_code,
)
from promptcard_storage.store import SCHEMA_VERSION, DuplicateItem, JsonCollectionStore


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


def downgrade_skill_schema_to_v12(database: Path) -> None:
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("DROP TABLE IF EXISTS skill_revision_reviews")
        connection.execute("DROP TABLE IF EXISTS skill_host_pins")
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
            self.assertEqual(
                connection.execute(
                    "SELECT MAX(version) FROM schema_migrations"
                ).fetchone()[0],
                SCHEMA_VERSION,
            )
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
                "skill_host_pins_digest_insert", "skill_host_pins_digest_update",
                "skill_revision_reviews_digest_insert", "skill_revision_reviews_digest_update",
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

    def test_skill_identifiers_share_case_insensitive_space_with_public_codes(self) -> None:
        first = self.store.create_skill(external_skill("legacy-alpha", "alpha", [
            package_entry("instruction", "SKILL.md", b"# Alpha", "text/markdown"),
        ]))
        public_code = first["referenceCode"]
        before = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            counts = (
                before.execute("SELECT COUNT(*) FROM skills").fetchone()[0],
                before.execute("SELECT COUNT(*) FROM skill_revisions").fetchone()[0],
                before.execute("SELECT COUNT(*) FROM skill_package_entries").fetchone()[0],
                before.execute("SELECT COUNT(*) FROM public_references WHERE namespace='SKL'").fetchone()[0],
            )
        finally:
            before.close()

        collisions = [
            (public_code.lower(), "second-slug"),
            ("second-id", public_code.lower()),
            ("same-token", "SAME-TOKEN"),
        ]
        for legacy_id, slug in collisions:
            with self.subTest(legacy_id=legacy_id, slug=slug), self.assertRaises(DuplicateItem):
                self.store.create_skill(external_skill(legacy_id, slug, [
                    package_entry("instruction", "SKILL.md", b"# Collision", "text/markdown"),
                ]))

        after = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            self.assertEqual((
                after.execute("SELECT COUNT(*) FROM skills").fetchone()[0],
                after.execute("SELECT COUNT(*) FROM skill_revisions").fetchone()[0],
                after.execute("SELECT COUNT(*) FROM skill_package_entries").fetchone()[0],
                after.execute("SELECT COUNT(*) FROM public_references WHERE namespace='SKL'").fetchone()[0],
            ), counts)
        finally:
            after.close()

        created = self.store.create_skill(external_skill("legacy-beta", "beta", [
            package_entry("instruction", "SKILL.md", b"# Beta", "text/markdown"),
        ]))
        self.assertEqual(created["id"], "legacy-beta")
        self.assertNotEqual(created["referenceCode"], public_code)
        self.assertEqual(self.store.get_skill("LEGACY-BETA"), created)
        self.assertEqual(self.store.get_skill("BETA"), created)

    def test_skill_public_code_generation_skips_case_insensitive_legacy_id_and_slug(self) -> None:
        timestamp = 1_700_000_000_000
        entropies = [bytes([value]) * 10 for value in (1, 2, 3)]
        candidates = [
            generate_reference_code(
                ReferenceNamespace.SKILL,
                timestamp_ms=timestamp,
                entropy_source=lambda entropy=entropy: entropy,
            )
            for entropy in entropies
        ]
        self.store.create_skill(external_skill(candidates[0].lower(), candidates[1].lower(), [
            package_entry("instruction", "SKILL.md", b"# Reserved", "text/markdown"),
        ]))

        with patch("promptcard_storage.store.now_ms", return_value=timestamp), patch(
            "promptcard_storage.reference_codes.token_bytes", side_effect=entropies
        ):
            created = self.store.create_skill(external_skill("legacy-generated", "generated", [
                package_entry("instruction", "SKILL.md", b"# Generated", "text/markdown"),
            ]))

        self.assertEqual(created["id"], "legacy-generated")
        self.assertEqual(created["referenceCode"], candidates[2])

    def test_skill_public_code_generation_exhaustion_rolls_back_all_rows(self) -> None:
        timestamp = 1_700_000_000_000
        entropy = b"\x04" * 10
        candidate = generate_reference_code(
            ReferenceNamespace.SKILL,
            timestamp_ms=timestamp,
            entropy_source=lambda: entropy,
        )
        self.store.create_skill(external_skill(candidate.lower(), "reserved-generator", [
            package_entry("instruction", "SKILL.md", b"# Reserved", "text/markdown"),
        ]))
        database = self.data_dir / "promptcard.sqlite3"
        connection = sqlite3.connect(database)
        try:
            before = {
                table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("skills", "skill_revisions", "skill_package_entries", "public_references")
            }
        finally:
            connection.close()

        with patch("promptcard_storage.store.now_ms", return_value=timestamp), patch(
            "promptcard_storage.reference_codes.token_bytes", return_value=entropy
        ), self.assertRaisesRegex(ReferenceCodeError, "reference_code_collision"):
            self.store.create_skill(external_skill("legacy-exhausted", "exhausted", [
                package_entry("instruction", "SKILL.md", b"# Exhausted", "text/markdown"),
            ]))

        connection = sqlite3.connect(database)
        try:
            self.assertEqual({
                table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("skills", "skill_revisions", "skill_package_entries", "public_references")
            }, before)
        finally:
            connection.close()

    def test_skill_resolver_fails_closed_when_raw_rows_match_multiple_skills(self) -> None:
        first = self.store.create_skill(external_skill("legacy-resolve-a", "resolve-a", [
            package_entry("instruction", "SKILL.md", b"# A", "text/markdown"),
        ]))
        self.store.create_skill(external_skill("legacy-resolve-b", "resolve-b", [
            package_entry("instruction", "SKILL.md", b"# B", "text/markdown"),
        ]))
        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            connection.execute(
                "UPDATE skills SET slug=? WHERE id='legacy-resolve-b'",
                (first["referenceCode"].lower(),),
            )
            connection.commit()
        finally:
            connection.close()

        with self.assertRaisesRegex(MigrationError, "ambiguous"):
            self.store.get_skill(first["referenceCode"])

    def test_v13_same_owner_legacy_id_and_slug_reopen_without_package_mutation(self) -> None:
        data_dir = self.data_dir / "same-owner-v13"
        store = JsonCollectionStore(data_dir)
        created = store.create_skill(external_skill("legacy-same-owner", "same-owner", [
            package_entry("instruction", "SKILL.md", b"# Same owner", "text/markdown"),
            package_entry("asset", "assets/raw.bin", b"\x00\xffsame-owner", "application/octet-stream"),
        ]))
        database = data_dir / "promptcard.sqlite3"
        connection = sqlite3.connect(database)
        try:
            connection.execute(
                "UPDATE skills SET slug=id WHERE id='legacy-same-owner'"
            )
            connection.commit()
            raw_before = connection.execute(
                """SELECT revision.digest, entry.canonical_index, entry.canonical_path,
                          entry.entry_digest, typeof(entry.content), entry.content
                     FROM skill_revisions AS revision
                     JOIN skill_package_entries AS entry
                       ON entry.skill_id=revision.skill_id
                      AND entry.revision=revision.revision
                    WHERE revision.skill_id='legacy-same-owner'
                    ORDER BY revision.revision, entry.canonical_index"""
            ).fetchall()
        finally:
            connection.close()

        try:
            reopened = JsonCollectionStore(data_dir)
        except MigrationError as error:
            self.fail(f"same-owner v13 Skill must reopen: {error}")
        resolved = reopened.get_skill(created["referenceCode"])
        self.assertEqual(resolved["id"], "legacy-same-owner")
        self.assertEqual(resolved["slug"], "legacy-same-owner")
        self.assertEqual(resolved["revisions"][0]["digest"], created["revisions"][0]["digest"])

        connection = sqlite3.connect(database)
        try:
            self.assertEqual(connection.execute(
                """SELECT revision.digest, entry.canonical_index, entry.canonical_path,
                          entry.entry_digest, typeof(entry.content), entry.content
                     FROM skill_revisions AS revision
                     JOIN skill_package_entries AS entry
                       ON entry.skill_id=revision.skill_id
                      AND entry.revision=revision.revision
                    WHERE revision.skill_id='legacy-same-owner'
                    ORDER BY revision.revision, entry.canonical_index"""
            ).fetchall(), raw_before)
        finally:
            connection.close()

    def test_v12_identifier_collisions_roll_back_schema_and_registry_completely(self) -> None:
        for collision_kind in ("legacy-cross", "public-code"):
            with self.subTest(collision_kind=collision_kind):
                data_dir = self.data_dir / collision_kind
                store = JsonCollectionStore(data_dir)
                first = store.create_skill(external_skill("legacy-migrate-a", "migrate-a", [
                    package_entry("instruction", "SKILL.md", b"# A", "text/markdown"),
                ]))
                store.create_skill(external_skill("legacy-migrate-b", "migrate-b", [
                    package_entry("instruction", "SKILL.md", b"# B", "text/markdown"),
                ]))
                database = data_dir / "promptcard.sqlite3"
                downgrade_skill_schema_to_v12(database)
                connection = sqlite3.connect(database)
                try:
                    collision = (
                        "LEGACY-MIGRATE-A"
                        if collision_kind == "legacy-cross"
                        else first["referenceCode"].lower()
                    )
                    connection.execute(
                        "UPDATE skills SET slug=? WHERE id='legacy-migrate-b'",
                        (collision,),
                    )
                    connection.commit()
                    registry_before = connection.execute(
                        """SELECT public_code, namespace, owner_scope, internal_id, created_at
                           FROM public_references ORDER BY public_code"""
                    ).fetchall()
                finally:
                    connection.close()

                with self.assertRaisesRegex(MigrationError, "identifier"):
                    JsonCollectionStore(data_dir)

                connection = sqlite3.connect(database)
                try:
                    self.assertEqual(
                        connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0],
                        12,
                    )
                    self.assertIsNone(connection.execute(
                        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_package_entries'"
                    ).fetchone())
                    self.assertNotIn(
                        "lifecycle_status",
                        {row[1] for row in connection.execute("PRAGMA table_info(skills)")},
                    )
                    self.assertEqual(connection.execute(
                        """SELECT public_code, namespace, owner_scope, internal_id, created_at
                           FROM public_references ORDER BY public_code"""
                    ).fetchall(), registry_before)
                finally:
                    connection.close()

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
        database = self.data_dir / "promptcard.sqlite3"
        downgrade_skill_schema_to_v12(database)
        connection = sqlite3.connect(database)
        try:
            connection.execute("""INSERT INTO skills(
                id, slug, name, description, source, trust_state, capability_id,
                tool_dependencies_json, current_revision, created_at, updated_at
            ) VALUES (
                'legacy-v12', 'legacy-v12', 'Legacy V12', '', 'external', 'trusted', NULL,
                '[]', 1, 1, 1
            )""")
            connection.execute("""INSERT INTO skill_revisions(
                skill_id, revision, digest, instructions, references_json, created_at
            ) VALUES (
                'legacy-v12', 1, 'sha256:legacy-v12', 'Legacy instructions',
                '[{"name":"guide","content":"Reference"}]', 1
            )""")
            connection.commit()
        finally:
            connection.close()

        try:
            migrated_store = JsonCollectionStore(self.data_dir)
        except MigrationError as error:
            self.fail(f"same-owner v12 Skill must migrate: {error}")
        migrated = migrated_store.get_skill("legacy-v12")
        revision = migrated["revisions"][0]
        self.assertEqual(revision["legacyDigest"], "sha256:legacy-v12")
        self.assertEqual(revision["digestVersion"], "skill-package-v1")
        self.assertIn("legacyMetadata", revision["provenance"])
        self.assertEqual(revision["provenance"]["legacyMetadata"], {
            "revision": 1,
            "digest": revision["legacyDigest"],
        })
        self.assertEqual([entry["path"] for entry in revision["entries"]], ["SKILL.md", "references/reference-0001.json"])
        self.assertRegex(migrated["referenceCode"], SKILL_CODE)
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
