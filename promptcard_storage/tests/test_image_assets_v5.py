import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from PIL import Image

try:
    from fastapi.testclient import TestClient
    from promptcard_storage.app import create_app
except ModuleNotFoundError:
    TestClient = None
    create_app = None

from promptcard_storage.store import (
    SCHEMA_VERSION,
    AssetValidationError,
    JsonCollectionStore,
    MissingItem,
)


TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / ".test-tmp" / "image-assets-v5"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


def image_bytes(image_format: str, size: tuple[int, int] = (64, 64), mode: str = "RGB") -> bytes:
    buffer = io.BytesIO()
    color = (12, 34, 56, 128) if mode == "RGBA" else (12, 34, 56)
    Image.new(mode, size, color).save(buffer, format=image_format)
    return buffer.getvalue()


def run_payload(run_id: str, project_id: str = "project-one") -> dict:
    return {
        "id": run_id,
        "projectId": project_id,
        "conversationId": "conversation-one",
        "connectionId": "connection-one",
        "providerId": "volcengine-ark",
        "modelId": "doubao-seedream-5-0-pro-260628",
        "state": "queued",
        "requestSnapshot": {"mode": "generate"},
        "outputAssetIds": [],
        "createdAt": 1,
    }


class ImageAssetV5StoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.data_dir = Path(self.temp_dir.name, "data")
        self.store = JsonCollectionStore(self.data_dir)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_schema_v5_creates_permanent_derivation_table(self) -> None:
        connection = sqlite3.connect(self.data_dir / "promptcard.sqlite3")
        try:
            version = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(image_asset_derivations)")
            }
        finally:
            connection.close()

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertEqual(
            columns,
            {
                "id",
                "source_asset_id",
                "derived_asset_id",
                "kind",
                "transform_json",
                "annotation_document_json",
                "created_at",
            },
        )

    def test_import_preserves_bmp_and_creates_standard_provider_derivative(self) -> None:
        imported = self.store.import_image_asset(
            "reference.bmp", "image/bmp", image_bytes("BMP")
        )

        original_path, original_type = self.store.get_asset(imported["originalAsset"]["id"])
        provider_path, provider_type = self.store.get_asset(imported["providerInputAsset"]["id"])
        self.assertEqual(original_type, "image/bmp")
        self.assertEqual(original_path.read_bytes()[:2], b"BM")
        self.assertIn(provider_type, {"image/png", "image/jpeg"})
        self.assertNotEqual(imported["originalAsset"]["id"], imported["providerInputAsset"]["id"])
        self.assertEqual(imported["width"], 64)
        self.assertEqual(imported["height"], 64)
        self.assertEqual(
            {item["kind"] for item in self.store.list_image_asset_derivations(
                imported["originalAsset"]["id"]
            )},
            {"preview", "provider-input"},
        )

    def test_import_uses_first_gif_frame_and_preserves_alpha_as_png(self) -> None:
        first = Image.new("RGBA", (64, 64), (255, 0, 0, 0))
        second = Image.new("RGBA", (64, 64), (0, 0, 255, 255))
        buffer = io.BytesIO()
        first.save(buffer, format="GIF", save_all=True, append_images=[second])

        imported = self.store.import_image_asset("animated.gif", "image/gif", buffer.getvalue())

        provider_path, provider_type = self.store.get_asset(imported["providerInputAsset"]["id"])
        self.assertEqual(provider_type, "image/png")
        with Image.open(provider_path) as image:
            self.assertEqual(image.n_frames, 1)

    def test_import_applies_exif_orientation_to_provider_derivative(self) -> None:
        buffer = io.BytesIO()
        image = Image.new("RGB", (32, 64), (12, 34, 56))
        exif = image.getexif()
        exif[274] = 6
        image.save(buffer, format="JPEG", exif=exif)

        imported = self.store.import_image_asset(
            "rotated.jpg", "image/jpeg", buffer.getvalue()
        )

        self.assertEqual((imported["width"], imported["height"]), (64, 32))
        self.assertNotEqual(
            imported["originalAsset"]["id"], imported["providerInputAsset"]["id"]
        )
        provider_path, _ = self.store.get_asset(imported["providerInputAsset"]["id"])
        with Image.open(provider_path) as provider:
            self.assertEqual(provider.size, (64, 32))

    def test_import_rejects_official_dimension_and_ratio_boundaries(self) -> None:
        for size in ((14, 64), (16, 272)):
            with self.subTest(size=size):
                with self.assertRaises(AssetValidationError):
                    self.store.import_image_asset(
                        "invalid.png", "image/png", image_bytes("PNG", size=size)
                    )

    def test_annotation_derivation_is_permanent_and_strongly_references_both_assets(self) -> None:
        source = self.store.save_asset(
            "source.png", "image/png", image_bytes("PNG")
        )
        flattened = self.store.save_asset(
            "flattened.png", "image/png", image_bytes("PNG", mode="RGBA")
        )

        record = self.store.create_image_asset_derivation({
            "sourceAssetId": source["id"],
            "derivedAssetId": flattened["id"],
            "kind": "annotation-flattened",
            "transform": {"format": "png"},
            "annotationDocument": {"version": 1, "marks": [{"type": "arrow"}]},
        })

        self.assertEqual(record["kind"], "annotation-flattened")
        unreferenced = self.store.diagnose_assets()["unreferencedAssets"]
        self.assertNotIn(source["id"], unreferenced)
        self.assertNotIn(flattened["id"], unreferenced)

    def test_run_detail_and_list_require_matching_project(self) -> None:
        self.store.create_image_generation_run(run_payload("run-one"))

        self.assertEqual(
            self.store.get_image_generation_run("run-one", project_id="project-one")["id"],
            "run-one",
        )
        with self.assertRaises(MissingItem):
            self.store.get_image_generation_run("run-one", project_id="project-two")
        with self.assertRaises(ValueError):
            self.store.list_image_generation_runs()

    def test_heif_preparer_can_be_injected_without_storage_dependency(self) -> None:
        calls = []

        def prepare(content_type: str, content: bytes) -> dict:
            calls.append((content_type, content))
            return {
                "width": 64,
                "height": 64,
                "contentType": "image/jpeg",
                "content": image_bytes("JPEG"),
                "converted": True,
            }

        injected = JsonCollectionStore(self.data_dir / "injected", image_preparer=prepare)
        heif = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 32

        imported = injected.import_image_asset("phone.heic", "image/heic", heif)

        self.assertEqual(calls, [("image/heic", heif)])
        self.assertEqual(imported["providerInputAsset"]["contentType"], "image/jpeg")

    def test_import_decodes_real_heic_with_locked_workspace_dependency(self) -> None:
        from pillow_heif import register_heif_opener

        register_heif_opener()
        buffer = io.BytesIO()
        Image.new("RGB", (64, 64), (12, 34, 56)).save(buffer, format="HEIF")

        imported = self.store.import_image_asset(
            "phone.heic", "image/heic", buffer.getvalue()
        )

        self.assertEqual(imported["originalAsset"]["contentType"], "image/heic")
        self.assertEqual(imported["providerInputAsset"]["contentType"], "image/jpeg")
        self.assertEqual((imported["width"], imported["height"]), (64, 64))


@unittest.skipUnless(TestClient and create_app, "FastAPI contract dependencies are not installed")
class ImageAssetV5AppTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.store = JsonCollectionStore(Path(self.temp_dir.name, "data"))
        self.client = TestClient(create_app(self.store))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_import_and_derivation_routes_have_no_delete(self) -> None:
        imported = self.client.post(
            "/api/image-assets/import",
            content=image_bytes("TIFF"),
            headers={"content-type": "image/tiff", "x-file-name": "reference.tiff"},
        )
        self.assertEqual(imported.status_code, 200)
        payload = imported.json()
        source_id = payload["originalAsset"]["id"]
        provider_id = payload["providerInputAsset"]["id"]

        derivation = self.client.post("/api/image-assets/derivations", json={
            "sourceAssetId": source_id,
            "derivedAssetId": provider_id,
            "kind": "annotation-flattened",
            "transform": {"reason": "test"},
            "annotationDocument": {"version": 1, "marks": []},
        })
        self.assertEqual(derivation.status_code, 200)
        self.assertEqual(
            self.client.delete(f"/api/image-assets/derivations/{derivation.json()['id']}").status_code,
            405,
        )

    def test_run_detail_requires_project_id(self) -> None:
        self.store.create_image_generation_run(run_payload("run-api"))

        self.assertEqual(self.client.get("/api/image-generation-runs/run-api").status_code, 422)
        self.assertEqual(
            self.client.get(
                "/api/image-generation-runs/run-api", params={"projectId": "project-two"}
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.get(
                "/api/image-generation-runs/run-api", params={"projectId": "project-one"}
            ).status_code,
            200,
        )


if __name__ == "__main__":
    unittest.main()
