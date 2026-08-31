from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from promptcard_storage.app import create_app
from promptcard_storage.store import JsonCollectionStore, SCHEMA_VERSION


TEST_ROOT = Path(__file__).resolve().parents[2] / ".test-tmp" / "task18-prompt-retrieval-r1"


def prompt(item_id: str, label: str, content: str, *, category: str = "shot", kind: str = "storyboard") -> dict:
    return {
        "id": item_id,
        "type": kind,
        "category": category,
        "label": label,
        "content": content,
        "usageCount": 0,
        "meta": {},
    }


class PromptRetrievalV18Test(unittest.TestCase):
    def setUp(self) -> None:
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.data_dir = Path(self.temp_dir.name)
        self.store = JsonCollectionStore(self.data_dir)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def search(self, query: str, **kwargs):
        return self.store.search_prompts(
            query,
            caller_kind="bridge",
            caller_id="codex-local",
            **kwargs,
        )

    def test_schema_v18_indexes_english_and_chinese_with_stable_bounded_results(self):
        self.assertEqual(SCHEMA_VERSION, 19)
        first = self.store.create_preset(
            prompt("p1", "Neon opening", "A rainy neon city at night")
        )
        self.store.create_preset(
            prompt("p2", "晨雾城市", "清晨的城市被雾气包围", category="scene")
        )

        english = self.search("neon city", limit=1)
        chinese = self.search("晨雾城市", categories=["scene"])

        self.assertEqual(english["results"][0]["reference"]["code"], first["referenceCode"])
        self.assertEqual(english["results"][0]["matchedFields"], ["label", "content"])
        self.assertEqual(len(english["results"]), 1)
        self.assertRegex(english["results"][0]["digest"], r"^sha256:[0-9a-f]{64}$")
        self.assertEqual(chinese["results"][0]["title"], "晨雾城市")
        self.assertFalse(chinese["degraded"])
        serialized = json.dumps(chinese, ensure_ascii=False)
        self.assertNotIn("preset_id", serialized)
        self.assertNotIn(str(self.data_dir), serialized)

    def test_create_update_trash_restore_and_delete_are_transactionally_indexed(self):
        created = self.store.create_preset(prompt("p1", "Old light", "amber corridor"))
        self.assertEqual(len(self.search("amber")["results"]), 1)

        updated = self.store.update_preset(
            "p1", {"label": "Blue light", "content": "cobalt corridor"}, created["revision"]
        )
        self.assertEqual(self.search("amber")["results"], [])
        self.assertEqual(self.search("cobalt")["results"][0]["revision"], updated["revision"])

        self.store.trash_presets(["p1"])
        self.assertEqual(self.search("cobalt")["results"], [])
        self.store.restore_presets(["p1"])
        self.assertEqual(len(self.search("cobalt")["results"]), 1)
        self.store.trash_presets(["p1"])
        self.store.delete_preset_trash(["p1"])
        self.assertEqual(self.store.prompt_retrieval_health()["indexedDocuments"], 0)

    def test_stale_candidate_is_rejected_audited_and_rebuild_recovers(self):
        self.store.create_preset(prompt("p1", "Stable", "rainy harbor"))
        with self.store._transaction() as connection:
            connection.execute(
                "UPDATE prompt_retrieval_documents SET digest=? WHERE preset_id='p1'",
                ("sha256:" + "0" * 64,),
            )

        rejected = self.search("harbor")
        self.assertEqual(rejected["results"], [])
        self.assertTrue(rejected["degraded"])
        self.assertEqual(rejected["staleRejectedCount"], 1)
        with self.store._connect() as connection:
            audit = connection.execute(
                "SELECT query_digest, result_count, stale_rejected_count, degraded FROM prompt_retrieval_audits WHERE audit_id=?",
                (rejected["auditId"],),
            ).fetchone()
        self.assertEqual(audit[1:], (0, 1, 1))

        self.assertEqual(self.store.rebuild_prompt_retrieval(), {"ok": True, "documents": 1})
        recovered = self.search("harbor")
        self.assertEqual(len(recovered["results"]), 1)
        self.assertFalse(recovered["degraded"])

    def test_filters_validation_and_http_routes_share_the_store_contract(self):
        self.store.create_preset(prompt("p1", "Wide shot", "mountain horizon"))
        self.store.create_preset(prompt("p2", "Portrait", "mountain traveler", kind="subject"))
        client = TestClient(create_app(self.store))

        response = client.post(
            "/api/prompt-retrieval/search",
            json={
                "query": "mountain",
                "types": ["subject"],
                "categories": [],
                "limit": 8,
                "callerKind": "bridge",
                "callerId": "codex-local",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["type"] for item in response.json()["results"]], ["subject"])
        self.assertEqual(client.get("/api/prompt-retrieval/health").json()["state"], "healthy")
        self.assertEqual(client.post("/api/prompt-retrieval/rebuild").json()["documents"], 2)
        self.assertEqual(
            client.post(
                "/api/prompt-retrieval/search",
                json={
                    "query": "mountain",
                    "types": ["subject", "subject"],
                    "callerKind": "bridge",
                    "callerId": "codex-local",
                },
            ).status_code,
            400,
        )

    def test_ranking_and_evidence_budgets_are_deterministic(self):
        for index in range(20):
            self.store.create_preset(
                prompt(
                    f"p{index:02d}",
                    f"Harbor establishing shot {index:02d}",
                    "harbor " + ("atmospheric detail " * 80),
                )
            )

        first = self.search("harbor", limit=20)
        second = self.search("harbor", limit=20)
        first_codes = [item["reference"]["code"] for item in first["results"]]
        second_codes = [item["reference"]["code"] for item in second["results"]]

        self.assertEqual(first_codes, second_codes)
        self.assertLessEqual(len(first["results"]), 20)
        self.assertLessEqual(
            sum(len(item["title"]) + len(item["summary"]) for item in first["results"]),
            12_000,
        )
        with self.assertRaisesRegex(ValueError, "query is invalid"):
            self.search("x" * 257)

    def test_v17_upgrade_builds_the_index_and_preserves_prompt_identity(self):
        created = self.store.create_preset(prompt("p1", "Legacy", "desert wind"))
        with self.store._connect() as connection:
            for trigger in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%prompt_retrieval%'"
            ).fetchall():
                connection.execute(f'DROP TRIGGER "{trigger[0]}"')
            connection.execute("DROP TABLE prompt_retrieval_fts")
            connection.execute("DROP TABLE prompt_retrieval_audits")
            connection.execute("DROP TABLE prompt_retrieval_documents")
            connection.execute("DROP TABLE bridge_delivery_ledger")
            connection.execute(
                "UPDATE schema_migrations SET version=17, name='fixture-v17' WHERE version=19"
            )
            connection.commit()

        upgraded = JsonCollectionStore(self.data_dir)
        result = upgraded.search_prompts(
            "desert", caller_kind="bridge", caller_id="codex-local"
        )
        self.assertEqual(result["results"][0]["reference"]["code"], created["referenceCode"])
        connection = sqlite3.connect(upgraded.database_path)
        try:
            self.assertEqual(
                connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0],
                19,
            )
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
