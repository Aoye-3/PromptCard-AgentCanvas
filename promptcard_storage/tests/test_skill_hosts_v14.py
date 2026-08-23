from __future__ import annotations

import base64
import json
import shutil
import sqlite3
import unittest
import uuid
from pathlib import Path

try:
    from fastapi.testclient import TestClient
    from promptcard_storage.app import create_app
except ModuleNotFoundError:
    TestClient = None
    create_app = None

from promptcard_storage.skill_hosts import (
    CodexProjectionAdapter,
    SkillHostConflict,
    SkillHostService,
)
from promptcard_storage.store import SCHEMA_VERSION, SqliteStore


def workspace_directory() -> Path:
    root = Path(__file__).resolve().parent / ".task14-fixtures" / uuid.uuid4().hex
    root.mkdir(parents=True)
    return root


def entry(entry_type: str, path: str, content: bytes) -> dict:
    return {
        "type": entry_type,
        "path": path,
        "contentType": "text/markdown",
        "contentBase64": base64.b64encode(content).decode("ascii"),
    }


@unittest.skipUnless(TestClient and create_app, "FastAPI contract dependencies are not installed")
class SkillHostsV14Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = workspace_directory()
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.store = SqliteStore(self.root / "storage")
        self.skill = self.store.create_skill({
            "id": "host-skill-id",
            "slug": "host-skill",
            "name": "Host Skill",
            "source": "external",
            "trustState": "trusted",
            "entries": [entry("instruction", "SKILL.md", b"# Revision one\n")],
        })
        self.service = SkillHostService(
            self.store,
            CodexProjectionAdapter({"repo-one": self.repository}),
        )
        self.client = TestClient(create_app(self.store, skill_host_service=self.service))

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def pin(self, host: str, revision: int, enabled: bool = True):
        payload = {"enabled": enabled, "revision": revision}
        if host == "codex":
            payload["repositoryScope"] = "repo-one"
        return self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/{host}",
            json=payload,
        )

    def test_schema_v14_persists_independent_host_pins(self) -> None:
        self.assertEqual(SCHEMA_VERSION, 14)
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        self.assertEqual(self.pin("local-agent", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]

        updated = self.pin("codex", revision_two).json()
        local = self.client.get(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/local-agent",
        ).json()

        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["digest"], self.store.get_skill("host-skill")["revisions"][0]["digest"])
        self.assertEqual(local["revision"], 1)
        self.assertTrue(local["enabled"])

    def test_codex_projection_manifest_is_repo_bound_and_republishable(self) -> None:
        response = self.pin("codex", 1)
        self.assertEqual(response.status_code, 200, response.text)
        target = self.repository / ".agents" / "skills" / "host-skill"
        manifest = json.loads((target / ".promptcard-skill.json").read_text("utf-8"))
        self.assertEqual(manifest, {
            "format": "promptcard-codex-projection-v1",
            "repositoryScope": "repo-one",
            "owner": "host-skill-id",
            "promptCardSource": "external",
            "skillReferenceCode": self.skill["referenceCode"],
            "revision": 1,
            "digest": self.skill["revisions"][0]["digest"],
            "files": [{
                "path": "SKILL.md",
                "digest": self.skill["revisions"][0]["entries"][0]["digest"],
            }],
        })
        self.assertEqual((target / "SKILL.md").read_bytes(), b"# Revision one\n")
        self.assertEqual(self.pin("codex", 1).status_code, 200)

    def test_collision_and_drift_are_visible_recoverable_and_do_not_advance_pin(self) -> None:
        target = self.repository / ".agents" / "skills" / "host-skill"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("unowned", encoding="utf-8")
        collision = self.pin("codex", 1)
        self.assertEqual(collision.status_code, 409)
        self.assertEqual(collision.json()["detail"]["code"], "codex_projection_collision")
        self.assertEqual(
            self.client.get(
                f"/api/skills/{self.skill['referenceCode']}/host-pins/codex",
                params={"repositoryScope": "repo-one"},
            ).status_code,
            404,
        )

        shutil.rmtree(target)
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        (target / "SKILL.md").write_text("locally changed", encoding="utf-8")
        drift = self.pin("codex", revision_two)
        self.assertEqual(drift.status_code, 409)
        self.assertEqual(drift.json()["detail"]["code"], "codex_projection_drift")
        pin = self.store.get_skill_host_pin("host-skill", "codex", "repo-one")
        self.assertEqual(pin["revision"], 1)

        (target / "SKILL.md").write_bytes(b"# Revision one\n")
        recovered = self.pin("codex", revision_two)
        self.assertEqual(recovered.status_code, 200, recovered.text)
        self.assertEqual(recovered.json()["revision"], 2)

    def test_unavailable_revision_and_projection_failure_leave_pin_unchanged(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        unavailable = self.pin("codex", 99)
        self.assertEqual(unavailable.status_code, 404)
        self.assertEqual(self.store.get_skill_host_pin("host-skill", "codex", "repo-one")["revision"], 1)

    def test_disable_safely_unpublishes_and_drift_keeps_old_pin_enabled(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        target = self.repository / ".agents" / "skills" / "host-skill"
        disabled = self.pin("codex", 1, enabled=False)
        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertFalse(disabled.json()["enabled"])
        self.assertFalse(target.exists())

        self.assertEqual(self.pin("codex", 1).status_code, 200)
        (target / "SKILL.md").write_text("drift", encoding="utf-8")
        rejected = self.pin("codex", 1, enabled=False)
        self.assertEqual(rejected.status_code, 409)
        pin = self.store.get_skill_host_pin("host-skill", "codex", "repo-one")
        self.assertTrue(pin["enabled"])
        self.assertTrue(target.exists())

        original = self.service.codex.project
        self.service.codex.project = lambda *args, **kwargs: (_ for _ in ()).throw(
            SkillHostConflict("codex_projection_failed", "Projection failed")
        )
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        failed = self.pin("codex", revision_two)
        self.service.codex.project = original
        self.assertEqual(failed.status_code, 409)
        self.assertEqual(self.store.get_skill_host_pin("host-skill", "codex", "repo-one")["revision"], 1)

    def test_local_agent_snapshot_is_exact_filtered_and_rejects_capability_escalation(self) -> None:
        self.assertEqual(self.pin("local-agent", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        snapshot = self.client.get(
            "/api/skill-host-snapshots/local-agent",
            params={"skillId": self.skill["referenceCode"]},
        )
        self.assertEqual(snapshot.status_code, 200, snapshot.text)
        self.assertEqual(snapshot.json()["revision"], 1)
        self.assertEqual(snapshot.json()["instructions"], "# Revision one\n")
        self.assertNotIn("entries", snapshot.json())
        self.assertNotEqual(snapshot.json()["revision"], revision_two)

        unsafe = self.store.create_skill({
            "id": "unsafe-host-skill-id", "slug": "unsafe-host-skill", "name": "Unsafe",
            "source": "external", "trustState": "trusted",
            "entries": [entry("instruction", "SKILL.md", b"# Unsafe\n")],
        })
        unsafe = self.store.add_skill_revision(unsafe["id"], {
            "entries": [entry("instruction", "SKILL.md", b"# Unsafe revision\n")],
            "declaredCapabilities": {"tools": ["shell"]},
        })
        enabled = self.client.put(
            f"/api/skills/{unsafe['referenceCode']}/host-pins/local-agent",
            json={"enabled": True, "revision": 2},
        )
        self.assertEqual(enabled.status_code, 200, enabled.text)
        unsafe_snapshot = self.client.get(
            "/api/skill-host-snapshots/local-agent",
            params={"skillId": unsafe["referenceCode"]},
        )
        self.assertEqual(unsafe_snapshot.status_code, 200)
        self.assertEqual(
            unsafe_snapshot.json()["declaredCapabilities"]["tools"], ["shell"]
        )

    def test_local_snapshot_filters_scripts_and_rejects_untrusted_enablement(self) -> None:
        scripted = self.store.create_skill({
            "id": "scripted-skill-id", "slug": "scripted-skill", "name": "Scripted",
            "source": "external", "trustState": "trusted",
            "entries": [
                entry("instruction", "SKILL.md", b"# Safe instructions\n"),
                entry("reference", "references/guide.md", b"Guide\n"),
                entry("script", "scripts/run.py", b"raise RuntimeError()\n"),
                entry("asset", "assets/example.md", b"Asset\n"),
            ],
        })
        self.assertEqual(
            self.client.put(
                f"/api/skills/{scripted['referenceCode']}/host-pins/local-agent",
                json={"enabled": True, "revision": 1},
            ).status_code,
            200,
        )
        snapshot = self.client.get(
            "/api/skill-host-snapshots/local-agent",
            params={"skillId": scripted["referenceCode"]},
        ).json()
        self.assertEqual(snapshot["instructions"], "# Safe instructions\n")
        self.assertEqual([item["path"] for item in snapshot["references"]], ["references/guide.md"])
        self.assertNotIn("scripts/run.py", repr(snapshot))

        untrusted = self.store.create_skill({
            "id": "untrusted-skill-id", "slug": "untrusted-skill", "name": "Untrusted",
            "source": "external",
            "entries": [entry("instruction", "SKILL.md", b"# Pending review\n")],
        })
        rejected = self.client.put(
            f"/api/skills/{untrusted['referenceCode']}/host-pins/local-agent",
            json={"enabled": True, "revision": 1},
        )
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["code"], "skill_review_required")

    def test_builtin_local_agent_pins_are_seeded_with_exact_digest(self) -> None:
        builtin = next(
            skill for skill in self.store.list_skills()["skills"]
            if skill["capabilityId"] == "canvas.prompt.edit"
        )
        pin = self.store.get_skill_host_pin(builtin["id"], "local-agent", "")
        self.assertTrue(pin["enabled"])
        self.assertEqual(pin["revision"], builtin["revision"])
        self.assertEqual(pin["digest"], builtin["digest"])

    def test_projection_rejects_windows_reserved_and_casefold_colliding_paths(self) -> None:
        reserved = self.store.create_skill({
            "id": "reserved-path-id", "slug": "reserved-path", "name": "Reserved",
            "source": "external", "trustState": "trusted",
            "entries": [
                entry("instruction", "SKILL.md", b"# Reserved\n"),
                entry("reference", "references/CON.txt", b"unsafe"),
            ],
        })
        rejected = self.client.put(
            f"/api/skills/{reserved['referenceCode']}/host-pins/codex",
            json={"repositoryScope": "repo-one", "enabled": True, "revision": 1},
        )
        self.assertEqual(rejected.status_code, 400)

        colliding = self.store.create_skill({
            "id": "colliding-path-id", "slug": "colliding-path", "name": "Collision",
            "source": "external", "trustState": "trusted",
            "entries": [
                entry("instruction", "SKILL.md", b"# Collision\n"),
                entry("reference", "references/Guide.md", b"A"),
                entry("reference", "references/guide.md", b"B"),
            ],
        })
        rejected = self.client.put(
            f"/api/skills/{colliding['referenceCode']}/host-pins/codex",
            json={"repositoryScope": "repo-one", "enabled": True, "revision": 1},
        )
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["code"], "codex_projection_path_invalid")

    def test_collision_recovers_with_a_different_publication_name(self) -> None:
        collision = self.repository / ".agents" / "skills" / "host-skill"
        collision.mkdir(parents=True)
        (collision / "SKILL.md").write_text("owned elsewhere", encoding="utf-8")
        failed = self.pin("codex", 1)
        self.assertEqual(failed.status_code, 409)

        recovered = self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/codex",
            json={
                "repositoryScope": "repo-one", "publicationName": "host-skill-safe",
                "enabled": True, "revision": 1,
            },
        )
        self.assertEqual(recovered.status_code, 200, recovered.text)
        self.assertTrue(
            (self.repository / ".agents" / "skills" / "host-skill-safe" / "SKILL.md").is_file()
        )

    def test_database_failure_rolls_projection_back_to_prior_revision(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        target = self.repository / ".agents" / "skills" / "host-skill"
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        original = self.store.set_skill_host_pin
        self.store.set_skill_host_pin = lambda *args, **kwargs: (_ for _ in ()).throw(
            sqlite3.OperationalError("forced commit failure")
        )
        try:
            with self.assertRaises(sqlite3.OperationalError):
                self.service.update_pin(
                    self.skill["referenceCode"], "codex", "repo-one", True,
                    revision_two, publication_name="host-skill",
                )
        finally:
            self.store.set_skill_host_pin = original
        self.assertEqual((target / "SKILL.md").read_bytes(), b"# Revision one\n")
        self.assertEqual(self.store.get_skill_host_pin("host-skill", "codex", "repo-one")["revision"], 1)

    def test_v13_migrates_to_v14_without_changing_canonical_revisions(self) -> None:
        before = self.store.get_skill("host-skill")["revisions"]
        database = self.root / "storage" / "promptcard.sqlite3"
        connection = sqlite3.connect(database)
        try:
            connection.execute("DROP TABLE skill_host_pins")
            connection.execute(
                "UPDATE schema_migrations SET version=13, name='legacy-v13' WHERE version=14"
            )
            connection.commit()
        finally:
            connection.close()

        reopened = SqliteStore(self.root / "storage")
        self.assertEqual(reopened.health()["schemaVersion"], 14)
        self.assertEqual(reopened.get_skill("host-skill")["revisions"], before)


if __name__ == "__main__":
    unittest.main()
