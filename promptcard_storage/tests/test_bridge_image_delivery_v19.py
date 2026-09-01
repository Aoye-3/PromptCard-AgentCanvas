from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from promptcard_storage.app import create_app
from promptcard_storage.assets import AssetValidationError
from promptcard_storage.delivery_ledger import BridgeDeliveryValidationError
from promptcard_storage.store import JsonCollectionStore
from promptcard_storage.tests.workspace_paths import workspace_test_root


TEST_ROOT = workspace_test_root("task25-image-v2")
PNG = b"\x89PNG\r\n\x1a\nbridge-image"
DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64


def project(project_id: str) -> dict:
    return {
        "id": project_id,
        "title": "Bridge image project",
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


def prepare(_content_type: str, content: bytes) -> dict:
    return {
        "width": 640,
        "height": 360,
        "contentType": "image/png",
        "content": content,
        "converted": False,
    }


class BridgeImageDeliveryV19Test(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.store = JsonCollectionStore(
            Path(self.temp_dir.name), image_preparer=prepare
        )
        self.created = self.store.create_project(project("project-a"))
        node_code = self.created["freeCanvas"]["nodes"][0]["referenceCode"]
        self.context = self.store.create_context_pack({
            "projectCode": self.created["referenceCode"],
            "projectRevision": self.created["revision"],
            "nodeCodes": [node_code],
            "placementHint": {
                "mode": "after-selection", "anchorNodeCodes": [node_code]
            },
            "creator": "test",
        })

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def operation_context(profile_id: str = "codex-local") -> dict:
        return {
            "profileId": profile_id,
            "scopes": ["bridge:deliver:image", "bridge:status"],
            "provenance": "promptcard-bridge",
            "clientInfo": {"name": "codex", "version": "1.0.0"},
        }

    def stage_request(self, request_id: str = "stage-1") -> dict:
        return {
            "clientRequestId": request_id,
            "cvcCode": self.context["cvcCode"],
            "workspaceRelativePath": "outputs/opening.png",
            "contentDigest": "sha256:" + hashlib.sha256(PNG).hexdigest(),
            "mediaType": "image/png",
            "byteLength": len(PNG),
        }

    def preview_request(self, handle: str) -> dict:
        return {
            "clientRequestId": "image-preview-1",
            "normalizedRequestDigest": DIGEST_A,
            "kind": "image.place",
            "target": {"cvcCode": self.context["cvcCode"]},
            "sourceCodes": [self.created["referenceCode"]],
            "skillPins": [{
                "skillCode": "SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "revision": 1,
                "digest": DIGEST_A,
                "projectionHealth": "healthy",
            }],
            "rationale": "Place the generated frame.",
            "provenance": "promptcard-bridge",
            "payload": {"stagedAssetHandle": handle, "altText": "Rainy street"},
        }

    def test_stage_replays_one_validated_asset_without_generation_run(self) -> None:
        first = self.store.stage_bridge_image(
            self.operation_context(), self.stage_request(), PNG
        )
        replay = self.store.stage_bridge_image(
            self.operation_context(), self.stage_request(), PNG
        )

        self.assertEqual(first["state"], "accepted")
        self.assertRegex(first["stagedAssetHandle"], r"^AST-[0-7][0-9A-HJKMNP-TV-Z]{25}$")
        self.assertEqual(replay["disposition"], "replay")
        self.assertEqual(replay["assetId"], first["assetId"])
        with self.store._connect() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 1)
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM image_generation_runs").fetchone()[0],
                0,
            )

    def test_stage_rejects_digest_size_path_and_mime_before_asset_write(self) -> None:
        cases = [
            ({**self.stage_request("digest"), "contentDigest": DIGEST_A}, "asset_digest_mismatch"),
            ({**self.stage_request("size"), "byteLength": len(PNG) + 1}, "asset_size_mismatch"),
            ({**self.stage_request("path"), "workspaceRelativePath": "../secret.png"}, "workspace_path_invalid"),
            ({**self.stage_request("mime"), "mediaType": "image/gif"}, "asset_media_type_invalid"),
        ]
        for request, code in cases:
            with self.subTest(code=code):
                with self.assertRaises(BridgeDeliveryValidationError) as rejected:
                    self.store.stage_bridge_image(self.operation_context(), request, PNG)
                self.assertEqual(rejected.exception.code, code)
        with self.store._connect() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 0)

    def test_stage_rejects_invalid_decoded_image_and_isolates_profile_handles(self) -> None:
        with mock.patch.object(
            self.store,
            "_prepare_provider_image",
            side_effect=AssetValidationError("bad image"),
        ):
            with self.assertRaises(BridgeDeliveryValidationError) as invalid:
                self.store.stage_bridge_image(
                    self.operation_context(), self.stage_request("invalid-image"), PNG
                )
        self.assertEqual(invalid.exception.code, "asset_image_invalid")

        staged = self.store.stage_bridge_image(
            self.operation_context(), self.stage_request("profile-stage"), PNG
        )
        with self.assertRaises(BridgeDeliveryValidationError) as unavailable:
            self.store.preview_bridge_image_delivery(
                self.operation_context("other-profile"),
                self.preview_request(staged["stagedAssetHandle"]),
            )
        self.assertEqual(unavailable.exception.code, "staged_asset_unavailable")

    def test_interrupted_stage_resumes_without_duplicate_asset(self) -> None:
        with mock.patch.object(
            self.store._bridge_deliveries,
            "finish",
            side_effect=RuntimeError("crash after asset save"),
        ):
            with self.assertRaises(RuntimeError):
                self.store.stage_bridge_image(
                    self.operation_context(), self.stage_request(), PNG
                )
        with self.store._connect() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 1)

        recovered = self.store.stage_bridge_image(
            self.operation_context(), self.stage_request(), PNG
        )
        self.assertEqual(recovered["state"], "accepted")
        with self.store._connect() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 1)

    def test_image_preview_commit_accept_and_restart_are_auditable(self) -> None:
        staged = self.store.stage_bridge_image(
            self.operation_context(), self.stage_request(), PNG
        )
        preview = self.store.preview_bridge_image_delivery(
            self.operation_context(), self.preview_request(staged["stagedAssetHandle"])
        )
        committed = self.store.commit_bridge_image_delivery(
            self.operation_context(),
            {
                "clientRequestId": "image-commit-1",
                "normalizedRequestDigest": DIGEST_B,
                "proposalId": preview["proposalId"],
            },
        )
        self.assertEqual(committed["state"], "pending_review")
        self.assertEqual(
            committed["visualProposal"]["kind"], "free_canvas_image_place"
        )

        current = self.store.get_project("project-a")
        canvas = current["freeCanvas"]
        canvas["nodes"].append({
            "id": "bridge-image",
            "kind": "image",
            "title": "opening.png",
            "position": {"x": 480, "y": 0},
            "width": 320,
            "height": 180,
            "assetId": staged["assetId"],
            "imageUrl": f"/api/assets/{staged['assetId']}",
            "imagePrompt": "",
            "sourceNodeId": None,
            "crop": None,
            "annotations": [],
            "meta": {"source": "promptcard-bridge"},
        })
        saved = self.store.update_project(
            "project-a", {"freeCanvas": canvas}, current["revision"]
        )
        image_code = next(
            node["referenceCode"]
            for node in saved["freeCanvas"]["nodes"]
            if node["id"] == "bridge-image"
        )
        accepted = self.store.decide_bridge_delivery(
            self.context["cvcCode"], preview["proposalId"], "accepted", [image_code]
        )
        self.assertEqual(accepted["state"], "accepted")
        self.assertEqual(accepted["resultCodes"], [image_code])

        restarted = JsonCollectionStore(
            Path(self.temp_dir.name), image_preparer=prepare
        )
        status = restarted.get_bridge_prompt_delivery("codex-local", "image-commit-1")
        self.assertEqual(status["state"], "accepted")
        self.assertEqual(
            restarted.list_bridge_deliveries(
                self.context["cvcCode"], state="accepted"
            )[0]["visualProposal"]["assetId"],
            staged["assetId"],
        )

    def test_internal_stage_requires_auth_and_reuses_visual_queue(self) -> None:
        metadata = {
            "operationContext": self.operation_context(),
            "stageRequest": self.stage_request(),
        }
        headers = {"X-PromptCard-Stage-Metadata": __import__("json").dumps(metadata)}
        with mock.patch.dict("os.environ", {"PROMPTCARD_INTERNAL_TOKEN": "internal-secret"}):
            client = TestClient(create_app(self.store))
            denied = client.post(
                "/api/internal/bridge-image-assets/stage",
                content=PNG,
                headers=headers,
            )
            self.assertEqual(denied.status_code, 401)
            staged = client.post(
                "/api/internal/bridge-image-assets/stage",
                content=PNG,
                headers={**headers, "X-PromptCard-Internal-Token": "internal-secret"},
            )
            self.assertEqual(staged.status_code, 200)
            self.assertEqual(staged.json()["state"], "accepted")


if __name__ == "__main__":
    unittest.main()
