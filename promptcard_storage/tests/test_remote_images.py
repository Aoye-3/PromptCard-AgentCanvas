import ipaddress
from io import BytesIO
import unittest

from email.message import Message

from promptcard_storage.remote_images import RemoteImageError, fetch_remote_image, validate_remote_image_url


class RemoteImageUrlValidationTest(unittest.TestCase):
    def test_accepts_a_public_https_image_url(self) -> None:
        resolved = validate_remote_image_url(
            "https://cdn.example.com/thumb.png",
            resolver=lambda _host, _port: [ipaddress.ip_address("93.184.216.34")],
        )

        self.assertEqual(resolved, "https://cdn.example.com/thumb.png")

    def test_rejects_loopback_and_private_network_targets(self) -> None:
        for address in ("127.0.0.1", "10.0.0.8", "169.254.169.254", "::1"):
            with self.subTest(address=address), self.assertRaises(RemoteImageError):
                validate_remote_image_url(
                    "https://images.example/thumb.png",
                    resolver=lambda _host, _port, address=address: [ipaddress.ip_address(address)],
                )

    def test_downloads_only_supported_image_bytes(self) -> None:
        class FakeResponse(BytesIO):
            status = 200

            def __init__(self) -> None:
                super().__init__(b"\x89PNG\r\n\x1a\nimage")
                self.headers = Message()
                self.headers["Content-Type"] = "image/png"

            def geturl(self) -> str:
                return "https://cdn.example.com/thumb.png"

        image = fetch_remote_image(
            "https://cdn.example.com/thumb.png",
            opener=lambda _request, _timeout: FakeResponse(),
            resolver=lambda _host, _port: [ipaddress.ip_address("93.184.216.34")],
        )

        self.assertEqual(image.content, b"\x89PNG\r\n\x1a\nimage")
        self.assertEqual(image.content_type, "image/png")
        self.assertEqual(image.filename, "thumb.png")

    def test_rejects_a_remote_response_that_is_not_an_image(self) -> None:
        class FakeResponse(BytesIO):
            status = 200

            def __init__(self) -> None:
                super().__init__(b"<html>not an image</html>")
                self.headers = Message()
                self.headers["Content-Type"] = "text/html"

            def geturl(self) -> str:
                return "https://cdn.example.com/not-image"

        with self.assertRaises(RemoteImageError):
            fetch_remote_image(
                "https://cdn.example.com/not-image",
                opener=lambda _request, _timeout: FakeResponse(),
                resolver=lambda _host, _port: [ipaddress.ip_address("93.184.216.34")],
            )
