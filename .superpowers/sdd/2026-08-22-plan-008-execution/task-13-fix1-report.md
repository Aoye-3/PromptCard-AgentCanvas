# Task 13 Fix 1 Report: Inspection Boundary Hardening

## Outcome

Closed the three Important findings from the independent Task 13 security review without extending into Task 14 host projection or Task 15 UI behavior.

1. Folder inspection is now bound to the initially reviewed root identity and discards all captured bytes if that identity changes.
2. TAR hard-limit failures immediately stop member iteration and return no snapshot entries.
3. A committed import consumes and clears its inspection snapshot before any response shaping that may fail.

## A. Folder root binding

On platforms with file-descriptor-relative filesystem APIs, inspection opens the root once with `O_DIRECTORY`, `O_NOFOLLOW`, and `O_CLOEXEC`, verifies the handle identity against the initial `lstat`, and traverses with descriptor-relative `scandir`, `stat`, and `open`. Child directories are opened relative to their parent handle and verified before use. An anchored-root open race is converted to the same closed `folder.root_changed` result.

The Windows standard library cannot open directories through `os.open` for descriptor-relative traversal. The fallback therefore revalidates the initial root's device, inode, type, and reparse state before and after each directory enumeration, before and after every file read, and before final return. Explicit path metadata is compared with enumerated metadata; file handles are still compared with explicit pre-read and post-read path identities including size and mtime. Any root mismatch returns exactly one blocking `folder.root_changed` finding with an empty manifest and snapshot.

Windows `DirEntry.stat` reports zero device/inode values and newly enumerated directory mtimes can differ slightly from immediate `lstat`. Those fields are therefore used only when both sides provide an identity; regular files additionally compare type, size, mtime, and reparse attributes. This is a documented best-effort limitation of the Windows standard-library fallback. The root itself always uses explicit `lstat` device/inode/type/reparse identity. The swap and swap-then-revert tests force this fallback and make every file-read attempt raise, proving replacement marker bytes are not read or retained.

## B. TAR hard limits

TAR enumeration now returns immediately on member-count, path, collision, per-file, total-uncompressed, compression-ratio, metadata-consistency, actual-total, or finding-count hard limits. Returning from the archive context closes the TAR before another header can be requested, and all previously accumulated entries are discarded.

The compressed-TAR probe wraps a real gzip TAR iterator. An oversized first member is followed by a valid `SKILL.md`; the test verifies that only the first header is requested, no member stream is extracted, the archive is closed, and the result contains no snapshot entries.

## C. Post-commit consumption

The import service continues to hold its existing `RLock` across the persistence call. Immediately when the Store call returns, it sets `snapshot = None`, sets cached bytes to zero, and marks the session consumed. Only then does it validate and shape the response. Malformed Store results and arbitrary response-summary exceptions produce the same fixed API error without exposing input, stack, or exception detail. The consumed tombstone remains, so retry returns 409 and cannot persist another revision.

Store exceptions still occur before consumption and leave the exact snapshot available for retry. The existing injected database-failure test and the new concurrent import test verify that this retry behavior and single-persistence serialization remain intact.

## TDD evidence

The first five behavior tests produced three failures, one error, and one pass:

- root swap and swap-revert incorrectly returned clean;
- TAR enumeration requested the following `SKILL.md` header after the limit;
- malformed post-commit Store output raised before consumption;
- the existing lock already serialized concurrent imports correctly.

The additional response-summary exception test first errored with an escaping `RuntimeError`. The anchored-root open-race test first errored with an escaping `OSError`. Both were then closed with minimal production changes.

Final focused coverage includes root swap, swap-revert, anchored-open race, replacement-byte no-read probes, compressed TAR iterator/close instrumentation, malformed post-commit output, arbitrary summary failure, concurrent import, and existing database failure/retry behavior.

## Verification

- Task 13 focused tests: `Ran 46`, `OK (skipped=1)`.
- Focused Ruff: all checks passed.
- Full Storage gate using the existing workspace-combined virtual environments and a fresh F-drive workspace TEMP: `Ran 248 tests in 110.439s`, `OK (skipped=2)`.
- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run build`: passed; `1911` modules transformed.

The build retains the pre-existing CSS syntax, mixed Tauri import, and large-chunk warnings. No dependency was installed or added.
