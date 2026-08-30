"""Small local-session gate for PromptCard's desktop runtime."""

from collections.abc import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

from app.gateway.bridge_auth import BridgeConfigurationError, resolve_bridge_principal
from app.gateway.internal_auth import (
    INTERNAL_AUTH_HEADER_NAME,
    is_valid_internal_auth_token,
)
from app.gateway.local_session import LOCAL_SESSION_COOKIE, is_valid_local_session

_PUBLIC_PATHS = {
    "/health",
    "/api/promptcard/runtime/status",
    "/api/promptcard/runtime/bootstrap",
}
_PUBLIC_PREFIXES = ("/docs", "/redoc", "/openapi.json")


class AuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        path = request.url.path.rstrip("/") or "/"
        if path in _PUBLIC_PATHS or any(path.startswith(prefix) for prefix in _PUBLIC_PREFIXES):
            return await call_next(request)
        if path.startswith("/api/promptcard/bridge/"):
            try:
                principal = resolve_bridge_principal(request.headers.get("authorization"))
            except BridgeConfigurationError:
                return JSONResponse(
                    status_code=503,
                    content={"detail": "PromptCard bridge configuration is invalid."},
                )
            if principal is None:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "PromptCard bridge credential required."},
                )
            request.state.bridge_principal = principal
            return await call_next(request)
        if is_valid_internal_auth_token(
            request.headers.get(INTERNAL_AUTH_HEADER_NAME)
        ):
            return await call_next(request)
        if not is_valid_local_session(request.cookies.get(LOCAL_SESSION_COOKIE)):
            return JSONResponse(
                status_code=401,
                content={"detail": "PromptCard local session required."},
            )
        return await call_next(request)
