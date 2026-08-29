from __future__ import annotations

import tempfile
import threading
import unittest
import shutil
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from promptcard_storage.app import create_app
from promptcard_storage.store import AgentApplyEditConflict, JsonCollectionStore


TEST_ROOT = Path(__file__).resolve().parents[2] / ".test-tmp" / "task15-9-agent-apply"
TEST_ROOT.mkdir(parents=True, exist_ok=True)


def project(project_id: str = "project-1") -> dict:
    return {
        "id": project_id,
        "title": "Document project",
        "type": "free-canvas",
        "pages": [],
        "currentPage": 0,
        "freeCanvas": {"nodes": [], "edges": [], "meta": {}},
        "createdAt": 1,
        "updatedAt": 1,
        "lastOpenedAt": 1,
        "meta": {},
    }


def pending_turn(request_id: str = "request-1", edit_id: str = "edit-1") -> dict:
    return {
        "requestId": request_id,
        "userMessage": {"role": "user", "text": "Create a document"},
        "assistantMessage": {
            "role": "assistant",
            "text": "Creating it",
            "canvasEdits": [{"kind": "document_create", "editId": edit_id}],
        },
        "applyEdit": {
            "status": "pending_apply",
            "conversationId": "conversation-1",
            "requestId": request_id,
            "editId": edit_id,
            "kind": "document_create",
            "nodeId": "document-node-1",
            "expectedResultDigest": "sha256:" + "a" * 64,
        },
    }


class AgentApplyEditStorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.store = JsonCollectionStore(Path(self.temp_dir.name, "data"))
        self.store.create_project(project())
        self.store.create_agent_conversation({
            "id": "conversation-1",
            "projectId": "project-1",
            "entrypoint": "workspace-chatbot-agent",
            "mode": "free-canvas-workspace",
        })

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_append_persists_one_top_level_pending_ledger_and_replays_it(self) -> None:
        first = self.store.append_agent_conversation_turn(
            "conversation-1", "project-1", pending_turn()
        )
        replay = self.store.append_agent_conversation_turn(
            "conversation-1", "project-1", pending_turn()
        )

        self.assertEqual(first["applyEdit"]["status"], "pending_apply")
        self.assertEqual(replay, first)
        self.assertEqual(
            self.store.get_agent_conversation("conversation-1", "project-1")["turns"][0],
            first,
        )

    def test_append_rejects_a_second_request_while_apply_is_pending(self) -> None:
        self.store.append_agent_conversation_turn(
            "conversation-1", "project-1", pending_turn()
        )

        with self.assertRaises(AgentApplyEditConflict) as raised:
            self.store.append_agent_conversation_turn(
                "conversation-1",
                "project-1",
                pending_turn("request-2", "edit-2"),
            )

        self.assertEqual(raised.exception.code, "agent_apply_edit_pending")
        detail = self.store.get_agent_conversation("conversation-1", "project-1")
        self.assertEqual(len(detail["turns"]), 1)

    def test_cas_terminal_transition_is_first_winner_and_idempotent(self) -> None:
        self.store.append_agent_conversation_turn(
            "conversation-1", "project-1", pending_turn()
        )
        evidence = {
            "projectRevision": 3,
            "nodeId": "document-node-1",
            "kind": "document",
            "resultDigest": "sha256:" + "a" * 64,
        }

        first = self.store.update_agent_apply_edit(
            "conversation-1",
            request_id="request-1",
            edit_id="edit-1",
            status="applied",
            evidence=evidence,
        )
        replay = self.store.update_agent_apply_edit(
            "conversation-1",
            request_id="request-1",
            edit_id="edit-1",
            status="applied",
            evidence=evidence,
        )

        self.assertEqual(replay, first)
        self.assertEqual(first["status"], "applied")
        with self.assertRaises(AgentApplyEditConflict) as raised:
            self.store.update_agent_apply_edit(
                "conversation-1",
                request_id="request-1",
                edit_id="edit-1",
                status="failed_integrity",
                evidence={"code": "marker_mismatch"},
            )
        self.assertEqual(raised.exception.code, "agent_apply_edit_terminal")

    def test_cas_rejects_wrong_request_edit_tuple_without_mutation(self) -> None:
        self.store.append_agent_conversation_turn(
            "conversation-1", "project-1", pending_turn()
        )

        for request_id, edit_id in (("request-other", "edit-1"), ("request-1", "edit-other")):
            with self.assertRaises(AgentApplyEditConflict) as raised:
                self.store.update_agent_apply_edit(
                    "conversation-1",
                    request_id=request_id,
                    edit_id=edit_id,
                    status="applied",
                    evidence={},
                )
            self.assertEqual(raised.exception.code, "agent_apply_edit_identity_mismatch")

        turn = self.store.get_agent_conversation("conversation-1", "project-1")["turns"][0]
        self.assertEqual(turn["applyEdit"]["status"], "pending_apply")

    def test_storage_patch_exposes_cas_and_conflicts(self) -> None:
        self.store.append_agent_conversation_turn(
            "conversation-1", "project-1", pending_turn()
        )
        client = TestClient(create_app(self.store))

        response = client.patch(
            "/api/agent-conversations/conversation-1/turns/request-1/apply-edit",
            json={
                "editId": "edit-1",
                "status": "failed_conflict",
                "evidence": {"code": "base_changed"},
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "failed_conflict")
        conflict = client.patch(
            "/api/agent-conversations/conversation-1/turns/request-1/apply-edit",
            json={"editId": "edit-1", "status": "applied", "evidence": {}},
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["detail"]["code"], "agent_apply_edit_terminal")

    def test_concurrent_append_transaction_allows_only_one_pending_edit(self) -> None:
        barrier = threading.Barrier(2)
        outcomes: list[str] = []

        def append(request_id: str, edit_id: str) -> None:
            barrier.wait()
            try:
                self.store.append_agent_conversation_turn(
                    "conversation-1",
                    "project-1",
                    pending_turn(request_id, edit_id),
                )
                outcomes.append("saved")
            except AgentApplyEditConflict as exc:
                outcomes.append(exc.code)

        threads = [
            threading.Thread(target=append, args=("request-a", "edit-a")),
            threading.Thread(target=append, args=("request-b", "edit-b")),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertCountEqual(outcomes, ["saved", "agent_apply_edit_pending"])
        detail = self.store.get_agent_conversation("conversation-1", "project-1")
        self.assertEqual(len(detail["turns"]), 1)

    def test_terminal_cas_rejects_incomplete_authority_evidence(self) -> None:
        self.store.append_agent_conversation_turn(
            "conversation-1", "project-1", pending_turn()
        )

        with self.assertRaises(ValueError):
            self.store.update_agent_apply_edit(
                "conversation-1",
                request_id="request-1",
                edit_id="edit-1",
                status="applied",
                evidence={},
            )
        with self.assertRaises(ValueError):
            self.store.update_agent_apply_edit(
                "conversation-1",
                request_id="request-1",
                edit_id="edit-1",
                status="failed_integrity",
                evidence={},
            )
        turn = self.store.get_agent_conversation("conversation-1", "project-1")["turns"][0]
        self.assertEqual(turn["applyEdit"]["status"], "pending_apply")


class StoryboardApplyEditStorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.data_root = Path(__file__).resolve().parents[1] / "pytest-tmp-native" / f"task-15-10-storyboard-{uuid.uuid4().hex}"
        self.data_root.mkdir(parents=True)
        self.store = JsonCollectionStore(self.data_root / "data")
        self.store.create_project(project())
        self.store.create_agent_conversation({
            "id": "conversation-1", "projectId": "project-1",
            "entrypoint": "workspace-chatbot-agent", "mode": "free-canvas-workspace",
        })

    def tearDown(self) -> None:
        shutil.rmtree(self.data_root)

    def test_storyboard_create_and_changes_share_the_pending_apply_cas_without_document_evidence(self) -> None:
        for kind in ("storyboard_create", "storyboard_changes"):
            with self.subTest(kind=kind):
                request_id = f"request-{kind}"
                edit_id = f"edit-{kind}"
                turn = pending_turn(request_id, edit_id)
                turn["applyEdit"].update({"kind": kind, "nodeId": "storyboard-node-1"})
                turn["assistantMessage"]["canvasEdits"] = [{"kind": kind, "editId": edit_id}]
                saved = self.store.append_agent_conversation_turn("conversation-1", "project-1", turn)
                applied = self.store.update_agent_apply_edit(
                    "conversation-1", request_id=request_id, edit_id=edit_id, status="applied",
                    evidence={"projectRevision": 3, "nodeId": "storyboard-node-1", "kind": "storyboard", "resultDigest": "sha256:" + "a" * 64},
                )
                self.assertEqual(saved["applyEdit"]["kind"], kind)
                self.assertEqual(applied["status"], "applied")


if __name__ == "__main__":
    unittest.main()
