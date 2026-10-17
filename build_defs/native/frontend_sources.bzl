"""PostgreSQL 18.4 source roles for the three published native tools.

Inventories follow src/bin/{pg_dump,pg_basebackup,psql}/meson.build. Other
upstream frontends are intentionally absent from the product construction roots.
"""

POSTGRES_DUMP_COMMON_SOURCES = [
    "src/bin/pg_dump/compress_gzip.c",
    "src/bin/pg_dump/compress_io.c",
    "src/bin/pg_dump/compress_lz4.c",
    "src/bin/pg_dump/compress_none.c",
    "src/bin/pg_dump/compress_zstd.c",
    "src/bin/pg_dump/connectdb.c",
    "src/bin/pg_dump/dumputils.c",
    "src/bin/pg_dump/filter.c",
    "src/bin/pg_dump/parallel.c",
    "src/bin/pg_dump/pg_backup_archiver.c",
    "src/bin/pg_dump/pg_backup_custom.c",
    "src/bin/pg_dump/pg_backup_db.c",
    "src/bin/pg_dump/pg_backup_directory.c",
    "src/bin/pg_dump/pg_backup_null.c",
    "src/bin/pg_dump/pg_backup_tar.c",
    "src/bin/pg_dump/pg_backup_utils.c",
]

POSTGRES_DUMP_SOURCES = [
    "src/bin/pg_dump/common.c",
    "src/bin/pg_dump/pg_dump.c",
    "src/bin/pg_dump/pg_dump_sort.c",
]

POSTGRES_BASEBACKUP_COMMON_SOURCES = [
    "src/bin/pg_basebackup/astreamer_inject.c",
    "src/bin/pg_basebackup/receivelog.c",
    "src/bin/pg_basebackup/streamutil.c",
    "src/bin/pg_basebackup/walmethods.c",
]

POSTGRES_PSQL_SOURCES = [
    "src/bin/psql/command.c",
    "src/bin/psql/common.c",
    "src/bin/psql/copy.c",
    "src/bin/psql/crosstabview.c",
    "src/bin/psql/describe.c",
    "src/bin/psql/help.c",
    "src/bin/psql/input.c",
    "src/bin/psql/large_obj.c",
    "src/bin/psql/mainloop.c",
    "src/bin/psql/prompt.c",
    "src/bin/psql/startup.c",
    "src/bin/psql/stringutils.c",
    "src/bin/psql/variables.c",
]
