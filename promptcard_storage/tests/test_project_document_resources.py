from __future__ import annotations

import io
import json
import os
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from promptcard_storage.app import create_app
except ModuleNotFoundError:
    TestClient = None
    create_app = None

from promptcard_storage.document_resources import (
    DOCX_MAX_BYTES,
    MAX_DOCX_ENTRIES,
    MAX_DOCX_EXPANSION_RATIO,
    MAX_DOCX_UNCOMPRESSED_BYTES,
    PDF_MAX_BYTES,
    TEXT_MAX_BYTES,
    DocumentValidationError,
    validate_document,
)
from promptcard_storage.store import MissingItem, SqliteStore


TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / ".test-tmp" / "task15-8-documents"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)

DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
CONTENT_TYPES_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
ROOT_RELS_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
DOCUMENT_XML = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Opening</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>Closing</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>"""


def project(item_id: str) -> dict:
    return {
        "id": item_id,
        "title": item_id,
        "type": "free-canvas",
        "revision": 1,
        "pages": [],
        "currentPage": 0,
        "createdAt": 1,
        "updatedAt": 1,
        "lastOpenedAt": 1,
        "meta": {},
    }


def make_docx(
    *,
    extra_entries: list[tuple[str, bytes]] | None = None,
    remote_relationship: bool = False,
    compression: int = zipfile.ZIP_DEFLATED,
) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=compression) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES_XML)
        archive.writestr("_rels/.rels", ROOT_RELS_XML)
        archive.writestr("word/document.xml", DOCUMENT_XML)
        if remote_relationship:
            archive.writestr(
                "word/_rels/document.xml.rels",
                b"""<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/secret" TargetMode="External"/>
                </Relationships>""",
            )
        for name, content in extra_entries or []:
            archive.writestr(name, content)
    return buffer.getvalue()


class DocumentFormatValidationTest(unittest.TestCase):
    def test_accepts_strict_utf8_text_markdown_pdf_and_ordered_docx_text(self) -> None:
        cases = [
            ("notes.txt", "text/plain", "Alpha\r\nBeta".encode(), "Alpha\nBeta"),
            ("plan.md", "text/markdown", "# H\n\u00e9".encode(), "# H\n\u00e9"),
            ("scan.pdf", "application/pdf", b"%PDF-1.7\nopaque", None),
        ]
        for filename, content_type, content, expected_text in cases:
            with self.subTest(filename=filename):
                validated = validate_document(filename, content_type, content)
                self.assertEqual(validated.normalized_text, expected_text)
                self.assertEqual(validated.size, len(content))
                self.assertEqual(len(validated.sha256), 64)

        docx = validate_document("outline.docx", DOCX_CONTENT_TYPE, make_docx())
        self.assertEqual(docx.normalized_text, "Opening\nA1\tB1\nA2\tB2\nClosing")
        self.assertEqual(docx.extraction_kind, "docx")

    def test_rejects_extension_mime_signature_and_binary_text_mismatches(self) -> None:
        cases = [
            ("notes.md", "text/plain", b"text"),
            ("notes.txt", "application/pdf", b"%PDF-1.7"),
            ("scan.pdf", "application/pdf", b"not-pdf"),
            ("notes.txt", "text/plain", b"\xff"),
            ("notes.txt", "text/plain", b"before\x00after"),
            ("notes.txt", "text/plain", b"before\x01after"),
            ("../notes.txt", "text/plain", b"text"),
        ]
        for filename, content_type, content in cases:
            with self.subTest(filename=filename, content_type=content_type):
                with self.assertRaises(DocumentValidationError):
                    validate_document(filename, content_type, content)

    def test_enforces_fixed_per_format_byte_budgets(self) -> None:
        self.assertEqual(TEXT_MAX_BYTES, 5 * 1024 * 1024)
        self.assertEqual(DOCX_MAX_BYTES, 20 * 1024 * 1024)
        self.assertEqual(PDF_MAX_BYTES, 50 * 1024 * 1024)
        cases = [
            ("large.txt", "text/plain", b"x" * (TEXT_MAX_BYTES + 1)),
            ("large.docx", DOCX_CONTENT_TYPE, b"P" * (DOCX_MAX_BYTES + 1)),
            ("large.pdf", "application/pdf", b"%PDF-" + b"x" * (PDF_MAX_BYTES - 4)),
        ]
        for filename, content_type, content in cases:
            with self.subTest(filename=filename):
                with self.assertRaises(DocumentValidationError):
                    validate_document(filename, content_type, content)

    def test_rejects_corrupt_encrypted_traversal_remote_and_bomb_docx(self) -> None:
        corrupt = b"PK\x03\x04corrupt"
        encrypted = bytearray(make_docx())
        cursor = 0
        while cursor < len(encrypted):
            local_header = encrypted.find(b"PK\x03\x04", cursor)
            central_header = encrypted.find(b"PK\x01\x02", cursor)
            offsets = [offset for offset in (local_header, central_header) if offset >= 0]
            if not offsets:
                break
            offset = min(offsets)
            flag_offset = offset + (6 if offset == local_header else 8)
            encrypted[flag_offset] |= 1
            cursor = offset + 4
        traversal = make_docx(extra_entries=[("../outside.bin", b"x")])
        remote = make_docx(remote_relationship=True)
        too_many = make_docx(
            extra_entries=[(f"word/extra/{index}.xml", b"x") for index in range(MAX_DOCX_ENTRIES)]
        )
        ratio_bomb = make_docx(extra_entries=[("word/huge.bin", b"0" * (1024 * 1024))])

        for name, content in [
            ("corrupt", corrupt),
            ("encrypted", bytes(encrypted)),
            ("traversal", traversal),
            ("remote", remote),
            ("entries", too_many),
            ("ratio", ratio_bomb),
        ]:
            with self.subTest(case=name):
                with self.assertRaises(DocumentValidationError):
                    validate_document("unsafe.docx", DOCX_CONTENT_TYPE, content)

    def test_enforces_total_uncompressed_docx_budget_before_parser(self) -> None:
        oversized = make_docx(
            extra_entries=[("word/large.bin", b"x" * 1024)],
            compression=zipfile.ZIP_STORED,
        )
        with patch(
            "promptcard_storage.document_resources.MAX_DOCX_UNCOMPRESSED_BYTES",
            len(DOCUMENT_XML),
        ):
            with self.assertRaises(DocumentValidationError):
                validate_document("large.docx", DOCX_CONTENT_TYPE, oversized)

    def test_ignores_embedded_and_macro_parts_without_executing_them(self) -> None:
        payload = make_docx(
            extra_entries=[
                ("word/embeddings/object.bin", b"must-not-run"),
                ("word/vbaProject.bin", b"must-not-run"),
            ]
        )

        validated = validate_document("safe.docx", DOCX_CONTENT_TYPE, payload)

        self.assertEqual(validated.normalized_text, "Opening\nA1\tB1\nA2\tB2\nClosing")
        self.assertGreater(MAX_DOCX_EXPANSION_RATIO, 1)
        self.assertGreater(MAX_DOCX_UNCOMPRESSED_BYTES, DOCX_MAX_BYTES)


class ProjectDocumentResourceStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.data_dir = Path(self.temp_dir.name) / "data"
        self.store = SqliteStore(self.data_dir)
        self.store.create_project(project("project-one"))
        self.store.create_project(project("project-two"))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_persists_bytes_in_dedicated_directory_and_projects_safe_metadata(self) -> None:
        content = b"Alpha\nBeta"
        resource = self.store.create_project_document_resource(
            "project-one", "notes.txt", "text/plain", content
        )

        self.assertEqual(resource["projectId"], "project-one")
        self.assertEqual(resource["originalFilename"], "notes.txt")
        self.assertEqual(resource["size"], len(content))
        serialized = json.dumps(resource)
        self.assertNotIn("relativePath", serialized)
        self.assertNotIn("normalizedText", resource)
        self.assertNotIn("provider", serialized.lower())
        documents = list((self.data_dir / "documents").iterdir())
        self.assertEqual(len(documents), 1)
        self.assertEqual(documents[0].read_bytes(), content)
        self.assertEqual(self.store.list_project_document_resources("project-one"), [resource])

        resolved_content, resolved = self.store.read_project_document_resource(
            "project-one", resource["id"]
        )
        self.assertEqual(resolved_content, content)
        self.assertEqual(resolved["normalizedText"], "Alpha\nBeta")
        self.assertNotIn("relativePath", resolved)

    def test_enforces_project_scope_and_resource_trash_restore(self) -> None:
        resource = self.store.create_project_document_resource(
            "project-one", "notes.txt", "text/plain", b"text"
        )

        with self.assertRaises(MissingItem):
            self.store.get_project_document_resource("project-two", resource["id"])
        trashed = self.store.trash_project_document_resource("project-one", resource["id"])
        self.assertEqual(trashed["lifecycleStatus"], "trash")
        self.assertEqual(self.store.list_project_document_resources("project-one"), [])
        with self.assertRaises(MissingItem):
            self.store.read_project_document_resource("project-one", resource["id"])
        restored = self.store.restore_project_document_resource("project-one", resource["id"])
        self.assertEqual(restored["lifecycleStatus"], "active")
        self.store.trash_projects(["project-one"])
        with self.assertRaises(MissingItem):
            self.store.list_project_document_resources("project-one")

    def test_failed_metadata_transaction_removes_compensating_file(self) -> None:
        connection = sqlite3.connect(self.store.database_path)
        try:
            connection.execute(
                """CREATE TRIGGER reject_document_insert
                   BEFORE INSERT ON project_document_resources
                   BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END"""
            )
            connection.commit()
        finally:
            connection.close()

        with self.assertRaises(sqlite3.IntegrityError):
            self.store.create_project_document_resource(
                "project-one", "notes.txt", "text/plain", b"text"
            )

        documents = self.data_dir / "documents"
        self.assertEqual(list(documents.iterdir()) if documents.exists() else [], [])

    def test_backup_restore_round_trips_document_bytes_and_v16_tables(self) -> None:
        original_content = make_docx()
        resource = self.store.create_project_document_resource(
            "project-one", "outline.docx", DOCX_CONTENT_TYPE, original_content
        )
        self.store.enqueue_provider_file_cleanup("ark", "connection-one", "remote-secret")
        backup = Path(self.temp_dir.name) / "backup"
        manifest = self.store.backup(backup)

        self.assertEqual(manifest["documents"], 1)
        self.assertEqual(len(list((backup / "documents").iterdir())), 1)
        restored_dir = Path(self.temp_dir.name) / "restored"
        from promptcard_storage.maintenance import restore_backup

        restore_backup(restored_dir, backup)
        restored = SqliteStore(restored_dir)
        content, _metadata = restored.read_project_document_resource(
            "project-one", resource["id"]
        )
        self.assertEqual(content, original_content)
        connection = sqlite3.connect(restored.database_path)
        try:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            cleanup_count = connection.execute(
                "SELECT COUNT(*) FROM provider_file_cleanup"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertIn("project_document_resources", tables)
        self.assertIn("provider_file_cleanup", tables)
        self.assertEqual(cleanup_count, 1)

    def test_cleanup_repository_is_idempotent_bounded_and_redacted(self) -> None:
        first = self.store.enqueue_provider_file_cleanup(
            "volcengine-ark", "connection-one", "remote-secret"
        )
        replay = self.store.enqueue_provider_file_cleanup(
            "volcengine-ark", "connection-one", "remote-secret"
        )
        self.assertEqual(first["cleanupId"], replay["cleanupId"])

        due = self.store.get_due_provider_file_cleanup(now=first["createdAt"], limit=1)
        self.assertEqual(len(due), 1)
        self.assertEqual(due[0]["remoteFileId"], "remote-secret")
        retried = self.store.mark_provider_file_cleanup_retry(
            first["cleanupId"], first["createdAt"] + 1000, "https://secret.invalid/raw response"
        )
        self.assertEqual(retried["attemptCount"], 1)
        self.assertEqual(retried["lastErrorCode"], "provider_cleanup_failed")
        diagnostics = self.store.provider_file_cleanup_diagnostics(now=first["createdAt"] + 1000)
        self.assertEqual(diagnostics, {"pending": 1, "due": 1})
        self.assertNotIn("remote-secret", json.dumps(diagnostics))
        self.store.mark_provider_file_cleanup_succeeded(first["cleanupId"])
        self.store.mark_provider_file_cleanup_succeeded(first["cleanupId"])
        self.assertEqual(self.store.get_due_provider_file_cleanup(now=10**18, limit=100), [])
        with self.assertRaises(ValueError):
            self.store.get_due_provider_file_cleanup(now=10**18, limit=101)


@unittest.skipUnless(TestClient and create_app, "FastAPI contract dependencies are not installed")
class ProjectDocumentResourceApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.store = SqliteStore(Path(self.temp_dir.name) / "data")
        self.store.create_project(project("project-one"))
        self.token_patch = patch.dict(os.environ, {"PROMPTCARD_INTERNAL_TOKEN": "internal-secret"})
        self.token_patch.start()
        self.client = TestClient(create_app(self.store))

    def tearDown(self) -> None:
        self.token_patch.stop()
        self.temp_dir.cleanup()

    def test_five_browser_routes_return_only_resource_identity_and_metadata(self) -> None:
        uploaded = self.client.post(
            "/api/projects/project-one/document-resources",
            content=b"Alpha",
            headers={"content-type": "text/plain", "x-file-name": "notes.txt"},
        )
        self.assertEqual(uploaded.status_code, 200)
        resource = uploaded.json()
        self.assertNotIn("relativePath", resource)
        self.assertNotIn("normalizedText", resource)

        listed = self.client.get("/api/projects/project-one/document-resources")
        fetched = self.client.get(
            f"/api/projects/project-one/document-resources/{resource['id']}"
        )
        trashed = self.client.delete(
            f"/api/projects/project-one/document-resources/{resource['id']}"
        )
        restored = self.client.post(
            f"/api/projects/project-one/document-resources/{resource['id']}/restore"
        )
        self.assertEqual(listed.json(), {"resources": [resource]})
        self.assertEqual(fetched.json(), resource)
        self.assertEqual(trashed.json()["lifecycleStatus"], "trash")
        self.assertEqual(restored.json()["lifecycleStatus"], "active")

    def test_upload_is_bounded_and_invalid_documents_return_safe_error(self) -> None:
        response = self.client.post(
            "/api/projects/project-one/document-resources",
            content=b"x" * (TEXT_MAX_BYTES + 1),
            headers={"content-type": "text/plain", "x-file-name": "notes.txt"},
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"]["code"], "document_too_large")

    def test_internal_read_and_cleanup_seam_requires_shared_token(self) -> None:
        resource = self.store.create_project_document_resource(
            "project-one", "notes.txt", "text/plain", b"Alpha"
        )
        content_url = (
            f"/api/internal/projects/project-one/document-resources/{resource['id']}/content"
        )
        self.assertEqual(self.client.get(content_url).status_code, 401)
        downloaded = self.client.get(
            content_url, headers={"X-PromptCard-Internal-Token": "internal-secret"}
        )
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.content, b"Alpha")
        self.assertEqual(downloaded.headers["x-file-name"], "notes.txt")

        enqueue = self.client.post(
            "/api/internal/provider-file-cleanup",
            headers={"X-PromptCard-Internal-Token": "internal-secret"},
            json={
                "providerId": "volcengine-ark",
                "connectionId": "connection-one",
                "remoteFileId": "remote-secret",
            },
        )
        self.assertEqual(enqueue.status_code, 200)
        due = self.client.get(
            "/api/internal/provider-file-cleanup/due?now=9999999999999&limit=10",
            headers={"X-PromptCard-Internal-Token": "internal-secret"},
        )
        self.assertEqual(due.json()["items"][0]["remoteFileId"], "remote-secret")
        health = self.client.get("/health").json()
        self.assertNotIn("remote-secret", json.dumps(health))


if __name__ == "__main__":
    unittest.main()
