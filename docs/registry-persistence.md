# Registry persistence (`registry:v2`)

The root session stores the state of all retained subagent threads as custom entries. Child
conversations live in their own session files; the root only stores the registry that points
at them (`sessionFile`, `sessionLeafId`) together with task, status, output, usage and the
agent definition.

## Why v2

`registry:v1` appended a **full snapshot of every thread** on each change. One child
appending a message moved `sessionLeafId`, so the whole registry — task text, system
prompts, outputs — was written again, thousands of times. A long session reached 2.4 GiB,
99% of it registry snapshots, and Pi ran out of heap when loading it.

## Format

Entry type `pi-subagent:registry:v2`, `data.version === 2`:

| `op`    | Meaning                                                                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`  | Full state (`threads: SavedThread[]`). Written for the first persist on a branch with no registry, when the entry's `rootSessionId` differs (a fork), and when a patch cannot express the change (thread order). |
| `patch` | `ops: RegistryOp[]`, relative to the state of the branch ancestors.                                                                                                                                              |

Patch ops (all keyed by thread `path`; unknown fields or kinds are rejected):

- `insert {thread}` – a full `SavedThread`; written once per thread.
- `remove {path}` – reap, or the first half of replacing a thread's `definition`.
- `set {path, view}` / `unset {path, keys}` – allowlisted view keys only. `null` is a value
  (`sessionLeafId: null`); a missing key is expressed with `unset`. `path` cannot be set and
  required keys cannot be unset.
- `setInherited {path, value}` / `unsetInherited {path}` – `[]` and "absent" differ
  (absent plus no `sessionFile` marks a context that is still pending).

A typical leaf or counter update is one `set` of ~150 bytes, regardless of how much task,
definition or output text the other threads hold.

## Reading

State is rebuilt from `sessionManager.getBranch()` (the parentId chain), never from file
order: start at the last `v1` entry or `v2` `base` on the branch, then apply later patches in
order. Navigating the tree, resuming an older checkpoint, or forking therefore sees exactly
the registry — including each child's `sessionLeafId` — that was current at that point.
`v1` entries are read as a base, so existing sessions keep working.

## Writing

`persist()` reconciles the whole manager state against the baseline (the folded state of the
current branch) on every call, so explicit persists, reap and shutdown are never missed. It
appends nothing when nothing changed. `definition` and `inherited` are replaced wholesale and
never edited in place, so they are compared by reference first and not cloned. Every
checkpoint is kept; there is no debouncing.

Before each write the newest registry entry on the active branch is compared with the one the
baseline came from. If a tree navigation moved the branch, the baseline is rebuilt first, so a
patch always extends the branch it lands on.

## Fail closed

If the branch holds a registry that cannot be interpreted — unknown `registry:vN`, a
malformed entry, a patch with no base, an op on an unknown thread — the extension reports an
error and **stops writing registry entries for that branch**. It does not treat the damage as
an empty registry and overwrite it. Re-attaching to a different branch re-evaluates.
A branch with no registry at all is a legitimate empty start.

## Damage and write failures

- **v2 depends on a complete ancestor chain.** A patch is only meaningful on top of its
  `base`/v1 and the patches in between. If an ancestor entry is missing or corrupt (for example
  a lost or truncated line in the session file), the branch cannot be rebuilt reliably.
- In that case registry recovery and registry writes stop for the branch, with an error. The
  plugin does **not** guess or re-create state, and does not authorize old threads to continue
  on a guessed registry. Child session files are never deleted; repairing a _copy_ of the root
  session file by hand is the way out.
- A failed registry append (disk full, I/O error) also stops registry saving for the rest of the
  session, never advances the in-memory baseline, and tells the user to stop the session and
  check the disk. Nothing is retried automatically.
- The format does not claim to survive arbitrary corruption of the session log.
- Before writing, a state that would not read back (non-finite numbers, invalid values, missing
  required keys) is rejected rather than cleaned up silently.

## Compatibility and limits

- New versions read `v1` and `v2`. **Older plugin versions do not understand `v2`**: a session
  written by this version loses its subagent registry when opened by an older one. To go
  back, restore a backup made before upgrading.
- Pi keeps every session entry in memory. Patches are small, but memory still grows linearly
  with the number of events; this change lowers the constant, it does not make it flat.
- Existing large `v1` sessions stay large until converted with the offline migration tool.
- `inherited` context is still written once per thread that has no session file yet.
