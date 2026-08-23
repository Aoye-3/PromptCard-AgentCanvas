from __future__ import annotations

import base64
import io
import os
import shutil
import sqlite3
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
import zipfile
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from promptcard_storage.app import create_app
except ModuleNotFoundError:
    TestClient = None
    create_app = None

from promptcard_storage.skill_importer import (
    DEFAULT_INSPECTION_LIMITS,
    SkillPackageImportService,
)
from promptcard_storage.store import SqliteStore


SKILL = b"---\nname: imported-skill\ndescription: Safe import.\n---\n# Imported\n"


def workspace_directory() -> Path:
    root = Path(__file__).resolve().parent / ".task13-fixtures" / uuid.uuid4().hex
    root.mkdir(parents=True)
    return root


def archive_bytes(skill: bytes = SKILL, extra: list[tuple[str, bytes]] | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("SKILL.md", skill)
        for path, content in extra or []:
            archive.writestr(path, content)
    return output.getvalue()


@unittest.skipUnless(TestClient and create_app, "FastAPI contract dependencies are not installed")
class SkillImportApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.data_dir = workspace_directory()
        self.store = SqliteStore(self.data_dir / "storage")
        self.now = 1000.0
        self.ids = iter(["inspection-one", "inspection-two", "inspection-three"])
        limits = replace(
            DEFAULT_INSPECTION_LIMITS,
            inspection_ttl_seconds=10,
            max_inspection_sessions=2,
            max_cached_snapshot_bytes=1024,
            max_total_cached_snapshot_bytes=2048,
        )
        self.service = SkillPackageImportService(
            self.store,
            limits=limits,
            clock=lambda: self.now,
            id_factory=lambda: next(self.ids),
        )
        self.client = TestClient(create_app(self.store, skill_import_service=self.service))

    def tearDown(self) -> None:
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def inspect_archive(self, content: bytes | None = None):
        raw = archive_bytes() if content is None else content
        return self.client.post("/api/skill-package-inspections/archive", json={
            "filename": "package.zip",
            "contentBase64": base64.b64encode(raw).decode("ascii"),
        })

    def import_create(self, inspection_id: str, **skill):
        return self.client.post("/api/skill-package-imports", json={
            "inspectionId": inspection_id,
            "operation": "create",
            "skill": skill,
        })

    def test_inspect_then_source_replacement_imports_the_reviewed_snapshot(self) -> None:
        folder = self.data_dir / "source"
        folder.mkdir()
        skill_file = folder / "SKILL.md"
        skill_file.write_bytes(SKILL)
        inspected = self.client.post("/api/skill-package-inspections/folder", json={"path": str(folder)})
        self.assertEqual(inspected.status_code, 200)
        inspection = inspected.json()
        self.assertEqual(inspection["inspectionId"], "inspection-one")
        self.assertNotIn(str(folder), repr(inspection))
        self.assertNotIn("contentBase64", repr(inspection))

        skill_file.write_bytes(b"---\nname: replaced\ndescription: Replaced.\n---\nREPLACED")
        imported = self.import_create("inspection-one")

        self.assertEqual(imported.status_code, 200)
        detail = self.store.get_skill(imported.json()["skill"]["referenceCode"])
        stored = base64.b64decode(detail["revisions"][0]["entries"][0]["contentBase64"])
        self.assertEqual(stored, SKILL)
        self.assertNotIn("contentBase64", repr(imported.json()))

    def test_folder_filesystem_error_returns_closed_sanitized_inspection(self) -> None:
        folder = self.data_dir / "source-error"
        folder.mkdir()
        (folder / "SKILL.md").write_bytes(SKILL)

        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=False),
            patch(
                "promptcard_storage.skill_importer.os.scandir",
                side_effect=OSError("C:\\private\\credential-folder"),
            ),
        ):
            response = self.client.post(
                "/api/skill-package-inspections/folder",
                json={"path": str(folder)},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["clean"])
        self.assertEqual(
            [finding["code"] for finding in payload["findings"]],
            ["folder.root_changed"],
        )
        self.assertEqual(payload["manifest"]["entries"], [])
        self.assertNotIn("credential-folder", repr(payload))
        self.assertNotIn(str(folder), repr(payload))

    def test_lazy_folder_iteration_error_returns_closed_sanitized_inspection(self) -> None:
        folder = self.data_dir / "source-lazy-error"
        folder.mkdir()
        (folder / "SKILL.md").write_bytes(SKILL)
        root_stat = os.lstat(folder)

        class LazyFailure:
            closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.closed = True

            def __iter__(self):
                return self

            def __next__(self):
                raise OSError("C:\\private\\lazy-api-secret")

        lazy = LazyFailure()
        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=True),
            patch("promptcard_storage.skill_importer.os.open", return_value=851),
            patch("promptcard_storage.skill_importer.os.fstat", return_value=root_stat),
            patch("promptcard_storage.skill_importer.os.scandir", return_value=lazy),
            patch("promptcard_storage.skill_importer.os.close"),
        ):
            response = self.client.post(
                "/api/skill-package-inspections/folder",
                json={"path": str(folder)},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            [finding["code"] for finding in payload["findings"]],
            ["folder.root_changed"],
        )
        self.assertEqual(payload["manifest"]["entries"], [])
        self.assertNotIn("lazy-api-secret", repr(payload))
        self.assertNotIn(str(folder), repr(payload))
        self.assertTrue(lazy.closed)

    def test_dirty_unknown_expired_and_consumed_inspections_fail_closed(self) -> None:
        dirty = self.inspect_archive(archive_bytes(
            b"---\nname: dirty\ndescription: Dirty.\n---\npassword=raw-secret-value"
        ))
        self.assertEqual(dirty.status_code, 200)
        dirty_payload = dirty.json()
        self.assertFalse(dirty_payload["clean"])
        self.assertNotIn("raw-secret-value", repr(dirty_payload))
        dirty_import = self.import_create(dirty_payload["inspectionId"])
        self.assertEqual(dirty_import.status_code, 422)
        self.assertEqual(dirty_import.json()["detail"]["code"], "inspection_not_clean")

        unknown = self.import_create("not-an-inspection")
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(unknown.json()["detail"]["code"], "inspection_unavailable")

        clean = self.inspect_archive()
        clean_id = clean.json()["inspectionId"]
        self.now += 11
        expired = self.import_create(clean_id)
        self.assertEqual(expired.status_code, 410)
        self.assertEqual(expired.json()["detail"]["code"], "inspection_expired")

        fresh = self.inspect_archive()
        fresh_id = fresh.json()["inspectionId"]
        self.assertEqual(self.import_create(fresh_id).status_code, 200)
        consumed = self.import_create(fresh_id)
        self.assertEqual(consumed.status_code, 409)
        self.assertEqual(consumed.json()["detail"]["code"], "inspection_consumed")

    def test_cache_capacity_and_encoded_archive_bound_fail_before_persistence(self) -> None:
        first = self.inspect_archive()
        second = self.inspect_archive()
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        capacity = self.inspect_archive()
        self.assertEqual(capacity.status_code, 429)
        self.assertEqual(capacity.json()["detail"]["code"], "inspection_capacity_exceeded")

        tiny_limits = replace(DEFAULT_INSPECTION_LIMITS, max_archive_bytes=3)
        tiny_service = SkillPackageImportService(self.store, limits=tiny_limits)
        client = TestClient(create_app(self.store, skill_import_service=tiny_service))
        oversized = client.post("/api/skill-package-inspections/archive", json={
            "filename": "x.zip",
            "contentBase64": base64.b64encode(b"1234").decode("ascii"),
        })
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(oversized.json()["detail"]["code"], "archive_too_large")

    def test_success_clears_snapshot_bytes_but_keeps_consumed_tombstone(self) -> None:
        limits = replace(
            DEFAULT_INSPECTION_LIMITS,
            max_total_cached_snapshot_bytes=len(SKILL),
            max_cached_snapshot_bytes=len(SKILL),
            max_inspection_sessions=2,
        )
        service = SkillPackageImportService(self.store, limits=limits)
        client = TestClient(create_app(self.store, skill_import_service=service))
        request = {
            "filename": "package.zip",
            "contentBase64": base64.b64encode(archive_bytes()).decode("ascii"),
        }
        first = client.post("/api/skill-package-inspections/archive", json=request).json()
        imported = client.post("/api/skill-package-imports", json={
            "inspectionId": first["inspectionId"],
            "operation": "create",
            "skill": {"id": "capacity-release"},
        })
        second = client.post("/api/skill-package-inspections/archive", json=request)
        replay = client.post("/api/skill-package-imports", json={
            "inspectionId": first["inspectionId"],
            "operation": "create",
            "skill": {},
        })

        self.assertEqual(imported.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(replay.status_code, 409)
        self.assertEqual(replay.json()["detail"]["code"], "inspection_consumed")

    def test_storage_failure_keeps_exact_snapshot_for_retry(self) -> None:
        inspected = self.inspect_archive()
        inspection_id = inspected.json()["inspectionId"]
        original = self.store.create_skill
        calls = 0

        def fail_once(payload):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise sqlite3.OperationalError("db path and Authorization: Bearer raw-secret")
            return original(payload)

        self.store.create_skill = fail_once
        failed = self.import_create(inspection_id)
        retried = self.import_create(inspection_id)

        self.assertEqual(failed.status_code, 500)
        self.assertEqual(failed.json()["detail"], {
            "code": "skill_import_failed",
            "message": "Skill import could not be persisted",
        })
        self.assertNotIn("raw-secret", repr(failed.json()))
        self.assertEqual(retried.status_code, 200)

    def test_post_commit_malformed_store_result_consumes_snapshot_once(self) -> None:
        inspected = self.inspect_archive().json()
        inspection_id = inspected["inspectionId"]
        baseline = self.raw_skill_counts()
        original = self.store.create_skill
        calls = 0

        def commit_then_malformed(payload):
            nonlocal calls
            calls += 1
            original(payload)
            return {"malformed": True}

        self.store.create_skill = commit_then_malformed
        response = self.import_create(inspection_id, id="post-commit-once")
        retry = self.import_create(inspection_id, id="post-commit-once")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], {
            "code": "skill_import_failed",
            "message": "Skill import was persisted but its response was invalid",
        })
        self.assertEqual(retry.status_code, 409)
        self.assertEqual(retry.json()["detail"]["code"], "inspection_consumed")
        self.assertEqual(calls, 1)
        after = self.raw_skill_counts()
        self.assertEqual(tuple(after[index] - baseline[index] for index in range(4)), (1, 1, 1, 1))

    def test_post_commit_summary_exception_consumes_snapshot_once(self) -> None:
        inspected = self.inspect_archive().json()
        inspection_id = inspected["inspectionId"]
        original = self.store.create_skill
        calls = 0

        def counted_create(payload):
            nonlocal calls
            calls += 1
            return original(payload)

        self.store.create_skill = counted_create
        with patch.object(
            self.service,
            "_import_response",
            side_effect=RuntimeError("unsafe response detail"),
        ):
            response = self.import_create(inspection_id, id="post-commit-summary-once")
        retry = self.import_create(inspection_id, id="post-commit-summary-once")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], {
            "code": "skill_import_failed",
            "message": "Skill import was persisted but its response was invalid",
        })
        self.assertNotIn("unsafe response detail", repr(response.json()))
        self.assertEqual(retry.status_code, 409)
        self.assertEqual(retry.json()["detail"]["code"], "inspection_consumed")
        self.assertEqual(calls, 1)

    def test_concurrent_import_consumes_one_snapshot_once(self) -> None:
        inspected = self.inspect_archive().json()
        payload = {
            "inspectionId": inspected["inspectionId"],
            "operation": "create",
            "skill": {"id": "concurrent-once"},
        }
        original = self.store.create_skill
        calls = 0

        def counted_create(item):
            nonlocal calls
            calls += 1
            return original(item)

        self.store.create_skill = counted_create

        def invoke():
            try:
                return self.service.import_request(payload)
            except Exception as error:
                return error

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _index: invoke(), range(2)))

        self.assertEqual(calls, 1)
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        errors = [result for result in results if not isinstance(result, dict)]
        self.assertEqual([getattr(error, "code", None) for error in errors], ["inspection_consumed"])

    def test_failed_inspection_and_import_create_no_skill_revision_or_public_skl(self) -> None:
        baseline = self.raw_skill_counts()
        dirty = self.inspect_archive(archive_bytes(
            b"---\nname: dirty\ndescription: Dirty.\n---\npassword=actual-secret"
        )).json()

        response = self.import_create(dirty["inspectionId"], id="should-not-exist")

        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.raw_skill_counts(), baseline)

    def test_storage_failure_after_skill_rows_are_staged_rolls_back_and_allows_retry(self) -> None:
        inspected = self.inspect_archive().json()
        baseline = self.raw_skill_counts()
        with patch.object(
            self.store,
            "_ensure_public_reference",
            side_effect=sqlite3.OperationalError("Authorization: Bearer raw-secret"),
        ):
            failed = self.import_create(inspected["inspectionId"], id="atomic-import")

        self.assertEqual(failed.status_code, 500)
        self.assertNotIn("raw-secret", repr(failed.json()))
        self.assertEqual(self.raw_skill_counts(), baseline)
        retried = self.import_create(inspected["inspectionId"], id="atomic-import")
        self.assertEqual(retried.status_code, 200)

    def test_clean_archive_can_add_revision_without_changing_public_identity(self) -> None:
        first = self.inspect_archive().json()
        created = self.import_create(first["inspectionId"]).json()["skill"]
        revised_skill = SKILL.replace(b"# Imported", b"# Revised")
        second = self.inspect_archive(archive_bytes(revised_skill)).json()

        response = self.client.post("/api/skill-package-imports", json={
            "inspectionId": second["inspectionId"],
            "operation": "revise",
            "skill": {"skillId": created["referenceCode"]},
        })

        self.assertEqual(response.status_code, 200)
        revised = response.json()["skill"]
        self.assertEqual(revised["referenceCode"], created["referenceCode"])
        self.assertEqual(revised["revision"], 2)

    def raw_skill_counts(self):
        connection = sqlite3.connect(self.store.database_path)
        try:
            return (
                connection.execute("SELECT COUNT(*) FROM skills").fetchone()[0],
                connection.execute("SELECT COUNT(*) FROM skill_revisions").fetchone()[0],
                connection.execute("SELECT COUNT(*) FROM skill_package_entries").fetchone()[0],
                connection.execute("SELECT COUNT(*) FROM public_references WHERE namespace='SKL'").fetchone()[0],
            )
        finally:
            connection.close()

    def test_api_rejects_urls_unknown_fields_and_malformed_base64_with_closed_errors(self) -> None:
        cases = [
            ({"url": "http://127.0.0.1/secret"}, "invalid_inspection_request"),
            ({"filename": "x.zip", "contentBase64": "%%%"}, "archive_encoding_invalid"),
            ({"filename": "x.zip", "contentBase64": base64.b64encode(b"bad").decode(), "extra": "x"}, "invalid_inspection_request"),
            ("Authorization: Bearer raw-secret", "invalid_inspection_request"),
        ]
        for payload, code in cases:
            with self.subTest(code=code):
                response = self.client.post("/api/skill-package-inspections/archive", json=payload)
                self.assertIn(response.status_code, {400, 413})
                self.assertEqual(response.json()["detail"]["code"], code)
                self.assertEqual(set(response.json()["detail"]), {"code", "message"})
                self.assertNotIn("raw-secret", repr(response.json()))

    def test_import_metadata_cannot_echo_an_absolute_path_or_credential_shaped_identifier(self) -> None:
        for unsafe_id in (r"F:\private\skill", "token=raw-secret"):
            inspected = self.inspect_archive().json()
            with self.subTest(unsafe_id=unsafe_id):
                response = self.import_create(inspected["inspectionId"], id=unsafe_id)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["detail"], {
                    "code": "invalid_import_metadata",
                    "message": "Skill import metadata is invalid",
                })
                self.assertNotIn(unsafe_id, repr(response.json()))

    def test_request_body_is_bounded_before_json_or_base64_materialization(self) -> None:
        service = SkillPackageImportService(
            self.store,
            limits=replace(DEFAULT_INSPECTION_LIMITS, max_control_request_bytes=64),
        )
        client = TestClient(create_app(self.store, skill_import_service=service))

        response = client.post(
            "/api/skill-package-inspections/folder",
            content=b'"' + (b"raw-secret" * 8) + b'"',
            headers={"content-type": "application/json"},
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], {
            "code": "request_too_large",
            "message": "Skill package request exceeds the safety limit",
        })
        self.assertNotIn("raw-secret", repr(response.json()))


if __name__ == "__main__":
    unittest.main()
