from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, ContextManager, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .assets import MAX_IMAGE_IMPORT_BYTES, is_valid_image_signature


ALLOWED_CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
DOWNLOAD_TIMEOUT_SECONDS = 12


class RemoteImageError(RuntimeError):
    pass


@dataclass(frozen=True)
class RemoteImage:
    content: bytes
    content_type: str
    filename: str


AddressResolver = Callable[[str, int], Iterable[ipaddress.IPv4Address | ipaddress.IPv6Address]]


def validate_remote_image_url(url: str, resolver: AddressResolver | None = None) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RemoteImageError("仅支持 HTTP 或 HTTPS 图片地址。")
    if parsed.username or parsed.password:
        raise RemoteImageError("图片地址不能包含登录凭据。")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = list((resolver or _resolve_addresses)(parsed.hostname, port))
    if not addresses or any(not address.is_global for address in addresses):
        raise RemoteImageError("为保护本地数据，不能从本机或私有网络地址读取图片。")
    return url


def fetch_remote_image(
    url: str,
    opener: Callable[[Request, int], ContextManager] | None = None,
    resolver: AddressResolver | None = None,
) -> RemoteImage:
    validated_url = validate_remote_image_url(url, resolver)
    request = Request(
        validated_url,
        headers={
            "Accept": "image/png,image/jpeg,image/webp",
            "User-Agent": "PromptCardManager/4.0 BrowserImageDrop",
        },
    )
    open_request = opener or _default_open
    try:
        with open_request(request, DOWNLOAD_TIMEOUT_SECONDS) as response:
            final_url = response.geturl()
            validate_remote_image_url(final_url, resolver)
            if getattr(response, "status", 200) != 200:
                raise RemoteImageError("图片服务器未返回可用内容。")
            content_type = response.headers.get_content_type().lower()
            if content_type not in ALLOWED_CONTENT_TYPES:
                raise RemoteImageError("拖入地址返回的不是 PNG、JPEG 或 WebP 图片。")
            content = response.read(MAX_IMAGE_IMPORT_BYTES + 1)
    except RemoteImageError:
        raise
    except (HTTPError, URLError, OSError, TimeoutError) as exc:
        raise RemoteImageError("无法下载拖入的浏览器图片。") from exc

    if not content or len(content) > MAX_IMAGE_IMPORT_BYTES:
        raise RemoteImageError("拖入图片必须大于 0 字节且不超过 30 MB。")
    if not is_valid_image_signature(content_type, content):
        raise RemoteImageError("图片内容与声明的格式不匹配。")

    return RemoteImage(
        content=content,
        content_type=content_type,
        filename=_filename_for(final_url, content_type),
    )


def _resolve_addresses(host: str, port: int) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    return list({ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})


class _SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_remote_image_url(urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _default_open(request: Request, timeout: int):
    return build_opener(_SafeRedirectHandler()).open(request, timeout=timeout)


def _filename_for(url: str, content_type: str) -> str:
    candidate = Path(unquote(urlsplit(url).path)).name
    expected_extension = ALLOWED_CONTENT_TYPES[content_type]
    if not candidate or Path(candidate).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        candidate = f"browser-image{expected_extension}"
    try:
        candidate.encode("ascii")
    except UnicodeEncodeError:
        candidate = f"browser-image{expected_extension}"
    return candidate
