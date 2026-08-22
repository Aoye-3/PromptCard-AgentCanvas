import json
import math
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from promptcard_storage import store as store_module
from promptcard_storage.app import create_app
from promptcard_storage.reference_codes import ReferenceCodeError
from promptcard_storage.store import JsonCollectionStore


TEST_ROOT = Path("F:.test-tmp/task8-canvas-references")


def text_node(node_id: str, text: str = "Alpha", **overrides: object) -> dict:
    return {
        "id": node_id,
        "kind": "text",
        "title": "Text title",
        "position": {"x": 10, "y": 20},
        "width": 420,
        "height": 180,
        "fontSize": "large",
        "segments": [
            {
                "id": f"segment-{node_id}",
                "source": "user",
                "text": text,
                "color": "#111827",
                "createdAt": 1,
                "updatedAt": 1,
            }
        ],
        "meta": {},
        **overrides,
    }


def image_node(node_id: str, asset_id: str = "shared-asset", **overrides: object) -> dict:
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
        "size": 321,
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


class CanvasReferenceResolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=f"{self._testMethodName}-", dir=TEST_ROOT
        )
        self.data_dir = Path(self.temp_dir.name)
        self.store = JsonCollectionStore(self.data_dir)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def registry_rows(self) -> list[tuple[str, str, str, str]]:
        with self.store._connect() as connection:
            return connection.execute(
                """SELECT public_code, namespace, owner_scope, internal_id
                   FROM public_references ORDER BY namespace, owner_scope, internal_id"""
            ).fetchall()

    def raw_project(self, project_id: str) -> dict:
        with self.store._connect() as connection:
            return json.loads(
                connection.execute(
                    "SELECT payload_json FROM projects WHERE id=?", (project_id,)
                ).fetchone()[0]
            )

    def test_project_and_supported_nodes_project_codes_across_create_get_list_update_and_reload(self) -> None:
        created = self.store.create_project(project(
            "project-a", [text_node("text-a"), image_node("image-a")]
        ))
        project_code = created["referenceCode"]
        text_code = created["freeCanvas"]["nodes"][0]["referenceCode"]
        image_code = created["freeCanvas"]["nodes"][1]["referenceCode"]

        self.assertTrue(project_code.startswith("PRJ-"))
        self.assertTrue(text_code.startswith("CVT-"))
        self.assertTrue(image_code.startswith("CVM-"))
        self.assertEqual(self.store.get_project("project-a")["referenceCode"], project_code)
        self.assertEqual(self.store.list_projects()[0]["referenceCode"], project_code)

        reordered = self.store.update_project(
            "project-a",
            {"freeCanvas": {
                "nodes": [created["freeCanvas"]["nodes"][1], created["freeCanvas"]["nodes"][0]],
                "edges": [],
                "meta": {},
            }},
            created["revision"],
        )
        self.assertEqual(
            [node["referenceCode"] for node in reordered["freeCanvas"]["nodes"]],
            [image_code, text_code],
        )
        reopened = JsonCollectionStore(self.data_dir).get_project("project-a")
        self.assertEqual(reopened["referenceCode"], project_code)
        self.assertEqual(
            [node["referenceCode"] for node in reopened["freeCanvas"]["nodes"]],
            [image_code, text_code],
        )

    def test_projection_is_additive_and_public_codes_never_pollute_payload_json(self) -> None:
        created = self.store.create_project(project(
            "clean-project",
            [
                text_node("clean-text", referenceCode="CVT-00000000000000000000000001"),
                image_node("clean-image", referenceCode="CVM-00000000000000000000000001"),
            ],
            referenceCode="PRJ-00000000000000000000000001",
        ))
        self.assertNotEqual(created["referenceCode"], "PRJ-00000000000000000000000001")
        raw = json.dumps(self.raw_project("clean-project"))
        self.assertNotIn("referenceCode", raw)
        self.assertNotIn("PRJ-", raw)
        self.assertNotIn("CVT-", raw)
        self.assertNotIn("CVM-", raw)

    def test_shared_asset_placements_and_same_node_id_cross_project_have_independent_codes(self) -> None:
        first = self.store.create_project(project(
            "project-one", [image_node("placement-a"), image_node("placement-b")]
        ))
        second = self.store.create_project(project(
            "project-two", [image_node("placement-a"), text_node("same-id")]
        ))
        first_codes = [node["referenceCode"] for node in first["freeCanvas"]["nodes"]]
        self.assertNotEqual(first_codes[0], first_codes[1])
        self.assertNotEqual(
            first["freeCanvas"]["nodes"][0]["referenceCode"],
            second["freeCanvas"]["nodes"][0]["referenceCode"],
        )
        self.assertNotEqual(first["referenceCode"], second["referenceCode"])

    def test_unsupported_and_transient_nodes_do_not_get_or_expose_codes(self) -> None:
        nodes = [
            {"id": "arrow-a", "kind": "arrow", "title": "Arrow", "text": "go"},
            {"id": "generator-a", "kind": "image-generator", "title": "Generator"},
            image_node("running-a", meta={"generationState": "running"}),
            image_node("transient-a", transient=True),
            image_node("ready-a", meta={"generationState": "succeeded"}),
        ]
        created = self.store.create_project(project("unsupported", nodes))

        for index in range(4):
            self.assertNotIn("referenceCode", created["freeCanvas"]["nodes"][index])
        self.assertTrue(created["freeCanvas"]["nodes"][4]["referenceCode"].startswith("CVM-"))
        identities = {(row[1], row[2], row[3]) for row in self.registry_rows()}
        self.assertNotIn(("CVM", "unsupported", "running-a"), identities)
        self.assertNotIn(("CVM", "unsupported", "transient-a"), identities)
        self.assertNotIn(("CVM", "unsupported", "arrow-a"), identities)

    def test_exact_project_and_node_resolution_is_bounded_and_redacted(self) -> None:
        long_text = "a" * 3999 + "BCDE"
        created = self.store.create_project(project(
            "bounded",
            [
                text_node("text-long", long_text, title="T" * 130),
                image_node("image-safe", title="I" * 130),
            ],
            title="P" * 130,
        ))
        project_code = created["referenceCode"]
        text_code = created["freeCanvas"]["nodes"][0]["referenceCode"]
        image_code = created["freeCanvas"]["nodes"][1]["referenceCode"]

        project_result = self.store.resolve_project_reference(project_code.lower())
        self.assertEqual(project_result, {
            "reference": {"namespace": "project", "code": project_code},
            "project": {
                "referenceCode": project_code,
                "revision": 1,
                "type": "free-canvas",
                "title": "P" * 120,
            },
        })
        text_result = self.store.resolve_canvas_reference(project_code, text_code.lower())
        self.assertEqual(text_result, {
            "reference": {"namespace": "canvasText", "code": text_code},
            "project": {"referenceCode": project_code, "revision": 1},
            "node": {
                "referenceCode": text_code,
                "kind": "text",
                "title": "T" * 120,
                "text": "a" * 3999 + "B",
                "truncated": True,
            },
        })
        image_result = self.store.resolve_canvas_reference(project_code, image_code)
        self.assertEqual(image_result, {
            "reference": {"namespace": "canvasMedia", "code": image_code},
            "project": {"referenceCode": project_code, "revision": 1},
            "node": {
                "referenceCode": image_code,
                "kind": "image",
                "title": "I" * 120,
                "width": 640,
                "height": 480,
                "contentType": "image/png",
                "size": 321,
            },
        })
        serialized = json.dumps((project_result, text_result, image_result))
        for secret in ("bounded", "text-long", "image-safe", "shared-asset", "private.png", "credentials", "must-not-leak"):
            self.assertNotIn(secret, serialized)

    def test_node_resolution_requires_matching_exact_project_reference(self) -> None:
        first = self.store.create_project(project("scope-a", [text_node("same-node")]))
        second = self.store.create_project(project("scope-b", [text_node("same-node")]))
        first_node_code = first["freeCanvas"]["nodes"][0]["referenceCode"]

        with self.assertRaises(store_module.PromptReferenceError) as caught:
            self.store.resolve_canvas_reference(second["referenceCode"], first_node_code)
        self.assertEqual(caught.exception.code, "canvas_reference_project_mismatch")
        self.assertEqual(caught.exception.reference, {
            "namespace": "canvasText", "code": first_node_code
        })

    def test_parse_namespace_and_unknown_codes_fail_before_identity_lookup(self) -> None:
        created = self.store.create_project(project("parse", [text_node("node")]))
        project_code = created["referenceCode"]
        node_code = created["freeCanvas"]["nodes"][0]["referenceCode"]
        wrong_cases = (
            (lambda: self.store.resolve_project_reference(node_code), "reference_namespace_mismatch"),
            (lambda: self.store.resolve_canvas_reference(node_code, node_code), "reference_namespace_mismatch"),
            (lambda: self.store.resolve_canvas_reference(project_code, project_code), "reference_namespace_mismatch"),
            (lambda: self.store.resolve_canvas_reference(project_code, "PLM-00000000000000000000000001"), "reference_namespace_mismatch"),
            (lambda: self.store.resolve_canvas_reference(project_code, "BAD-00000000000000000000000001"), "invalid_reference_code_prefix"),
        )
        for operation, expected in wrong_cases:
            with self.subTest(expected=expected):
                with self.assertRaises(ReferenceCodeError) as caught:
                    operation()
                self.assertEqual(caught.exception.code, expected)

        with self.assertRaises(store_module.PromptReferenceError) as missing_project:
            self.store.resolve_project_reference("PRJ-00000000000000000000000001")
        self.assertEqual(missing_project.exception.code, "project_reference_not_found")
        with self.assertRaises(store_module.PromptReferenceError) as missing_node:
            self.store.resolve_canvas_reference(
                project_code.lower(), "CVT-00000000000000000000000001"
            )
        self.assertEqual(missing_node.exception.code, "canvas_node_reference_not_found")

    def test_deleted_node_is_detached_while_reorder_and_project_revision_remain_current(self) -> None:
        created = self.store.create_project(project(
            "detach", [text_node("keep"), image_node("remove")]
        ))
        removed_code = created["freeCanvas"]["nodes"][1]["referenceCode"]
        updated = self.store.update_project(
            "detach",
            {"freeCanvas": {
                "nodes": [created["freeCanvas"]["nodes"][0]],
                "edges": [],
                "meta": {},
            }},
            created["revision"],
        )
        with self.assertRaises(store_module.PromptReferenceError) as detached:
            self.store.resolve_canvas_reference(created["referenceCode"], removed_code)
        self.assertEqual(detached.exception.code, "canvas_node_detached")
        self.assertEqual(
            self.store.resolve_project_reference(created["referenceCode"])["project"]["revision"],
            updated["revision"],
        )

    def test_trash_and_restore_keep_codes_and_return_typed_lifecycle_errors(self) -> None:
        created = self.store.create_project(project("lifecycle", [text_node("node")]))
        project_code = created["referenceCode"]
        node_code = created["freeCanvas"]["nodes"][0]["referenceCode"]
        trashed = self.store.trash_projects(["lifecycle"])[0]
        self.assertEqual(trashed["referenceCode"], project_code)
        self.assertEqual(
            self.store.list_project_trash()[0]["payload"]["referenceCode"], project_code
        )
        for operation in (
            lambda: self.store.resolve_project_reference(project_code),
            lambda: self.store.resolve_canvas_reference(project_code, node_code),
        ):
            with self.assertRaises(store_module.PromptReferenceError) as caught:
                operation()
            self.assertEqual(caught.exception.code, "project_trashed")
        restored = self.store.restore_projects(["lifecycle"])[0]
        self.assertEqual(restored["referenceCode"], project_code)
        self.assertEqual(
            restored["freeCanvas"]["nodes"][0]["referenceCode"], node_code
        )

    def test_permanent_delete_retires_project_and_node_codes_and_is_atomic(self) -> None:
        created = self.store.create_project(project(
            "reused", [text_node("same-node"), image_node("same-image")]
        ))
        old_codes = (
            created["referenceCode"],
            created["freeCanvas"]["nodes"][0]["referenceCode"],
            created["freeCanvas"]["nodes"][1]["referenceCode"],
        )
        self.store.trash_projects(["reused"])
        self.store.delete_project_trash(["reused"])
        with self.store._connect() as connection:
            self.assertEqual(
                [],
                connection.execute(
                    "SELECT public_code FROM public_references WHERE internal_id='reused' OR owner_scope='reused'"
                ).fetchall(),
            )
        recreated = self.store.create_project(project(
            "reused", [text_node("same-node"), image_node("same-image")]
        ))
        new_codes = (
            recreated["referenceCode"],
            recreated["freeCanvas"]["nodes"][0]["referenceCode"],
            recreated["freeCanvas"]["nodes"][1]["referenceCode"],
        )
        self.assertTrue(set(old_codes).isdisjoint(new_codes))

        self.store.trash_projects(["reused"])
        before = self.registry_rows()
        with self.store._connect() as connection:
            connection.execute("""
                CREATE TRIGGER reject_task8_project_delete
                BEFORE DELETE ON projects
                BEGIN
                    SELECT RAISE(ABORT, 'injected project delete failure');
                END
            """)
            connection.commit()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "injected project delete failure"):
            self.store.delete_project_trash(["reused"])
        self.assertEqual(self.registry_rows(), before)
        with self.assertRaises(store_module.PromptReferenceError) as still_trashed:
            self.store.resolve_project_reference(recreated["referenceCode"])
        self.assertEqual(still_trashed.exception.code, "project_trashed")

    def test_all_project_write_boundaries_reject_malformed_supported_nodes_atomically(self) -> None:
        malformed = {
            "missing-id": [{key: value for key, value in text_node("x").items() if key != "id"}],
            "duplicate-id": [text_node("duplicate"), image_node("duplicate")],
            "non-string-id": [text_node("x", id=["nested-secret"])],
            "kind-spoof": [text_node("x", kind={"credentials": "secret"})],
            "nested-title": [text_node("x", title={"path": "F:/secret"})],
            "nested-text": [text_node("x", segments=[{"text": {"credentials": "secret"}}])],
            "bad-width": [image_node("x", width={"assetId": "secret"})],
            "bad-height": [image_node("x", height=math.inf)],
        }
        for name, nodes in malformed.items():
            with self.subTest(boundary="create", malformed=name):
                case_dir = self.data_dir / f"create-{name}"
                case_store = JsonCollectionStore(case_dir)
                with self.assertRaisesRegex(ValueError, "Canvas nodes are invalid"):
                    case_store.create_project(project("invalid", nodes))
                self.assertEqual(case_store.list_projects(), [])

            with self.subTest(boundary="update", malformed=name):
                case_dir = self.data_dir / f"update-{name}"
                case_store = JsonCollectionStore(case_dir)
                valid = case_store.create_project(project("existing", [text_node("valid")]))
                with case_store._connect() as connection:
                    before = connection.execute(
                        "SELECT revision, payload_json FROM projects WHERE id='existing'"
                    ).fetchone()
                with self.assertRaisesRegex(ValueError, "Canvas nodes are invalid"):
                    case_store.update_project(
                        "existing", {"freeCanvas": {"nodes": nodes, "edges": [], "meta": {}}}, valid["revision"]
                    )
                with case_store._connect() as connection:
                    after = connection.execute(
                        "SELECT revision, payload_json FROM projects WHERE id='existing'"
                    ).fetchone()
                self.assertEqual(after, before)

    def test_malformed_persisted_node_returns_structured_redacted_store_and_http_error(self) -> None:
        created = self.store.create_project(project("corrupt", [text_node("target")]))
        project_code = created["referenceCode"]
        node_code = created["freeCanvas"]["nodes"][0]["referenceCode"]
        raw = self.raw_project("corrupt")
        raw["freeCanvas"]["nodes"][0]["segments"] = [
            {"text": {"credentials": "secret-value", "path": "F:/private"}}
        ]
        with self.store._connect() as connection:
            connection.execute(
                "UPDATE projects SET payload_json=? WHERE id='corrupt'", (json.dumps(raw),)
            )
            connection.commit()

        with self.assertRaises(store_module.PromptReferenceError) as caught:
            self.store.resolve_canvas_reference(project_code, node_code)
        self.assertEqual(caught.exception.code, "canvas_node_invalid")
        self.assertEqual(caught.exception.reference, {
            "namespace": "canvasText", "code": node_code
        })
        response = TestClient(create_app(self.store)).get(
            f"/api/projects/references/{project_code}/nodes/{node_code}"
        )
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["detail"]["code"], "canvas_node_invalid")
        serialized = json.dumps(response.json())
        for secret in ("credentials", "secret-value", "F:/private", "target", "corrupt"):
            self.assertNotIn(secret, serialized)

    def test_duplicate_persisted_node_ids_do_not_expose_an_ambiguous_code(self) -> None:
        created = self.store.create_project(project(
            "duplicate-persisted", [text_node("target"), image_node("other")]
        ))
        project_code = created["referenceCode"]
        text_code = created["freeCanvas"]["nodes"][0]["referenceCode"]
        raw = self.raw_project("duplicate-persisted")
        raw["freeCanvas"]["nodes"][1]["id"] = "target"
        with self.store._connect() as connection:
            connection.execute(
                "UPDATE projects SET payload_json=? WHERE id='duplicate-persisted'",
                (json.dumps(raw),),
            )
            connection.commit()

        projected = self.store.get_project("duplicate-persisted")
        self.assertNotIn("referenceCode", projected["freeCanvas"]["nodes"][0])
        self.assertNotIn("referenceCode", projected["freeCanvas"]["nodes"][1])
        with self.assertRaises(store_module.PromptReferenceError) as invalid:
            self.store.resolve_canvas_reference(project_code, text_code)
        self.assertEqual(invalid.exception.code, "canvas_node_invalid")

    def test_http_projection_and_exact_resolve_match_store_semantics(self) -> None:
        client = TestClient(create_app(self.store))
        created = client.post("/api/projects", json=project(
            "http-project", [text_node("http-text")]
        )).json()
        project_code = created["referenceCode"]
        node_code = created["freeCanvas"]["nodes"][0]["referenceCode"]
        self.assertEqual(
            client.get("/api/projects").json()["projects"][0]["referenceCode"],
            project_code,
        )
        self.assertEqual(
            client.get("/api/projects/http-project").json()["referenceCode"],
            project_code,
        )
        project_response = client.get(
            f"/api/projects/references/{project_code.lower()}"
        )
        self.assertEqual(project_response.status_code, 200)
        self.assertEqual(project_response.json()["reference"]["code"], project_code)
        node_response = client.get(
            f"/api/projects/references/{project_code.lower()}/nodes/{node_code.lower()}"
        )
        self.assertEqual(node_response.status_code, 200)
        self.assertEqual(node_response.json()["node"]["text"], "Alpha")

    def test_reconcile_preserves_legal_codes_ignores_unsupported_legacy_shape_and_backup_restores_resolution(self) -> None:
        created = self.store.create_project(project(
            "stable", [text_node("legal"), {"id": "legacy", "assetId": "asset-without-kind"}]
        ))
        codes_before = (
            created["referenceCode"], created["freeCanvas"]["nodes"][0]["referenceCode"]
        )
        self.store.reconcile_public_references()
        reopened = JsonCollectionStore(self.data_dir)
        reopened.reconcile_public_references()
        stable = reopened.get_project("stable")
        self.assertEqual(
            (stable["referenceCode"], stable["freeCanvas"]["nodes"][0]["referenceCode"]),
            codes_before,
        )
        identities = {(row[1], row[2], row[3]) for row in self.registry_rows()}
        self.assertNotIn(("CVM", "stable", "legacy"), identities)

        snapshot = self.data_dir / "snapshot"
        self.store.backup(snapshot)
        restored = JsonCollectionStore(snapshot)
        self.assertEqual(
            restored.resolve_canvas_reference(codes_before[0], codes_before[1])["node"]["text"],
            "Alpha",
        )


if __name__ == "__main__":
    unittest.main()
