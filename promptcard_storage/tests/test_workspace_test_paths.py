from __future__ import annotations

import re
import unittest
from pathlib import Path

from promptcard_storage.tests.workspace_paths import (
    REPOSITORY_ROOT,
    workspace_test_root,
)


TESTS_ROOT = Path(__file__).resolve().parent
MACHINE_TEST_ROOT = re.compile(
    r"(?:TEST_ROOT|TEST_TEMP_ROOT)\s*=\s*Path\(\s*[rR]?[\"'][A-Za-z]:",
    re.MULTILINE,
)
SYSTEM_TEMP_DIRECTORY = re.compile(r"TemporaryDirectory\(\s*\)")


class WorkspaceTestPathPolicyTest(unittest.TestCase):
    def test_workspace_test_root_resolves_inside_current_repository(self) -> None:
        root = workspace_test_root("path-policy")

        self.assertTrue(root.is_relative_to(REPOSITORY_ROOT.resolve()))
        self.assertEqual(root.drive.casefold(), REPOSITORY_ROOT.drive.casefold())

    def test_workspace_test_root_rejects_absolute_or_traversing_suite_names(self) -> None:
        for suite_name in ("", "../outside", "nested/suite", r"C:\outside"):
            with self.subTest(suite_name=suite_name):
                with self.assertRaises(ValueError):
                    workspace_test_root(suite_name)

    def test_storage_tests_do_not_bind_temporary_state_to_one_machine(self) -> None:
        offenders: list[str] = []
        for source_path in sorted(TESTS_ROOT.glob("test_*.py")):
            if source_path == Path(__file__):
                continue
            source = source_path.read_text(encoding="utf-8")
            if MACHINE_TEST_ROOT.search(source) or SYSTEM_TEMP_DIRECTORY.search(source):
                offenders.append(source_path.name)

        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
