# Physical Archive Format

This is the maintainer contract for `BackupFormat::PhysicalArchive` in the
native Rust SDK and `liboliphaunt` integration. It is intentionally narrower
than `pg_basebackup` and is versioned as `oliphaunt-physical-archive-v1`.

## Scope

Physical archives are same-major PostgreSQL 18 restore artifacts for Oliphaunt
native roots. They are used by direct and broker mode backups and are the only
restore artifact accepted by the native SDK today. SQL backups and the future
`OliphauntArchive` format are separate contracts.

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
- `manifest.properties`;
- `.oliphaunt/backup-manifest.properties`.

Path canonicalization removes `.` components and rejects absolute paths, parent
directory traversal, Windows prefixes, and entries that would place a file below
an already-seen file or replace an already-seen subtree.

## Metadata

`manifest.properties` is the native root manifest. It must validate through the
same parser used for opened native roots.

`.oliphaunt/backup-manifest.properties` identifies the archive and compatibility
metadata. Required keys are:

- `archiveLayout=oliphaunt-physical-archive-v1`;
- `product=oliphaunt`;
- `postgresMajor=18`;
- `pgdataVersion`;
- `postgresVersionNum`;
- `serverEncoding`;
- `lcCollate`;
- `lcCtype`;
- `dataChecksums`;
- `sharedPreloadLibraries`;
- `requiredPreloadLibraries`;
- `selectedExtensions`;
- `installedExtensions`.

`postgresVersionNum` must be a PostgreSQL 18 version number, and `pgdataVersion`
must agree with `pgdata/PG_VERSION` when that file is present.

## Backup Creation

Backup creation starts PostgreSQL backup mode, archives `PGDATA`, stops backup
mode, then appends required WAL plus generated `backup_label` and
`tablespace_map` files. The initial `PGDATA` pass skips runtime-local state:
`postmaster.pid`, `postmaster.opts`, `pg_internal.init`, `pgsql_tmp*`, transient
content directories, and `pg_wal` contents before `pg_backup_stop`.

Metadata may be appended to an existing physical archive. If metadata entries
already exist, they are replaced rather than duplicated.

## Restore

Restore unpacks into a staging directory first, validates required PostgreSQL
files, validates archive/root metadata, applies regular-file and directory
permissions, then publishes the staged root according to the selected restore
target policy. Existing targets must be empty unless replacement was explicitly
requested, and restore target paths must not be empty or contain NUL bytes.

The required restored files are:

- `pgdata/PG_VERSION`;
- `pgdata/global/pg_control`;
- `pgdata/backup_label`.

## Verification

The Rust unit tests under `backup::tests` are the executable contract for this
format. They cover valid annotation/restore behavior and malicious or malformed
tar cases such as traversal, links, duplicate paths, invalid checksums, invalid
numeric fields, truncated terminators, trailing data, and tree-shape conflicts.
