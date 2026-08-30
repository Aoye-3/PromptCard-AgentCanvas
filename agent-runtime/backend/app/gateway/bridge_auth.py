from __future__ import annotations

import json
import os
import re
import secrets
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request

BRIDGE_PROFILES_ENV = "PROMPTCARD_BRIDGE_PROFILES_JSON"
BRIDGE_SCOPES = frozenset(
    {
        "bridge:read",
        "bridge:deliver:document",
        "bridge:deliver:storyboard",
        "bridge:deliver:prompt",
        "bridge:deliver:image",
        "bridge:status",
    }
)
_PROFILE_PATTERN = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")


class BridgeConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True)
class BridgePrincipal:
    profile_id: str
    scopes: frozenset[str]
    client_info: dict[str, str] | None
    repository_scope: str | None

    def operation_context(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "profileId": self.profile_id,
            "scopes": sorted(self.scopes),
            "provenance": "promptcard-bridge",
        }
        if self.client_info is not None:
            result["clientInfo"] = dict(self.client_info)
        return result


def resolve_bridge_principal(authorization: str | None) -> BridgePrincipal | None:
    token = _bearer_token(authorization)
    if token is None:
        return None
    matched: BridgePrincipal | None = None
    for profile_id, profile in _configured_profiles().items():
        if secrets.compare_digest(token, profile["token"]):
            matched = BridgePrincipal(
                profile_id=profile_id,
                scopes=frozenset(profile["scopes"]),
                client_info=profile.get("clientInfo"),
                repository_scope=profile.get("repositoryScope"),
            )
    return matched


def require_bridge_principal(request: Request) -> BridgePrincipal:
    principal = getattr(request.state, "bridge_principal", None)
    if not isinstance(principal, BridgePrincipal):
        raise HTTPException(status_code=401, detail="bridge_credential_required")
    return principal


def require_bridge_scope(principal: BridgePrincipal, scope: str) -> None:
    if scope not in principal.scopes:
        raise HTTPException(
            status_code=403,
            detail={"code": "bridge_scope_required", "requiredScope": scope},
        )


def _configured_profiles() -> dict[str, dict[str, Any]]:
    raw = os.getenv(BRIDGE_PROFILES_ENV, "").strip()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BridgeConfigurationError("bridge_profiles_invalid") from exc
    if not isinstance(payload, dict) or len(payload) > 16:
        raise BridgeConfigurationError("bridge_profiles_invalid")
    normalized: dict[str, dict[str, Any]] = {}
    tokens: set[str] = set()
    for profile_id, profile in payload.items():
        if not isinstance(profile_id, str) or _PROFILE_PATTERN.fullmatch(profile_id) is None:
            raise BridgeConfigurationError("bridge_profile_id_invalid")
        if not isinstance(profile, dict) or not set(profile).issubset(
            {"token", "scopes", "clientInfo", "repositoryScope"}
        ):
            raise BridgeConfigurationError("bridge_profile_invalid")
        token = profile.get("token")
        scopes = profile.get("scopes")
        if not isinstance(token, str) or len(token) < 32 or token in tokens:
            raise BridgeConfigurationError("bridge_profile_token_invalid")
        if (
            not isinstance(scopes, list)
            or not scopes
            or len(scopes) != len(set(scopes))
            or any(scope not in BRIDGE_SCOPES for scope in scopes)
        ):
            raise BridgeConfigurationError("bridge_profile_scopes_invalid")
        client_info = profile.get("clientInfo")
        if client_info is not None and (
            not isinstance(client_info, dict)
            or set(client_info) != {"name", "version"}
            or any(
                not isinstance(client_info[key], str)
                or not client_info[key]
                or len(client_info[key]) > 128
                for key in ("name", "version")
            )
        ):
            raise BridgeConfigurationError("bridge_profile_client_info_invalid")
        repository_scope = profile.get("repositoryScope")
        if repository_scope is not None and (
            not isinstance(repository_scope, str)
            or not repository_scope.strip()
            or len(repository_scope.strip()) > 200
            or "\x00" in repository_scope
        ):
            raise BridgeConfigurationError("bridge_repository_scope_invalid")
        tokens.add(token)
        normalized[profile_id] = {
            "token": token,
            "scopes": list(scopes),
            **({"clientInfo": dict(client_info)} if client_info is not None else {}),
            **(
                {"repositoryScope": repository_scope.strip()}
                if isinstance(repository_scope, str)
                else {}
            ),
        }
    return normalized


def _bearer_token(authorization: str | None) -> str | None:
    if not isinstance(authorization, str):
        return None
    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token or " " in token:
        return None
    return token
