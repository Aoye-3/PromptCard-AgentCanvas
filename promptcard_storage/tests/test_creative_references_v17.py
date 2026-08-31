from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from promptcard_storage.app import create_app
from promptcard_storage.store import JsonCollectionStore, SCHEMA_VERSION


TEST_ROOT = Path("F:.test-tmp/task16-creative-references")
DIGEST = "sha256:" + "a" * 64


def document_node(node_id: str = "document-1") -> dict:
    return {
        "id": node_id,
        "kind": "document",
        "title": "Script analysis",
        "position": {"x": 10, "y": 20},
        "width": 640,
        "height": 480,
        "document": {
            "version": 1,
            "blocks": [
                {
                    "id": "block-1",
                    "type": "paragraph",
                    "content": [{"text": "Opening image"}],
                }
            ],
            "revision": 2,
            "digest": DIGEST,
            "suggestions": [],
        },
        "linkedDocumentResourceIds": [],
        "appliedAgentEdits": [],
        "meta": {"private": "must-not-leak"},
    }


def storyboard_node(node_id: str = "storyboard-1") -> dict:
    return {
        "id": node_id,
        "kind": "storyboard",
        "title": "Opening shots",
        "position": {"x": 700, "y": 20},
        "width": 800,
        "height": 520,
        "sequence": {
            "id": "internal-sequence-id",
            "name": "Opening",
            "description": "Quiet reveal",
            "style": "Naturalistic",
            "constraints": "No dialogue",
            "rows": [
                {
                    "id": "internal-row-id",
                    "cutLabel": "1",
                    "timeRange": "00:00-00:04",
                    "subject": "Street",
                    "action": "Rain falls",
                    "scene": "Night exterior",
                    "camera": "Slow push",
                    "lighting": "Neon",
                    "audio": "Rain",
                    "duration": "4s",
                    "createdAt": 1,
                    "updatedAt": 1,
                }
            ],
            "createdAt": 1,
            "updatedAt": 1,
            "meta": {"private": "must-not-leak"},
        },
        "source": {
            "documentNodeId": "document-1",
            "documentRevision": 2,
            "documentDigest": DIGEST,
            "documentResourceDigests": [],
            "model": {
                "connectionId": "private-connection",
                "providerId": "provider",
                "modelId": "model",
                "displayName": "Model",
                "capabilities": {},
            },
            "skills": [],
        },
        "pendingFieldChanges": [],
        "revision": 1,
        "digest": DIGEST,
        "appliedAgentEdits": [],
        "meta": {},
    }


def project(nodes: list[dict]) -> dict:
    return {
        "id": "project-1",
        "title": "Episode 1",
        "type": "free-canvas",
        "pages": [],
        "currentPage": 0,
        "freeCanvas": {"nodes": nodes, "edges": [], "meta": {}},
        "meta": {},
    }


class CreativeReferencesV17Test(unittest.TestCase):
    def setUp(self) -> None:
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.store = JsonCollectionStore(Path(self.temp_dir.name))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_schema_and_projection_assign_stable_cvd_and_cvs_without_polluting_json(self):
        self.assertGreaterEqual(SCHEMA_VERSION, 17)
        created = self.store.create_project(project([document_node(), storyboard_node()]))
        nodes = created["freeCanvas"]["nodes"]
        self.assertRegex(nodes[0]["referenceCode"], r"^CVD-[0-7][0-9A-HJKMNP-TV-Z]{25}$")
        self.assertRegex(nodes[1]["referenceCode"], r"^CVS-[0-7][0-9A-HJKMNP-TV-Z]{25}$")

        with self.store._connect() as connection:
            raw = json.loads(
                connection.execute(
                    "SELECT payload_json FROM projects WHERE id='project-1'"
                ).fetchone()[0]
            )
        self.assertNotIn("referenceCode", raw["freeCanvas"]["nodes"][0])
        self.assertNotIn("referenceCode", raw["freeCanvas"]["nodes"][1])

        reloaded = JsonCollectionStore(Path(self.temp_dir.name)).get_project("project-1")
        self.assertEqual(
            [node["referenceCode"] for node in reloaded["freeCanvas"]["nodes"]],
            [node["referenceCode"] for node in nodes],
        )

    def test_creative_resolver_redacts_internal_node_row_model_and_meta_ids(self):
        created = self.store.create_project(project([document_node(), storyboard_node()]))
        project_code = created["referenceCode"]
        document_code, storyboard_code = [
            node["referenceCode"] for node in created["freeCanvas"]["nodes"]
        ]

        document = self.store.resolve_creative_reference(project_code, document_code)
        storyboard = self.store.resolve_creative_reference(project_code, storyboard_code)

        self.assertEqual(document["node"]["referenceCode"], document_code)
        self.assertNotIn("id", document["node"])
        self.assertEqual(document["node"]["document"]["blocks"][0]["id"], "block-1")
        serialized = json.dumps(storyboard)
        self.assertNotIn("internal-row-id", serialized)
        self.assertNotIn("internal-sequence-id", serialized)
        self.assertNotIn("private-connection", serialized)
        self.assertNotIn("must-not-leak", serialized)
        self.assertEqual(storyboard["node"]["sequence"]["rows"][0]["ordinal"], 0)
        self.assertEqual(storyboard["node"]["source"]["documentCode"], document_code)

    def test_context_pack_accepts_creative_objects_and_resolves_immutable_entries(self):
        created = self.store.create_project(project([document_node(), storyboard_node()]))
        project_code = created["referenceCode"]
        creative_codes = [
            node["referenceCode"] for node in created["freeCanvas"]["nodes"]
        ]
        pack = self.store.create_context_pack(
            {
                "projectCode": project_code,
                "projectRevision": created["revision"],
                "nodeCodes": creative_codes,
                "placementHint": {
                    "mode": "after-selection",
                    "anchorNodeCodes": creative_codes,
                },
                "creator": "user",
            }
        )

        resolved = self.store.resolve_context_pack(pack["cvcCode"])
        self.assertEqual(
            [entry["reference"]["code"] for entry in resolved["entries"]],
            creative_codes,
        )
        self.assertEqual(
            [entry["reference"]["namespace"] for entry in resolved["entries"]],
            ["canvasDocument", "canvasStoryboard"],
        )

    def test_v16_upgrade_reconciles_creative_codes_and_exposes_the_bounded_api(self):
        self.store.create_project(project([document_node(), storyboard_node()]))
        with self.store._connect() as connection:
            for trigger in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%prompt_retrieval%'"
            ).fetchall():
                connection.execute(f'DROP TRIGGER "{trigger[0]}"')
            connection.execute("DROP TABLE prompt_retrieval_fts")
            connection.execute("DROP TABLE prompt_retrieval_audits")
            connection.execute("DROP TABLE prompt_retrieval_documents")
            connection.execute("DROP TABLE creative_references")
            connection.execute("DELETE FROM schema_migrations WHERE version>=17")
            connection.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (16, 'fixture-v16', 1)"
            )
            connection.commit()

        upgraded = JsonCollectionStore(Path(self.temp_dir.name))
        projected = upgraded.get_project("project-1")
        project_code = projected["referenceCode"]
        document_code = projected["freeCanvas"]["nodes"][0]["referenceCode"]
        response = TestClient(create_app(upgraded)).get(
            f"/api/projects/references/{project_code}/creative/{document_code}"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["node"]["referenceCode"], document_code)
        with upgraded._connect() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT MAX(version) FROM schema_migrations"
                ).fetchone()[0],
                SCHEMA_VERSION,
            )


if __name__ == "__main__":
    unittest.main()
