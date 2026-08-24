from __future__ import annotations

import base64
import shutil
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from promptcard_storage.app import create_app
except ModuleNotFoundError:
    TestClient = None
    create_app = None

from promptcard_storage.skill_hosts import CodexProjectionAdapter, SkillHostService
from promptcard_storage.store import SCHEMA_VERSION, SqliteStore


def entry(content: bytes) -> dict:
    return {
        "type": "instruction",
        "path": "SKILL.md",
        "contentType": "text/markdown",
        "contentBase64": base64.b64encode(content).decode("ascii"),
    }


@unittest.skipUnless(TestClient and create_app, "FastAPI contract dependencies are not installed")
class SkillManagementV15Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(__file__).resolve().parent / ".task15-fixtures" / uuid.uuid4().hex
        self.repository = self.root / "repository"
        self.repository.mkdir(parents=True)
        self.store = SqliteStore(self.root / "storage")
        self.skill = self.store.create_skill({
            "id": "review-skill-id",
            "slug": "review-skill",
            "name": "Review Skill",
            "source": "external",
            "trustState": "untrusted",
            "entries": [entry(b"# Revision one\n")],
        })
        self.service = SkillHostService(
            self.store,
            CodexProjectionAdapter({"repo-one": self.repository}),
        )
        self.client = TestClient(create_app(self.store, skill_host_service=self.service))

    def tearDown(self) -> None:
        self.client.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def review(self, revision: int, digest: str):
        return self.client.post(
            f"/api/skills/{self.skill['referenceCode']}/revisions/{revision}/review",
            json={"expectedDigest": digest, "decision": "trusted"},
        )

    def test_schema_v15_records_revision_bound_trust_reviews(self) -> None:
        self.assertEqual(SCHEMA_VERSION, 15)
        revision = self.skill["revisions"][0]

        reviewed = self.review(1, revision["digest"])

        self.assertEqual(reviewed.status_code, 200, reviewed.text)
        current = reviewed.json()["revisions"][0]
        self.assertEqual(current["trustReview"]["state"], "trusted")
        self.assertEqual(current["trustReview"]["digest"], revision["digest"])
        self.assertIsInstance(current["trustReview"]["reviewedAt"], int)

    def test_review_requires_the_exact_revision_digest_before_enablement(self) -> None:
        blocked = self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/local-agent",
            json={"enabled": True, "revision": 1},
        )
        wrong = self.review(1, "sha256:" + "0" * 64)

        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.json()["detail"]["code"], "skill_review_required")
        self.assertEqual(wrong.status_code, 409)
        self.assertEqual(wrong.json()["detail"]["code"], "skill_review_stale")

        digest = self.skill["revisions"][0]["digest"]
        self.assertEqual(self.review(1, digest).status_code, 200)
        enabled = self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/local-agent",
            json={"enabled": True, "revision": 1},
        )
        self.assertEqual(enabled.status_code, 200, enabled.text)

    def test_new_revision_requires_a_new_review_without_moving_existing_pin(self) -> None:
        revision_one = self.skill["revisions"][0]
        self.assertEqual(self.review(1, revision_one["digest"]).status_code, 200)
        self.assertEqual(self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/local-agent",
            json={"enabled": True, "revision": 1},
        ).status_code, 200)
        updated = self.store.add_skill_revision(self.skill["id"], {
            "entries": [entry(b"# Revision two\n")],
        })

        blocked = self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/local-agent",
            json={"enabled": True, "revision": 2},
        )
        pin = self.store.get_skill_host_pin(self.skill["id"], "local-agent", "")

        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.json()["detail"]["code"], "skill_review_required")
        self.assertEqual(pin["revision"], 1)
        self.assertIsNone(updated["revisions"][0]["trustReview"])

    def test_a_trusted_historical_revision_remains_eligible_when_current_is_unreviewed(self) -> None:
        revision_one = self.skill["revisions"][0]
        self.assertEqual(self.review(1, revision_one["digest"]).status_code, 200)
        self.store.add_skill_revision(self.skill["id"], {
            "entries": [entry(b"# Revision two\n")],
        })

        historical = self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/local-agent",
            json={"enabled": True, "revision": 1},
        )
        current = self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/local-agent",
            json={"enabled": True, "revision": 2},
        )

        self.assertEqual(historical.status_code, 200, historical.text)
        self.assertEqual(historical.json()["revision"], 1)
        self.assertEqual(current.status_code, 409)
        self.assertEqual(current.json()["detail"]["code"], "skill_review_required")

    def test_host_description_exposes_scope_keys_without_paths(self) -> None:
        response = self.client.get("/api/skill-hosts")

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload, {
            "hosts": [
                {"id": "local-agent", "label": "Local Agent", "scopes": [""]},
                {"id": "codex", "label": "Codex .agents/skills", "scopes": ["repo-one"]},
            ]
        })
        self.assertNotIn(str(self.repository), response.text)

    def test_explicit_repair_restores_owned_drift_without_advancing_pin(self) -> None:
        revision = self.skill["revisions"][0]
        self.assertEqual(self.review(1, revision["digest"]).status_code, 200)
        publish = self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/codex",
            json={"enabled": True, "revision": 1, "repositoryScope": "repo-one"},
        )
        self.assertEqual(publish.status_code, 200, publish.text)
        target = self.repository / ".agents" / "skills" / "review-skill"
        (target / "SKILL.md").write_text("locally changed", encoding="utf-8")

        repaired = self.client.post(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/codex/repair",
            json={
                "repositoryScope": "repo-one",
                "expectedRevision": 1,
                "expectedDigest": revision["digest"],
            },
        )

        self.assertEqual(repaired.status_code, 200, repaired.text)
        self.assertEqual(repaired.json()["revision"], 1)
        self.assertEqual(repaired.json()["projectionHealth"]["state"], "healthy")
        self.assertEqual((target / "SKILL.md").read_bytes(), b"# Revision one\n")

    def test_explicit_repair_preserves_an_unowned_collision(self) -> None:
        revision = self.skill["revisions"][0]
        self.assertEqual(self.review(1, revision["digest"]).status_code, 200)
        self.assertEqual(self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/codex",
            json={"enabled": True, "revision": 1, "repositoryScope": "repo-one"},
        ).status_code, 200)
        target = self.repository / ".agents" / "skills" / "review-skill"
        shutil.rmtree(target)
        target.mkdir(parents=True)
        sentinel = target / "user-owned.txt"
        sentinel.write_text("keep", encoding="utf-8")

        repaired = self.client.post(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/codex/repair",
            json={
                "repositoryScope": "repo-one",
                "expectedRevision": 1,
                "expectedDigest": revision["digest"],
            },
        )

        self.assertEqual(repaired.status_code, 409)
        self.assertEqual(repaired.json()["detail"]["code"], "codex_projection_collision")
        self.assertEqual(sentinel.read_text("utf-8"), "keep")

    def test_explicit_repair_rejects_a_reparse_projection_parent_before_mutation(self) -> None:
        revision = self.skill["revisions"][0]
        self.assertEqual(self.review(1, revision["digest"]).status_code, 200)
        self.assertEqual(self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/codex",
            json={"enabled": True, "revision": 1, "repositoryScope": "repo-one"},
        ).status_code, 200)
        projection_root = self.repository / ".agents" / "skills"
        root_stat = projection_root.lstat()
        target = projection_root / "review-skill"
        sentinel = target / "SKILL.md"
        sentinel.write_text("keep this drift", encoding="utf-8")

        def marks_projection_root(candidate) -> bool:
            return (candidate.st_dev, candidate.st_ino) == (root_stat.st_dev, root_stat.st_ino)

        with patch("promptcard_storage.skill_hosts._is_reparse", side_effect=marks_projection_root):
            repaired = self.client.post(
                f"/api/skills/{self.skill['referenceCode']}/host-pins/codex/repair",
                json={
                    "repositoryScope": "repo-one",
                    "expectedRevision": 1,
                    "expectedDigest": revision["digest"],
                },
            )

        self.assertEqual(repaired.status_code, 409)
        self.assertEqual(repaired.json()["detail"]["code"], "codex_projection_path_invalid")
        self.assertEqual(sentinel.read_text("utf-8"), "keep this drift")

    def test_revoked_archived_skill_can_still_be_explicitly_unpublished(self) -> None:
        revision = self.skill["revisions"][0]
        self.assertEqual(self.review(1, revision["digest"]).status_code, 200)
        published = self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/codex",
            json={"enabled": True, "revision": 1, "repositoryScope": "repo-one"},
        )
        self.assertEqual(published.status_code, 200, published.text)
        target = self.repository / ".agents" / "skills" / "review-skill"
        self.assertTrue(target.exists())
        revoked = self.client.post(
            f"/api/skills/{self.skill['referenceCode']}/revisions/1/review",
            json={"expectedDigest": revision["digest"], "decision": "untrusted"},
        )
        (target / "SKILL.md").write_text("revoked drift", encoding="utf-8")
        repair = self.client.post(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/codex/repair",
            json={
                "repositoryScope": "repo-one",
                "expectedRevision": 1,
                "expectedDigest": revision["digest"],
            },
        )
        self.assertEqual(repair.status_code, 409)
        self.assertEqual(repair.json()["detail"]["code"], "skill_review_required")
        self.assertEqual((target / "SKILL.md").read_text("utf-8"), "revoked drift")
        (target / "SKILL.md").write_bytes(b"# Revision one\n")
        archived = self.client.post(f"/api/skills/{self.skill['referenceCode']}/archive")
        self.assertEqual(revoked.status_code, 200, revoked.text)
        self.assertEqual(archived.status_code, 200, archived.text)

        disabled = self.client.put(
            f"/api/skills/{self.skill['referenceCode']}/host-pins/codex",
            json={"enabled": False, "revision": 1, "repositoryScope": "repo-one"},
        )

        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertFalse(disabled.json()["enabled"])
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
