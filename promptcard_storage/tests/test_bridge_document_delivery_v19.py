from __future__ import annotations

import tempfile
import unittest
import hashlib
from unittest import mock
from pathlib import Path

from fastapi.testclient import TestClient

from promptcard_storage.app import create_app
from promptcard_storage.delivery_ledger import (
    BridgeDeliveryValidationError,
)
from promptcard_storage.store import JsonCollectionStore, MissingItem


TEST_ROOT = Path(
    "F:/.Agent-PromptCardManager/PromptCard-Manager/.test-tmp/task26a-document"
)
DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64
DIGEST_C = "sha256:" + "c" * 64
TEXT_DIGEST = "sha256:" + hashlib.sha256(b"Opening image").hexdigest()


def project() -> dict:
    return {
        "id": "project-a",
        "title": "Document delivery project",
        "type": "free-canvas",
        "pages": [],
        "currentPage": 0,
        "freeCanvas": {
            "nodes": [{
                "id": "script-document",
                "kind": "document",
                "title": "Script analysis",
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
                "appliedAgentEdits": [],
                "meta": {},
            }],
            "edges": [],
            "meta": {},
        },
        "meta": {},
    }


class BridgeDocumentDeliveryV19Test(unittest.TestCase):
    def setUp(self) -> None:
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.store = JsonCollectionStore(Path(self.temp_dir.name))
        self.created = self.store.create_project(project())
        self.document_code = self.created["freeCanvas"]["nodes"][0]["referenceCode"]
        self.context = self.store.create_context_pack({
            "projectCode": self.created["referenceCode"],
            "projectRevision": self.created["revision"],
            "nodeCodes": [self.document_code],
            "placementHint": {
                "mode": "after-selection",
                "anchorNodeCodes": [self.document_code],
            },
            "creator": "test",
        })

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def operation_context() -> dict:
        return {
            "profileId": "codex-local",
            "scopes": ["bridge:deliver:document", "bridge:status"],
            "provenance": "promptcard-bridge",
            "clientInfo": {"name": "codex", "version": "1.0.0"},
        }

    def create_request(self) -> dict:
        return {
            "clientRequestId": "document-create-preview",
            "normalizedRequestDigest": DIGEST_B,
            "kind": "document.create",
            "target": {"cvcCode": self.context["cvcCode"]},
            "sourceCodes": [self.document_code],
            "skillPins": [{
                "skillCode": "SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "revision": 1,
                "digest": DIGEST_A,
                "projectionHealth": "healthy",
            }],
            "rationale": "Create the reviewed script analysis.",
            "provenance": "promptcard-bridge",
            "payload": {
                "title": "Reviewed analysis",
                "blocks": [{
                    "id": "summary",
                    "type": "paragraph",
                    "content": [{"text": "A rainy opening."}],
                }],
            },
        }

    def change_request(self, *, base_digest: str = DIGEST_A) -> dict:
        return {
            "clientRequestId": "document-change-preview",
            "normalizedRequestDigest": DIGEST_C,
            "kind": "document.change",
            "target": {
                "cvcCode": self.context["cvcCode"],
                "documentCode": self.document_code,
                "baseRevision": 2,
                "baseDigest": base_digest,
            },
            "sourceCodes": [self.document_code],
            "skillPins": [],
            "rationale": "Clarify the opening image.",
            "provenance": "promptcard-bridge",
            "payload": {
                "operations": [{
                    "kind": "replace",
                    "blockId": "opening",
                    "utf8Start": 0,
                    "utf8End": 7,
                    "text": "First",
                    "expectedTextDigest": TEXT_DIGEST,
                }],
            },
        }

    def test_create_preview_commit_replay_and_restart_share_one_proposal(self) -> None:
        preview = self.store.preview_bridge_document_delivery(
            self.operation_context(), self.create_request()
        )
        replay = self.store.preview_bridge_document_delivery(
            self.operation_context(), self.create_request()
        )
        self.assertEqual(replay["proposalId"], preview["proposalId"])
        self.assertEqual(replay["disposition"], "replay")
        self.assertEqual(preview["visualProposal"]["kind"], "document_create")

        commit = self.store.commit_bridge_document_delivery(
            self.operation_context(), {
                "clientRequestId": "document-create-commit",
                "normalizedRequestDigest": DIGEST_C,
                "proposalId": preview["proposalId"],
            }
        )
        self.assertEqual(commit["state"], "pending_review")
        restarted = JsonCollectionStore(Path(self.temp_dir.name))
        pending = restarted.list_bridge_deliveries(
            self.context["cvcCode"], state="pending_review"
        )
        self.assertEqual([item["proposalId"] for item in pending], [preview["proposalId"]])

    def test_change_requires_exact_document_revision_and_digest_before_ledger_write(self) -> None:
        stale = self.change_request(base_digest=DIGEST_B)
        with self.assertRaises(BridgeDeliveryValidationError) as rejected:
            self.store.preview_bridge_document_delivery(
                self.operation_context(), stale
            )
        self.assertEqual(rejected.exception.code, "delivery_target_stale")
        with self.assertRaises(MissingItem):
            self.store.get_bridge_delivery("codex-local", stale["clientRequestId"])

        preview = self.store.preview_bridge_document_delivery(
            self.operation_context(), self.change_request()
        )
        self.assertEqual(preview["visualProposal"]["kind"], "document_changes")
        self.assertEqual(
            preview["visualProposal"]["documentCode"], self.document_code
        )
        self.assertNotIn("nodeId", str(preview))

    def test_document_decision_requires_one_document_code(self) -> None:
        preview = self.store.preview_bridge_document_delivery(
            self.operation_context(), self.change_request()
        )
        self.store.commit_bridge_document_delivery(
            self.operation_context(), {
                "clientRequestId": "document-change-commit",
                "normalizedRequestDigest": DIGEST_B,
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
            [self.document_code],
        )
        self.assertEqual(accepted["state"], "accepted")
        self.assertEqual(accepted["resultCodes"], [self.document_code])

    def test_internal_document_routes_use_the_same_durable_ledger(self) -> None:
        headers = {"X-PromptCard-Internal-Token": "internal-secret"}
        with mock.patch.dict(
            "os.environ", {"PROMPTCARD_INTERNAL_TOKEN": "internal-secret"}
        ):
            client = TestClient(create_app(self.store))
            denied = client.post(
                "/api/internal/bridge-document-deliveries/preview",
                json={
                    "operationContext": self.operation_context(),
                    "deliveryRequest": self.create_request(),
                },
            )
            self.assertEqual(denied.status_code, 401)
            preview = client.post(
                "/api/internal/bridge-document-deliveries/preview",
                headers=headers,
                json={
                    "operationContext": self.operation_context(),
                    "deliveryRequest": self.create_request(),
                },
            )
            self.assertEqual(preview.status_code, 200)
            committed = client.post(
                "/api/internal/bridge-document-deliveries/commit",
                headers=headers,
                json={
                    "operationContext": self.operation_context(),
                    "deliveryRequest": {
                        "clientRequestId": "document-api-commit",
                        "normalizedRequestDigest": DIGEST_C,
                        "proposalId": preview.json()["proposalId"],
                    },
                },
            )
            self.assertEqual(committed.status_code, 200)
            self.assertEqual(committed.json()["state"], "pending_review")


if __name__ == "__main__":
    unittest.main()
