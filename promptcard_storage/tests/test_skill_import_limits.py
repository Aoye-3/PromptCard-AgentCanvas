from __future__ import annotations

import base64
import io
import unittest
import zipfile
from dataclasses import replace

from promptcard_storage.skill_importer import (
    DEFAULT_INSPECTION_LIMITS,
    SkillPackageImportError,
    SkillPackageImportService,
    inspect_archive,
)


SKILL = b"---\nname: limit-skill\ndescription: bounded\n---\nbody\n"


def zipped(entries: list[tuple[str, bytes]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for path, content in entries:
            archive.writestr(path, content)
    return output.getvalue()


def inspect(entries: list[tuple[str, bytes]], **changes):
    limits = replace(DEFAULT_INSPECTION_LIMITS, **changes)
    return inspect_archive(zipped(entries), "package.zip", limits)


class SkillInspectionBoundaryTests(unittest.TestCase):
    def test_archive_input_limit_accepts_n_minus_one_and_n_but_rejects_n_plus_one_before_decode(self) -> None:
        archive = zipped([("SKILL.md", SKILL)])
        limit = len(archive)
        service = SkillPackageImportService(
            object(), limits=replace(DEFAULT_INSPECTION_LIMITS, max_archive_bytes=limit)
        )

        below = service.inspect_archive_request({
            "filename": "x.zip",
            "contentBase64": base64.b64encode(archive[:-1]).decode("ascii"),
        })
        exact = service.inspect_archive_request({
            "filename": "x.zip",
            "contentBase64": base64.b64encode(archive).decode("ascii"),
        })
        self.assertFalse(below["clean"])
        self.assertTrue(exact["clean"])
        with self.assertRaises(SkillPackageImportError) as raised:
            service.inspect_archive_request({
                "filename": "x.zip",
                "contentBase64": base64.b64encode(archive + b"x").decode("ascii"),
            })
        self.assertEqual((raised.exception.status_code, raised.exception.code), (413, "archive_too_large"))

    def test_path_and_segment_character_limits_cover_n_minus_one_n_and_n_plus_one(self) -> None:
        path_limit = len("assets/aaaaaa")
        for length, clean in ((5, True), (6, True), (7, False)):
            with self.subTest(kind="path", length=length):
                result = inspect(
                    [("SKILL.md", SKILL), (f"assets/{'a' * length}", b"x")],
                    max_path_chars=path_limit,
                )
                self.assertEqual(result.clean, clean)

        for length, clean in ((11, True), (12, True), (13, False)):
            with self.subTest(kind="segment", length=length):
                result = inspect(
                    [("SKILL.md", SKILL), (f"assets/{'a' * length}", b"x")],
                    max_path_segment_chars=12,
                )
                self.assertEqual(result.clean, clean)

    def test_directory_depth_limit_covers_n_minus_one_n_and_n_plus_one(self) -> None:
        for depth, clean in ((1, True), (2, True), (3, False)):
            path = "/".join(["assets", *(["d"] * (depth - 1)), "file"])
            with self.subTest(depth=depth):
                result = inspect(
                    [("SKILL.md", SKILL), (path, b"x")], max_directory_depth=2
                )
                self.assertEqual(result.clean, clean)

    def test_skill_md_limit_covers_n_minus_one_n_and_n_plus_one(self) -> None:
        limit = len(SKILL)
        variants = ((SKILL[:-1], True), (SKILL, True), (SKILL + b"x", False))
        for content, clean in variants:
            with self.subTest(size=len(content)):
                result = inspect(
                    [("SKILL.md", content)],
                    max_skill_md_bytes=limit,
                    max_file_bytes=limit + 10,
                )
                self.assertEqual(result.clean, clean)

    def test_frontmatter_byte_limit_is_inclusive(self) -> None:
        closing_end = SKILL.index(b"---\n", 4) + 4
        for boundary, clean in ((closing_end - 1, False), (closing_end, True), (closing_end + 1, True)):
            with self.subTest(boundary=boundary):
                result = inspect([("SKILL.md", SKILL)], max_frontmatter_bytes=boundary)
                self.assertEqual(result.clean, clean)

    def test_frontmatter_field_metadata_and_scalar_limits_are_inclusive(self) -> None:
        for count, clean in ((3, True), (4, True), (5, False)):
            optional = ["license: safe", "compatibility: local", "metadata:"][: count - 2]
            content = ("---\nname: limit-skill\ndescription: bounded\n" + "\n".join(optional) + "\n---\n").encode()
            with self.subTest(kind="fields", count=count):
                self.assertEqual(inspect([("SKILL.md", content)], max_frontmatter_fields=4).clean, clean)

        for count, clean in ((3, True), (4, True), (5, False)):
            metadata = "\n".join(f"  key{index}: value" for index in range(count))
            content = f"---\nname: limit-skill\ndescription: bounded\nmetadata:\n{metadata}\n---\n".encode()
            with self.subTest(kind="metadata", count=count):
                self.assertEqual(inspect([("SKILL.md", content)], max_metadata_fields=4).clean, clean)

        for length, clean in ((3, True), (4, True), (5, False)):
            content = f"---\nname: s\ndescription: {'a' * length}\n---\n".encode()
            with self.subTest(kind="scalar", length=length):
                self.assertEqual(inspect([("SKILL.md", content)], max_frontmatter_scalar_chars=4).clean, clean)

    def test_allowed_tool_count_and_name_limits_are_inclusive(self) -> None:
        for count, clean in ((3, True), (4, True), (5, False)):
            tools = " ".join(f"t{index}" for index in range(count))
            content = f"---\nname: limit-skill\ndescription: bounded\nallowed-tools: {tools}\n---\n".encode()
            with self.subTest(kind="count", count=count):
                self.assertEqual(inspect([("SKILL.md", content)], max_allowed_tools=4).clean, clean)

        for length, clean in ((3, True), (4, True), (5, False)):
            content = f"---\nname: limit-skill\ndescription: bounded\nallowed-tools: {'t' * length}\n---\n".encode()
            with self.subTest(kind="name", length=length):
                self.assertEqual(inspect([("SKILL.md", content)], max_tool_chars=4).clean, clean)

    def test_finding_limit_never_returns_more_than_n_and_marks_n_and_n_plus_one(self) -> None:
        for count in (2, 3, 4):
            entries = [("SKILL.md", SKILL)] + [(f"unsupported-{index}.txt", b"x") for index in range(count)]
            result = inspect(entries, max_findings=3)
            with self.subTest(count=count):
                self.assertLessEqual(len(result.findings), 3)
                truncated = any(finding.code == "inspection.findings_truncated" for finding in result.findings)
                self.assertEqual(truncated, count >= 3)

    def test_single_and_total_snapshot_cache_limits_are_inclusive(self) -> None:
        archive = zipped([("SKILL.md", SKILL)])
        encoded = base64.b64encode(archive).decode("ascii")
        request = {"filename": "x.zip", "contentBase64": encoded}
        size = len(SKILL)
        for boundary, accepted in ((size - 1, False), (size, True), (size + 1, True)):
            service = SkillPackageImportService(
                object(), limits=replace(
                    DEFAULT_INSPECTION_LIMITS, max_cached_snapshot_bytes=boundary
                )
            )
            with self.subTest(kind="single", boundary=boundary):
                if accepted:
                    self.assertTrue(service.inspect_archive_request(request)["clean"])
                else:
                    with self.assertRaises(SkillPackageImportError) as raised:
                        service.inspect_archive_request(request)
                    self.assertEqual(raised.exception.code, "inspection_capacity_exceeded")

        service = SkillPackageImportService(
            object(), limits=replace(
                DEFAULT_INSPECTION_LIMITS,
                max_total_cached_snapshot_bytes=size * 2,
                max_inspection_sessions=3,
            )
        )
        self.assertTrue(service.inspect_archive_request(request)["clean"])
        self.assertTrue(service.inspect_archive_request(request)["clean"])
        with self.assertRaises(SkillPackageImportError) as raised:
            service.inspect_archive_request(request)
        self.assertEqual(raised.exception.code, "inspection_capacity_exceeded")

    def test_inspection_id_retry_limit_is_bounded(self) -> None:
        archive = zipped([("SKILL.md", SKILL)])
        request = {
            "filename": "x.zip",
            "contentBase64": base64.b64encode(archive).decode("ascii"),
        }
        service = SkillPackageImportService(
            object(),
            limits=replace(DEFAULT_INSPECTION_LIMITS, max_inspection_id_attempts=2),
            id_factory=lambda: "same-id",
        )
        service.inspect_archive_request(request)
        with self.assertRaises(SkillPackageImportError) as raised:
            service.inspect_archive_request(request)
        self.assertEqual(raised.exception.code, "inspection_id_unavailable")


if __name__ == "__main__":
    unittest.main()
