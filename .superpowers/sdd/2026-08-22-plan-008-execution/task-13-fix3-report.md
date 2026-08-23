# Task 13 Fix 3 Report: Lazy Enumeration And Windows Directory Leases

## Outcome

Closed both Important findings from the third Task 13 security review without changing package persistence, host projection, or Skill Hub UI behavior.

1. Descriptor-relative directory enumeration now places iterator creation, complete materialization, sorting, and iterator close inside the narrow filesystem-failure boundary.
2. Windows folder inspection now holds non-delete-sharing directory handles for the root and every discovered child instead of relying on `DirEntry` timestamps to detect swap-then-revert races.

## Lazy descriptor-relative enumeration

The anchored path uses one sorted-scan helper. The helper creates `os.scandir(fd)`, enters its context when supported, fully consumes and sorts the iterator, and exits the context inside `_folder_filesystem_call`. An `OSError` or `ValueError` raised by lazy `__next__`, context enter/exit, or sorting therefore becomes the same fixed `folder.root_changed` result. `AssertionError`, `TypeError`, and other programming failures still propagate after descriptor cleanup.

The regression iterator raises an `OSError` containing a fixed fake private path only from `__next__`. Inspector and API tests verify a single closed finding, an empty snapshot/manifest, no exception text or source path in the response, iterator exit, and balanced root descriptor close.

## Windows directory leases

Windows traversal now creates a lease registry before path-based scanning. It opens the root and each child directory with `CreateFileW`, `OPEN_EXISTING`, `FILE_FLAG_BACKUP_SEMANTICS`, and `FILE_FLAG_OPEN_REPARSE_POINT`. Desired access is `DELETE | FILE_READ_ATTRIBUTES`; sharing permits `FILE_SHARE_READ | FILE_SHARE_WRITE` and intentionally excludes `FILE_SHARE_DELETE`.

The `DELETE` desired-access bit is required on the tested workspace volume for the no-delete-share lease to block a concurrent directory rename. The real Windows test attempts `os.replace` against a leased nested directory and observes the expected `OSError` while a normal package inspection remains clean.

Each lease acquisition performs an explicit `lstat` before open, registers the returned handle immediately, and performs another explicit `lstat` after open. Both must match the parent-observed expected directory identity, type, and reparse state. Root and child leases remain held until the complete inspection ends, covering scanning, materialization, and later pending-child processing. Existing explicit metadata checks remain as defense in depth.

All registered handles are closed in reverse order in one context exit. Close continues after an individual close failure. Open, validation, unavailable WinAPI, permission, or close failures fail closed with `folder.root_changed`; there is no fallback to the unleased Windows path mode. A programming exception is never replaced by a close exception.

This design intentionally requires delete/attribute access to every reviewed directory. A package that cannot grant that local handle access is rejected rather than inspected with a weaker race boundary.

## TDD evidence

The five initial behavior tests produced three failures and two errors:

- lazy inspector and API iterators leaked their `__next__` exception;
- a real Windows nested rename succeeded while inspection was scanning;
- injected root/child lease functions were never called;
- an injected lease-open error incorrectly allowed a clean result.

The first lease implementation used only `FILE_READ_ATTRIBUTES`. The real workspace RED showed that this volume still allowed rename. Adding the minimal `DELETE` desired access while retaining a share mask without delete made the actual rename probe fail as required.

Final focused coverage also reruns the prior nested swap and swap-revert marker probes. Neither result is clean and neither reads replacement bytes. Injected lease handles show two opens and reverse-order child/root closes; ordinary folders remain clean.

## Verification

- Task 13 focused tests: `Ran 58`, `OK (skipped=1)`.
- Focused Ruff: all checks passed.
- Full Storage gate using the existing workspace-combined virtual environments and a fresh F-drive workspace TEMP: `Ran 260 tests in 86.877s`, `OK (skipped=2)`.
- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run build`: passed; `1911` modules transformed.

The build retains the pre-existing CSS syntax, mixed Tauri import, and large-chunk warnings. No dependency was installed or added.
