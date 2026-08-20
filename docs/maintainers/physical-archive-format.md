# Physical Archive Format

This is the common native/WASIX physical-backup contract. It is intentionally
narrower than `pg_basebackup` and is versioned as
`oliphaunt-physical-archive-v1`.

## Scope

Physical archives are buffered same-family PostgreSQL 18 restore artifacts.
Native direct and broker sessions use the native format. Both WASIX bindings
use the WASIX format. A physical archive is not the interchange path between
native and WASIX; standard PostgreSQL logical dump/restore serves that purpose.

Native server mode does not expose this SDK backup API. Applications connected
to a native server use PostgreSQL's `pg_basebackup` tool.

## Container

The container is a tar archive. Restore validation accepts GNU or ustar headers
only, verifies header checksums and numeric/string fields, requires a complete
tar terminator, and rejects trailing bytes after the terminator.

Archive entries may be regular files or directories only. Symlinks, hard links,
FIFOs, device nodes, and all other entry types are rejected. Regular file
entries must not carry link metadata, directory entries must not carry payload
bytes, and duplicate canonical paths are rejected.

## Paths

Allowed canonical archive paths are:

- `pgdata/` and descendants;
- `.oliphaunt/backup-manifest.properties`.

Path canonicalization removes `.` components and rejects absolute paths, parent
directory traversal, Windows prefixes, and entries that would place a file below
an already-seen file or replace an already-seen subtree.

## Metadata

`.oliphaunt/backup-manifest.properties` identifies the archive and compatibility
metadata. Readers byte-compare its exact ASCII (and therefore UTF-8) contents:
five lines in the order below, each terminated by LF, including the final line.

```text
archiveLayout=oliphaunt-physical-archive-v1
product=oliphaunt
engineFamily=<native or wasix>
physicalFormat=<native-pg18-v1 or wasix-pg18-v1, matching engineFamily>
postgresMajor=18
```

Unknown, missing, or duplicate keys are rejected. There is no legacy
PGDATA-only or partial-manifest restore path.

## Backup Creation

Backup creation starts PostgreSQL backup mode, archives the bulk `PGDATA` tree,
then appends a fresh `global/pg_control` before stopping backup mode. It next
appends required WAL plus the generated `backup_label` and `tablespace_map`.
This is PostgreSQL's fetch-at-end WAL collection model. Backup start records the
starting WAL filename and the cluster's actual WAL segment size; backup stop
records the final required WAL filename. The creator enumerates that inclusive
range, verifies each concrete segment has the configured size, and appends only
those required segments. A short read, malformed or reversed range, timeline
change, or missing or truncated required segment fails backup creation instead
of emitting an incomplete archive. The implementations do not enable WAL
archiving, create a replication slot, change retention settings, or expose
another backup mode.

The filename arithmetic contract, including 16 MiB and 4 MiB segment sizes and
the 4 GiB `XLogId` boundary, is fixed by
`src/shared/fixtures/storage/physical-backup-wal-range-v1.properties`.
The bulk pass skips top-level backup/runtime temporaries, `.DS_Store` wherever
encountered, `pg_internal.init*`, `pgsql_tmp*`, `global/pg_control`, `pg_wal` contents, and the contents of
PostgreSQL's transient state directories. Those directories remain present as
empty directory entries. The top-level exclusions are `postmaster.pid`,
`postmaster.opts`, `postgresql.auto.conf.tmp`, `current_logfiles.tmp`,
`backup_label`, `tablespace_map`, and `backup_manifest`; empty-content
directories are `pg_dynshmem`, `pg_notify`, `pg_replslot`, `pg_serial`,
`pg_snapshots`, `pg_stat_tmp`, and `pg_subtrans`.

The runtime boundary writes the archive and its manifest once. SDKs do not
reopen the tar to add language-specific metadata.

## Restore

Restore unpacks into a staging directory first, validates required PostgreSQL
files and archive metadata, consumes the archive manifest, creates the
destination-owned `.oliphaunt.json`, applies regular-file and directory
permissions, then publishes the staged root. Safe archive modes are accepted
but are not preserved: managed directories are normalized to `0700` and files,
including `.oliphaunt.json`, to `0600`. The archive manifest is not part
of the live root. The destination must be new or empty; replacement is not a
current public mode. Restore destination paths must not be empty or contain NUL
bytes. Archives containing `pgdata/postmaster.pid` or
`pgdata/postmaster.opts` are rejected as stale process state before extraction.

The required restored directories are real directories, not symbolic links,
junctions, or reparse points:

- `pgdata`;
- `pgdata/base`;
- `pgdata/global`;
- `pgdata/pg_wal`.

The required restored files are:

- `pgdata/PG_VERSION`;
- `pgdata/global/pg_control`;
- `pgdata/backup_label`.

## Verification

Native C tests and both WASIX binding suites consume the shared manifest and WAL
range fixtures under `src/shared/fixtures/storage`. Parser tests cover traversal,
links, duplicate paths, invalid
checksums, truncated terminators, trailing data, unknown metadata, and
tree-shape conflicts. Backup tests cover same-segment and multi-segment WAL
ranges, both configured segment sizes in the shared vectors, a missing or
truncated required segment, malformed and reversed ranges, and timeline changes.
