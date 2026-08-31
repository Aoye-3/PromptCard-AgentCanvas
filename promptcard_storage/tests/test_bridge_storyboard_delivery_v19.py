from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from promptcard_storage.app import create_app
from promptcard_storage.delivery_ledger import BridgeDeliveryValidationError
from promptcard_storage.store import JsonCollectionStore, MissingItem


TEST_ROOT = Path(
    "F:/.Agent-PromptCardManager/PromptCard-Manager/.test-tmp/task26b-storyboard"
)
DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64
DIGEST_C = "sha256:" + "c" * 64
DIGEST_D = "sha256:" + "d" * 64


def project() -> dict:
    return {
        "id": "project-a",
        "title": "Storyboard delivery project",
        "type": "free-canvas",
        "pages": [],
        "currentPage": 0,
        "freeCanvas": {
            "nodes": [
                {
                    "id": "script-document",
                    "kind": "document",
                    "title": "Accepted script",
                    "position": {"x": 0, "y": 0},
                    "width": 640,
                    "height": 480,
                    "document": {
                        "version": 1,
                        "blocks": [{
                            "id": "opening",
                            "type": "paragraph",
                            "content": [{"text": "Opening image"}],
                        }],
                        "revision": 2,
                        "digest": DIGEST_A,
                        "suggestions": [],
                    },
                    "linkedDocumentResourceIds": [],
                    "meta": {},
                },
                {
                    "id": "storyboard",
                    "kind": "storyboard",
                    "title": "Opening shots",
                    "position": {"x": 700, "y": 0},
                    "width": 680,
                    "height": 440,
                    "sequence": {
                        "id": "sequence-internal",
                        "name": "Opening",
                        "description": "Quiet reveal",
                        "style": "Naturalistic",
                        "constraints": "No dialogue",
                        "rows": [{
                            "id": "row-internal",
                            "cutLabel": "1",
                            "timeRange": "00:00-00:04",
                            "subject": "Empty street",
                            "action": "Rain falls",
                            "scene": "Night exterior",
                            "camera": "Slow push",
                            "lighting": "Neon reflections",
                            "audio": "Rain",
                            "duration": "4s",
                            "createdAt": 1,
                            "updatedAt": 1,
                        }],
                        "createdAt": 1,
                        "updatedAt": 1,
                        "meta": {},
                    },
                    "source": {
                        "documentNodeId": "script-document",
                        "documentRevision": 2,
                        "documentDigest": DIGEST_A,
                        "documentResourceDigests": [],
                        "model": {
                            "connectionId": "external-agent",
                            "providerId": "promptcard-bridge",
                            "modelId": "external-agent",
                            "displayName": "External Agent",
                            "capabilities": {},
                        },
                        "skills": [],
                    },
                    "pendingFieldChanges": [],
                    "revision": 1,
                    "digest": DIGEST_B,
                    "meta": {},
                },
            ],
            "edges": [],
            "meta": {},
        },
        "meta": {},
    }


class BridgeStoryboardDeliveryV19Test(unittest.TestCase):
    def setUp(self) -> None:
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.store = JsonCollectionStore(Path(self.temp_dir.name))
        self.created = self.store.create_project(project())
        self.document_code, self.storyboard_code = [
            node["referenceCode"]
            for node in self.created["freeCanvas"]["nodes"]
        ]
        self.context = self.store.create_context_pack({
            "projectCode": self.created["referenceCode"],
            "projectRevision": self.created["revision"],
            "nodeCodes": [self.document_code, self.storyboard_code],
            "placementHint": {
                "mode": "after-selection",
                "anchorNodeCodes": [self.storyboard_code],
            },
            "creator": "test",
        })

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def operation_context() -> dict:
        return {
            "profileId": "codex-local",
            "scopes": ["bridge:deliver:storyboard", "bridge:status"],
            "provenance": "promptcard-bridge",
            "clientInfo": {"name": "codex", "version": "1.0.0"},
        }

    def create_request(self, *, source_digest: str = DIGEST_A) -> dict:
        return {
            "clientRequestId": "storyboard-create-preview",
            "normalizedRequestDigest": DIGEST_C,
            "kind": "storyboard.create",
            "target": {"cvcCode": self.context["cvcCode"]},
            "sourceCodes": [self.document_code],
            "skillPins": [],
            "rationale": "Turn the accepted document into shots.",
            "provenance": "promptcard-bridge",
            "payload": {
                "title": "Bridge opening shots",
                "sourceDocumentCode": self.document_code,
                "sourceDocumentRevision": 2,
                "sourceDocumentDigest": source_digest,
                "sequence": {
                    "name": "Opening",
                    "description": "A quiet reveal.",
                    "style": "Naturalistic",
                    "constraints": "No dialogue",
                    "rows": [{
                        "cutLabel": "1",
                        "timeRange": "00:00-00:04",
                        "subject": "Empty street",
                        "action": "Rain falls",
                        "scene": "Night exterior",
                        "camera": "Slow push",
                        "lighting": "Neon reflections",
                        "audio": "Rain",
                        "duration": "4s",
                    }],
                },
            },
        }

    def change_request(
        self, *, row_ordinal: int = 0, base_digest: str = DIGEST_B
    ) -> dict:
        return {
            "clientRequestId": "storyboard-change-preview",
            "normalizedRequestDigest": DIGEST_D,
            "kind": "storyboard.change",
            "target": {
                "cvcCode": self.context["cvcCode"],
                "storyboardCode": self.storyboard_code,
                "baseRevision": 1,
                "baseDigest": base_digest,
            },
            "sourceCodes": [self.storyboard_code],
            "skillPins": [],
            "rationale": "Tighten the first shot.",
            "provenance": "promptcard-bridge",
            "payload": {
                "changes": [{
                    "scope": "row",
                    "rowOrdinal": row_ordinal,
                    "field": "duration",
                    "value": "3s",
                }],
            },
        }

    def test_create_preview_commit_replay_and_restart_share_one_proposal(self) -> None:
        preview = self.store.preview_bridge_storyboard_delivery(
            self.operation_context(), self.create_request()
        )
        replay = self.store.preview_bridge_storyboard_delivery(
            self.operation_context(), self.create_request()
        )
        self.assertEqual(replay["proposalId"], preview["proposalId"])
        self.assertEqual(replay["disposition"], "replay")
        self.assertEqual(preview["visualProposal"]["kind"], "storyboard_create")
        self.assertEqual(
            preview["visualProposal"]["sourceDocumentCode"], self.document_code
        )
        self.assertNotIn("documentNodeId", str(preview))

        commit = self.store.commit_bridge_storyboard_delivery(
            self.operation_context(), {
                "clientRequestId": "storyboard-create-commit",
                "normalizedRequestDigest": DIGEST_D,
                "proposalId": preview["proposalId"],
            }
        )
        self.assertEqual(commit["state"], "pending_review")
        restarted = JsonCollectionStore(Path(self.temp_dir.name))
        pending = restarted.list_bridge_deliveries(
            self.context["cvcCode"], state="pending_review"
        )
        self.assertEqual([item["proposalId"] for item in pending], [preview["proposalId"]])

    def test_create_requires_exact_source_document_revision_and_digest(self) -> None:
        stale = self.create_request(source_digest=DIGEST_B)
        with self.assertRaises(BridgeDeliveryValidationError) as rejected:
            self.store.preview_bridge_storyboard_delivery(
                self.operation_context(), stale
            )
        self.assertEqual(rejected.exception.code, "delivery_source_stale")
        with self.assertRaises(MissingItem):
            self.store.get_bridge_delivery("codex-local", stale["clientRequestId"])

    def test_change_resolves_ordinal_and_rejects_stale_or_missing_rows(self) -> None:
        stale = self.change_request(base_digest=DIGEST_A)
        with self.assertRaises(BridgeDeliveryValidationError) as rejected:
            self.store.preview_bridge_storyboard_delivery(
                self.operation_context(), stale
            )
        self.assertEqual(rejected.exception.code, "delivery_target_stale")

        missing = self.change_request(row_ordinal=1)
        with self.assertRaises(BridgeDeliveryValidationError) as rejected:
            self.store.preview_bridge_storyboard_delivery(
                self.operation_context(), missing
            )
        self.assertEqual(rejected.exception.code, "storyboard_row_not_found")

        preview = self.store.preview_bridge_storyboard_delivery(
            self.operation_context(), self.change_request()
        )
        self.assertEqual(preview["visualProposal"]["kind"], "storyboard_changes")
        self.assertEqual(preview["visualProposal"]["changes"][0]["rowOrdinal"], 0)
        self.assertNotIn("row-internal", str(preview))

    def test_storyboard_decision_requires_one_storyboard_code(self) -> None:
        preview = self.store.preview_bridge_storyboard_delivery(
            self.operation_context(), self.change_request()
        )
        self.store.commit_bridge_storyboard_delivery(
            self.operation_context(), {
                "clientRequestId": "storyboard-change-commit",
                "normalizedRequestDigest": DIGEST_C,
                "proposalId": preview["proposalId"],
            }
        )
        with self.assertRaises(BridgeDeliveryValidationError) as rejected:
            self.store.decide_bridge_delivery(
                self.context["cvcCode"], preview["proposalId"], "accepted", []
            )
        self.assertEqual(rejected.exception.code, "delivery_result_codes_invalid")

        accepted = self.store.decide_bridge_delivery(
            self.context["cvcCode"], preview["proposalId"], "accepted",
            [self.storyboard_code],
        )
        self.assertEqual(accepted["state"], "accepted")
        self.assertEqual(accepted["resultCodes"], [self.storyboard_code])

    def test_internal_storyboard_routes_use_the_same_durable_ledger(self) -> None:
        headers = {"X-PromptCard-Internal-Token": "internal-secret"}
        with mock.patch.dict(
            "os.environ", {"PROMPTCARD_INTERNAL_TOKEN": "internal-secret"}
        ):
            client = TestClient(create_app(self.store))
            denied = client.post(
                "/api/internal/bridge-storyboard-deliveries/preview",
                json={
                    "operationContext": self.operation_context(),
                    "deliveryRequest": self.create_request(),
                },
            )
            self.assertEqual(denied.status_code, 401)
            preview = client.post(
                "/api/internal/bridge-storyboard-deliveries/preview",
                headers=headers,
                json={
                    "operationContext": self.operation_context(),
                    "deliveryRequest": self.create_request(),
                },
            )
            self.assertEqual(preview.status_code, 200)
            committed = client.post(
                "/api/internal/bridge-storyboard-deliveries/commit",
                headers=headers,
                json={
                    "operationContext": self.operation_context(),
                    "deliveryRequest": {
                        "clientRequestId": "storyboard-api-commit",
                        "normalizedRequestDigest": DIGEST_D,
                        "proposalId": preview.json()["proposalId"],
                    },
                },
            )
            self.assertEqual(committed.status_code, 200)
            self.assertEqual(committed.json()["state"], "pending_review")


if __name__ == "__main__":
    unittest.main()
