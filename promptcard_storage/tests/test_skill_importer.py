from __future__ import annotations

import builtins
import importlib
import io
import os
import shutil
import stat
import subprocess
import tarfile
import unittest
import uuid
import warnings
import zipfile
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import promptcard_storage.skill_importer as skill_importer_module
from promptcard_storage.skill_importer import (
    DEFAULT_INSPECTION_LIMITS,
    InspectionLimits,
    inspect_archive,
    inspect_folder,
    is_windows_reparse_point,
)


def workspace_directory() -> Path:
    root = Path(__file__).resolve().parent / ".task13-fixtures" / uuid.uuid4().hex
    root.mkdir(parents=True)
    return root


def skill_markdown(
    *,
    name: str = "safe-skill",
    description: str = "A safe imported skill.",
    extra: str = "",
    body: bytes = b"# Safe skill\n",
) -> bytes:
    frontmatter = (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        f"{extra}"
        "---\n"
    ).encode("utf-8")
    return frontmatter + body


def zip_bytes(entries: list[tuple[zipfile.ZipInfo | str, bytes]], compression: int = zipfile.ZIP_STORED) -> bytes:
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(output, "w", compression=compression) as archive:
            for path, content in entries:
                archive.writestr(path, content)
    return output.getvalue()


def tar_bytes(entries: list[tuple[tarfile.TarInfo, bytes]]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for info, content in entries:
            if info.isreg():
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            else:
                archive.addfile(info)
    return output.getvalue()


def tar_regular(path: str) -> tarfile.TarInfo:
    info = tarfile.TarInfo(path)
    info.mode = 0o644
    return info


class SkillFolderInspectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = workspace_directory()

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, relative_path: str, content: bytes) -> Path:
        target = self.root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return target

    def test_clean_folder_returns_sorted_sanitized_manifest_and_exact_snapshot(self) -> None:
        binary = b"\x00\xff\x80inert"
        self.write("SKILL.md", skill_markdown())
        self.write("references/guide.md", b"guide")
        self.write("scripts/tool.py", b"raise RuntimeError('must not run')")
        self.write("assets/blob.bin", binary)
        self.write(".git/secret", b"ignored")
        self.write("node_modules/module.js", b"ignored")
        self.write("cache/item", b"ignored")

        result = inspect_folder(self.root)

        self.assertTrue(result.clean, result.public_dict())
        self.assertEqual(
            [entry["path"] for entry in result.manifest["entries"]],
            ["SKILL.md", "assets/blob.bin", "references/guide.md", "scripts/tool.py"],
        )
        self.assertNotIn(str(self.root), repr(result.public_dict()))
        self.assertNotIn("content", result.manifest["entries"][0])
        self.assertEqual(result.snapshot.entry_bytes("assets/blob.bin"), binary)
        self.assertEqual([entry.entry_type for entry in result.snapshot.entries], [
            "instruction", "asset", "reference", "script",
        ])

    def test_missing_root_skill_file_is_blocking(self) -> None:
        self.write("references/guide.md", b"guide")

        result = inspect_folder(self.root)

        self.assertFalse(result.clean)
        self.assertIn("skill.root_instruction_missing", [finding.code for finding in result.findings])

    def test_symlink_is_rejected_without_reading_target(self) -> None:
        outside = self.root.parent / f"{self.root.name}-outside-secret"
        outside.write_bytes(b"outside-secret")
        link = self.root / "assets" / "escape.bin"
        link.parent.mkdir()
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError) as exc:
            outside.unlink(missing_ok=True)
            self.skipTest(f"symlink creation unavailable: {exc}")
        self.addCleanup(outside.unlink, missing_ok=True)
        self.write("SKILL.md", skill_markdown())

        result = inspect_folder(self.root)

        self.assertFalse(result.clean)
        self.assertIn("path.unsafe_link", [finding.code for finding in result.findings])
        self.assertNotIn(b"outside-secret", [entry.content for entry in result.snapshot.entries])

    def test_windows_reparse_fixture_is_detected(self) -> None:
        reparse = SimpleNamespace(st_file_attributes=0x400)
        ordinary = SimpleNamespace(st_file_attributes=0)

        self.assertTrue(is_windows_reparse_point(reparse))
        self.assertFalse(is_windows_reparse_point(ordinary))

    def test_file_identity_change_during_read_is_blocking(self) -> None:
        self.write("SKILL.md", skill_markdown())
        real_fstat = os.fstat
        calls = 0

        def changed_after_read(fd: int):
            nonlocal calls
            value = real_fstat(fd)
            calls += 1
            if calls == 2:
                values = list(value)
                values[6] = value.st_size + 1
                return os.stat_result(values)
            return value

        with patch("promptcard_storage.skill_importer.os.fstat", side_effect=changed_after_read):
            result = inspect_folder(self.root)

        self.assertFalse(result.clean)
        self.assertIn("folder.file_changed", [finding.code for finding in result.findings])

    def test_root_identity_swap_discards_replacement_bytes(self) -> None:
        original_content = skill_markdown(body=b"original-body")
        replacement_content = skill_markdown(body=b"replacement-marker-must-not-be-read")
        self.write("SKILL.md", original_content)
        parked = self.root.with_name(f"{self.root.name}-parked")
        replacement = self.root.with_name(f"{self.root.name}-replacement")
        replacement.mkdir()
        (replacement / "SKILL.md").write_bytes(replacement_content)
        real_scandir = os.scandir
        swapped = False

        def swap_before_scan(path):
            nonlocal swapped
            if not swapped and Path(path) == self.root:
                os.replace(self.root, parked)
                os.replace(replacement, self.root)
                swapped = True
            return real_scandir(path)

        try:
            with (
                patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=False),
                patch("promptcard_storage.skill_importer.os.scandir", side_effect=swap_before_scan),
                patch(
                    "promptcard_storage.skill_importer._read_folder_file",
                    side_effect=AssertionError("replacement bytes were read"),
                ),
            ):
                result = inspect_folder(self.root)
        finally:
            if swapped:
                os.replace(self.root, replacement)
                os.replace(parked, self.root)
            shutil.rmtree(replacement, ignore_errors=True)

        self.assertFalse(result.clean)
        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())
        self.assertNotIn(b"replacement-marker", repr(result.public_dict()).encode())

    def test_root_swap_then_revert_during_scandir_fails_closed(self) -> None:
        original_content = skill_markdown(body=b"original")
        replacement_content = skill_markdown(body=b"replacement-marker-must-not-be-read")
        self.write("SKILL.md", original_content)
        parked = self.root.with_name(f"{self.root.name}-parked")
        replacement = self.root.with_name(f"{self.root.name}-replacement")
        replacement.mkdir()
        (replacement / "SKILL.md").write_bytes(replacement_content)
        real_scandir = os.scandir
        swapped = False

        def enumerate_replacement_then_revert(path):
            nonlocal swapped
            if not swapped and Path(path) == self.root:
                os.replace(self.root, parked)
                os.replace(replacement, self.root)
                entries = list(real_scandir(path))
                os.replace(self.root, replacement)
                os.replace(parked, self.root)
                swapped = True
                return iter(entries)
            return real_scandir(path)

        try:
            with (
                patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=False),
                patch(
                    "promptcard_storage.skill_importer.os.scandir",
                    side_effect=enumerate_replacement_then_revert,
                ),
                patch(
                    "promptcard_storage.skill_importer._read_folder_file",
                    side_effect=AssertionError("replacement bytes were read"),
                ),
            ):
                result = inspect_folder(self.root)
        finally:
            if parked.exists():
                os.replace(parked, self.root)
            shutil.rmtree(replacement, ignore_errors=True)

        self.assertFalse(result.clean)
        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())

    def test_anchored_root_open_race_fails_closed(self) -> None:
        self.write("SKILL.md", skill_markdown())

        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=True),
            patch("promptcard_storage.skill_importer.os.open", side_effect=OSError),
        ):
            result = inspect_folder(self.root)

        self.assertFalse(result.clean)
        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())

    def test_anchored_scandir_error_is_redacted_and_closes_root_fd(self) -> None:
        self.write("SKILL.md", skill_markdown())
        root_stat = os.lstat(self.root)
        closed: list[int] = []

        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=True),
            patch("promptcard_storage.skill_importer.os.open", return_value=101),
            patch("promptcard_storage.skill_importer.os.fstat", return_value=root_stat),
            patch(
                "promptcard_storage.skill_importer.os.scandir",
                side_effect=OSError("C:\\private\\secret-folder"),
            ),
            patch("promptcard_storage.skill_importer.os.close", side_effect=closed.append),
        ):
            result = inspect_folder(self.root)

        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())
        self.assertNotIn("secret-folder", repr(result.public_dict()))
        self.assertEqual(closed, [101])

    def test_anchored_lazy_scandir_error_is_redacted_and_closes_resources(self) -> None:
        self.write("SKILL.md", skill_markdown())
        root_stat = os.lstat(self.root)
        closed_fds: list[int] = []

        class LazyFailure:
            closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.closed = True

            def __iter__(self):
                return self

            def __next__(self):
                raise OSError("C:\\private\\lazy-secret-folder")

        lazy = LazyFailure()
        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=True),
            patch("promptcard_storage.skill_importer.os.open", return_value=151),
            patch("promptcard_storage.skill_importer.os.fstat", return_value=root_stat),
            patch("promptcard_storage.skill_importer.os.scandir", return_value=lazy),
            patch("promptcard_storage.skill_importer.os.close", side_effect=closed_fds.append),
        ):
            result = inspect_folder(self.root)

        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())
        self.assertNotIn("lazy-secret-folder", repr(result.public_dict()))
        self.assertTrue(lazy.closed)
        self.assertEqual(closed_fds, [151])

    def test_anchored_child_fstat_error_closes_every_open_fd(self) -> None:
        self.write("SKILL.md", skill_markdown())
        child = self.root / "assets"
        child.mkdir()
        root_stat = os.lstat(self.root)
        child_stat = os.lstat(child)
        entry = SimpleNamespace(name="assets", stat=lambda **_kwargs: child_stat)
        opened = [201, 202]
        closed: list[int] = []

        def child_fstat_fails(fd):
            if fd == 202:
                raise OSError("C:\\private\\child-secret")
            return root_stat

        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=True),
            patch("promptcard_storage.skill_importer.os.open", side_effect=opened),
            patch("promptcard_storage.skill_importer.os.fstat", side_effect=child_fstat_fails),
            patch("promptcard_storage.skill_importer.os.scandir", return_value=iter([entry])),
            patch("promptcard_storage.skill_importer.os.stat", return_value=child_stat),
            patch("promptcard_storage.skill_importer.os.close", side_effect=closed.append),
        ):
            result = inspect_folder(self.root)

        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())
        self.assertNotIn("child-secret", repr(result.public_dict()))
        self.assertCountEqual(closed, [201, 202])

    def test_anchored_child_open_error_is_closed(self) -> None:
        self.write("SKILL.md", skill_markdown())
        child = self.root / "assets"
        child.mkdir()
        root_stat = os.lstat(self.root)
        child_stat = os.lstat(child)
        entry = SimpleNamespace(name="assets", stat=lambda **_kwargs: child_stat)
        closed: list[int] = []

        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=True),
            patch(
                "promptcard_storage.skill_importer.os.open",
                side_effect=[301, OSError("C:\\private\\open-secret")],
            ),
            patch("promptcard_storage.skill_importer.os.fstat", return_value=root_stat),
            patch("promptcard_storage.skill_importer.os.scandir", return_value=iter([entry])),
            patch("promptcard_storage.skill_importer.os.stat", return_value=child_stat),
            patch("promptcard_storage.skill_importer.os.close", side_effect=closed.append),
        ):
            result = inspect_folder(self.root)

        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())
        self.assertNotIn("open-secret", repr(result.public_dict()))
        self.assertEqual(closed, [301])

    def test_anchored_read_and_close_errors_fail_closed(self) -> None:
        self.write("SKILL.md", skill_markdown())
        root_stat = os.lstat(self.root)
        file_stat = os.lstat(self.root / "SKILL.md")
        entry = SimpleNamespace(name="SKILL.md", stat=lambda **_kwargs: file_stat)
        close_attempts: list[int] = []

        def fail_close(fd):
            close_attempts.append(fd)
            raise OSError("C:\\private\\close-secret")

        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=True),
            patch("promptcard_storage.skill_importer.os.open", return_value=401),
            patch("promptcard_storage.skill_importer.os.fstat", return_value=root_stat),
            patch("promptcard_storage.skill_importer.os.scandir", return_value=iter([entry])),
            patch("promptcard_storage.skill_importer.os.stat", return_value=file_stat),
            patch(
                "promptcard_storage.skill_importer._read_folder_file",
                side_effect=OSError("C:\\private\\read-secret"),
            ),
            patch("promptcard_storage.skill_importer.os.close", side_effect=fail_close),
        ):
            result = inspect_folder(self.root)

        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())
        self.assertNotIn("private", repr(result.public_dict()))
        self.assertEqual(close_attempts, [401])

    @unittest.skipUnless(os.name == "nt", "Windows directory lease behavior")
    def test_windows_directory_lease_blocks_real_nested_rename(self) -> None:
        self.write("SKILL.md", skill_markdown())
        target = self.root / "assets"
        target.mkdir()
        (target / "payload.bin").write_bytes(b"safe")
        parked = self.root.parent / f"{self.root.name}-lease-parked"
        real_scandir = os.scandir
        attempted = False
        blocked = False

        def attempt_rename_while_scanning(path):
            nonlocal attempted, blocked
            if not attempted and Path(path) == target:
                attempted = True
                try:
                    os.replace(target, parked)
                except OSError:
                    blocked = True
            return real_scandir(path)

        try:
            with (
                patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=False),
                patch(
                    "promptcard_storage.skill_importer.os.scandir",
                    side_effect=attempt_rename_while_scanning,
                ),
            ):
                result = inspect_folder(self.root)
        finally:
            if parked.exists():
                os.replace(parked, target)

        self.assertTrue(attempted)
        self.assertTrue(blocked)
        self.assertTrue(result.clean, result.public_dict())

    @unittest.skipUnless(os.name == "nt", "Windows directory lease behavior")
    def test_windows_directory_lease_handles_close_in_reverse_order(self) -> None:
        self.write("SKILL.md", skill_markdown())
        (self.root / "assets").mkdir()
        opened_paths: list[Path] = []
        closed_handles: list[int] = []

        def open_lease(path):
            opened_paths.append(Path(path))
            return 700 + len(opened_paths)

        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=False),
            patch(
                "promptcard_storage.skill_importer._open_windows_directory_lease",
                side_effect=open_lease,
                create=True,
            ),
            patch(
                "promptcard_storage.skill_importer._close_windows_directory_lease",
                side_effect=closed_handles.append,
                create=True,
            ),
        ):
            result = inspect_folder(self.root)

        self.assertTrue(result.clean, result.public_dict())
        self.assertEqual(opened_paths, [self.root, self.root / "assets"])
        self.assertEqual(closed_handles, [702, 701])

    @unittest.skipUnless(os.name == "nt", "Windows directory lease behavior")
    def test_windows_directory_lease_open_error_fails_closed(self) -> None:
        self.write("SKILL.md", skill_markdown())

        with (
            patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=False),
            patch(
                "promptcard_storage.skill_importer._open_windows_directory_lease",
                side_effect=OSError("C:\\private\\lease-secret"),
                create=True,
            ),
        ):
            result = inspect_folder(self.root)

        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())
        self.assertNotIn("lease-secret", repr(result.public_dict()))

    def test_nested_directory_swap_discards_replacement_bytes(self) -> None:
        self.write("SKILL.md", skill_markdown())
        target = self.root / "assets" / "level-one" / "level-two"
        target.mkdir(parents=True)
        (target / "payload.bin").write_bytes(b"original-child")
        parked = self.root.parent / f"{self.root.name}-child-parked"
        replacement = self.root.parent / f"{self.root.name}-child-replacement"
        replacement.mkdir()
        (replacement / "payload.bin").write_bytes(b"replacement-marker-must-not-be-read")
        real_scandir = os.scandir
        real_read = skill_importer_module._read_folder_file
        child_reads: list[Path] = []
        swapped = False

        def swap_child_before_scan(path):
            nonlocal swapped
            if not swapped and Path(path) == target:
                os.replace(target, parked)
                os.replace(replacement, target)
                swapped = True
            return real_scandir(path)

        def record_child_read(path, expected, limit, *, dir_fd=None):
            candidate = Path(path)
            if candidate.name == "payload.bin":
                child_reads.append(candidate)
            return real_read(path, expected, limit, dir_fd=dir_fd)

        try:
            with (
                patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=False),
                patch("promptcard_storage.skill_importer.os.scandir", side_effect=swap_child_before_scan),
                patch(
                    "promptcard_storage.skill_importer._read_folder_file",
                    side_effect=record_child_read,
                ),
            ):
                result = inspect_folder(self.root)
        finally:
            if swapped:
                os.replace(target, replacement)
                os.replace(parked, target)
            shutil.rmtree(replacement, ignore_errors=True)

        self.assertFalse(result.clean)
        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())
        self.assertEqual(child_reads, [])

    def test_nested_directory_swap_then_revert_fails_closed(self) -> None:
        self.write("SKILL.md", skill_markdown())
        target = self.root / "assets" / "level-one" / "level-two"
        target.mkdir(parents=True)
        original_file = target / "payload.bin"
        original_file.write_bytes(b"same-size-original")
        parked = self.root.parent / f"{self.root.name}-child-parked"
        replacement = self.root.parent / f"{self.root.name}-child-replacement"
        replacement.mkdir()
        replacement_file = replacement / "payload.bin"
        replacement_file.write_bytes(b"same-size-marker-x")
        fixed_mtime = 1_700_000_000_000_000_000
        os.utime(original_file, ns=(fixed_mtime, fixed_mtime))
        os.utime(replacement_file, ns=(fixed_mtime, fixed_mtime))
        real_scandir = os.scandir
        real_read = skill_importer_module._read_folder_file
        child_reads: list[Path] = []
        swapped = False

        def enumerate_replacement_then_revert(path):
            nonlocal swapped
            if not swapped and Path(path) == target:
                os.replace(target, parked)
                os.replace(replacement, target)
                entries = list(real_scandir(path))
                for entry in entries:
                    entry.stat(follow_symlinks=False)
                os.replace(target, replacement)
                os.replace(parked, target)
                swapped = True
                return iter(entries)
            return real_scandir(path)

        def record_child_read(path, expected, limit, *, dir_fd=None):
            candidate = Path(path)
            if candidate.name == "payload.bin":
                child_reads.append(candidate)
            return real_read(path, expected, limit, dir_fd=dir_fd)

        try:
            with (
                patch("promptcard_storage.skill_importer._supports_anchored_folder_walk", return_value=False),
                patch(
                    "promptcard_storage.skill_importer.os.scandir",
                    side_effect=enumerate_replacement_then_revert,
                ),
                patch(
                    "promptcard_storage.skill_importer._read_folder_file",
                    side_effect=record_child_read,
                ),
            ):
                result = inspect_folder(self.root)
        finally:
            if parked.exists():
                os.replace(parked, target)
            shutil.rmtree(replacement, ignore_errors=True)

        self.assertFalse(result.clean)
        self.assertEqual([finding.code for finding in result.findings], ["folder.root_changed"])
        self.assertEqual(result.snapshot.entries, ())
        self.assertEqual(child_reads, [])

    def test_windows_ambiguous_paths_and_canonical_collisions_fail_closed(self) -> None:
        cases = {"reserved": "assets/CON.txt"}
        for label, relative in cases.items():
            with self.subTest(label=label):
                case_root = self.root / label
                case_root.mkdir()
                (case_root / "SKILL.md").write_bytes(skill_markdown())
                target = case_root.joinpath(*relative.split("/"))
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(b"unsafe")
                except OSError:
                    continue
                result = inspect_folder(case_root)
                self.assertFalse(result.clean)
                self.assertTrue(any(finding.code.startswith("path.") for finding in result.findings))


class SkillArchiveInspectionTests(unittest.TestCase):
    def clean_entries(self) -> list[tuple[str, bytes]]:
        return [("SKILL.md", skill_markdown()), ("references/guide.md", b"guide")]

    def test_clean_zip_and_tar_produce_the_same_canonical_digest(self) -> None:
        zip_content = zip_bytes(self.clean_entries())
        tar_content = tar_bytes([
            (tar_regular("references/guide.md"), b"guide"),
            (tar_regular("SKILL.md"), skill_markdown()),
        ])

        zipped = inspect_archive(zip_content, "skill.zip")
        tarred = inspect_archive(tar_content, "skill.tar")

        self.assertTrue(zipped.clean)
        self.assertTrue(tarred.clean)
        self.assertEqual(zipped.manifest["digest"], tarred.manifest["digest"])
        self.assertEqual(
            [(entry.path, entry.content) for entry in zipped.snapshot.entries],
            [(entry.path, entry.content) for entry in tarred.snapshot.entries],
        )

    def test_zip_rejects_traversal_links_encryption_and_nested_archives(self) -> None:
        symlink = zipfile.ZipInfo("assets/link")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        fixtures = {
            "traversal": zip_bytes(self.clean_entries() + [("../escape", b"x")]),
            "symlink": zip_bytes(self.clean_entries() + [(symlink, b"target")]),
            "nested": zip_bytes(self.clean_entries() + [("assets/nested.zip", b"PK")]),
        }
        encrypted = bytearray(zip_bytes(self.clean_entries()))
        encrypted[6:8] = (int.from_bytes(encrypted[6:8], "little") | 1).to_bytes(2, "little")
        central = encrypted.index(b"PK\x01\x02")
        encrypted[central + 8:central + 10] = (
            int.from_bytes(encrypted[central + 8:central + 10], "little") | 1
        ).to_bytes(2, "little")
        fixtures["encrypted"] = bytes(encrypted)

        expected = {
            "traversal": "path.invalid",
            "symlink": "archive.unsafe_member",
            "nested": "archive.nested_unsupported",
            "encrypted": "archive.encrypted_member",
        }
        for label, content in fixtures.items():
            with self.subTest(label=label):
                result = inspect_archive(content, "fixture.zip")
                self.assertFalse(result.clean)
                self.assertIn(expected[label], [finding.code for finding in result.findings])

    def test_tar_rejects_symlink_hardlink_device_and_fifo_cross_platform(self) -> None:
        member_types = {
            "symlink": tarfile.SYMTYPE,
            "hardlink": tarfile.LNKTYPE,
            "character": tarfile.CHRTYPE,
            "block": tarfile.BLKTYPE,
            "fifo": tarfile.FIFOTYPE,
        }
        for label, member_type in member_types.items():
            with self.subTest(label=label):
                unsafe = tarfile.TarInfo(f"assets/{label}")
                unsafe.type = member_type
                unsafe.linkname = "SKILL.md"
                content = tar_bytes([
                    (tar_regular("SKILL.md"), skill_markdown()),
                    (unsafe, b""),
                ])
                result = inspect_archive(content, "fixture.tar")
                self.assertFalse(result.clean)
                self.assertIn("archive.unsafe_member", [finding.code for finding in result.findings])

    def test_duplicate_casefold_and_nfc_paths_are_rejected(self) -> None:
        variants = {
            "duplicate": [("assets/a.bin", b"one"), ("assets/a.bin", b"two")],
            "casefold": [("assets/A.bin", b"one"), ("assets/a.bin", b"two")],
            "nfc": [("assets/caf\u00e9.bin", b"one"), ("assets/cafe\u0301.bin", b"two")],
        }
        for label, extra in variants.items():
            with self.subTest(label=label):
                result = inspect_archive(zip_bytes(self.clean_entries() + extra), "fixture.zip")
                self.assertFalse(result.clean)
                self.assertIn("path.collision", [finding.code for finding in result.findings])

    def test_windows_reserved_ads_and_trailing_dot_space_archive_paths_are_rejected(self) -> None:
        cases = {
            "assets/CON.txt": "path.windows_ambiguous",
            "assets/file.txt:secret": "path.windows_ambiguous",
            "assets/file. ": "path.windows_ambiguous",
            "assets/control\x01.bin": "path.invalid",
        }
        for path, code in cases.items():
            with self.subTest(path=path):
                result = inspect_archive(
                    zip_bytes(self.clean_entries() + [(path, b"unsafe")]), "fixture.zip"
                )
                self.assertFalse(result.clean)
                self.assertIn(code, [finding.code for finding in result.findings])

    def test_count_file_total_and_compression_limits_are_bounded(self) -> None:
        base = [("SKILL.md", skill_markdown())]
        count_limits = replace(DEFAULT_INSPECTION_LIMITS, max_members=3)
        for actual, clean in ((2, True), (3, True), (4, False)):
            entries = base + [(f"assets/{index}.bin", b"x") for index in range(actual - 1)]
            with self.subTest(limit="count", actual=actual):
                self.assertEqual(inspect_archive(zip_bytes(entries), "x.zip", count_limits).clean, clean)

        per_file_limit = len(skill_markdown()) + 4
        file_limits = replace(DEFAULT_INSPECTION_LIMITS, max_file_bytes=per_file_limit)
        for actual, clean in (
            (per_file_limit - 1, True),
            (per_file_limit, True),
            (per_file_limit + 1, False),
        ):
            entries = [("SKILL.md", skill_markdown()), ("assets/file.bin", b"x" * actual)]
            with self.subTest(limit="file", actual=actual):
                self.assertEqual(inspect_archive(zip_bytes(entries), "x.zip", file_limits).clean, clean)

        skill_size = len(skill_markdown())
        total_limits = replace(DEFAULT_INSPECTION_LIMITS, max_total_bytes=skill_size + 4)
        for actual, clean in ((3, True), (4, True), (5, False)):
            entries = [("SKILL.md", skill_markdown()), ("assets/file.bin", b"x" * actual)]
            with self.subTest(limit="total", actual=actual):
                self.assertEqual(inspect_archive(zip_bytes(entries), "x.zip", total_limits).clean, clean)

        compressed = zip_bytes(
            [("SKILL.md", skill_markdown()), ("assets/repeated.bin", b"x" * 256)],
            zipfile.ZIP_DEFLATED,
        )
        strict_ratio = replace(DEFAULT_INSPECTION_LIMITS, max_compression_ratio=2)
        self.assertFalse(inspect_archive(compressed, "x.zip", strict_ratio).clean)

    def test_tar_hard_limit_stops_before_requesting_the_next_header(self) -> None:
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode="w:gz") as archive:
            oversized = tarfile.TarInfo("assets/oversized.bin")
            oversized.size = 5
            archive.addfile(oversized, io.BytesIO(b"12345"))
            instruction = tarfile.TarInfo("SKILL.md")
            instruction.size = len(skill_markdown())
            archive.addfile(instruction, io.BytesIO(skill_markdown()))

        real_archive = tarfile.open(fileobj=io.BytesIO(content.getvalue()), mode="r:gz")
        requested_headers: list[str] = []
        extracted: list[str] = []
        closed = False

        class InstrumentedArchive:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                nonlocal closed
                real_archive.close()
                closed = True

            def __iter__(self):
                for member in real_archive:
                    requested_headers.append(member.name)
                    yield member

            def extractfile(self, member):
                extracted.append(member.name)
                return real_archive.extractfile(member)

        limits = replace(DEFAULT_INSPECTION_LIMITS, max_file_bytes=4)
        with patch("promptcard_storage.skill_importer.tarfile.open", return_value=InstrumentedArchive()):
            result = inspect_archive(content.getvalue(), "fixture.tar.gz", limits)

        self.assertFalse(result.clean)
        self.assertEqual(requested_headers, ["assets/oversized.bin"])
        self.assertEqual(extracted, [])
        self.assertTrue(closed)
        self.assertEqual(result.snapshot.entries, ())


class SkillMetadataAndCredentialTests(unittest.TestCase):
    def inspect_skill(self, content: bytes):
        return inspect_archive(zip_bytes([("SKILL.md", content)]), "skill.zip")

    def test_frontmatter_is_utf8_bounded_closed_and_rejects_yaml_features(self) -> None:
        invalid = {
            "missing": b"# no frontmatter\n",
            "duplicate": b"---\nname: one\nname: two\ndescription: safe\n---\nbody",
            "anchor": b"---\nname: &value one\ndescription: safe\n---\nbody",
            "alias": b"---\nname: one\ndescription: *value\n---\nbody",
            "tag": b"---\nname: one\ndescription: !custom safe\n---\nbody",
            "unknown": b"---\nname: one\ndescription: safe\nhooks: install\n---\nbody",
            "dangerous-type": b"---\nname: true\ndescription: safe\n---\nbody",
            "invalid-utf8": b"---\nname: safe\ndescription: \xff\n---\nbody",
        }
        for label, content in invalid.items():
            with self.subTest(label=label):
                result = self.inspect_skill(content)
                self.assertFalse(result.clean)
                self.assertTrue(any(finding.code.startswith("frontmatter.") for finding in result.findings))

    def test_allowed_tools_are_validation_only_and_body_bytes_remain_exact(self) -> None:
        content = skill_markdown(extra="allowed-tools: read_prompt search_prompt\n", body=b"body\r\nexact\x00")

        result = self.inspect_skill(content)

        self.assertTrue(result.clean)
        self.assertEqual(list(result.snapshot.metadata["allowedTools"]), ["read_prompt", "search_prompt"])
        self.assertEqual(result.snapshot.entry_bytes("SKILL.md"), content)

    def test_credentials_report_rule_path_and_line_without_secret_echo(self) -> None:
        secrets = {
            "private-key": b"-----BEGIN PRIVATE KEY-----\nraw-secret-material",
            "known-token": b"token = ghp_abcdefghijklmnopqrstuvwxyz1234567890",
            "assignment": b"password = actual-secret-value",
        }
        for label, secret in secrets.items():
            with self.subTest(label=label):
                content = zip_bytes(self.clean_with_reference(secret))
                result = inspect_archive(content, "skill.zip")
                public = repr(result.public_dict())
                self.assertFalse(result.clean)
                findings = [finding for finding in result.findings if finding.code == "credential.detected"]
                self.assertTrue(findings)
                self.assertIsNotNone(findings[0].rule)
                self.assertEqual(findings[0].path, "references/secret.txt")
                self.assertEqual(findings[0].line, 1)
                self.assertNotIn(secret.decode("ascii").splitlines()[-1], public)

    def clean_with_reference(self, reference: bytes) -> list[tuple[str, bytes]]:
        return [("SKILL.md", skill_markdown()), ("references/secret.txt", reference)]

    def test_credential_placeholders_are_not_false_positives(self) -> None:
        placeholders = b"password=<password>\napi_key=YOUR_API_KEY\ntoken=changeme\n"

        result = inspect_archive(zip_bytes(self.clean_with_reference(placeholders)), "skill.zip")

        self.assertTrue(result.clean)
        self.assertFalse(any(finding.code == "credential.detected" for finding in result.findings))

    def test_scripts_and_package_manifests_are_never_executed(self) -> None:
        marker_root = workspace_directory()
        self.addCleanup(shutil.rmtree, marker_root, True)
        marker = marker_root / "executed.marker"
        script = f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')\n".encode()
        package = b'{"scripts":{"install":"write-marker"}}'
        archive = zip_bytes([
            ("SKILL.md", skill_markdown()),
            ("scripts/install.py", script),
            ("package.json", package),
        ])

        with (
            patch.object(builtins, "eval", side_effect=AssertionError("eval forbidden")),
            patch.object(builtins, "exec", side_effect=AssertionError("exec forbidden")),
            patch.object(importlib, "import_module", side_effect=AssertionError("import forbidden")),
            patch.object(subprocess, "Popen", side_effect=AssertionError("subprocess forbidden")),
            patch.object(subprocess, "run", side_effect=AssertionError("subprocess forbidden")),
            patch.object(subprocess, "call", side_effect=AssertionError("subprocess forbidden")),
            patch.object(subprocess, "check_call", side_effect=AssertionError("subprocess forbidden")),
            patch.object(subprocess, "check_output", side_effect=AssertionError("subprocess forbidden")),
            patch.object(os, "system", side_effect=AssertionError("system forbidden")),
        ):
            result = inspect_archive(archive, "skill.zip")

        self.assertTrue(result.clean)
        self.assertFalse(marker.exists())
        self.assertEqual(result.snapshot.entry_bytes("scripts/install.py"), script)
        self.assertIn("package.inert_manifest", [finding.code for finding in result.findings])


class InspectionLimitDefinitionTests(unittest.TestCase):
    def test_all_limits_are_positive_and_centrally_defined(self) -> None:
        limits = DEFAULT_INSPECTION_LIMITS
        self.assertIsInstance(limits, InspectionLimits)
        for name, value in vars(limits).items():
            self.assertGreater(value, 0, name)


if __name__ == "__main__":
    unittest.main()
