# Task 13 Fix 2 Report: Nested Directory And Filesystem Failure Hardening

## Outcome

Closed both Important findings from the second Task 13 security review without changing package persistence, host projection, or Skill Hub UI behavior.

1. The Windows/path fallback now binds every pending directory to the explicit identity observed before it is queued, including nested directories.
2. Descriptor-relative inspection now closes every successfully opened descriptor on every exit path and converts expected filesystem failures into one fixed, redacted `folder.root_changed` result.

## Nested directory identity

Fallback traversal pending items now carry the directory path, depth, and explicit `lstat` captured before the directory was queued. Before and after `scandir`, before processing each child, after the child's explicit `lstat`, and before and after file reads, the current directory is compared with that expected identity. Any mismatch discards all accumulated entries and returns exactly one blocking `folder.root_changed` finding.

Reliable directory comparison requires both values to be directories, rejects symlink/reparse state, compares type and Windows file attributes, and compares device/inode whenever both sides provide non-zero values. When an enumeration result cannot provide device/inode on Windows, creation/change time is the closed fallback discriminator. Regular enumerated files additionally compare type, attributes, creation/change time, size, and mtime. This avoids treating Windows `DirEntry.stat` zero device/inode fields as reliable while detecting a swap-then-revert fixture whose replacement has the same name, size, and mtime.

The descriptor-relative POSIX path carries the parent-observed directory stat with each pending child descriptor. Every child handle is verified against that stat immediately after open and again before/after its directory scan and while processing entries.

## Filesystem failure and descriptor lifecycle

Descriptor-relative filesystem calls are normalized through a narrow boundary that catches only `OSError` and filesystem `ValueError`. Root/child open, handle stat, directory scan, relative stat, bounded read, and close failures therefore return the same redacted `folder.root_changed` result with an empty manifest and snapshot. Exception text and source paths never enter findings or API responses.

Each successful root or child open is registered before the next filesystem operation. One outer `finally` attempts every registered close in reverse order, including when child `fstat`, scan, or read fails. A close failure does not stop later close attempts and forces a closed result. Programming failures such as `AssertionError` and `TypeError` are not caught by the filesystem boundary; descriptor cleanup still runs while the programming failure propagates.

Fallback `scandir`, explicit stat, and file-open/read `OSError` or `ValueError` cases use the same closed result instead of continuing with partial findings. The API contract test confirms a fake private source path in an injected exception is absent from the response.

## TDD evidence

The initial seven behavior tests produced four failures and three errors:

- nested child swap and swap-then-revert both returned clean;
- anchored `scandir`, child `fstat`, and close errors escaped with their original exception text;
- child open failure was reduced to `folder.file_changed` plus a missing-instruction finding;
- the fallback API returned partial findings rather than the single closed result.

After the minimal implementation, all seven passed. The nested tests use three directory levels. The swap test replaces the deepest pending directory; the swap-revert test caches replacement enumeration metadata, restores an original file with the same name, size, and mtime, and still fails closed. File-read probes record no child payload read.

Descriptor probes verify one root open/close attempt for a scan failure, two opens/two close attempts for a child-`fstat` failure, and cleanup continuation when close itself raises. All public results contain only fixed findings and empty snapshots.

## Verification

- Task 13 focused tests: `Ran 53`, `OK (skipped=1)`.
- Focused Ruff: all checks passed.
- Full Storage gate using the existing workspace-combined virtual environments and a fresh F-drive workspace TEMP: `Ran 255 tests in 96.728s`, `OK (skipped=2)`.
- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run build`: passed; `1911` modules transformed.

The build retains the pre-existing CSS syntax, mixed Tauri import, and large-chunk warnings. No dependency was installed or added.
