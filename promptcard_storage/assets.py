from __future__ import annotations

import os
import tempfile
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, ContextManager


ASSET_EXTENSIONS = {
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/tiff": ".tiff",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}

IMAGE_CONTENT_TYPES = {
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
}
VIDEO_CONTENT_TYPES = {"video/mp4", "video/webm"}
DEFAULT_MAX_ASSET_BYTES = 200 * 1024 * 1024
MAX_IMAGE_IMPORT_BYTES = 30 * 1024 * 1024
MAX_IMAGE_IMPORT_PIXELS = 36_000_000
MIN_IMAGE_SIDE_EXCLUSIVE = 14
MIN_IMAGE_ASPECT_RATIO = 1 / 16
MAX_IMAGE_ASPECT_RATIO = 16


class AssetValidationError(Exception):
    pass


class DeletedAssetLookup(LookupError):
    pass


def prepare_provider_image(content_type: str, content: bytes) -> dict[str, Any]:
    normalized_content_type = content_type.lower()
    if normalized_content_type not in IMAGE_CONTENT_TYPES:
        raise AssetValidationError("Unsupported image content type")
    if not content or len(content) > MAX_IMAGE_IMPORT_BYTES:
        raise AssetValidationError("Image asset must be between 1 byte and 30 MB")
    if not is_valid_image_signature(normalized_content_type, content):
        raise AssetValidationError("Image bytes do not match the declared type")

    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
    except ModuleNotFoundError as exc:
        raise AssetValidationError("Image decoder is unavailable") from exc

    if normalized_content_type in {"image/heic", "image/heif"}:
        try:
            from pillow_heif import register_heif_opener
        except ModuleNotFoundError as exc:
            raise AssetValidationError("HEIC/HEIF decoder is unavailable") from exc
        register_heif_opener()

    try:
        with Image.open(BytesIO(content)) as opened:
            opened.seek(0)
            orientation = opened.getexif().get(274, 1)
            frame = ImageOps.exif_transpose(opened.copy())
    except (OSError, UnidentifiedImageError) as exc:
        raise AssetValidationError("Image could not be decoded") from exc

    width, height = frame.size
    pixels = width * height
    ratio = width / height if height else 0
    if width <= MIN_IMAGE_SIDE_EXCLUSIVE or height <= MIN_IMAGE_SIDE_EXCLUSIVE:
        raise AssetValidationError("Image width and height must both be greater than 14 pixels")
    if pixels > MAX_IMAGE_IMPORT_PIXELS:
        raise AssetValidationError("Image must not exceed 36,000,000 pixels")
    if ratio < MIN_IMAGE_ASPECT_RATIO or ratio > MAX_IMAGE_ASPECT_RATIO:
        raise AssetValidationError("Image aspect ratio must be between 1:16 and 16:1")

    if normalized_content_type in {"image/jpeg", "image/png", "image/webp"} and orientation == 1:
        return {
            "width": width,
            "height": height,
            "contentType": normalized_content_type,
            "content": content,
            "converted": False,
        }

    has_alpha = _has_visible_alpha_channel(frame)
    output = BytesIO()
    if has_alpha:
        frame.convert("RGBA").save(output, format="PNG")
        output_type = "image/png"
    else:
        frame.convert("RGB").save(output, format="JPEG", quality=95, optimize=True)
        output_type = "image/jpeg"
    return {
        "width": width,
        "height": height,
        "contentType": output_type,
        "content": output.getvalue(),
        "converted": True,
    }


class AssetStore:
    def __init__(
        self,
        data_dir: Path,
        connect: Callable[[], ContextManager[Any]],
        transaction: Callable[[], ContextManager[Any]],
        referenced_payloads: Callable[[], list[Any]],
        now_ms: Callable[[], int],
    ) -> None:
        self.data_dir = data_dir
        self.assets_dir = data_dir / "assets"
        self._connect = connect
        self._transaction = transaction
        self._referenced_payloads = referenced_payloads
        self._now_ms = now_ms

    def save(self, filename: str, content_type: str, content: bytes, max_bytes: int = DEFAULT_MAX_ASSET_BYTES) -> dict[str, Any]:
        normalized_content_type = content_type.lower()
        extension = ASSET_EXTENSIONS.get(normalized_content_type)
        if extension is None:
            raise AssetValidationError("Unsupported asset content type")
        if not content or len(content) > max_bytes:
            raise AssetValidationError("Asset must be between 1 byte and 200 MB")
        if normalized_content_type in IMAGE_CONTENT_TYPES and not is_valid_image_signature(normalized_content_type, content):
            raise AssetValidationError("Image bytes do not match the declared type")
        if normalized_content_type in VIDEO_CONTENT_TYPES and not is_valid_video_signature(normalized_content_type, content):
            raise AssetValidationError("Video bytes do not match the declared type")
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        asset_id = f"{uuid.uuid4().hex}{extension}"
        final_path = self.assets_dir / asset_id
        fd, temp_name = tempfile.mkstemp(prefix=".asset-", suffix=".tmp", dir=str(self.assets_dir))
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, final_path)
            with self._transaction() as connection:
                connection.execute(
                    "INSERT INTO assets(asset_id, original_filename, relative_path, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (asset_id, Path(filename).name or asset_id, f"assets/{asset_id}", normalized_content_type, len(content), self._now_ms()),
                )
        except Exception:
            Path(temp_name).unlink(missing_ok=True)
            final_path.unlink(missing_ok=True)
            raise
        return {"id": asset_id, "filename": Path(filename).name or asset_id, "contentType": normalized_content_type, "size": len(content)}

    def save_idempotent(
        self,
        asset_id: str,
        filename: str,
        content_type: str,
        content: bytes,
        max_bytes: int = MAX_IMAGE_IMPORT_BYTES,
    ) -> dict[str, Any]:
        normalized_content_type = content_type.lower()
        extension = ASSET_EXTENSIONS.get(normalized_content_type)
        if (
            extension is None
            or normalized_content_type not in IMAGE_CONTENT_TYPES
            or Path(asset_id).name != asset_id
            or not asset_id.endswith(extension)
        ):
            raise AssetValidationError("Bridge asset identity is invalid")
        if not content or len(content) > max_bytes:
            raise AssetValidationError("Image asset must be between 1 byte and 30 MB")
        if not is_valid_image_signature(normalized_content_type, content):
            raise AssetValidationError("Image bytes do not match the declared type")
        stored_filename = Path(filename).name or asset_id
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        final_path = self.assets_dir / asset_id
        with self._transaction() as connection:
            row = connection.execute(
                """SELECT original_filename, relative_path, content_type, size
                   FROM assets WHERE asset_id=?""",
                (asset_id,),
            ).fetchone()
            if row is not None:
                if row[2] != normalized_content_type or row[3] != len(content):
                    raise AssetValidationError("Bridge asset replay does not match stored metadata")
                existing_path = self.data_dir / row[1]
                if existing_path.is_file() and existing_path.read_bytes() != content:
                    raise AssetValidationError("Bridge asset replay does not match stored bytes")
                if not existing_path.is_file():
                    _write_asset_file(existing_path, content)
                return {
                    "id": asset_id,
                    "filename": row[0],
                    "contentType": row[2],
                    "size": row[3],
                }
            if final_path.is_file() and final_path.read_bytes() != content:
                raise AssetValidationError("Bridge asset file conflicts with staged bytes")
            if not final_path.is_file():
                _write_asset_file(final_path, content)
            connection.execute(
                """INSERT INTO assets(
                       asset_id, original_filename, relative_path,
                       content_type, size, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    asset_id,
                    stored_filename,
                    f"assets/{asset_id}",
                    normalized_content_type,
                    len(content),
                    self._now_ms(),
                ),
            )
        return {
            "id": asset_id,
            "filename": stored_filename,
            "contentType": normalized_content_type,
            "size": len(content),
        }

    def get(self, asset_id: str) -> tuple[Path, str]:
        candidate = Path(asset_id)
        if candidate.name != asset_id:
            raise LookupError(asset_id)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT relative_path, content_type, lifecycle_status FROM assets WHERE asset_id=?",
                (asset_id,),
            ).fetchone()
        if not row:
            raise LookupError(asset_id)
        if row[2] == "deleted":
            raise DeletedAssetLookup(asset_id)
        path = self.data_dir / row[0]
        if not path.is_file():
            raise LookupError(asset_id)
        return path, row[1]

    def diagnose(self) -> dict[str, list[str]]:
        with self._connect() as connection:
            all_registered = {row[0] for row in connection.execute("SELECT asset_id FROM assets")}
            registered = {
                row[0]
                for row in connection.execute(
                    "SELECT asset_id FROM assets WHERE lifecycle_status IN ('active','trash')"
                )
            }
        on_disk = {path.name for path in self.assets_dir.iterdir() if path.is_file() and not path.name.startswith(".")} if self.assets_dir.exists() else set()
        referenced = _collect_asset_ids(self._referenced_payloads())
        return {
            "unregisteredFiles": sorted(on_disk - registered),
            "missingFiles": sorted(registered - on_disk),
            "unreferencedAssets": sorted(registered - referenced),
            "missingReferences": sorted(referenced - all_registered),
        }


def is_valid_image_signature(content_type: str, content: bytes) -> bool:
    if content_type == "image/bmp":
        return content.startswith(b"BM")
    if content_type == "image/gif":
        return content.startswith((b"GIF87a", b"GIF89a"))
    if content_type in {"image/heic", "image/heif"}:
        return len(content) >= 12 and content[4:8] == b"ftyp" and content[8:12] in {
            b"heic",
            b"heix",
            b"hevc",
            b"hevx",
            b"heim",
            b"heis",
            b"mif1",
            b"msf1",
        }
    if content_type == "image/png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return content.startswith(b"\xff\xd8\xff")
    if content_type == "image/tiff":
        return content.startswith((b"II*\x00", b"MM\x00*"))
    if content_type == "image/webp":
        return len(content) >= 12 and content.startswith(b"RIFF") and content[8:12] == b"WEBP"
    return False


def is_valid_video_signature(content_type: str, content: bytes) -> bool:
    if content_type == "video/mp4":
        return len(content) >= 12 and content[4:8] == b"ftyp"
    if content_type == "video/webm":
        return content.startswith(b"\x1a\x45\xdf\xa3")
    return False


def _write_asset_file(path: Path, content: bytes) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=".asset-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except Exception:
        Path(temp_name).unlink(missing_ok=True)
        raise


def _collect_asset_ids(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        for key in ("assetId", "sourceAssetId", "derivedAssetId"):
            asset_id = value.get(key)
            if isinstance(asset_id, str) and asset_id:
                found.add(asset_id)
        output_asset_ids = value.get("outputAssetIds")
        if isinstance(output_asset_ids, list):
            found.update(item for item in output_asset_ids if isinstance(item, str) and item)
        for child in value.values():
            found.update(_collect_asset_ids(child))
    elif isinstance(value, list):
        for child in value:
            found.update(_collect_asset_ids(child))
    return found


def _has_visible_alpha_channel(image: Any) -> bool:
    if image.mode in {"RGBA", "LA"}:
        alpha = image.getchannel("A")
        minimum, _maximum = alpha.getextrema()
        return minimum < 255
    return image.mode == "P" and "transparency" in image.info
