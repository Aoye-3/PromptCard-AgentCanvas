from __future__ import annotations

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
from promptcard_storage.store import JsonCollectionStore


TEST_ROOT = Path("F:/.Agent-PromptCardManager/PromptCard-Manager/.test-tmp/task24-prompt")
DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64


def project(project_id: str) -> dict:
    return {
        "id": project_id,
        "title": "Prompt delivery project",
        "type": "free-canvas",
        "pages": [],
        "currentPage": 0,
        "freeCanvas": {
            "nodes": [{
                "id": "script",
                "kind": "text",
                "title": "Script",
                "position": {"x": 0, "y": 0},
                "width": 420,
                "height": 180,
                "fontSize": "large",
                "segments": [{"id": "script-user", "source": "user", "text": "Opening."}],
                "meta": {},
            }],
            "edges": [],
            "meta": {},
        },
        "meta": {},
    }


class BridgePromptDeliveryV19Test(unittest.TestCase):
    def setUp(self) -> None:
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
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
    def operation_context() -> dict:
        return {
            "profileId": "codex-local",
            "scopes": ["bridge:deliver:prompt", "bridge:status"],
            "provenance": "promptcard-bridge",
            "clientInfo": {"name": "codex", "version": "1.0.0"},
        }

    def preview_request(self, request_id: str = "preview-1", digest: str = DIGEST_A) -> dict:
        return {
            "clientRequestId": request_id,
            "normalizedRequestDigest": digest,
            "kind": "prompt.create",
            "target": {"cvcCode": self.context["cvcCode"]},
            "sourceCodes": [],
            "skillPins": [],
            "rationale": "Create a shot prompt.",
            "provenance": "promptcard-bridge",
            "payload": {"title": "Opening shot", "userText": "Wide shot in rain"},
        }

    def test_preview_is_deterministic_replayable_and_does_not_mutate_project(self) -> None:
        before = self.store.get_project("project-a")
        first = self.store.preview_bridge_prompt_delivery(
            self.operation_context(), self.preview_request()
        )
        replay = self.store.preview_bridge_prompt_delivery(
            self.operation_context(), self.preview_request()
        )

        self.assertRegex(first["proposalId"], r"^DVP-[0-7][0-9A-HJKMNP-TV-Z]{25}$")
        self.assertEqual(first["state"], "previewed")
        self.assertEqual(first["disposition"], "original")
        self.assertEqual(replay["proposalId"], first["proposalId"])
        self.assertEqual(replay["disposition"], "replay")
        self.assertEqual(self.store.get_project("project-a"), before)
        self.assertEqual(first["resultCodes"], [])
        self.assertEqual(first["request"]["payload"]["userText"], "Wide shot in rain")

        with self.assertRaises(BridgeDeliveryConflict):
            self.store.preview_bridge_prompt_delivery(
                self.operation_context(), self.preview_request(digest=DIGEST_B)
            )

    def test_preview_rejects_sources_outside_the_explicit_context(self) -> None:
        allowed = self.preview_request("allowed-source")
        allowed["sourceCodes"] = [self.created["referenceCode"]]
        self.assertEqual(
            self.store.preview_bridge_prompt_delivery(
                self.operation_context(), allowed
            )["state"],
            "previewed",
        )

        outside_project = self.store.create_project(project("project-outside"))
        outside = self.preview_request("outside-source", DIGEST_B)
        outside["sourceCodes"] = [outside_project["referenceCode"]]
        with self.assertRaises(BridgeDeliveryValidationError) as rejected:
            self.store.preview_bridge_prompt_delivery(
                self.operation_context(), outside
            )
        self.assertEqual(
            rejected.exception.code, "source_reference_outside_context"
        )

    def test_commit_enters_visual_review_once_and_reject_survives_restart(self) -> None:
        preview = self.store.preview_bridge_prompt_delivery(
            self.operation_context(), self.preview_request()
        )
        commit_request = {
            "clientRequestId": "commit-1",
            "normalizedRequestDigest": DIGEST_B,
            "proposalId": preview["proposalId"],
        }
        committed = self.store.commit_bridge_prompt_delivery(
            self.operation_context(), commit_request
        )
        replay = self.store.commit_bridge_prompt_delivery(
            self.operation_context(), commit_request
        )

        self.assertEqual(committed["state"], "pending_review")
        self.assertEqual(committed["request"], self.preview_request())
        self.assertEqual(committed["visualProposal"]["kind"], "free_canvas_text_create")
        self.assertTrue(all(
            segment["source"] == "user"
            for segment in committed["visualProposal"]["segments"]
        ))
        self.assertEqual(replay["disposition"], "replay")

        pending = self.store.list_bridge_deliveries(
            self.context["cvcCode"], state="pending_review"
        )
        self.assertEqual([item["proposalId"] for item in pending], [preview["proposalId"]])

        rejected = self.store.decide_bridge_delivery(
            self.context["cvcCode"], preview["proposalId"], "rejected", []
        )
        self.assertEqual(rejected["state"], "rejected")
        self.assertEqual(
            self.store.list_bridge_deliveries(
                self.context["cvcCode"], state="pending_review"
            ),
            [],
        )

        restarted = JsonCollectionStore(Path(self.temp_dir.name))
        status = restarted.get_bridge_prompt_delivery("codex-local", "commit-1")
        self.assertEqual(status["state"], "rejected")
        self.assertEqual(status["proposalId"], preview["proposalId"])

    def test_accept_requires_one_prompt_code_from_the_same_project(self) -> None:
        preview = self.store.preview_bridge_prompt_delivery(
            self.operation_context(), self.preview_request()
        )
        self.store.commit_bridge_prompt_delivery(self.operation_context(), {
            "clientRequestId": "commit-accept",
            "normalizedRequestDigest": DIGEST_B,
            "proposalId": preview["proposalId"],
        })

        current = self.store.get_project("project-a")
        current_canvas = current["freeCanvas"]
        current_canvas["nodes"].append({
            "id": "delivered-prompt",
            "kind": "text",
            "title": "Opening shot",
            "position": {"x": 480, "y": 0},
            "width": 420,
            "height": 180,
            "fontSize": "large",
            "segments": [{
                "id": "delivered-prompt-user",
                "source": "user",
                "text": "Wide shot in rain",
            }],
            "meta": {},
        })
        saved = self.store.update_project(
            "project-a", {"freeCanvas": current_canvas}, current["revision"]
        )
        prompt_code = next(
            node["referenceCode"]
            for node in saved["freeCanvas"]["nodes"]
            if node["id"] == "delivered-prompt"
        )

        with self.assertRaises(BridgeDeliveryValidationError) as invalid:
            self.store.decide_bridge_delivery(
                self.context["cvcCode"], preview["proposalId"], "accepted",
                ["CVT-01ARZ3NDEKTSV4RRFFQ69G5FAV"],
            )
        self.assertEqual(invalid.exception.code, "delivery_result_code_unavailable")
        accepted = self.store.decide_bridge_delivery(
            self.context["cvcCode"], preview["proposalId"], "accepted", [prompt_code]
        )
        self.assertEqual(accepted["state"], "accepted")
        self.assertEqual(accepted["resultCodes"], [prompt_code])

    def test_internal_gateway_routes_and_visual_review_routes_share_the_ledger(self) -> None:
        headers = {"X-PromptCard-Internal-Token": "internal-secret"}
        with mock.patch.dict("os.environ", {"PROMPTCARD_INTERNAL_TOKEN": "internal-secret"}):
            client = TestClient(create_app(self.store))
            denied = client.post(
                "/api/internal/bridge-prompt-deliveries/preview",
                json={
                    "operationContext": self.operation_context(),
                    "deliveryRequest": self.preview_request(),
                },
            )
            self.assertEqual(denied.status_code, 401)
            preview = client.post(
                "/api/internal/bridge-prompt-deliveries/preview",
                headers=headers,
                json={
                    "operationContext": self.operation_context(),
                    "deliveryRequest": self.preview_request(),
                },
            )
            proposal_id = preview.json()["proposalId"]
            committed = client.post(
                "/api/internal/bridge-prompt-deliveries/commit",
                headers=headers,
                json={
                    "operationContext": self.operation_context(),
                    "deliveryRequest": {
                        "clientRequestId": "api-commit",
                        "normalizedRequestDigest": DIGEST_B,
                        "proposalId": proposal_id,
                    },
                },
            )
            self.assertEqual(committed.status_code, 200)
            pending = client.get(
                f"/api/context-packs/{self.context['cvcCode']}/bridge-deliveries",
                params={"state": "pending_review"},
            )
            self.assertEqual(len(pending.json()["deliveries"]), 1)
            rejected = client.post(
                f"/api/context-packs/{self.context['cvcCode']}"
                f"/bridge-deliveries/{proposal_id}/decision",
                json={"decision": "rejected", "resultCodes": []},
            )
            self.assertEqual(rejected.json()["state"], "rejected")
            status = client.get(
                "/api/internal/bridge-prompt-deliveries/api-commit",
                headers=headers,
                params={"profileId": "codex-local"},
            )
            self.assertEqual(status.json()["state"], "rejected")


if __name__ == "__main__":
    unittest.main()
