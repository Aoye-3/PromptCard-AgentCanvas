from __future__ import annotations

import sqlite3
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from fastapi.testclient import TestClient

from promptcard_storage.app import create_app
from promptcard_storage.delivery_ledger import (
    BridgeDeliveryConflict,
    BridgeDeliveryValidationError,
)
from promptcard_storage.store import JsonCollectionStore, MissingItem
from promptcard_storage.tests.workspace_paths import workspace_test_root


TEST_ROOT = workspace_test_root("task23-ledger")
DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64


def project(project_id: str) -> dict:
    return {
        "id": project_id,
        "title": "Delivery project",
        "type": "free-canvas",
        "pages": [],
        "currentPage": 0,
        "freeCanvas": {
            "nodes": [{
                "id": "text-a",
                "kind": "text",
                "title": "Script",
                "position": {"x": 0, "y": 0},
                "width": 420,
                "height": 180,
                "fontSize": "large",
                "segments": [{"id": "segment-a", "source": "user", "text": "Opening."}],
                "meta": {},
            }],
            "edges": [],
            "meta": {},
        },
        "meta": {},
    }


class BridgeDeliveryLedgerV19Test(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.store = JsonCollectionStore(Path(self.temp_dir.name))
        self.created = self.store.create_project(project("project-a"))
        node_code = self.created["freeCanvas"]["nodes"][0]["referenceCode"]
        self.context = self.store.create_context_pack({
            "projectCode": self.created["referenceCode"],
            "projectRevision": self.created["revision"],
            "nodeCodes": [node_code],
            "placementHint": {"mode": "after-selection", "anchorNodeCodes": [node_code]},
            "creator": "test",
        })

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def operation_context(profile_id: str = "codex-default") -> dict:
        return {
            "profileId": profile_id,
            "scopes": ["bridge:deliver:prompt"],
            "provenance": "promptcard-bridge",
            "clientInfo": {"name": "codex", "version": "1.0.0"},
        }

    def request(self, request_id: str, digest: str = DIGEST_A, **extra: object) -> dict:
        return {
            "clientRequestId": request_id,
            "normalizedRequestDigest": digest,
            "kind": "prompt.create",
            "target": {"cvcCode": self.context["cvcCode"]},
            "sourceCodes": [],
            "skillPins": [],
            "rationale": "Create a prompt proposal.",
            "provenance": "promptcard-bridge",
            "payload": {"title": "Opening", "userText": "Wide shot"},
            **extra,
        }

    def test_begin_finish_replay_conflict_and_profile_isolation_survive_restart(self) -> None:
        first = self.store.begin_bridge_delivery(
            self.operation_context(), "delivery.preview", self.request("request-1")
        )
        self.assertEqual((first["state"], first["disposition"]), ("processing", "original"))
        self.assertEqual(first["operationContext"]["profileId"], "codex-default")
        self.assertEqual(first["targetManifest"], {
            "cvcCode": self.context["cvcCode"],
        })
        self.assertEqual(first["sourceManifest"], {"skillPins": [], "sourceCodes": []})

        completed = self.store.finish_bridge_delivery(
            "codex-default",
            "request-1",
            DIGEST_A,
            "previewed",
            {"proposalId": "DVP-01ARZ3NDEKTSV4RRFFQ69G5FAV"},
        )
        self.assertEqual((completed["state"], completed["disposition"]), ("previewed", "original"))

        restarted = JsonCollectionStore(Path(self.temp_dir.name))
        replay = restarted.begin_bridge_delivery(
            self.operation_context(), "delivery.preview", self.request("request-1")
        )
        self.assertEqual((replay["state"], replay["disposition"]), ("previewed", "replay"))
        self.assertEqual(replay["result"], completed["result"])

        with self.assertRaises(BridgeDeliveryConflict) as conflict:
            restarted.begin_bridge_delivery(
                self.operation_context(),
                "delivery.preview",
                self.request("request-1", DIGEST_B),
            )
        self.assertEqual(conflict.exception.code, "delivery_conflict")
        self.assertEqual(conflict.exception.existing_digest, DIGEST_A)

        isolated = restarted.begin_bridge_delivery(
            self.operation_context("trae-default"),
            "delivery.preview",
            self.request("request-1"),
        )
        self.assertEqual(isolated["disposition"], "original")
        self.assertEqual(isolated["operationContext"]["profileId"], "trae-default")

        restarted.revoke_context_pack(
            self.context["cvcCode"], "test", "replay remains inspectable"
        )
        replay_after_revoke = restarted.begin_bridge_delivery(
            self.operation_context(), "delivery.preview", self.request("request-1")
        )
        self.assertEqual(
            (replay_after_revoke["state"], replay_after_revoke["disposition"]),
            ("previewed", "replay"),
        )

    def test_validation_precedes_insert_and_rejects_forged_stale_or_revoked_context(self) -> None:
        with self.assertRaises(BridgeDeliveryValidationError) as forged:
            self.store.begin_bridge_delivery(
                self.operation_context(),
                "delivery.preview",
                self.request("forged", profileId="forged-admin"),
            )
        self.assertEqual(forged.exception.code, "bridge_authority_in_request")
        self.assertEqual(self._ledger_count(), 0)

        current = self.store.get_project("project-a")
        self.store.update_project("project-a", {"title": "Changed"}, current["revision"])
        with self.assertRaises(BridgeDeliveryValidationError) as stale:
            self.store.begin_bridge_delivery(
                self.operation_context(), "delivery.preview", self.request("stale")
            )
        self.assertEqual(stale.exception.code, "context_stale")
        self.assertEqual(self._ledger_count(), 0)

        fresh_project = self.store.create_project(project("project-b"))
        node_code = fresh_project["freeCanvas"]["nodes"][0]["referenceCode"]
        revoked = self.store.create_context_pack({
            "projectCode": fresh_project["referenceCode"],
            "projectRevision": fresh_project["revision"],
            "nodeCodes": [node_code],
            "placementHint": {"mode": "after-selection", "anchorNodeCodes": [node_code]},
            "creator": "test",
        })
        self.store.revoke_context_pack(revoked["cvcCode"], "test", "expired")
        request = self.request("revoked")
        request["target"] = {"cvcCode": revoked["cvcCode"]}
        with self.assertRaises(BridgeDeliveryValidationError) as revoked_error:
            self.store.begin_bridge_delivery(
                self.operation_context(), "delivery.preview", request
            )
        self.assertEqual(revoked_error.exception.code, "context_revoked")
        self.assertEqual(self._ledger_count(), 0)

    def test_processing_recovery_is_durable_and_does_not_repeat_mutation(self) -> None:
        self.store.begin_bridge_delivery(
            self.operation_context(), "delivery.preview", self.request("interrupted")
        )
        recovered = self.store.reconcile_bridge_deliveries(stale_before_ms=10**15)
        self.assertEqual(recovered, 1)

        status = self.store.get_bridge_delivery("codex-default", "interrupted")
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["result"]["error"]["code"], "delivery_interrupted")

        replay = self.store.begin_bridge_delivery(
            self.operation_context(), "delivery.preview", self.request("interrupted")
        )
        self.assertEqual((replay["state"], replay["disposition"]), ("failed", "replay"))
        with self.assertRaises(MissingItem):
            self.store.get_bridge_delivery("trae-default", "interrupted")

    def test_internal_api_requires_auth_and_preserves_trusted_profile(self) -> None:
        payload = {
            "operationContext": self.operation_context(),
            "operation": "delivery.preview",
            "deliveryRequest": self.request("api-request"),
        }
        with mock.patch.dict("os.environ", {"PROMPTCARD_INTERNAL_TOKEN": "internal-secret"}):
            client = TestClient(create_app(self.store))
            denied = client.post("/api/internal/bridge-deliveries/begin", json=payload)
            self.assertEqual(denied.status_code, 401)

            headers = {"X-PromptCard-Internal-Token": "internal-secret"}
            created = client.post(
                "/api/internal/bridge-deliveries/begin", json=payload, headers=headers
            )
            self.assertEqual(created.status_code, 200)
            self.assertEqual(
                created.json()["operationContext"]["profileId"], "codex-default"
            )

            finished = client.post(
                "/api/internal/bridge-deliveries/api-request/finish",
                json={
                    "profileId": "codex-default",
                    "normalizedRequestDigest": DIGEST_A,
                    "state": "previewed",
                    "result": {"proposalId": "DVP-01ARZ3NDEKTSV4RRFFQ69G5FAV"},
                },
                headers=headers,
            )
            self.assertEqual(finished.status_code, 200)

            status = client.get(
                "/api/internal/bridge-deliveries/api-request",
                params={"profileId": "codex-default"},
                headers=headers,
            )
            self.assertEqual(status.status_code, 200)
            self.assertEqual(status.json()["state"], "previewed")

            forged_payload = {
                **payload,
                "deliveryRequest": self.request("api-forged", scopes=["bridge:read"]),
            }
            forged = client.post(
                "/api/internal/bridge-deliveries/begin",
                json=forged_payload,
                headers=headers,
            )
            self.assertEqual(forged.status_code, 400)
            self.assertEqual(
                forged.json()["detail"]["code"], "bridge_authority_in_request"
            )

    def test_v18_upgrade_creates_ledger_without_changing_existing_data(self) -> None:
        connection = sqlite3.connect(self.store.database_path)
        try:
            connection.execute("DROP TABLE bridge_delivery_ledger")
            connection.execute(
                "UPDATE schema_migrations SET version=18, name='fixture-v18' WHERE version=19"
            )
            connection.commit()
        finally:
            connection.close()

        upgraded = JsonCollectionStore(Path(self.temp_dir.name))
        self.assertEqual(upgraded.get_project("project-a")["title"], "Delivery project")
        connection = sqlite3.connect(upgraded.database_path)
        try:
            self.assertIsNotNone(connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bridge_delivery_ledger'"
            ).fetchone())
            self.assertEqual(
                connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0],
                19,
            )
        finally:
            connection.close()

    def test_v18_upgrade_rolls_back_when_ledger_name_is_incompatible(self) -> None:
        connection = sqlite3.connect(self.store.database_path)
        try:
            connection.execute("DROP TABLE bridge_delivery_ledger")
            connection.execute(
                "UPDATE schema_migrations SET version=18, name='fixture-v18' WHERE version=19"
            )
            connection.execute("CREATE VIEW bridge_delivery_ledger AS SELECT 1 AS incompatible")
            connection.commit()
        finally:
            connection.close()

        with self.assertRaises(sqlite3.OperationalError):
            JsonCollectionStore(Path(self.temp_dir.name))
        connection = sqlite3.connect(self.store.database_path)
        try:
            self.assertEqual(
                connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0],
                18,
            )
        finally:
            connection.close()

    def _ledger_count(self) -> int:
        connection = sqlite3.connect(self.store.database_path)
        try:
            return connection.execute("SELECT COUNT(*) FROM bridge_delivery_ledger").fetchone()[0]
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
