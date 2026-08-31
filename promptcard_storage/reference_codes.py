"""Storage-owned generation and parsing for public ``PREFIX-ULID`` codes."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from secrets import token_bytes
from typing import Callable


_CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ULID_LENGTH = 26
_ULID_ENTROPY_BYTES = 10
_ULID_MAX_TIMESTAMP_MS = (1 << 48) - 1
_GENERATION_ATTEMPTS = 16


class ReferenceNamespace(str, Enum):
    """The public-code namespaces owned by Storage."""

    PROJECT = "PRJ"
    PROMPT_BUNDLE = "PLP"
    PROMPT_MEDIA = "PLM"
    CANVAS_TEMPLATE = "CVT"
    CANVAS_MEDIA = "CVM"
    CANVAS_CONTEXT = "CVC"
    CANVAS_DOCUMENT = "CVD"
    CANVAS_STORYBOARD = "CVS"
    SKILL = "SKL"


class ReferenceCodeError(ValueError):
    """A validation or generation failure with a stable machine-readable code."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ReferenceCode:
    """A validated, canonical public reference."""

    namespace: ReferenceNamespace
    ulid: str

    @property
    def code(self) -> str:
        return f"{self.namespace.value}-{self.ulid}"

    def __str__(self) -> str:
        return self.code


def parse_reference_code(
    value: str,
    *,
    expected_namespace: ReferenceNamespace | str | None = None,
) -> ReferenceCode:
    """Parse a public reference, returning its canonical uppercase representation."""
    if not isinstance(value, str):
        raise ReferenceCodeError("invalid_reference_code")

    prefix, separator, ulid = value.upper().partition("-")
    if not separator or "-" in ulid:
        raise ReferenceCodeError("invalid_reference_code_length")

    namespace = _parse_namespace(prefix)
    _validate_ulid(ulid)

    expected = (
        _coerce_namespace(expected_namespace)
        if expected_namespace is not None
        else None
    )
    if expected is not None and namespace is not expected:
        raise ReferenceCodeError("reference_namespace_mismatch")

    return ReferenceCode(namespace=namespace, ulid=ulid)


def generate_reference_code(
    namespace: ReferenceNamespace | str,
    *,
    timestamp_ms: int,
    entropy_source: Callable[[], bytes] = lambda: token_bytes(_ULID_ENTROPY_BYTES),
    collision_predicate: Callable[[str], bool] | None = None,
) -> str:
    """Generate a unique public code using a caller-supplied collision check when needed."""
    canonical_namespace = _coerce_namespace(namespace)
    if not isinstance(timestamp_ms, int) or not 0 <= timestamp_ms <= _ULID_MAX_TIMESTAMP_MS:
        raise ValueError("timestamp_ms must fit in the ULID 48-bit timestamp range")

    for _ in range(_GENERATION_ATTEMPTS):
        entropy = entropy_source()
        if not isinstance(entropy, bytes) or len(entropy) != _ULID_ENTROPY_BYTES:
            raise ValueError("entropy_source must return exactly 10 bytes")

        ulid = _encode_ulid(timestamp_ms, entropy)
        code = f"{canonical_namespace.value}-{ulid}"
        if collision_predicate is None or not collision_predicate(code):
            return code

    raise ReferenceCodeError("reference_code_collision")


def _parse_namespace(prefix: str) -> ReferenceNamespace:
    try:
        return ReferenceNamespace(prefix)
    except ValueError as error:
        raise ReferenceCodeError("invalid_reference_code_prefix") from error


def _coerce_namespace(namespace: ReferenceNamespace | str) -> ReferenceNamespace:
    if isinstance(namespace, ReferenceNamespace):
        return namespace
    if isinstance(namespace, str):
        return _parse_namespace(namespace.upper())
    raise TypeError("namespace must be a ReferenceNamespace or a public-code prefix")


def _validate_ulid(ulid: str) -> None:
    if len(ulid) != _ULID_LENGTH:
        raise ReferenceCodeError("invalid_reference_code_length")
    if any(character not in _CROCKFORD_ALPHABET for character in ulid):
        raise ReferenceCodeError("invalid_reference_code_alphabet")
    if ulid[0] > "7":
        raise ReferenceCodeError("invalid_reference_code_overflow")


def _encode_ulid(timestamp_ms: int, entropy: bytes) -> str:
    value = (timestamp_ms << 80) | int.from_bytes(entropy, byteorder="big")
    characters = ["0"] * _ULID_LENGTH
    for index in range(_ULID_LENGTH - 1, -1, -1):
        characters[index] = _CROCKFORD_ALPHABET[value & 31]
        value >>= 5
    return "".join(characters)
