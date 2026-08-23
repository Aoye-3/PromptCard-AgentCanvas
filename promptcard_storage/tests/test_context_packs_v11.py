from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from promptcard_storage import store as store_module
from promptcard_storage.app import create_app
from promptcard_storage.maintenance import restore_backup
from promptcard_storage.reference_codes import ReferenceCodeError
from promptcard_storage.store import JsonCollectionStore, PromptReferenceError, RevisionConflict


TEST_ROOT = Path("F:.test-tmp/task10-context-packs")
CONTRACT_SCHEMA_PATH = (
    Path(__file__).resolve().parents[2]
    / "contracts"
    / "promptcard-bridge"
    / "v1"
    / "schema.json"
)
PNG = b"\x89PNG\r\n\x1a\ncontext-pack"


def contract_validator(name: str) -> Draft202012Validator:
    schema = json.loads(CONTRACT_SCHEMA_PATH.read_text(encoding="utf-8"))
    registry = Registry().with_resources([
        (
            definition["$id"],
            Resource.from_contents(definition, default_specification=DRAFT202012),
        )
        for definition in schema["$defs"].values()
        if isinstance(definition, dict) and "$id" in definition
    ])
    return Draft202012Validator(schema["$defs"][name], registry=registry)


def text_node(node_id: str, text: str = "Alpha", **overrides: object) -> dict:
    return {
        "id": node_id,
        "kind": "text",
        "title": "Text title",
        "position": {"x": 10, "y": 20},
        "width": 420,
        "height": 180,
        "fontSize": "large",
        "segments": [{"id": f"segment-{node_id}", "source": "user", "text": text}],
        "meta": {},
        **overrides,
    }


def image_node(node_id: str, asset_id: str, **overrides: object) -> dict:
    return {
        "id": node_id,
        "kind": "image",
        "title": "Image title",
        "position": {"x": 30, "y": 40},
        "width": 640,
        "height": 480,
        "assetId": asset_id,
        "imageUrl": "https://secret.invalid/private.png",
        "contentType": "image/png",
        "size": len(PNG),
        "annotations": [],
        "meta": {"credentials": "must-not-leak"},
        **overrides,
    }


def project(project_id: str, nodes: list[dict], **overrides: object) -> dict:
    return {
        "id": project_id,
        "title": "Canvas project",
        "type": "free-canvas",
        "pages": [],
        "currentPage": 0,
        "freeCanvas": {"nodes": nodes, "edges": [], "meta": {}},
        "meta": {"private": "must-not-leak"},
        **overrides,
    }


def preset(item_id: str, asset: dict) -> dict:
    return {
        "id": item_id,
        "type": "custom",
        "category": "custom",
        "label": f"Prompt {item_id}",
        "content": "Prompt content",
        "usageCount": 0,
        "createdAt": 10,
        "updatedAt": 10,
        "meta": {"media": [{
            "id": "binding-one",
            "kind": "image",
            "source": "asset",
            "assetId": asset["id"],
            "filename": asset["filename"],
            "contentType": asset["contentType"],
            "size": asset["size"],
            "title": "Prompt source",
        }]},
    }


class ContextPackV11Test(unittest.TestCase):
    def setUp(self) -> None:
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.data_dir = Path(self.temp_dir.name)
        self.store = JsonCollectionStore(self.data_dir)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def create_sources(self, project_id: str = "project-a") -> tuple[dict, dict, dict]:
        asset = self.store.save_asset("source.png", "image/png", PNG)
        prompt = self.store.create_preset(preset(f"prompt-{project_id}", asset))
        prompt_code = prompt["referenceCode"]
        prompt_media_code = prompt["meta"]["media"][0]["referenceCode"]
        created = self.store.create_project(project(project_id, [
            text_node(
                "text-a",
                "X" * 4500,
                promptLibraryReferences=[
                    prompt_code.lower(), prompt_media_code.lower(), prompt_code.lower()
                ],
            ),
            image_node(
                "image-a",
                asset["id"],
                canvasMediaReferences=[],
            ),
        ]))
        image_code = created["freeCanvas"]["nodes"][1]["referenceCode"]
        current = self.store.get_project(project_id)
        raw = current["freeCanvas"]["nodes"]
        raw[0]["canvasMediaReferences"] = [image_code.lower(), image_code.lower()]
        current = self.store.update_project(
            project_id,
            {"freeCanvas": current["freeCanvas"]},
            current["revision"],
        )
        return current, asset, prompt

    def create_plm_source(self, suffix: str) -> tuple[dict, dict, str]:
        asset = self.store.save_asset(f"{suffix}.png", "image/png", PNG + suffix.encode())
        prompt = self.store.create_preset(preset(f"prompt-{suffix}", asset))
        media_code = prompt["meta"]["media"][0]["referenceCode"]
        created = self.store.create_project(project(
            f"project-{suffix}",
            [text_node("text-a", promptLibraryReferences=[media_code])],
        ))
        return created, asset, media_code

    @staticmethod
    def pack_payload(created: dict, node_codes: list[str] | None = None) -> dict:
        selected = node_codes or [
            node["referenceCode"] for node in created["freeCanvas"]["nodes"]
        ]
        return {
            "projectCode": created["referenceCode"],
            "projectRevision": created["revision"],
            "nodeCodes": selected,
            "placementHint": {
                "mode": "after-selection",
                "anchorNodeCodes": list(reversed(selected)),
            },
            "creator": "developer-001",
        }

    def test_fresh_schema_and_real_v10_v11_databases_migrate_to_current(self) -> None:
        self.assertEqual(store_module.SCHEMA_VERSION, 14)
        self.assertTrue(self.store.health()["capabilities"]["contextPacks"])
        with self.store._connect() as connection:
            self.assertEqual(
                connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0],
                store_module.SCHEMA_VERSION,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='context_packs'"
                ).fetchone()[0],
                "context_packs",
            )
            self.assertEqual(connection.execute("PRAGMA recursive_triggers").fetchone()[0], 1)
            self.assertIsNotNone(connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='context_packs_no_replace'"
            ).fetchone())

        legacy_dir = self.data_dir / "legacy-v10"
        legacy = JsonCollectionStore(legacy_dir)
        with legacy._connect() as connection:
            connection.execute("DROP TRIGGER context_packs_snapshot_immutable")
            connection.execute("DROP TRIGGER context_packs_revocation_once")
            connection.execute("DROP TRIGGER context_packs_no_delete")
            connection.execute("DROP TRIGGER IF EXISTS context_packs_no_replace")
            connection.execute("DROP TABLE context_packs")
            connection.execute("DELETE FROM schema_migrations")
            connection.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (10, 'add-public-reference-registry', 1)"
            )
            connection.commit()
        reopened = JsonCollectionStore(legacy_dir)
        with reopened._connect() as connection:
            self.assertEqual(
                connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0],
                store_module.SCHEMA_VERSION,
            )
            self.assertIsNotNone(connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='context_packs_snapshot_immutable'"
            ).fetchone())
            self.assertIsNotNone(connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='context_packs_no_replace'"
            ).fetchone())

        legacy_v11_dir = self.data_dir / "legacy-v11"
        legacy_v11 = JsonCollectionStore(legacy_v11_dir)
        with legacy_v11._connect() as connection:
            connection.execute("DROP TRIGGER IF EXISTS context_packs_no_replace")
            connection.execute("DELETE FROM schema_migrations")
            connection.execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (11, 'add-canvas-context-packs', 1)"
            )
            connection.commit()
        reopened_v11 = JsonCollectionStore(legacy_v11_dir)
        with reopened_v11._connect() as connection:
            self.assertEqual(
                connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0],
                store_module.SCHEMA_VERSION,
            )
            self.assertIsNotNone(connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='context_packs_no_replace'"
            ).fetchone())

    def test_create_resolve_is_ordered_bounded_redacted_and_contract_valid(self) -> None:
        created, _asset, prompt = self.create_sources()
        codes = [node["referenceCode"] for node in created["freeCanvas"]["nodes"]]
        payload = self.pack_payload(created, list(reversed(codes)))
        payload["projectCode"] = payload["projectCode"].lower()
        payload["nodeCodes"] = [code.lower() for code in payload["nodeCodes"]]
        payload["placementHint"]["anchorNodeCodes"] = [
            code.lower() for code in payload["placementHint"]["anchorNodeCodes"]
        ]
        inspection = self.store.create_context_pack(payload)
        self.assertRegex(inspection["cvcCode"], r"^CVC-[0-7][0-9A-HJKMNP-TV-Z]{25}$")
        self.assertEqual(inspection["projectCode"], created["referenceCode"])
        self.assertEqual(inspection["projectRevision"], created["revision"])
        self.assertEqual(inspection["creator"], "developer-001")
        self.assertEqual(inspection["placementHint"]["anchorNodeCodes"], codes)

        resolved = self.store.resolve_context_pack(inspection["cvcCode"].lower())
        contract_validator("ContextPack").validate(resolved)
        self.assertEqual(
            [entry["reference"]["code"] for entry in resolved["entries"]],
            list(reversed(codes)),
        )
        for entry in resolved["entries"]:
            self.assertEqual(
                entry["contentDigest"],
                "sha256:" + hashlib.sha256(entry["content"].encode("utf-8")).hexdigest(),
            )
        text_content = json.loads(resolved["entries"][1]["content"])
        self.assertEqual(len(text_content["text"]), 4000)
        self.assertTrue(text_content["truncated"])
        self.assertEqual(len(text_content["title"]), len("Text title"))
        self.assertEqual(resolved["sourceCodes"], [
            prompt["referenceCode"],
            prompt["meta"]["media"][0]["referenceCode"],
            codes[1],
        ])
        serialized = json.dumps(inspection) + json.dumps(resolved)
        for forbidden in (
            "assetId", "imageUrl", "credentials", "secret.invalid", "private",
            str(self.data_dir), PNG.hex(),
        ):
            self.assertNotIn(forbidden, serialized)

    def test_create_rejects_unavailable_prompt_media_assets_without_leaking_details(self) -> None:
        def assert_unavailable(suffix: str, mutate) -> None:
            created, asset, media_code = self.create_plm_source(suffix)
            mutate(asset)
            with self.assertRaises(PromptReferenceError) as unavailable:
                self.store.create_context_pack(self.pack_payload(created))
            self.assertEqual(unavailable.exception.code, "source_unavailable")
            self.assertEqual(
                unavailable.exception.reference,
                {"namespace": "promptMedia", "code": media_code},
            )
            serialized = json.dumps({
                "code": unavailable.exception.code,
                "reference": unavailable.exception.reference,
            })
            self.assertNotIn(asset["id"], serialized)
            self.assertNotIn(str(self.data_dir), serialized)

        def trash(asset: dict) -> None:
            self.store.trash_storage_artifacts([asset["id"]], "user", "test")

        def delete_row(asset: dict) -> None:
            with self.store._connect() as connection:
                connection.execute("DELETE FROM assets WHERE asset_id=?", (asset["id"],))
                connection.commit()

        def mark_deleted(asset: dict) -> None:
            with self.store._connect() as connection:
                connection.execute(
                    "UPDATE assets SET lifecycle_status='deleted', deleted_at=1 WHERE asset_id=?",
                    (asset["id"],),
                )
                connection.commit()

        def delete_file(asset: dict) -> None:
            (self.data_dir / "assets" / asset["id"]).unlink()

        for suffix, mutation in (
            ("create-trash", trash),
            ("create-row-missing", delete_row),
            ("create-deleted", mark_deleted),
            ("create-file-missing", delete_file),
        ):
            with self.subTest(lifecycle=suffix):
                assert_unavailable(suffix, mutation)

    def test_resolve_rechecks_prompt_media_asset_lifecycle_without_leaking_details(self) -> None:
        def assert_unavailable(suffix: str, mutate) -> None:
            created, asset, media_code = self.create_plm_source(suffix)
            inspection = self.store.create_context_pack(self.pack_payload(created))
            mutate(asset)
            with self.assertRaises(PromptReferenceError) as unavailable:
                self.store.resolve_context_pack(inspection["cvcCode"])
            self.assertEqual(unavailable.exception.code, "source_unavailable")
            self.assertEqual(
                unavailable.exception.reference,
                {"namespace": "promptMedia", "code": media_code},
            )
            serialized = json.dumps({
                "code": unavailable.exception.code,
                "reference": unavailable.exception.reference,
            })
            self.assertNotIn(asset["id"], serialized)
            self.assertNotIn(str(self.data_dir), serialized)

        def trash(asset: dict) -> None:
            self.store.trash_storage_artifacts([asset["id"]], "user", "test")

        def delete_row(asset: dict) -> None:
            with self.store._connect() as connection:
                connection.execute("DELETE FROM assets WHERE asset_id=?", (asset["id"],))
                connection.commit()

        def mark_deleted(asset: dict) -> None:
            with self.store._connect() as connection:
                connection.execute(
                    "UPDATE assets SET lifecycle_status='deleted', deleted_at=1 WHERE asset_id=?",
                    (asset["id"],),
                )
                connection.commit()

        def delete_file(asset: dict) -> None:
            (self.data_dir / "assets" / asset["id"]).unlink()

        for suffix, mutation in (
            ("resolve-trash", trash),
            ("resolve-row-missing", delete_row),
            ("resolve-deleted", mark_deleted),
            ("resolve-file-missing", delete_file),
        ):
            with self.subTest(lifecycle=suffix):
                assert_unavailable(suffix, mutation)

    def test_create_rejects_invalid_selection_revision_scope_and_nodes(self) -> None:
        first, _asset, _prompt = self.create_sources("first")
        second, _asset2, _prompt2 = self.create_sources("second")
        first_code = first["freeCanvas"]["nodes"][0]["referenceCode"]
        second_code = second["freeCanvas"]["nodes"][0]["referenceCode"]

        invalid_payloads = (
            {**self.pack_payload(first), "nodeCodes": []},
            {**self.pack_payload(first), "nodeCodes": [first_code, first_code]},
            {**self.pack_payload(first), "nodeCodes": [first["referenceCode"]]},
            {**self.pack_payload(first), "nodeCodes": [second_code]},
            {**self.pack_payload(first), "placementHint": {
                "mode": "after-selection", "anchorNodeCodes": [second_code]
            }},
            {**self.pack_payload(first), "projectId": "first"},
            {**self.pack_payload(first), "nodeId": "text-a"},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                with self.assertRaises((ValueError, ReferenceCodeError, PromptReferenceError)):
                    self.store.create_context_pack(payload)

        with self.assertRaises(RevisionConflict):
            self.store.create_context_pack({
                **self.pack_payload(first), "projectRevision": first["revision"] - 1
            })

        updated = self.store.update_project(
            "first",
            {"freeCanvas": {"nodes": [{
                **first["freeCanvas"]["nodes"][0], "kind": "arrow"
            }], "edges": [], "meta": {}}},
            first["revision"],
        )
        with self.assertRaises(PromptReferenceError) as detached:
            self.store.create_context_pack({
                **self.pack_payload(updated, [first_code]), "nodeCodes": [first_code],
                "placementHint": {"mode": "after-selection", "anchorNodeCodes": [first_code]},
            })
        self.assertIn(detached.exception.code, {"canvas_node_detached", "canvas_node_invalid"})

    def test_snapshot_is_immutable_and_media_lifecycle_is_rechecked(self) -> None:
        created, asset, _prompt = self.create_sources()
        inspection = self.store.create_context_pack(self.pack_payload(created))
        before = self.store.resolve_context_pack(inspection["cvcCode"])
        updated = self.store.update_project(
            "project-a",
            {
                "title": "Focused elsewhere",
                "currentPage": 99,
                "freeCanvas": {
                    **created["freeCanvas"],
                    "nodes": [
                        {
                            **created["freeCanvas"]["nodes"][0],
                            "title": "Edited after snapshot",
                            "segments": [{"id": "edited", "source": "user", "text": "Beta"}],
                        },
                        created["freeCanvas"]["nodes"][1],
                    ],
                },
            },
            created["revision"],
        )
        self.assertGreater(updated["revision"], created["revision"])
        self.assertEqual(self.store.resolve_context_pack(inspection["cvcCode"]), before)

        with self.store._connect() as connection:
            for assignment in (
                "entries_json='[]'", "project_code='PRJ-00000000000000000000000000'",
                "creator='attacker'", "snapshot_digest='sha256:" + "0" * 64 + "'",
            ):
                with self.subTest(assignment=assignment):
                    with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                        connection.execute(
                            f"UPDATE context_packs SET {assignment} WHERE cvc_code=?",
                            (inspection["cvcCode"],),
                        )

        self.store.trash_storage_artifacts([asset["id"]], "user", "test")
        with self.assertRaises(PromptReferenceError) as unavailable:
            self.store.resolve_context_pack(inspection["cvcCode"])
        self.assertEqual(unavailable.exception.code, "media_unavailable")
        self.assertEqual(unavailable.exception.reference["code"], created["freeCanvas"]["nodes"][1]["referenceCode"])

    def test_revoke_is_idempotent_inspectable_and_blocks_exact_resolve(self) -> None:
        created, _asset, _prompt = self.create_sources()
        inspection = self.store.create_context_pack(self.pack_payload(created))
        first = self.store.revoke_context_pack(
            inspection["cvcCode"].lower(), "developer-002", "No longer needed"
        )
        second = self.store.revoke_context_pack(
            inspection["cvcCode"], "different-actor", "different reason"
        )
        self.assertEqual(second, first)
        self.assertEqual(first["revokedBy"], "developer-002")
        self.assertEqual(first["revocationReason"], "No longer needed")
        self.assertEqual(
            self.store.inspect_context_pack(inspection["cvcCode"])["revokedAt"],
            first["revokedAt"],
        )
        self.assertEqual(
            self.store.list_context_packs(created["referenceCode"])[0]["cvcCode"],
            inspection["cvcCode"],
        )
        with self.assertRaises(PromptReferenceError) as revoked:
            self.store.resolve_context_pack(inspection["cvcCode"])
        self.assertEqual(revoked.exception.code, "context_revoked")
        with self.store._connect() as connection:
            with self.assertRaisesRegex(sqlite3.IntegrityError, "only be set once"):
                connection.execute(
                    """UPDATE context_packs SET revoked_at=?, revoked_by=?, revocation_reason=?
                       WHERE cvc_code=?""",
                    (first["revokedAt"] + 1, "attacker", "overwrite", first["cvcCode"]),
                )
            with self.assertRaisesRegex(sqlite3.IntegrityError, "cannot be deleted"):
                connection.execute(
                    "DELETE FROM context_packs WHERE cvc_code=?", (first["cvcCode"],)
                )

    def test_insert_or_replace_cannot_rewrite_or_unrevoke_context_pack(self) -> None:
        created, _asset, _prompt = self.create_sources()
        inspection = self.store.create_context_pack(self.pack_payload(created))
        revoked = self.store.revoke_context_pack(
            inspection["cvcCode"], "developer-002", "No longer needed"
        )
        before = self.store.inspect_context_pack(inspection["cvcCode"])
        with self.store._connect() as connection:
            original = list(connection.execute(
                self.store._context_pack_select() + " WHERE cvc_code=?",
                (inspection["cvcCode"],),
            ).fetchone())
            replacement = list(original)
            replacement[4] = "attacker"
            replacement[5] = '[{"changed":true}]'
            replacement[9] = "sha256:" + "0" * 64
            replacement[10:13] = [None, None, None]
            with self.assertRaisesRegex(sqlite3.IntegrityError, "cannot be replaced"):
                connection.execute(
                    """INSERT OR REPLACE INTO context_packs(
                           cvc_code, project_code, project_revision, created_at, creator,
                           entries_json, source_codes_json, source_boundaries_json,
                           placement_hint_json, snapshot_digest,
                           revoked_at, revoked_by, revocation_reason
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    replacement,
                )
            self.assertEqual(connection.execute("PRAGMA recursive_triggers").fetchone()[0], 1)
            self.assertEqual(
                connection.execute(
                    self.store._context_pack_select() + " WHERE cvc_code=?",
                    (inspection["cvcCode"],),
                ).fetchone(),
                tuple(original),
            )
        self.assertEqual(self.store.inspect_context_pack(inspection["cvcCode"]), before)
        with self.assertRaises(PromptReferenceError) as blocked:
            self.store.resolve_context_pack(revoked["cvcCode"])
        self.assertEqual(blocked.exception.code, "context_revoked")

    def test_missing_detached_running_malformed_and_invalid_sources_fail_closed(self) -> None:
        missing = self.store.create_project(project(
            "missing-media", [image_node("missing", "asset-does-not-exist")]
        ))
        with self.assertRaises(PromptReferenceError) as unavailable:
            self.store.create_context_pack(self.pack_payload(missing))
        self.assertEqual(unavailable.exception.code, "media_unavailable")

        asset = self.store.save_asset("state.png", "image/png", PNG + b"-state")
        created = self.store.create_project(project(
            "state-project", [text_node("target"), image_node("running", asset["id"])]
        ))
        text_code, image_code = [
            node["referenceCode"] for node in created["freeCanvas"]["nodes"]
        ]
        raw = json.loads(json.dumps(created))
        raw["freeCanvas"]["nodes"][1]["meta"] = {"generationState": "running"}
        running = self.store.update_project(
            "state-project", {"freeCanvas": raw["freeCanvas"]}, created["revision"]
        )
        with self.assertRaises(PromptReferenceError) as transient:
            self.store.create_context_pack({
                **self.pack_payload(running, [image_code]),
                "placementHint": {"mode": "after-selection", "anchorNodeCodes": [image_code]},
            })
        self.assertEqual(transient.exception.code, "canvas_node_detached")

        with self.store._connect() as connection:
            persisted = json.loads(connection.execute(
                "SELECT payload_json FROM projects WHERE id='state-project'"
            ).fetchone()[0])
            persisted["freeCanvas"]["nodes"][0]["segments"] = [{
                "text": {"credentials": "secret", "path": "F:/private"}
            }]
            connection.execute(
                "UPDATE projects SET payload_json=? WHERE id='state-project'",
                (json.dumps(persisted),),
            )
            connection.commit()
        with self.assertRaises(PromptReferenceError) as malformed:
            self.store.create_context_pack({
                **self.pack_payload(running, [text_code]),
                "placementHint": {"mode": "after-selection", "anchorNodeCodes": [text_code]},
            })
        self.assertEqual(malformed.exception.code, "canvas_node_invalid")
        self.assertNotIn("credentials", str(malformed.exception))

        source_project = self.store.create_project(project(
            "bad-source", [text_node(
                "source-node",
                promptLibraryReferences=[
                    store_module.generate_reference_code(
                        "PLP", timestamp_ms=1
                    )
                ],
            )]
        ))
        with self.assertRaises(PromptReferenceError) as source_missing:
            self.store.create_context_pack(self.pack_payload(source_project))
        self.assertEqual(source_missing.exception.code, "source_reference_not_found")
        code = source_project["freeCanvas"]["nodes"][0]["referenceCode"]
        with self.assertRaises(ValueError):
            self.store.create_context_pack({
                **self.pack_payload(source_project, [code]),
                "placementHint": {
                    "mode": "after-selection", "anchorNodeCodes": [code, code.lower()]
                },
            })

        deleted_asset = self.store.save_asset(
            "deleted.png", "image/png", PNG + b"-deleted"
        )
        deletion_project = self.store.create_project(project(
            "deletion-project", [image_node("deleted-image", deleted_asset["id"])]
        ))
        deleted_code = deletion_project["freeCanvas"]["nodes"][0]["referenceCode"]
        deletion_pack = self.store.create_context_pack(self.pack_payload(deletion_project))
        self.store.trash_storage_artifacts([deleted_asset["id"]], "user", "delete")
        without_node = self.store.update_project(
            "deletion-project",
            {"freeCanvas": {"nodes": [], "edges": [], "meta": {}}},
            deletion_project["revision"],
        )
        self.assertEqual(without_node["freeCanvas"]["nodes"], [])
        self.store.delete_storage_artifacts_forever([deleted_asset["id"]])
        with self.assertRaises(PromptReferenceError) as deleted_media:
            self.store.resolve_context_pack(deletion_pack["cvcCode"])
        self.assertEqual(deleted_media.exception.code, "media_unavailable")
        self.assertEqual(deleted_media.exception.reference["code"], deleted_code)

    def test_project_lifecycle_collision_rollback_and_backup_restore(self) -> None:
        created, _asset, _prompt = self.create_sources()
        first = self.store.create_context_pack(self.pack_payload(created))
        with mock.patch.object(store_module, "generate_reference_code", return_value=first["cvcCode"]):
            with self.assertRaises(sqlite3.IntegrityError):
                self.store.create_context_pack(self.pack_payload(created))
        with self.store._connect() as connection:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM context_packs"
            ).fetchone()[0], 1)
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM public_references WHERE namespace='CVC'"
            ).fetchone()[0], 1)

        self.store.trash_projects(["project-a"])
        with self.assertRaises(PromptReferenceError) as trashed:
            self.store.resolve_context_pack(first["cvcCode"])
        self.assertEqual(trashed.exception.code, "project_trashed")
        self.store.restore_projects(["project-a"])
        expected = self.store.resolve_context_pack(first["cvcCode"])

        backup_dir = self.data_dir / "backup"
        restored_dir = self.data_dir / "restored"
        manifest = self.store.backup(backup_dir)
        self.assertEqual(manifest["schemaVersion"], store_module.SCHEMA_VERSION)
        restore_backup(restored_dir, backup_dir)
        restored = JsonCollectionStore(restored_dir)
        self.assertEqual(restored.resolve_context_pack(first["cvcCode"]), expected)

        self.store.trash_projects(["project-a"])
        self.store.delete_project_trash(["project-a"])
        with self.assertRaises(PromptReferenceError) as deleted:
            self.store.resolve_context_pack(first["cvcCode"])
        self.assertEqual(deleted.exception.code, "project_missing")
        self.assertEqual(self.store.inspect_context_pack(first["cvcCode"])["cvcCode"], first["cvcCode"])

    def test_http_routes_use_stable_status_and_closed_payloads(self) -> None:
        created, asset, _prompt = self.create_sources()
        client = TestClient(create_app(self.store))
        response = client.post("/api/context-packs", json=self.pack_payload(created))
        self.assertEqual(response.status_code, 200)
        cvc_code = response.json()["cvcCode"]
        resolved = client.get(f"/api/context-packs/{cvc_code.lower()}/resolve")
        self.assertEqual(resolved.status_code, 200)
        contract_validator("ContextPack").validate(resolved.json())

        wrong = client.get(f"/api/context-packs/{created['referenceCode']}/resolve")
        self.assertEqual(wrong.status_code, 400)
        stale = client.post("/api/context-packs", json={
            **self.pack_payload(created), "projectRevision": 999,
        })
        self.assertEqual(stale.status_code, 409)
        empty = client.post("/api/context-packs", json={
            **self.pack_payload(created), "nodeCodes": [],
        })
        self.assertEqual(empty.status_code, 400)
        non_object = client.post("/api/context-packs", json=[])
        self.assertEqual(non_object.status_code, 400)
        missing_body = client.post("/api/context-packs")
        self.assertEqual(missing_body.status_code, 400)

        revoked = client.post(f"/api/context-packs/{cvc_code}/revoke", json={
            "actor": "developer-001", "reason": "done",
        })
        self.assertEqual(revoked.status_code, 200)
        blocked = client.get(f"/api/context-packs/{cvc_code}/resolve")
        self.assertEqual(blocked.status_code, 410)
        self.assertEqual(blocked.json()["detail"]["code"], "context_revoked")

        serialized = json.dumps(response.json()) + json.dumps(resolved.json())
        for forbidden in (asset["id"], str(self.data_dir), "imageUrl", "credentials", "bytes", "base64"):
            self.assertNotIn(forbidden, serialized)


if __name__ == "__main__":
    unittest.main()
