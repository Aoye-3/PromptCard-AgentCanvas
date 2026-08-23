from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

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
from promptcard_storage.skill_importer import _FolderRootChanged, _WindowsDirectoryLeases
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

        prefixed = self.store.create_skill({
            "id": "prefixed-path-id", "slug": "prefixed-path", "name": "Prefix Collision",
            "source": "external", "trustState": "trusted",
            "entries": [
                entry("instruction", "SKILL.md", b"# Prefix collision\n"),
                entry("reference", "references", b"file"),
                entry("reference", "references/guide.md", b"nested"),
            ],
        })
        prefix_rejected = self.client.put(
            f"/api/skills/{prefixed['referenceCode']}/host-pins/codex",
            json={"repositoryScope": "repo-one", "enabled": True, "revision": 1},
        )
        self.assertEqual(prefix_rejected.status_code, 409)
        self.assertEqual(
            prefix_rejected.json()["detail"]["code"], "codex_projection_path_invalid"
        )

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

    def test_publish_restore_failure_keeps_journal_until_reopen_recovers(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        target = self.repository / ".agents" / "skills" / "host-skill"
        original_replace = os.replace
        install_failed = False

        def fail_install_and_restore(source, destination) -> None:
            nonlocal install_failed
            source_path = Path(source)
            destination_path = Path(destination)
            if source_path.parent.name == ".promptcard-projection-staging" and destination_path == target:
                install_failed = True
                raise OSError("forced projection install failure")
            if (
                install_failed
                and source_path.parent.name == ".promptcard-projection-backups"
                and destination_path == target
            ):
                raise OSError("forced projection restore failure")
            original_replace(source, destination)

        with patch("promptcard_storage.skill_hosts.os.replace", side_effect=fail_install_and_restore):
            rejected = self.pin("codex", revision_two)

        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(
            rejected.json()["detail"]["code"], "codex_projection_recovery_required"
        )
        journals = self.repository / ".agents" / ".promptcard-projection-journal"
        self.assertEqual(len(list(journals.glob("*.json"))), 1)
        self.assertFalse(target.exists())

        reopened = SkillHostService(
            SqliteStore(self.root / "storage"),
            CodexProjectionAdapter({"repo-one": self.repository}),
        )
        recovered = reopened.get_pin(self.skill["referenceCode"], "codex", "repo-one")
        self.assertEqual(recovered["revision"], 1)
        self.assertEqual(recovered["projectionHealth"]["state"], "healthy")
        self.assertEqual((target / "SKILL.md").read_bytes(), b"# Revision one\n")
        self.assertEqual(list(journals.glob("*.json")), [])

    def test_unpublish_restore_failure_keeps_journal_until_reopen_recovers(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        target = self.repository / ".agents" / "skills" / "host-skill"
        original_replace = os.replace
        original_verify = self.service.codex._verify_exact_projection

        def fail_unpublish_backup_verify(path, expected) -> None:
            if path.parent.name == ".promptcard-projection-backups" and path.name.endswith("-old"):
                raise SkillHostConflict("codex_projection_drift", "forced backup verify failure")
            original_verify(path, expected)

        def fail_unpublish_restore(source, destination) -> None:
            source_path = Path(source)
            if (
                source_path.parent.name == ".promptcard-projection-backups"
                and source_path.name.endswith("-old")
                and Path(destination) == target
            ):
                raise OSError("forced unpublish restore failure")
            original_replace(source, destination)

        with (
            patch.object(
                self.service.codex,
                "_verify_exact_projection",
                side_effect=fail_unpublish_backup_verify,
            ),
            patch("promptcard_storage.skill_hosts.os.replace", side_effect=fail_unpublish_restore),
        ):
            rejected = self.pin("codex", 1, enabled=False)

        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(
            rejected.json()["detail"]["code"], "codex_projection_recovery_required"
        )
        journals = self.repository / ".agents" / ".promptcard-projection-journal"
        self.assertEqual(len(list(journals.glob("*.json"))), 1)
        self.assertFalse(target.exists())

        reopened = SkillHostService(
            SqliteStore(self.root / "storage"),
            CodexProjectionAdapter({"repo-one": self.repository}),
        )
        recovered = reopened.get_pin(self.skill["referenceCode"], "codex", "repo-one")
        self.assertTrue(recovered["enabled"])
        self.assertEqual(recovered["projectionHealth"]["state"], "healthy")
        self.assertEqual((target / "SKILL.md").read_bytes(), b"# Revision one\n")
        self.assertEqual(list(journals.glob("*.json")), [])

    def test_staging_cleanup_failure_keeps_journal_until_reopen_cleans_it(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        original_write = Path.write_bytes
        original_rmtree = shutil.rmtree

        def fail_staging_write(path: Path, content: bytes) -> int:
            if ".promptcard-projection-staging" in path.parts:
                raise OSError("forced staging write failure")
            return original_write(path, content)

        def leave_staging(path, *args, **kwargs) -> None:
            if Path(path).parent.name == ".promptcard-projection-staging":
                return
            original_rmtree(path, *args, **kwargs)

        with (
            patch.object(Path, "write_bytes", fail_staging_write),
            patch("promptcard_storage.skill_hosts.shutil.rmtree", side_effect=leave_staging),
        ):
            rejected = self.pin("codex", revision_two)

        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(
            rejected.json()["detail"]["code"], "codex_projection_recovery_required"
        )
        journals = self.repository / ".agents" / ".promptcard-projection-journal"
        staging = self.repository / ".agents" / ".promptcard-projection-staging"
        self.assertEqual(len(list(journals.glob("*.json"))), 1)
        self.assertEqual(len(list(staging.glob("*-new"))), 1)

        reopened = SkillHostService(
            SqliteStore(self.root / "storage"),
            CodexProjectionAdapter({"repo-one": self.repository}),
        )
        recovered = reopened.get_pin(self.skill["referenceCode"], "codex", "repo-one")
        self.assertEqual(recovered["revision"], 1)
        self.assertEqual(recovered["projectionHealth"]["state"], "healthy")
        self.assertEqual(list(journals.glob("*.json")), [])
        self.assertEqual(list(staging.glob("*-new")), [])

    def test_cross_instance_publish_publish_is_serialized_and_consistent(self) -> None:
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        revision_three = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision three\n")],
        })["currentRevision"]
        second_store = SqliteStore(self.root / "storage")
        second = SkillHostService(second_store, CodexProjectionAdapter({"repo-one": self.repository}))
        swapped = threading.Event()
        original_set = self.store.set_skill_host_pin

        def delayed_set(*args, **kwargs):
            swapped.set()
            time.sleep(0.15)
            return original_set(*args, **kwargs)

        self.store.set_skill_host_pin = delayed_set
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first_future = pool.submit(
                    self.service.update_pin,
                    self.skill["referenceCode"], "codex", "repo-one", True,
                    revision_two,
                )
                self.assertTrue(swapped.wait(2))
                second_future = pool.submit(
                    second.update_pin,
                    self.skill["referenceCode"], "codex", "repo-one", True,
                    revision_three,
                )
                first_future.result(timeout=5)
                second_future.result(timeout=5)
        finally:
            self.store.set_skill_host_pin = original_set
        pin = self.store.get_skill_host_pin("host-skill", "codex", "repo-one")
        disk = json.loads((
            self.repository / ".agents" / "skills" / "host-skill" / ".promptcard-skill.json"
        ).read_text("utf-8"))
        self.assertEqual((pin["revision"], pin["digest"]), (disk["revision"], disk["digest"]))

    def test_cross_instance_publish_unpublish_never_leaves_enabled_pin_without_projection(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        second_store = SqliteStore(self.root / "storage")
        second = SkillHostService(second_store, CodexProjectionAdapter({"repo-one": self.repository}))
        swapped = threading.Event()
        original_set = self.store.set_skill_host_pin

        def delayed_set(*args, **kwargs):
            swapped.set()
            time.sleep(0.15)
            return original_set(*args, **kwargs)

        self.store.set_skill_host_pin = delayed_set
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                publish = pool.submit(
                    self.service.update_pin,
                    self.skill["referenceCode"], "codex", "repo-one", True,
                    revision_two,
                )
                self.assertTrue(swapped.wait(2))
                unpublish = pool.submit(
                    second.update_pin,
                    self.skill["referenceCode"], "codex", "repo-one", False, 1,
                )
                publish.result(timeout=5)
                unpublish.result(timeout=5)
        finally:
            self.store.set_skill_host_pin = original_set
        pin = self.store.get_skill_host_pin("host-skill", "codex", "repo-one")
        target = self.repository / ".agents" / "skills" / "host-skill"
        self.assertEqual(pin["enabled"], target.exists())
        if pin["enabled"]:
            disk = json.loads((target / ".promptcard-skill.json").read_text("utf-8"))
            self.assertEqual(pin["digest"], disk["digest"])

    def test_crash_after_swap_is_recovered_on_reopen(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        original_set = self.store.set_skill_host_pin
        self.store.set_skill_host_pin = lambda *args, **kwargs: (_ for _ in ()).throw(
            SystemExit("simulated crash")
        )
        try:
            with self.assertRaises(SystemExit):
                self.service.update_pin(
                    self.skill["referenceCode"], "codex", "repo-one", True, revision_two
                )
        finally:
            self.store.set_skill_host_pin = original_set

        reopened = SkillHostService(
            SqliteStore(self.root / "storage"),
            CodexProjectionAdapter({"repo-one": self.repository}),
        )
        pin = reopened.get_pin(self.skill["referenceCode"], "codex", "repo-one")
        self.assertEqual(pin["revision"], 1)
        self.assertEqual(pin["projectionHealth"]["state"], "healthy")
        self.assertEqual(
            (self.repository / ".agents" / "skills" / "host-skill" / "SKILL.md").read_bytes(),
            b"# Revision one\n",
        )

    def test_crash_after_database_commit_finalizes_on_reopen(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        original_set = self.store.set_skill_host_pin

        def committed_then_crash(*args, **kwargs):
            original_set(*args, **kwargs)
            raise SystemExit("simulated crash")

        self.store.set_skill_host_pin = committed_then_crash
        try:
            with self.assertRaises(SystemExit):
                self.service.update_pin(
                    self.skill["referenceCode"], "codex", "repo-one", True, revision_two
                )
        finally:
            self.store.set_skill_host_pin = original_set
        reopened = SkillHostService(
            SqliteStore(self.root / "storage"),
            CodexProjectionAdapter({"repo-one": self.repository}),
        )
        pin = reopened.get_pin(self.skill["referenceCode"], "codex", "repo-one")
        self.assertEqual(pin["revision"], revision_two)
        self.assertEqual(pin["projectionHealth"]["state"], "healthy")
        journals = self.repository / ".agents" / ".promptcard-projection-journal"
        self.assertEqual(list(journals.glob("*.json")), [])

    def test_crash_recovery_refuses_a_tampered_rollback_backup_without_mutating(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        original_set = self.store.set_skill_host_pin
        self.store.set_skill_host_pin = lambda *args, **kwargs: (_ for _ in ()).throw(
            SystemExit("simulated crash")
        )
        try:
            with self.assertRaises(SystemExit):
                self.service.update_pin(
                    self.skill["referenceCode"], "codex", "repo-one", True, revision_two
                )
        finally:
            self.store.set_skill_host_pin = original_set
        backup = next((
            self.repository / ".agents" / ".promptcard-projection-backups"
        ).glob("*-new"))
        (backup / "SKILL.md").write_text("tampered backup", encoding="utf-8")

        reopened = SkillHostService(
            SqliteStore(self.root / "storage"),
            CodexProjectionAdapter({"repo-one": self.repository}),
        )
        pin = reopened.get_pin(self.skill["referenceCode"], "codex", "repo-one")

        self.assertEqual(pin["projectionHealth"]["state"], "unhealthy")
        self.assertTrue(backup.exists())
        self.assertEqual(
            (self.repository / ".agents" / "skills" / "host-skill" / "SKILL.md").read_bytes(),
            b"# Revision two\n",
        )

    def test_committed_crash_recovery_refuses_a_tampered_finalize_backup(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        original_set = self.store.set_skill_host_pin

        def committed_then_crash(*args, **kwargs):
            original_set(*args, **kwargs)
            raise SystemExit("simulated crash")

        self.store.set_skill_host_pin = committed_then_crash
        try:
            with self.assertRaises(SystemExit):
                self.service.update_pin(
                    self.skill["referenceCode"], "codex", "repo-one", True, revision_two
                )
        finally:
            self.store.set_skill_host_pin = original_set
        backup = next((
            self.repository / ".agents" / ".promptcard-projection-backups"
        ).glob("*-new"))
        (backup / "SKILL.md").write_text("tampered backup", encoding="utf-8")

        reopened = SkillHostService(
            SqliteStore(self.root / "storage"),
            CodexProjectionAdapter({"repo-one": self.repository}),
        )
        pin = reopened.get_pin(self.skill["referenceCode"], "codex", "repo-one")

        self.assertEqual(pin["projectionHealth"]["state"], "unhealthy")
        self.assertTrue(backup.exists())

    def test_get_pin_reports_full_manifest_and_nested_link_drift(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        target = self.repository / ".agents" / "skills" / "host-skill"
        manifest_path = target / ".promptcard-skill.json"
        baseline = json.loads(manifest_path.read_text("utf-8"))
        mutations = (
            {**baseline, "revision": 99},
            {**baseline, "digest": "sha256:" + "f" * 64},
            {**baseline, "promptCardSource": "tampered"},
            {**baseline, "unexpected": True},
            {**baseline, "files": []},
        )
        for mutated in mutations:
            with self.subTest(mutated=mutated):
                manifest_path.write_text(json.dumps(mutated), encoding="utf-8")
                pin = self.service.get_pin(self.skill["referenceCode"], "codex", "repo-one")
                self.assertEqual(pin["projectionHealth"]["state"], "drifted")
                manifest_path.write_text(json.dumps(baseline), encoding="utf-8")
        manifest_path.write_text("not-json", encoding="utf-8")
        invalid_manifest = self.service.get_pin(
            self.skill["referenceCode"], "codex", "repo-one"
        )
        self.assertEqual(invalid_manifest["projectionHealth"], {
            "state": "drifted",
            "code": "codex_projection_drift",
        })
        manifest_path.write_text(json.dumps(baseline), encoding="utf-8")
        (target / "extra.md").write_text("extra", encoding="utf-8")
        self.assertEqual(
            self.service.get_pin(self.skill["referenceCode"], "codex", "repo-one")["projectionHealth"]["state"],
            "drifted",
        )
        (target / "extra.md").unlink()
        empty = target / "unexpected-empty-directory"
        empty.mkdir()
        self.assertEqual(
            self.service.get_pin(self.skill["referenceCode"], "codex", "repo-one")["projectionHealth"]["state"],
            "drifted",
        )
        empty.rmdir()
        instruction = target / "SKILL.md"
        original_instruction = instruction.read_bytes()
        instruction.unlink()
        self.assertEqual(
            self.service.get_pin(self.skill["referenceCode"], "codex", "repo-one")["projectionHealth"]["state"],
            "drifted",
        )
        instruction.write_bytes(original_instruction)
        nested = target / "references"
        outside = self.root / "outside"
        outside.mkdir()
        try:
            nested.symlink_to(outside, target_is_directory=True)
        except OSError:
            pass
        else:
            self.assertEqual(
                self.service.get_pin(self.skill["referenceCode"], "codex", "repo-one")["projectionHealth"]["state"],
                "drifted",
            )

    @unittest.skipUnless(os.name == "nt", "Windows junction probe")
    def test_get_pin_rejects_a_nested_windows_junction(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        target = self.repository / ".agents" / "skills" / "host-skill"
        outside = self.root / "junction-target"
        outside.mkdir()
        junction = target / "references"
        created = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(outside)],
            capture_output=True,
            text=True,
            check=False,
        )
        if created.returncode != 0:
            self.skipTest("Windows junction creation is unavailable")
        try:
            pin = self.service.get_pin(self.skill["referenceCode"], "codex", "repo-one")
            self.assertEqual(pin["projectionHealth"]["state"], "drifted")
        finally:
            os.rmdir(junction)

    def test_get_pin_rejects_a_simulated_nested_reparse_point(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        target = self.repository / ".agents" / "skills" / "host-skill"
        nested = target / "references"
        nested.mkdir()
        nested_stat = nested.lstat()

        def simulated_reparse(value) -> bool:
            return (value.st_dev, value.st_ino) == (nested_stat.st_dev, nested_stat.st_ino)

        with patch("promptcard_storage.skill_hosts._is_reparse", side_effect=simulated_reparse):
            pin = self.service.get_pin(self.skill["referenceCode"], "codex", "repo-one")
        self.assertEqual(pin["projectionHealth"]["state"], "drifted")

    @unittest.skipUnless(os.name == "nt", "Windows directory lease boundary")
    def test_get_pin_maps_windows_lease_acquire_failure_to_drift(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)

        with patch.object(
            _WindowsDirectoryLeases,
            "acquire",
            side_effect=_FolderRootChanged,
        ):
            response = self.client.get(
                f"/api/skills/{self.skill['referenceCode']}/host-pins/codex",
                params={"repositoryScope": "repo-one"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["projectionHealth"], {
            "state": "drifted",
            "code": "codex_projection_drift",
        })

    @unittest.skipUnless(os.name == "nt", "Windows directory lease boundary")
    def test_get_pin_maps_windows_lease_close_failure_to_drift(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        original_exit = _WindowsDirectoryLeases.__exit__

        def close_then_fail(leases, *args) -> bool:
            original_exit(leases, *args)
            raise _FolderRootChanged

        with patch.object(_WindowsDirectoryLeases, "__exit__", close_then_fail):
            response = self.client.get(
                f"/api/skills/{self.skill['referenceCode']}/host-pins/codex",
                params={"repositoryScope": "repo-one"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["projectionHealth"], {
            "state": "drifted",
            "code": "codex_projection_drift",
        })

    def test_unrecoverable_journal_is_reported_unhealthy(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        journal_root = self.repository / ".agents" / ".promptcard-projection-journal"
        journal_root.mkdir(parents=True, exist_ok=True)
        (journal_root / ("f" * 32 + ".json")).write_text("not-json", encoding="utf-8")

        pin = self.service.get_pin(self.skill["referenceCode"], "codex", "repo-one")

        self.assertEqual(pin["projectionHealth"], {
            "state": "unhealthy",
            "code": "codex_projection_recovery_required",
        })

    def test_malformed_journal_cannot_escape_control_directories(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        current = self.store.get_skill_host_pin("host-skill", "codex", "repo-one")
        durable_pin = {
            "enabled": current["enabled"],
            "revision": current["revision"],
            "digest": current["digest"],
            "projection": current["projection"],
        }
        user_owned = self.repository / ".agents" / "outside-old"
        user_owned.mkdir(parents=True)
        sentinel = user_owned / "sentinel.txt"
        sentinel.write_text("keep", encoding="utf-8")
        journal_root = self.repository / ".agents" / ".promptcard-projection-journal"
        journal_root.mkdir(parents=True, exist_ok=True)
        (journal_root / "malicious.json").write_text(json.dumps({
            "format": "promptcard-codex-operation-v1",
            "operationId": "../outside",
            "skillId": "host-skill-id",
            "repositoryScope": "repo-one",
            "oldPublicationName": "host-skill",
            "newPublicationName": "host-skill",
            "priorPin": durable_pin,
            "desiredPin": durable_pin,
        }), encoding="utf-8")

        pin = self.service.get_pin(self.skill["referenceCode"], "codex", "repo-one")

        self.assertEqual(pin["projectionHealth"], {
            "state": "unhealthy",
            "code": "codex_projection_recovery_required",
        })
        self.assertEqual(sentinel.read_text("utf-8"), "keep")

    def test_projection_lock_file_reparse_is_rejected(self) -> None:
        lock_root = self.repository / ".agents" / ".promptcard-projection-locks"
        lock_root.mkdir(parents=True)
        key = "pin\x00repo-one\x00host-skill-id"
        lock_file = lock_root / (hashlib.sha256(key.encode("utf-8")).hexdigest() + ".lock")
        lock_file.write_bytes(b"\0")
        lock_stat = lock_file.lstat()

        def simulated_reparse(value) -> bool:
            return (value.st_dev, value.st_ino) == (lock_stat.st_dev, lock_stat.st_ino)

        with patch("promptcard_storage.skill_hosts._is_reparse", side_effect=simulated_reparse):
            rejected = self.pin("codex", 1)
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["code"], "codex_projection_path_invalid")

    def test_projection_rejects_a_dangling_target_link(self) -> None:
        target = self.repository / ".agents" / "skills" / "host-skill"
        target.parent.mkdir(parents=True)
        try:
            target.symlink_to(self.root / "missing-target", target_is_directory=True)
        except OSError:
            self.skipTest("Symbolic link creation is unavailable")

        rejected = self.pin("codex", 1)

        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["code"], "codex_projection_path_invalid")
        self.assertTrue(target.is_symlink())

    def test_projection_rejects_a_simulated_dangling_reparse_target(self) -> None:
        target = self.repository / ".agents" / "skills" / "host-skill"
        target.mkdir(parents=True)
        target_stat = target.lstat()
        original_exists = Path.exists

        def simulated_exists(path: Path) -> bool:
            return False if path == target else original_exists(path)

        def simulated_reparse(value) -> bool:
            return (value.st_dev, value.st_ino) == (target_stat.st_dev, target_stat.st_ino)

        with (
            patch.object(Path, "exists", simulated_exists),
            patch("promptcard_storage.skill_hosts._is_reparse", side_effect=simulated_reparse),
        ):
            rejected = self.pin("codex", 1)
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["code"], "codex_projection_path_invalid")

    def test_publish_detects_a_target_change_during_the_swap(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        revision_two = self.store.add_skill_revision("host-skill", {
            "entries": [entry("instruction", "SKILL.md", b"# Revision two\n")],
        })["currentRevision"]
        target = self.repository / ".agents" / "skills" / "host-skill"
        original_replace = os.replace
        changed = False

        def change_before_swap(source, destination) -> None:
            nonlocal changed
            source_path = Path(source)
            destination_path = Path(destination)
            if source_path == target and destination_path.parent.name == ".promptcard-projection-backups":
                (target / "SKILL.md").write_text("changed during swap", encoding="utf-8")
                changed = True
            original_replace(source, destination)

        with patch("promptcard_storage.skill_hosts.os.replace", side_effect=change_before_swap):
            rejected = self.pin("codex", revision_two)

        self.assertTrue(changed)
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["code"], "codex_projection_drift")
        self.assertEqual(
            self.store.get_skill_host_pin("host-skill", "codex", "repo-one")["revision"],
            1,
        )
        self.assertEqual((target / "SKILL.md").read_text("utf-8"), "changed during swap")

    def test_unpublish_detects_a_target_change_during_the_swap(self) -> None:
        self.assertEqual(self.pin("codex", 1).status_code, 200)
        target = self.repository / ".agents" / "skills" / "host-skill"
        original_replace = os.replace

        def change_before_swap(source, destination) -> None:
            source_path = Path(source)
            destination_path = Path(destination)
            if source_path == target and destination_path.parent.name == ".promptcard-projection-backups":
                (target / "SKILL.md").write_text("changed during unpublish", encoding="utf-8")
            original_replace(source, destination)

        with patch("promptcard_storage.skill_hosts.os.replace", side_effect=change_before_swap):
            rejected = self.pin("codex", 1, enabled=False)

        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["code"], "codex_projection_drift")
        self.assertTrue(self.store.get_skill_host_pin("host-skill", "codex", "repo-one")["enabled"])
        self.assertEqual((target / "SKILL.md").read_text("utf-8"), "changed during unpublish")

    def test_local_snapshot_rechecks_trust_and_lowercase_skl_is_canonicalized(self) -> None:
        self.assertEqual(self.pin("local-agent", 1).status_code, 200)
        lowered = self.skill["referenceCode"].lower()
        snapshot = self.client.get(
            "/api/skill-host-snapshots/local-agent", params={"skillId": lowered}
        )
        self.assertEqual(snapshot.status_code, 200)
        self.assertEqual(snapshot.json()["skillReferenceCode"], self.skill["referenceCode"])
        connection = sqlite3.connect(self.root / "storage" / "promptcard.sqlite3")
        try:
            connection.execute("UPDATE skills SET trust_state='untrusted' WHERE id='host-skill-id'")
            connection.commit()
        finally:
            connection.close()
        rejected = self.client.get(
            "/api/skill-host-snapshots/local-agent", params={"skillId": lowered}
        )
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["code"], "skill_review_required")

    def test_local_snapshot_rechecks_disabled_archived_restored_and_missing_state(self) -> None:
        self.assertEqual(self.pin("local-agent", 1).status_code, 200)
        disabled = self.pin("local-agent", 1, enabled=False)
        self.assertEqual(disabled.status_code, 200)
        self.assertEqual(self.client.get(
            "/api/skill-host-snapshots/local-agent",
            params={"skillId": self.skill["referenceCode"]},
        ).status_code, 404)

        self.assertEqual(self.pin("local-agent", 1).status_code, 200)
        self.store.archive_skill(self.skill["id"])
        archived = self.client.get(
            "/api/skill-host-snapshots/local-agent",
            params={"skillId": self.skill["referenceCode"]},
        )
        self.assertEqual(archived.status_code, 400)

        connection = sqlite3.connect(self.root / "storage" / "promptcard.sqlite3")
        try:
            connection.execute("UPDATE skills SET trust_state='untrusted' WHERE id='host-skill-id'")
            connection.commit()
        finally:
            connection.close()
        self.store.restore_skill(self.skill["id"])
        restored = self.client.get(
            "/api/skill-host-snapshots/local-agent",
            params={"skillId": self.skill["referenceCode"]},
        )
        self.assertEqual(restored.status_code, 409)
        self.assertEqual(restored.json()["detail"]["code"], "skill_review_required")
        self.assertEqual(self.client.get(
            "/api/skill-host-snapshots/local-agent",
            params={"skillId": "SKL-00000000000000000000000001"},
        ).status_code, 404)

    def test_local_snapshot_rejects_oversized_declared_capabilities(self) -> None:
        unsafe_capabilities = (
            {"tools": [f"tool-{index}" for index in range(65)]},
            {"tools": ["界" * 43]},
        )
        for capabilities in unsafe_capabilities:
            with self.subTest(capabilities=capabilities):
                revision = self.store.add_skill_revision("host-skill", {
                    "entries": [entry(
                        "instruction",
                        "SKILL.md",
                        f"# Capability test {capabilities!r}\n".encode(),
                    )],
                    "declaredCapabilities": capabilities,
                })["currentRevision"]
                self.assertEqual(self.pin("local-agent", revision).status_code, 200)
                rejected = self.client.get(
                    "/api/skill-host-snapshots/local-agent",
                    params={"skillId": self.skill["referenceCode"]},
                )
                self.assertEqual(rejected.status_code, 409)
                self.assertEqual(
                    rejected.json()["detail"]["code"], "skill_snapshot_invalid"
                )

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
