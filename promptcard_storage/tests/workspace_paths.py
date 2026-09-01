from __future__ import annotations

import re
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
_STORAGE_TEST_ROOT = (REPOSITORY_ROOT / ".test-tmp" / "promptcard-storage").resolve()
_SUITE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")


def workspace_test_root(suite_name: str) -> Path:
    """Return one validated, repository-local root for Storage test artifacts."""
    if not isinstance(suite_name, str) or _SUITE_NAME.fullmatch(suite_name) is None:
        raise ValueError("workspace_test_suite_name_invalid")

    repository_root = REPOSITORY_ROOT.resolve()
    suite_root = (_STORAGE_TEST_ROOT / suite_name).resolve()
    try:
        suite_root.relative_to(repository_root)
    except ValueError as exc:
        raise RuntimeError("workspace_test_root_escape") from exc

    suite_root.mkdir(parents=True, exist_ok=True)
    return suite_root
