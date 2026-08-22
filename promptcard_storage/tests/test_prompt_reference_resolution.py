from __future__ import annotations

import json
import shutil
import sqlite3
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from promptcard_storage import store as store_module
from promptcard_storage.app import create_app
from promptcard_storage.reference_codes import ReferenceCodeError
from promptcard_storage.store import JsonCollectionStore


TEST_ROOT = (
    Path(__file__).resolve().parents[2]
    / ".test-tmp"
    / "task6-prompt-references"
)
PNG = b"\x89PNG\r\n\x1a\nasset"


def preset(item_id: str, media: list[dict]) -> dict:
    return {
        "id": item_id,
        "type": "custom",
        "category": "custom",
        "label": f"Prompt {item_id}",
        "content": "Hand-written prompt content",
        "usageCount": 0,
        "createdAt": 10,
        "updatedAt": 10,
        "meta": {"media": media, "privatePath": "F:/must-not-resolve"},
    }


def media(binding_id: str, asset: dict, title: str) -> dict:
    return {
        "id": binding_id,
        "kind": "image",
        "source": "asset",
        "assetId": asset["id"],
        "filename": asset["filename"],
        "contentType": asset["contentType"],
        "size": asset["size"],
        "title": title,
    }


class PromptReferenceResolutionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        shutil.rmtree(TEST_ROOT, ignore_errors=True)
        TEST_ROOT.mkdir(parents=True)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_ROOT, ignore_errors=True)

    def setUp(self) -> None:
        self.data_dir = TEST_ROOT / self._testMethodName / "data"
        self.data_dir.mkdir(parents=True)
        self.store = JsonCollectionStore(self.data_dir)

    def connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.data_dir / "promptcard.sqlite3")

    def create_prompt(self, item_id: str = "prompt-one") -> tuple[dict, dict, dict]:
        first_asset = self.store.save_asset("first.png", "image/png", PNG + b"-first")
        second_asset = self.store.save_asset("second.png", "image/png", PNG + b"-second")
        created = self.store.create_preset(preset(item_id, [
            media("binding-first", first_asset, "First"),
            media("binding-second", second_asset, "Second"),
        ]))
        return created, first_asset, second_asset

    def test_create_get_list_and_exact_plp_resolution_project_codes_without_polluting_payload(self) -> None:
        created, _first_asset, _second_asset = self.create_prompt()

        self.assertIn("referenceCode", created)
        self.assertRegex(created["referenceCode"], r"^PLP-[0-7][0-9A-HJKMNP-TV-Z]{25}$")
        created_media = created["meta"]["media"]
        self.assertEqual([item["id"] for item in created_media], ["binding-first", "binding-second"])
        self.assertTrue(all(item["referenceCode"].startswith("PLM-") for item in created_media))
        self.assertEqual(self.store.get_preset(created["id"])["referenceCode"], created["referenceCode"])
        self.assertEqual(self.store.list_presets()[0]["referenceCode"], created["referenceCode"])

        resolved = self.store.resolve_prompt_reference(created["referenceCode"].lower())

        self.assertEqual(resolved["reference"], {
            "namespace": "promptBundle",
            "code": created["referenceCode"],
        })
        self.assertEqual(resolved["prompt"], {
            "referenceCode": created["referenceCode"],
            "revision": 1,
            "type": "custom",
            "category": "custom",
            "label": "Prompt prompt-one",
            "content": "Hand-written prompt content",
        })
        self.assertEqual(
            [item["referenceCode"] for item in resolved["media"]],
            [item["referenceCode"] for item in created_media],
        )
        self.assertEqual(
            resolved["media"],
            [
                {
                    "referenceCode": created_media[0]["referenceCode"],
                    "kind": "image",
                    "filename": "first.png",
                    "contentType": "image/png",
                    "size": len(PNG + b"-first"),
                    "title": "First",
                },
                {
                    "referenceCode": created_media[1]["referenceCode"],
                    "kind": "image",
                    "filename": "second.png",
                    "contentType": "image/png",
                    "size": len(PNG + b"-second"),
                    "title": "Second",
                },
            ],
        )
        self.assertNotIn("assetId", json.dumps(resolved))
        self.assertNotIn("privatePath", json.dumps(resolved))
        with self.connect() as connection:
            raw_payload = connection.execute(
                "SELECT payload_json FROM presets WHERE id=?", (created["id"],)
            ).fetchone()[0]
        self.assertNotIn("referenceCode", raw_payload)
        self.assertNotIn("PLP-", raw_payload)
        self.assertNotIn("PLM-", raw_payload)

    def test_prompt_without_media_resolves_as_an_empty_ordered_bundle(self) -> None:
        created = self.store.create_preset({
            "id": "text-only",
            "type": "custom",
            "category": "custom",
            "label": "Text only",
            "content": "No media needed",
            "meta": {},
        })

        resolved = self.store.resolve_prompt_reference(created["referenceCode"])

        self.assertEqual(resolved["prompt"]["revision"], 1)
        self.assertEqual(resolved["media"], [])

    def test_update_reorders_reuses_and_detaches_binding_codes(self) -> None:
        created, _first_asset, _second_asset = self.create_prompt()
        original = {item["id"]: item["referenceCode"] for item in created["meta"]["media"]}
        third_asset = self.store.save_asset("third.png", "image/png", PNG + b"-third")
        reordered = [
            created["meta"]["media"][1],
            created["meta"]["media"][0],
            media("binding-third", third_asset, "Third"),
        ]

        updated = self.store.update_preset(
            created["id"],
            {"label": "Renamed", "meta": {"media": reordered}},
            created["revision"],
        )

        self.assertEqual(updated["referenceCode"], created["referenceCode"])
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(
            [item["referenceCode"] for item in updated["meta"]["media"][:2]],
            [original["binding-second"], original["binding-first"]],
        )
        third_code = updated["meta"]["media"][2]["referenceCode"]
        self.assertNotIn(third_code, set(original.values()))
        plm_resolved = self.store.resolve_prompt_reference(third_code)
        self.assertEqual(plm_resolved["reference"], {
            "namespace": "promptMedia",
            "code": third_code,
        })
        self.assertEqual(plm_resolved["prompt"]["revision"], 2)
        self.assertEqual(
            [item["referenceCode"] for item in plm_resolved["media"]],
            [original["binding-second"], original["binding-first"], third_code],
        )

        removed = self.store.update_preset(
            created["id"],
            {"meta": {"media": updated["meta"]["media"][::2]}},
            updated["revision"],
        )
        self.assertEqual(removed["referenceCode"], created["referenceCode"])
        with self.assertRaises(store_module.PromptReferenceError) as caught:
            self.store.resolve_prompt_reference(original["binding-first"])
        self.assertEqual(caught.exception.code, "prompt_media_detached")
        self.assertEqual(caught.exception.reference, {
            "namespace": "promptMedia",
            "code": original["binding-first"],
        })
        with self.connect() as connection:
            raw_payload = connection.execute(
                "SELECT payload_json FROM presets WHERE id=?", (created["id"],)
            ).fetchone()[0]
        self.assertNotIn("referenceCode", raw_payload)
        self.assertNotIn("PLM-", raw_payload)

    def test_duplicate_prompt_and_binding_receive_independent_codes_even_for_shared_asset_and_binding_id(self) -> None:
        shared_asset = self.store.save_asset("shared.png", "image/png", PNG + b"-shared")
        first = self.store.create_preset(preset(
            "prompt-first", [media("same-binding", shared_asset, "Shared")]
        ))
        duplicate = self.store.create_preset(preset(
            "prompt-duplicate", [media("same-binding", shared_asset, "Shared")]
        ))

        self.assertNotEqual(first["referenceCode"], duplicate["referenceCode"])
        self.assertNotEqual(
            first["meta"]["media"][0]["referenceCode"],
            duplicate["meta"]["media"][0]["referenceCode"],
        )

    def test_prompt_trash_and_restore_preserve_codes_and_return_typed_lifecycle_errors(self) -> None:
        created, _first_asset, _second_asset = self.create_prompt()
        prompt_code = created["referenceCode"]
        media_code = created["meta"]["media"][0]["referenceCode"]

        trashed = self.store.trash_presets([created["id"]])

        self.assertEqual(trashed[0]["referenceCode"], prompt_code)
        self.assertEqual(
            self.store.list_preset_trash()[0]["payload"]["referenceCode"], prompt_code
        )
        cases = (
            (prompt_code, "prompt_bundle_trashed", "promptBundle"),
            (media_code, "prompt_media_owner_trashed", "promptMedia"),
        )
        for code, error_code, namespace in cases:
            with self.subTest(code=code):
                with self.assertRaises(store_module.PromptReferenceError) as caught:
                    self.store.resolve_prompt_reference(code)
                self.assertEqual(caught.exception.code, error_code)
                self.assertEqual(caught.exception.reference, {
                    "namespace": namespace,
                    "code": code,
                })

        restored = self.store.restore_presets([created["id"]])
        self.assertEqual(restored[0]["referenceCode"], prompt_code)
        self.assertEqual(
            self.store.resolve_prompt_reference(media_code)["prompt"]["referenceCode"],
            prompt_code,
        )

    def test_media_asset_trash_restore_and_missing_row_are_plm_scoped(self) -> None:
        created, first_asset, _second_asset = self.create_prompt()
        first_media_code = created["meta"]["media"][0]["referenceCode"]
        self.store.trash_storage_artifacts([first_asset["id"]])

        with self.assertRaises(store_module.PromptReferenceError) as caught:
            self.store.resolve_prompt_reference(created["referenceCode"])
        self.assertEqual(caught.exception.code, "prompt_media_asset_trashed")
        self.assertEqual(caught.exception.reference, {
            "namespace": "promptMedia",
            "code": first_media_code,
        })

        self.store.restore_storage_artifacts([first_asset["id"]])
        self.assertEqual(
            self.store.resolve_prompt_reference(first_media_code)["reference"]["code"],
            first_media_code,
        )
        with self.connect() as connection:
            connection.execute("DELETE FROM assets WHERE asset_id=?", (first_asset["id"],))
            connection.commit()
        with self.assertRaises(store_module.PromptReferenceError) as missing:
            self.store.resolve_prompt_reference(first_media_code)
        self.assertEqual(missing.exception.code, "prompt_media_asset_missing")
        self.assertEqual(missing.exception.reference["code"], first_media_code)

    def test_parse_namespace_and_unknown_reference_errors_are_stable_before_lookup(self) -> None:
        created, _first_asset, _second_asset = self.create_prompt()
        project_code = self.store.ensure_public_reference("PRJ", created["id"])
        with self.assertRaisesRegex(ReferenceCodeError, "reference_namespace_mismatch") as wrong:
            self.store.resolve_prompt_reference(project_code)
        self.assertEqual(wrong.exception.code, "reference_namespace_mismatch")
        with self.assertRaisesRegex(ReferenceCodeError, "invalid_reference_code_prefix") as invalid:
            self.store.resolve_prompt_reference("BAD-00000000000000000000000001")
        self.assertEqual(invalid.exception.code, "invalid_reference_code_prefix")

        unknown_cases = (
            ("PLP-00000000000000000000000001", "prompt_bundle_reference_not_found", "promptBundle"),
            ("PLM-00000000000000000000000001", "prompt_media_reference_not_found", "promptMedia"),
        )
        for code, error_code, namespace in unknown_cases:
            with self.subTest(code=code):
                with self.assertRaises(store_module.PromptReferenceError) as caught:
                    self.store.resolve_prompt_reference(code.lower())
                self.assertEqual(caught.exception.code, error_code)
                self.assertEqual(caught.exception.reference, {
                    "namespace": namespace,
                    "code": code,
                })

    def test_browser_import_reconcile_and_sqlite_backup_restore_preserve_or_create_independent_codes(self) -> None:
        shared_asset = self.store.save_asset("import.png", "image/png", PNG + b"-import")
        existing = self.store.create_preset(preset(
            "existing", [media("same-binding", shared_asset, "Existing")]
        ))
        result = self.store.migrate_browser_payload({
            "migrationId": "task6-import",
            "projects": [],
            "presets": [preset(
                "imported", [media("same-binding", shared_asset, "Imported")]
            )],
        })
        imported = next(item for item in self.store.list_presets() if item["id"] == "imported")
        before = (imported["referenceCode"], imported["meta"]["media"][0]["referenceCode"])

        self.assertEqual(result, {"projects": 0, "presets": 1, "alreadyApplied": False})
        self.assertNotEqual(existing["referenceCode"], before[0])
        self.assertNotEqual(existing["meta"]["media"][0]["referenceCode"], before[1])
        self.store.reconcile_public_references()
        replay = self.store.migrate_browser_payload({
            "migrationId": "task6-import", "projects": [], "presets": []
        })
        after = self.store.get_preset("imported")
        self.assertEqual(replay, {"projects": 0, "presets": 0, "alreadyApplied": True})
        self.assertEqual(
            (after["referenceCode"], after["meta"]["media"][0]["referenceCode"]),
            before,
        )

        snapshot = TEST_ROOT / self._testMethodName / "snapshot"
        self.store.backup(snapshot)
        restored = JsonCollectionStore(snapshot)
        self.assertEqual(
            restored.resolve_prompt_reference(before[1])["prompt"]["referenceCode"],
            before[0],
        )

    def test_http_exact_resolve_and_structured_errors_match_store_semantics(self) -> None:
        created, _first_asset, _second_asset = self.create_prompt()
        client = TestClient(create_app(self.store))

        response = client.get(
            f"/api/prompt-library/references/{created['referenceCode'].lower()}"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["reference"], {
            "namespace": "promptBundle", "code": created["referenceCode"]
        })
        listed = client.get("/api/presets").json()["presets"][0]
        fetched = client.get(f"/api/presets/{created['id']}").json()
        self.assertEqual(listed["referenceCode"], created["referenceCode"])
        self.assertEqual(fetched["meta"]["media"][0]["referenceCode"], created["meta"]["media"][0]["referenceCode"])
        updated = client.put(f"/api/presets/{created['id']}", json={
            "revision": created["revision"], "updates": {"label": "HTTP rename"}
        }).json()
        self.assertEqual(updated["referenceCode"], created["referenceCode"])
        trashed_api = client.post("/api/presets/trash", json={
            "ids": [created["id"]], "deletedBy": "user"
        }).json()["presets"][0]
        self.assertEqual(trashed_api["referenceCode"], created["referenceCode"])
        trash_payload = client.get("/api/presets/trash").json()["items"][0]["payload"]
        self.assertEqual(trash_payload["referenceCode"], created["referenceCode"])
        restored_api = client.post("/api/presets/trash/restore", json={
            "ids": [created["id"]]
        }).json()["presets"][0]
        self.assertEqual(restored_api["referenceCode"], created["referenceCode"])

        wrong = client.get("/api/prompt-library/references/PRJ-00000000000000000000000001")
        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(wrong.json()["detail"]["code"], "reference_namespace_mismatch")
        unknown = client.get("/api/prompt-library/references/PLM-00000000000000000000000001")
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(unknown.json()["detail"], {
            "code": "prompt_media_reference_not_found",
            "message": "Prompt media reference was not found",
            "detail": {
                "reference": {
                    "namespace": "promptMedia",
                    "code": "PLM-00000000000000000000000001",
                }
            },
        })

        self.store.trash_presets([created["id"]])
        trashed = client.get(
            f"/api/prompt-library/references/{created['referenceCode']}"
        )
        self.assertEqual(trashed.status_code, 410)
        self.assertEqual(trashed.json()["detail"]["code"], "prompt_bundle_trashed")
        self.assertEqual(
            trashed.json()["detail"]["detail"]["reference"]["namespace"],
            "promptBundle",
        )


if __name__ == "__main__":
    unittest.main()
