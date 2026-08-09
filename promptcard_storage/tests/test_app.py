import tempfile
import unittest
from pathlib import Path

try:
    from fastapi.testclient import TestClient
    from promptcard_storage.app import create_app
except ModuleNotFoundError:
    TestClient = None
    create_app = None

from promptcard_storage.store import SqliteStore


def preset(item_id: str, label: str) -> dict:
    return {
        "id": item_id,
        "type": "subject",
        "category": "scene",
        "label": label,
        "content": label,
        "usageCount": 0,
        "revision": 1,
        "createdAt": 1,
        "updatedAt": 1,
        "meta": {},
    }


@unittest.skipUnless(TestClient and create_app, "FastAPI contract dependencies are not installed")
class StorageAppContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = SqliteStore(Path(self.temp_dir.name))
        self.client = TestClient(create_app(self.store))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_uploads_and_reads_an_asset(self) -> None:
        content = b"\x89PNG\r\n\x1a\nimage"
        response = self.client.post(
            "/api/assets",
            content=content,
            headers={"content-type": "image/png", "x-file-name": "board.png"},
        )

        self.assertEqual(response.status_code, 200)
        asset = response.json()
        downloaded = self.client.get(f"/api/assets/{asset['id']}")
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.content, content)

    def test_returns_structured_error_envelope(self) -> None:
        response = self.client.post(
            "/api/assets",
            content=b"not-a-png",
            headers={"content-type": "image/png", "x-file-name": "fake.png"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"]["code"], "invalid_asset")

    def test_replaces_presets_through_batch_endpoint(self) -> None:
        response = self.client.put("/api/presets/batch", json={"presets": [preset("p1", "One")]})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["presets"][0]["id"], "p1")

    def test_browser_migration_is_idempotent(self) -> None:
        payload = {"migrationId": "contract-v1", "projects": [], "presets": []}

        first = self.client.post("/api/migrations/browser-cache", json=payload)
        second = self.client.post("/api/migrations/browser-cache", json=payload)

        self.assertFalse(first.json()["alreadyApplied"])
        self.assertTrue(second.json()["alreadyApplied"])

    def test_creates_lists_and_updates_recent_captures(self) -> None:
        asset_response = self.client.post(
            "/api/assets",
            content=b"\x89PNG\r\n\x1a\nimage",
            headers={"content-type": "image/png", "x-file-name": "shot.png"},
        )
        asset_id = asset_response.json()["id"]

        create_response = self.client.post("/api/recent-captures", json={
            "id": "capture-one",
            "assetId": asset_id,
            "kind": "screenshot",
            "contentType": "image/png",
            "width": 320,
            "height": 180,
            "capturedAt": 123,
        })

        self.assertEqual(create_response.status_code, 200)
        capture = create_response.json()
        self.assertEqual(capture["assetId"], asset_id)
        self.assertEqual(capture["revision"], 1)

        list_response = self.client.get("/api/recent-captures")
        self.assertEqual(list_response.json()["captures"][0]["id"], "capture-one")

        update_response = self.client.put(
            "/api/recent-captures/capture-one",
            json={"revision": capture["revision"], "updates": {"status": "placedOnCanvas"}},
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.json()["status"], "placedOnCanvas")

        delete_response = self.client.request(
            "DELETE",
            "/api/recent-captures/capture-one",
            json={"revision": update_response.json()["revision"]},
        )
        self.assertEqual(delete_response.status_code, 200)
        self.assertEqual(delete_response.json(), {"ok": True})
        self.assertEqual(self.client.get("/api/recent-captures").json()["captures"], [])
        self.assertEqual(self.client.get(f"/api/assets/{asset_id}").status_code, 200)

    def test_project_resource_api_is_project_scoped_and_reports_folder_errors(self) -> None:
        for project_id in ("project-a", "project-b"):
            response = self.client.post("/api/projects", json={
                "id": project_id,
                "title": project_id,
                "type": "free-canvas",
                "pages": [],
                "currentPage": 0,
                "meta": {},
            })
            self.assertEqual(response.status_code, 200)
        asset = self.client.post(
            "/api/assets",
            content=b"\x89PNG\r\n\x1a\nresource",
            headers={"content-type": "image/png", "x-file-name": "resource.png"},
        ).json()
        folder = self.client.post("/api/projects/project-a/resource-folders", json={
            "id": "folder-a", "name": " Folder "
        }).json()
        resource = self.client.post("/api/projects/project-a/resources", json={
            "id": "resource-a",
            "kind": "material",
            "name": "Reference",
            "sourceAssetId": asset["id"],
            "previewAssetId": asset["id"],
            "providerAssetId": asset["id"],
            "width": 640,
            "height": 480,
            "contentType": "image/png",
            "folderId": folder["id"],
        }).json()

        snapshot = self.client.get("/api/projects/project-a/resources")
        cross_project = self.client.put(
            f"/api/projects/project-b/resources/{resource['id']}",
            json={"revision": resource["revision"], "updates": {"name": "Leaked"}},
        )
        non_empty = self.client.request(
            "DELETE",
            f"/api/projects/project-a/resource-folders/{folder['id']}",
            json={"revision": folder["revision"]},
        )

        self.assertEqual(snapshot.status_code, 200)
        self.assertEqual(snapshot.json()["folders"][0]["name"], "Folder")
        self.assertEqual(cross_project.status_code, 404)
        self.assertEqual(non_empty.status_code, 409)
        self.assertEqual(non_empty.json()["detail"]["code"], "folder_not_empty")

    def test_registers_recent_captures_to_prompt_library_atomically(self) -> None:
        asset = self.client.post(
            "/api/assets",
            content=b"\x89PNG\r\n\x1a\nimage",
            headers={"content-type": "image/png", "x-file-name": "shot.png"},
        ).json()
        capture = self.client.post("/api/recent-captures", json={
            "id": "capture-register", "assetId": asset["id"], "kind": "screenshot",
            "contentType": "image/png", "title": "Shot", "prompt": "A wide shot", "role": "composition",
        }).json()

        response = self.client.post("/api/recent-captures/register-to-prompt-library", json={
            "mode": "separate",
            "captures": [{
                "id": capture["id"], "revision": capture["revision"],
                "label": "Shot", "content": "A wide shot", "type": "camera",
            }],
        })

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["presets"][0]["meta"]["media"][0]["assetId"], asset["id"])
        self.assertEqual(payload["captures"][0]["registeredPromptId"], payload["presets"][0]["id"])

    def test_creates_analysis_derived_prompt_without_reassigning_registered_capture(self) -> None:
        asset = self.client.post(
            "/api/assets",
            content=b"\x89PNG\r\n\x1a\nimage",
            headers={"content-type": "image/png", "x-file-name": "source.png"},
        ).json()
        capture = self.client.post("/api/recent-captures", json={
            "id": "capture-analysis-derived",
            "assetId": asset["id"],
            "kind": "screenshot",
            "contentType": "image/png",
            "title": "Source",
        }).json()
        initial = self.client.post("/api/recent-captures/register-to-prompt-library", json={
            "mode": "separate",
            "captures": [{
                "id": capture["id"],
                "revision": capture["revision"],
                "label": "Original",
                "content": "Original prompt",
                "type": "style",
            }],
        }).json()
        registered_capture = initial["captures"][0]
        original_prompt_id = registered_capture["registeredPromptId"]

        response = self.client.post("/api/recent-captures/register-to-prompt-library", json={
            "intent": "analysis-derived",
            "mode": "separate",
            "captures": [{
                "id": registered_capture["id"],
                "revision": registered_capture["revision"],
                "label": "Derived",
                "content": "Derived analysis prompt",
                "type": "camera",
                "category": "portrait",
            }],
        })

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertNotEqual(payload["presets"][0]["id"], original_prompt_id)
        self.assertEqual(payload["presets"][0]["type"], "camera")
        self.assertEqual(payload["presets"][0]["meta"]["media"][0]["assetId"], asset["id"])
        self.assertEqual(payload["captures"][0]["registeredPromptId"], original_prompt_id)
        persisted = self.client.get(f"/api/recent-captures/{capture['id']}").json()
        self.assertEqual(persisted["registeredPromptId"], original_prompt_id)
        self.assertEqual(persisted["revision"], registered_capture["revision"])

    def test_agent_conversation_and_skill_hub_contracts(self) -> None:
        self.client.post("/api/projects", json={
            "id": "project-agent", "title": "Agent", "type": "free-canvas",
            "pages": [], "currentPage": 0, "meta": {},
        })
        created = self.client.post("/api/agent-conversations", json={
            "id": "conversation-1", "projectId": "project-agent",
            "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas",
            "modelBinding": {"connectionId": "connection-a", "providerId": "ark", "modelId": "model-a"},
        })
        turn = self.client.post("/api/agent-conversations/conversation-1/turns", json={
            "projectId": "project-agent", "requestId": "request-1",
            "userMessage": {"role": "user", "text": "Hello"},
            "assistantMessage": {"role": "assistant", "text": "Hi"},
            "modelSnapshot": {"connectionId": "connection-a", "providerId": "ark", "modelId": "model-a"},
        })
        listed = self.client.get("/api/agent-conversations", params={"projectId": "project-agent"})
        detail = self.client.get("/api/agent-conversations/conversation-1", params={"projectId": "project-agent"})
        skills = self.client.get("/api/skills")

        self.assertEqual(created.status_code, 200)
        self.assertEqual(turn.status_code, 200)
        self.assertEqual(listed.json()["conversations"][0]["id"], "conversation-1")
        self.assertEqual(listed.json()["conversations"][0]["modelBinding"]["modelId"], "model-a")
        self.assertEqual(len(detail.json()["messages"]), 2)
        self.assertEqual(detail.json()["turns"][0]["modelSnapshot"]["connectionId"], "connection-a")
        self.assertEqual(len(skills.json()["skills"]), 2)

        updated_model = self.client.patch(
            "/api/projects/project-agent/agent-conversations/conversation-1/model",
            json={"modelBinding": {"connectionId": "connection-b", "providerId": "openai", "modelId": "model-b"}},
        )
        self.assertEqual(updated_model.status_code, 200)
        self.assertEqual(updated_model.json()["modelBinding"]["modelId"], "model-b")
        self.assertNotIn("messages", updated_model.json())

        self.assertEqual(self.client.post(
            "/api/agent-conversations/conversation-1/trash", json={"projectId": "project-agent"}
        ).status_code, 200)
        self.assertEqual(self.client.post(
            "/api/agent-conversations/conversation-1/restore", json={"projectId": "project-agent"}
        ).status_code, 200)
        self.client.post("/api/agent-conversations/conversation-1/trash", json={"projectId": "project-agent"})
        self.assertEqual(self.client.request(
            "DELETE", "/api/agent-conversations/conversation-1", json={"projectId": "project-agent"}
        ).json(), {"ok": True})

    def test_storage_artifact_contract_lists_trashes_restores_and_downloads(self) -> None:
        asset = self.client.post(
            "/api/assets",
            content=b"\x89PNG\r\n\x1a\nimage",
            headers={"content-type": "image/png", "x-file-name": "reference.png"},
        ).json()
        self.client.post("/api/recent-captures", json={
            "id": "capture-storage", "assetId": asset["id"], "kind": "screenshot",
            "contentType": "image/png", "title": "Reference", "capturedAt": 123,
        })

        summary = self.client.get("/api/storage/summary")
        listed = self.client.get("/api/storage/artifacts", params={"category": "external-media"})
        downloaded = self.client.get(f"/api/storage/artifacts/{asset['id']}/download")
        trashed = self.client.post("/api/storage/artifacts/trash", json={"ids": [asset["id"]]})

        self.assertEqual(summary.status_code, 200)
        self.assertGreater(summary.json()["userAssetBytes"], 0)
        self.assertEqual(listed.json()["artifacts"][0]["assetId"], asset["id"])
        self.assertIn("reference.png", downloaded.headers["content-disposition"])
        self.assertEqual(trashed.status_code, 200)
        self.assertEqual(self.client.get("/api/recent-captures").json()["captures"], [])

        restored = self.client.post("/api/storage/artifacts/restore", json={"ids": [asset["id"]]})
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(self.client.get("/api/recent-captures").json()["captures"][0]["id"], "capture-storage")

    def test_storage_permanent_delete_returns_reference_details(self) -> None:
        asset = self.client.post(
            "/api/assets",
            content=b"\x89PNG\r\n\x1a\nimage",
            headers={"content-type": "image/png", "x-file-name": "project.png"},
        ).json()
        self.client.post("/api/projects", json={
            "id": "project-storage", "title": "Storage Project", "type": "free-canvas",
            "pages": [], "currentPage": 0,
            "freeCanvas": {"nodes": [{"id": "image", "kind": "image", "assetId": asset["id"]}], "edges": []},
            "createdAt": 1, "updatedAt": 1, "lastOpenedAt": 1, "meta": {},
        })
        self.client.post("/api/storage/artifacts/trash", json={"ids": [asset["id"]]})

        response = self.client.post("/api/storage/artifacts/delete-forever", json={"ids": [asset["id"]]})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "asset_in_use")
        self.assertEqual(response.json()["detail"]["detail"]["references"][0]["id"], "project-storage")


if __name__ == "__main__":
    unittest.main()
