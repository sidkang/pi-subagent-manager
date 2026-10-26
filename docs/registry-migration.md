# Migrating a session from registry v1 to v2

Older versions appended a full `pi-subagent:registry:v1` snapshot of every retained agent
on each change, which can grow a session file to gigabytes. `scripts/migrate-registry.ts`
rewrites such a file into `pi-subagent:registry:v2` records (see `registry-persistence.md`).

Run from the repository root with the locally installed dependencies (`npm ci` beforehand);
the tool does not download anything.

```sh
node --import tsx scripts/migrate-registry.ts --input old.jsonl --output new.jsonl
node --import tsx scripts/migrate-registry.ts --input old.jsonl --output new.jsonl --verify-only
```

## Safety rules

- **Stop Pi first.** The tool checks the input's inode, size and mtime at the start and end
  and aborts if they changed. That is a check, not a lock; it cannot stop a writer that
  appends between checks you did not run.
- The input is only read. The tool never replaces a file: the output path must not exist
  (symlinks and the input itself are refused). Output is written to a `0600` temp file in
  the same directory, fsynced, fully re-verified, then published with a no-clobber hard
  link. Any failure removes the temp file and leaves no output.
- Swapping the migrated file in for the session is manual and yours to do; keep the original
  as the backup. Older plugin versions cannot read v2, so rolling the plugin back means
  restoring that backup (registry changes made after migration are lost).

## What it does

- Every entry keeps its `id`, `parentId`, `timestamp` and other fields; non-registry lines
  (including blank, corrupt, CRLF and a missing final newline) are copied byte for byte.
- Each registry entry becomes a v2 record relative to its **nearest registry ancestor on the
  parentId chain**, not the previous line in the file. Entries with no ancestor, or whose
  ancestor belongs to another `rootSessionId` (forked copies), become full `base` records.
  Unchanged entries become an empty patch so the node is kept.
- Memory is O(longest line + entry index + a few cached states): two streaming passes with an
  offset index; ancestor snapshots are re-read on demand.

## Verification (all must pass before publishing)

1. Each converted record is re-applied with `applyRegistry` and deep-compared to the v1 state.
2. The output is re-read independently: same line count, same id/parentId tree, same registry
   lines, byte-identical non-registry lines, identical envelope fields, and for **every**
   registry entry the state folded along its own ancestor chain equals the v1 state.

## Rejected input

v2 or any unknown `pi-subagent:registry:*` type (mixed files are not supported), invalid
registry state, duplicate entry ids, parentId cycles (including registry entries that are each other's parent), an input that is not a regular file.
Corrupt JSON lines are not entries (Pi skips them) and are copied unchanged.

Not covered: files modified by something other than appends during the run beyond the stat
checks, and any migration of real user sessions (not performed by this change).
