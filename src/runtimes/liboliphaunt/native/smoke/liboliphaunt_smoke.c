#ifndef _WIN32
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#endif

#include "postgres.h"
#include "fmgr.h"

#include "../include/oliphaunt.h"
#ifdef _WIN32
#define OLIPHAUNT_PLATFORM_EXTERNAL_POSIX_SHIMS 1
#endif
#include "../src/liboliphaunt_internal.h"

#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dirent.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>
#endif

#undef PG_MAGIC_FUNCTION_NAME
#define PG_MAGIC_FUNCTION_NAME liboliphaunt_smoke_static_magic
PG_MODULE_MAGIC_EXT(
    .name = "liboliphaunt_smoke_static",
    .version = "1");

PG_FUNCTION_INFO_V1(liboliphaunt_smoke_static_answer);

static int liboliphaunt_smoke_static_init_calls = 0;

Datum liboliphaunt_smoke_static_answer(PG_FUNCTION_ARGS) {
    (void)fcinfo;
    PG_RETURN_INT32(2718);
}

static void liboliphaunt_smoke_static_init(void) {
    liboliphaunt_smoke_static_init_calls++;
}

static void push_query(unsigned char **buf, size_t *len, const char *sql) {
    size_t sql_len = strlen(sql) + 1;
    size_t frame_len = sql_len + 4;
    *len = frame_len + 1;
    *buf = (unsigned char *)calloc(*len, 1);
    (*buf)[0] = 'Q';
    (*buf)[1] = (unsigned char)((frame_len >> 24) & 0xff);
    (*buf)[2] = (unsigned char)((frame_len >> 16) & 0xff);
    (*buf)[3] = (unsigned char)((frame_len >> 8) & 0xff);
    (*buf)[4] = (unsigned char)(frame_len & 0xff);
    memcpy(*buf + 5, sql, sql_len);
}

static int expect_error_contains(OliphauntHandle *db, const char *context, const char *needle) {
    const char *message = oliphaunt_last_error(db);
    if (message == NULL || strstr(message, needle) == NULL) {
        fprintf(stderr, "%s did not set expected error containing '%s': %s\n",
                context,
                needle,
                message ? message : "(null)");
        return 1;
    }
    return 0;
}

static int verify_global_contract(void) {
    const char *version = oliphaunt_version();
    unsigned int major = 0;
    unsigned int minor = 0;
    unsigned int patch = 0;
    char trailing = '\0';
    if (version == NULL || sscanf(version, "%u.%u.%u%c", &major, &minor, &patch, &trailing) != 3) {
        fprintf(stderr, "unexpected liboliphaunt version: %s\n", version ? version : "(null)");
        return 1;
    }

    if (oliphaunt_close(NULL) != 0) {
        fprintf(stderr, "oliphaunt_close(NULL) should be a successful no-op\n");
        return 1;
    }
    if (oliphaunt_detach(NULL) != 0) {
        fprintf(stderr, "oliphaunt_detach(NULL) should be a successful no-op\n");
        return 1;
    }
    if (oliphaunt_cancel(NULL) == 0) {
        fprintf(stderr, "oliphaunt_cancel(NULL) should fail\n");
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_cancel null handle", "invalid oliphaunt_cancel arguments") != 0) {
        return 1;
    }

    OliphauntConfig invalid_config = {
        .abi_version = OLIPHAUNT_ABI_VERSION + 1,
        .pgdata = "/tmp/oliphaunt-invalid-pgdata",
    };
    OliphauntHandle *invalid = NULL;
    if (oliphaunt_init(&invalid_config, &invalid) == 0 || invalid != NULL) {
        fprintf(stderr, "oliphaunt_init accepted an invalid ABI version\n");
        if (invalid != NULL) {
            oliphaunt_close(invalid);
        }
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_init invalid ABI", "invalid oliphaunt_init config") != 0) {
        return 1;
    }
    if (oliphaunt_init(NULL, &invalid) == 0 || invalid != NULL) {
        fprintf(stderr, "oliphaunt_init accepted a null config\n");
        if (invalid != NULL) {
            oliphaunt_close(invalid);
        }
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_init null config", "invalid oliphaunt_init config") != 0) {
        return 1;
    }
    if (oliphaunt_init(&invalid_config, NULL) == 0) {
        fprintf(stderr, "oliphaunt_init accepted a null out parameter\n");
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_init null out", "out parameter is null") != 0) {
        return 1;
    }
    OliphauntConfig invalid_flags = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = "/tmp/oliphaunt-invalid-flags-pgdata",
        .reserved_flags = 1ull << 63,
    };
    if (oliphaunt_init(&invalid_flags, &invalid) == 0 || invalid != NULL) {
        fprintf(stderr, "oliphaunt_init accepted unknown config flags\n");
        if (invalid != NULL) {
            oliphaunt_close(invalid);
        }
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_init invalid flags", "invalid oliphaunt_init config flags") != 0) {
        return 1;
    }
    OliphauntConfig invalid_module_config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = "/tmp/oliphaunt-invalid-module-pgdata",
        .module_dir = "/tmp/oliphaunt-missing-module-directory/not-a-directory",
    };
    if (oliphaunt_init(&invalid_module_config, &invalid) == 0 || invalid != NULL) {
        fprintf(stderr, "oliphaunt_init accepted a missing module directory\n");
        if (invalid != NULL) {
            oliphaunt_close(invalid);
        }
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_init missing module directory", "invalid oliphaunt_init module_dir") != 0) {
        return 1;
    }
    invalid_module_config.module_dir = "";
    if (oliphaunt_init(&invalid_module_config, &invalid) == 0 || invalid != NULL) {
        fprintf(stderr, "oliphaunt_init accepted an empty module directory\n");
        if (invalid != NULL) {
            oliphaunt_close(invalid);
        }
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_init empty module directory", "invalid oliphaunt_init module_dir") != 0) {
        return 1;
    }
    return 0;
}

static int expect_pgdata_env(const char *context, const char *expected) {
    const char *actual = getenv("PGDATA");
    if ((expected == NULL && actual != NULL) ||
        (expected != NULL && (actual == NULL || strcmp(actual, expected) != 0))) {
        fprintf(stderr,
                "%s left unexpected PGDATA environment: expected %s, got %s\n",
                context,
                expected ? expected : "(unset)",
                actual ? actual : "(unset)");
        return 1;
    }
    return 0;
}

static int set_pgdata_env_for_smoke(const char *value) {
    if (setenv("PGDATA", value, 1) != 0) {
        perror("set smoke PGDATA environment");
        return 1;
    }
    return 0;
}

static int expect_static_extension_registration_fails(
    const OliphauntStaticExtension *extensions,
    size_t count,
    const char *context,
    const char *needle) {
    if (oliphaunt_register_static_extensions(extensions, count) == 0) {
        fprintf(stderr, "%s unexpectedly succeeded\n", context);
        return 1;
    }
    return expect_error_contains(NULL, context, needle);
}

static int verify_static_extension_registry_rejects_invalid_entries(void) {
    static const OliphauntStaticExtensionSymbol valid_symbols[] = {
        {
            .name = "liboliphaunt_smoke_static_answer",
            .address = (void *)liboliphaunt_smoke_static_answer,
        },
    };
    static const OliphauntStaticExtensionSymbol duplicate_symbols[] = {
        {
            .name = "liboliphaunt_smoke_static_answer",
            .address = (void *)liboliphaunt_smoke_static_answer,
        },
        {
            .name = "liboliphaunt_smoke_static_answer",
            .address = (void *)liboliphaunt_smoke_static_answer,
        },
    };
    static const OliphauntStaticExtension invalid_abi[] = {
        {
            .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION + 1,
            .name = "liboliphaunt_smoke_invalid_abi",
            .magic = (const void *(*)(void))liboliphaunt_smoke_static_magic,
            .symbols = valid_symbols,
            .symbol_count = sizeof(valid_symbols) / sizeof(valid_symbols[0]),
        },
    };
    static const OliphauntStaticExtension duplicate_extensions[] = {
        {
            .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
            .name = "liboliphaunt_smoke_duplicate",
            .magic = (const void *(*)(void))liboliphaunt_smoke_static_magic,
            .symbols = valid_symbols,
            .symbol_count = sizeof(valid_symbols) / sizeof(valid_symbols[0]),
        },
        {
            .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
            .name = "liboliphaunt_smoke_duplicate",
            .magic = (const void *(*)(void))liboliphaunt_smoke_static_magic,
            .symbols = valid_symbols,
            .symbol_count = sizeof(valid_symbols) / sizeof(valid_symbols[0]),
        },
    };
    static const OliphauntStaticExtension duplicate_symbol_entry[] = {
        {
            .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
            .name = "liboliphaunt_smoke_duplicate_symbol",
            .magic = (const void *(*)(void))liboliphaunt_smoke_static_magic,
            .symbols = duplicate_symbols,
            .symbol_count = sizeof(duplicate_symbols) / sizeof(duplicate_symbols[0]),
        },
    };

    if (expect_static_extension_registration_fails(
            invalid_abi,
            sizeof(invalid_abi) / sizeof(invalid_abi[0]),
            "static extension invalid ABI",
            "invalid static extension registration entry") != 0) {
        return 1;
    }
    if (expect_static_extension_registration_fails(
            duplicate_extensions,
            sizeof(duplicate_extensions) / sizeof(duplicate_extensions[0]),
            "static extension duplicate module",
            "duplicate static extension registration entry") != 0) {
        return 1;
    }
    if (expect_static_extension_registration_fails(
            duplicate_symbol_entry,
            sizeof(duplicate_symbol_entry) / sizeof(duplicate_symbol_entry[0]),
            "static extension duplicate symbol",
            "duplicate static extension symbol registration entry") != 0) {
        return 1;
    }
    return 0;
}

static int register_static_extension_fixture(void) {
    /*
     * Real statically linked extensions can expose toolchain-generated names
     * longer than the 128-byte module/package identity limit. PostGIS's C++
     * objects are one such producer. Keep this fixture longer than that limit
     * so the registry's symbol contract cannot regress back to treating a
     * linker symbol as a package name.
     */
    static const char long_linker_symbol[] =
        "_ZNSt3__112__hash_tableINS_17__hash_value_typeIyyEENS_22__unordered_map_hasherIyNS_4pairIKyyEENS_4hashIyEENS_8equal_toIyEELb1EEENS_21__unordered_map_equalIyS6_SA_S8_Lb1EEENS_9allocatorIS6_EEE25__emplace_unique_key_argsIyJNS4_IyyEEEEENS4_INS_15__hash_iteratorIPNS_11__hash_nodeIS2_PvEEEEbEERKT_DpOT0_";
    static const OliphauntStaticExtensionSymbol symbols[] = {
        {
            .name = "liboliphaunt_smoke_static_answer",
            .address = (void *)liboliphaunt_smoke_static_answer,
        },
        {
            .name = "pg_finfo_liboliphaunt_smoke_static_answer",
            .address = (void *)pg_finfo_liboliphaunt_smoke_static_answer,
        },
        {
            .name = long_linker_symbol,
            .address = (void *)liboliphaunt_smoke_static_answer,
        },
    };
    static const OliphauntStaticExtension extensions[] = {
        {
            .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
            .name = "liboliphaunt_smoke_static",
            .magic = (const void *(*)(void))liboliphaunt_smoke_static_magic,
            .init = liboliphaunt_smoke_static_init,
            .symbols = symbols,
            .symbol_count = sizeof(symbols) / sizeof(symbols[0]),
            .reserved_flags = 0,
        },
    };
    if (oliphaunt_register_static_extensions(extensions, sizeof(extensions) / sizeof(extensions[0])) != 0) {
        fprintf(stderr, "oliphaunt_register_static_extensions failed: %s\n", oliphaunt_last_error(NULL));
        return 1;
    }
    return 0;
}

static int contains_tag(const OliphauntResponse *response, unsigned char tag) {
    size_t off = 0;
    while (off + 5 <= response->len) {
        unsigned char current = response->data[off];
        uint32_t len = ((uint32_t)response->data[off + 1] << 24) |
                       ((uint32_t)response->data[off + 2] << 16) |
                       ((uint32_t)response->data[off + 3] << 8) |
                       (uint32_t)response->data[off + 4];
        if (len < 4 || off + 1 + len > response->len) {
            return 0;
        }
        if (current == tag) {
            return 1;
        }
        off += 1 + len;
    }
    return 0;
}

static int contains_bytes(const OliphauntResponse *response, const char *needle) {
    size_t needle_len = strlen(needle);
    if (needle_len == 0) {
        return 1;
    }
    if (response->data == NULL || response->len < needle_len) {
        return 0;
    }
    for (size_t i = 0; i + needle_len <= response->len; i++) {
        if (memcmp(response->data + i, needle, needle_len) == 0) {
            return 1;
        }
    }
    return 0;
}

static size_t tar_entry_count(const OliphauntResponse *archive, const char *expected_name);

static const char *native_archive_manifest_fixture_path = NULL;

static int load_native_archive_manifest_fixture(char *out, size_t capacity) {
    const char *path = native_archive_manifest_fixture_path;
    if (path == NULL || path[0] == '\0') {
        fprintf(stderr, "native archive manifest fixture path was not provided\n");
        return -1;
    }
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        fprintf(stderr, "failed to open shared native archive manifest fixture %s\n", path);
        return -1;
    }
    size_t length = fread(out, 1, capacity - 1, file);
    if (ferror(file) || !feof(file) || fclose(file) != 0) {
        fprintf(stderr, "failed to read shared native archive manifest fixture %s\n", path);
        return -1;
    }
    out[length] = '\0';
    return 0;
}

#ifndef _WIN32
typedef struct WalRangeFixtureCase {
    char name[64];
    uint64_t segment_size;
    char start[32];
    char stop[32];
    char expected[512];
    char error[64];
} WalRangeFixtureCase;

typedef struct WalRangeCollector {
    char value[512];
    size_t len;
} WalRangeCollector;

static int collect_wal_file(void *raw_context, const char *wal_file) {
    WalRangeCollector *collector = (WalRangeCollector *)raw_context;
    size_t wal_len = strlen(wal_file);
    size_t separator = collector->len == 0 ? 0 : 1;
    if (collector->len + separator + wal_len >= sizeof(collector->value)) {
        return -1;
    }
    if (separator != 0) {
        collector->value[collector->len++] = ',';
    }
    memcpy(collector->value + collector->len, wal_file, wal_len + 1);
    collector->len += wal_len;
    return 0;
}

static WalRangeFixtureCase *wal_fixture_case(
    WalRangeFixtureCase *cases,
    size_t *case_count,
    const char *name) {
    for (size_t i = 0; i < *case_count; i++) {
        if (strcmp(cases[i].name, name) == 0) {
            return &cases[i];
        }
    }
    if (*case_count >= 16) {
        return NULL;
    }
    WalRangeFixtureCase *item = &cases[(*case_count)++];
    memset(item, 0, sizeof(*item));
    snprintf(item->name, sizeof(item->name), "%s", name);
    return item;
}

static int verify_shared_wal_range_fixture(void) {
    const char *path = "src/shared/fixtures/storage/physical-backup-wal-range-v1.properties";
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        fprintf(stderr, "failed to open shared WAL range fixture %s\n", path);
        return 1;
    }
    WalRangeFixtureCase cases[16] = {0};
    size_t case_count = 0;
    size_t schema_count = 0;
    char line[1024];
    while (fgets(line, sizeof(line), file) != NULL) {
        line[strcspn(line, "\r\n")] = '\0';
        if (strncmp(line, "schema=", 7) == 0) {
            if (strcmp(line, "schema=oliphaunt-physical-backup-wal-range-v1") != 0) {
                fclose(file);
                fprintf(stderr, "shared WAL range fixture has unexpected schema\n");
                return 1;
            }
            schema_count++;
            continue;
        }
        if (strncmp(line, "case.", 5) != 0) {
            continue;
        }
        char *equals = strchr(line, '=');
        char *field_separator = equals == NULL ? NULL : strrchr(line, '.');
        if (equals == NULL || field_separator == NULL || field_separator >= equals) {
            fclose(file);
            fprintf(stderr, "malformed shared WAL range fixture line\n");
            return 1;
        }
        *field_separator = '\0';
        *equals = '\0';
        WalRangeFixtureCase *item = wal_fixture_case(cases, &case_count, line + 5);
        if (item == NULL) {
            fclose(file);
            fprintf(stderr, "too many shared WAL range fixture cases\n");
            return 1;
        }
        const char *field = field_separator + 1;
        const char *value = equals + 1;
        if (strcmp(field, "segmentSizeBytes") == 0) {
            item->segment_size = strtoull(value, NULL, 10);
        } else if (strcmp(field, "start") == 0) {
            snprintf(item->start, sizeof(item->start), "%s", value);
        } else if (strcmp(field, "stop") == 0) {
            snprintf(item->stop, sizeof(item->stop), "%s", value);
        } else if (strcmp(field, "expected") == 0) {
            snprintf(item->expected, sizeof(item->expected), "%s", value);
        } else if (strcmp(field, "error") == 0) {
            snprintf(item->error, sizeof(item->error), "%s", value);
        }
    }
    if (ferror(file) || fclose(file) != 0 || schema_count != 1 || case_count == 0) {
        fprintf(stderr, "failed to read shared WAL range fixture %s\n", path);
        return 1;
    }
    for (size_t i = 0; i < case_count; i++) {
        WalRangeCollector collector = {0};
        int rc = oliphaunt_visit_wal_range(
            NULL,
            cases[i].start,
            cases[i].stop,
            cases[i].segment_size,
            collect_wal_file,
            &collector);
        if (cases[i].expected[0] != '\0') {
            if (rc != 0 || strcmp(collector.value, cases[i].expected) != 0) {
                fprintf(stderr, "shared WAL range case %s produced %s: %s\n",
                        cases[i].name,
                        collector.value,
                        oliphaunt_last_error(NULL));
                return 1;
            }
        } else {
            if (rc == 0) {
                fprintf(stderr, "shared WAL range case %s unexpectedly succeeded\n", cases[i].name);
                return 1;
            }
            const char *needle = NULL;
            if (strcmp(cases[i].error, "reversed-range") == 0) {
                needle = "reversed WAL range";
            } else if (strcmp(cases[i].error, "timeline-change") == 0) {
                needle = "changes timeline";
            } else if (strcmp(cases[i].error, "segment-index-out-of-range") == 0) {
                needle = "segment index";
            } else if (strcmp(cases[i].error, "malformed-wal-filename") == 0) {
                needle = "malformed WAL filename";
            }
            if (needle == NULL || expect_error_contains(NULL, cases[i].name, needle) != 0) {
                return 1;
            }
        }
    }
    return 0;
}

static int write_sparse_file(const char *path, size_t size) {
    FILE *file = fopen(path, "wb");
    if (file == NULL || size == 0) {
        return -1;
    }
    int rc = fseek(file, (long)(size - 1), SEEK_SET) == 0 && fputc(0, file) != EOF ? 0 : -1;
    if (fclose(file) != 0) {
        rc = -1;
    }
    return rc;
}

static int verify_wal_range_archive_selection(const char *pgdata) {
    char root[4096];
    snprintf(root, sizeof(root), "%s.wal-range-test.%ld", pgdata, (long)getpid());
    (void)oliphaunt_remove_tree(root);
    char pg_wal[4096];
    snprintf(pg_wal, sizeof(pg_wal), "%s/pg_wal", root);
    if (oliphaunt_mkdir_p(pg_wal, 0700) != 0) {
        fprintf(stderr, "failed to create WAL range smoke root\n");
        return 1;
    }
    static const char *required_start = "00000001000000000000000A";
    static const char *required_stop = "00000001000000000000000B";
    static const char *unrelated = "00000001000000000000000C";
    char start_path[4096];
    char stop_path[4096];
    char unrelated_path[4096];
    snprintf(start_path, sizeof(start_path), "%s/%s", pg_wal, required_start);
    snprintf(stop_path, sizeof(stop_path), "%s/%s", pg_wal, required_stop);
    snprintf(unrelated_path, sizeof(unrelated_path), "%s/%s", pg_wal, unrelated);
    const size_t segment_size = 1024 * 1024;
    if (write_sparse_file(start_path, segment_size) != 0) {
        (void)oliphaunt_remove_tree(root);
        return 1;
    }
    OliphauntByteBuffer archive = {0};
    if (oliphaunt_archive_append_wal_range(
            &archive, NULL, root, required_start, required_stop, segment_size) == 0 ||
        expect_error_contains(NULL, "missing required WAL segment", "requires complete WAL segment") != 0) {
        free(archive.data);
        (void)oliphaunt_remove_tree(root);
        return 1;
    }
    free(archive.data);
    archive = (OliphauntByteBuffer){0};
    if (write_sparse_file(stop_path, segment_size - 1) != 0 ||
        oliphaunt_archive_append_wal_range(
            &archive, NULL, root, required_start, required_stop, segment_size) == 0 ||
        expect_error_contains(NULL, "short required WAL segment", "exactly 1048576 bytes") != 0) {
        free(archive.data);
        (void)oliphaunt_remove_tree(root);
        return 1;
    }
    free(archive.data);
    archive = (OliphauntByteBuffer){0};
    if (write_sparse_file(stop_path, segment_size) != 0 ||
        write_sparse_file(unrelated_path, segment_size) != 0 ||
        oliphaunt_archive_append_wal_range(
            &archive, NULL, root, required_start, required_stop, segment_size) != 0) {
        fprintf(stderr, "failed to archive exact required WAL range: %s\n", oliphaunt_last_error(NULL));
        free(archive.data);
        (void)oliphaunt_remove_tree(root);
        return 1;
    }
    OliphauntResponse response = {.data = archive.data, .len = archive.len};
    char start_entry[64];
    char stop_entry[64];
    char unrelated_entry[64];
    snprintf(start_entry, sizeof(start_entry), "pgdata/pg_wal/%s", required_start);
    snprintf(stop_entry, sizeof(stop_entry), "pgdata/pg_wal/%s", required_stop);
    snprintf(unrelated_entry, sizeof(unrelated_entry), "pgdata/pg_wal/%s", unrelated);
    int failed = tar_entry_count(&response, start_entry) != 1 ||
                 tar_entry_count(&response, stop_entry) != 1 ||
                 tar_entry_count(&response, unrelated_entry) != 0;
    if (failed) {
        fprintf(stderr, "physical backup did not select the exact required WAL range\n");
    }
    free(archive.data);
    (void)oliphaunt_remove_tree(root);
    return failed;
}
#else
static int verify_shared_wal_range_fixture(void) {
    fprintf(stderr, "skipping internal WAL range vector smoke on Windows\n");
    return 0;
}

static int verify_wal_range_archive_selection(const char *pgdata) {
    (void)pgdata;
    fprintf(stderr, "skipping internal WAL archive selection smoke on Windows\n");
    return 0;
}
#endif

static int32_t append_stream_chunk(void *context, const uint8_t *data, size_t len);

typedef struct StreamAccumulator {
    unsigned char *data;
    size_t len;
    size_t cap;
    size_t chunks;
} StreamAccumulator;

typedef struct CancelQueryThread {
    OliphauntHandle *db;
    int status;
} CancelQueryThread;

typedef struct TestTarArchive {
    unsigned char data[8192];
    size_t len;
} TestTarArchive;

static void smoke_sleep_millis(unsigned milliseconds) {
#ifdef _WIN32
    Sleep((DWORD)milliseconds);
#else
    struct timespec remaining = {
        .tv_sec = milliseconds / 1000,
        .tv_nsec = (long)(milliseconds % 1000) * 1000000L,
    };
    while (nanosleep(&remaining, &remaining) != 0 && errno == EINTR) {
    }
#endif
}

static int verify_free_response_contract(void) {
    OliphauntResponse empty = {0};
    oliphaunt_free_response(NULL);
    oliphaunt_free_response(&empty);
    if (empty.data != NULL || empty.len != 0) {
        fprintf(stderr, "oliphaunt_free_response mutated empty response incorrectly\n");
        return 1;
    }

    empty.data = (uint8_t *)malloc(4);
    if (empty.data == NULL) {
        fprintf(stderr, "failed to allocate response fixture\n");
        return 1;
    }
    empty.len = 4;
    oliphaunt_free_response(&empty);
    if (empty.data != NULL || empty.len != 0) {
        fprintf(stderr, "oliphaunt_free_response did not clear freed response\n");
        return 1;
    }
    oliphaunt_free_response(&empty);
    return 0;
}

static int exec_query_expect_tags(
    OliphauntHandle *db,
    const char *sql,
    const unsigned char *tags,
    size_t tag_count) {
    unsigned char *query = NULL;
    size_t query_len = 0;
    push_query(&query, &query_len, sql);

    OliphauntResponse response = {0};
    fprintf(stderr, "executing raw protocol: %s\n", sql);
    /* OLIPHAUNT_DOCS_SNIPPET liboliphaunt-quickstart */
    int rc = oliphaunt_exec_protocol(db, query, query_len, &response);
    free(query);
    if (rc != 0) {
        fprintf(stderr, "oliphaunt_exec_protocol failed: %s\n", oliphaunt_last_error(db));
        return 1;
    }
    for (size_t i = 0; i < tag_count; i++) {
        if (!contains_tag(&response, tags[i])) {
            fprintf(stderr, "response for %s did not contain protocol tag %c\n", sql, tags[i]);
            oliphaunt_free_response(&response);
            return 1;
        }
    }
    oliphaunt_free_response(&response);
    return 0;
}

static int exec_query_expect_bytes(OliphauntHandle *db, const char *sql, const char *needle) {
    unsigned char *query = NULL;
    size_t query_len = 0;
    push_query(&query, &query_len, sql);

    OliphauntResponse response = {0};
    fprintf(stderr, "executing raw protocol: %s\n", sql);
    int rc = oliphaunt_exec_protocol(db, query, query_len, &response);
    free(query);
    if (rc != 0) {
        fprintf(stderr, "oliphaunt_exec_protocol failed: %s\n", oliphaunt_last_error(db));
        return 1;
    }
    if (!contains_bytes(&response, needle)) {
        fprintf(stderr, "response for %s did not contain expected bytes %s\n", sql, needle);
        oliphaunt_free_response(&response);
        return 1;
    }
    oliphaunt_free_response(&response);
    return 0;
}

static int exec_simple_query_expect_bytes(OliphauntHandle *db, const char *sql, const char *needle) {
    OliphauntResponse response = {0};
    fprintf(stderr, "executing simple query ABI: %s\n", sql);
    int rc = oliphaunt_exec_simple_query(db, sql, strlen(sql), &response);
    if (rc != 0) {
        fprintf(stderr, "oliphaunt_exec_simple_query failed: %s\n", oliphaunt_last_error(db));
        return 1;
    }
    if (!contains_bytes(&response, needle)) {
        fprintf(stderr, "simple-query response for %s did not contain expected bytes %s\n", sql, needle);
        oliphaunt_free_response(&response);
        return 1;
    }
    oliphaunt_free_response(&response);
    return 0;
}

static int exec_invalid_argument_checks(OliphauntHandle *db) {
    OliphauntResponse response = {0};
    unsigned char byte = 0;
    if (oliphaunt_exec_protocol(db, NULL, 1, &response) == 0) {
        fprintf(stderr, "oliphaunt_exec_protocol accepted null request with non-zero length\n");
        oliphaunt_free_response(&response);
        return 1;
    }
    if (expect_error_contains(db, "oliphaunt_exec_protocol null request", "invalid oliphaunt_exec_protocol arguments") != 0) {
        return 1;
    }
    if (response.data != NULL || response.len != 0) {
        fprintf(stderr, "invalid exec arguments unexpectedly produced a response\n");
        oliphaunt_free_response(&response);
        return 1;
    }
    if (oliphaunt_exec_protocol(db, &byte, sizeof(byte), NULL) == 0) {
        fprintf(stderr, "oliphaunt_exec_protocol accepted null response out parameter\n");
        return 1;
    }
    if (expect_error_contains(db, "oliphaunt_exec_protocol null out", "invalid oliphaunt_exec_protocol arguments") != 0) {
        return 1;
    }
    if (oliphaunt_exec_protocol_stream(db, &byte, sizeof(byte), NULL, NULL) == 0) {
        fprintf(stderr, "oliphaunt_exec_protocol_stream accepted null callback\n");
        return 1;
    }
    if (expect_error_contains(db, "oliphaunt_exec_protocol_stream null callback", "invalid oliphaunt_exec_protocol_stream arguments") != 0) {
        return 1;
    }
    if (oliphaunt_exec_protocol_stream(db, NULL, 1, append_stream_chunk, NULL) == 0) {
        fprintf(stderr, "oliphaunt_exec_protocol_stream accepted null request with non-zero length\n");
        return 1;
    }
    if (expect_error_contains(db, "oliphaunt_exec_protocol_stream null request", "invalid oliphaunt_exec_protocol_stream arguments") != 0) {
        return 1;
    }
    if (oliphaunt_exec_simple_query(db, NULL, 0, &response) == 0) {
        fprintf(stderr, "oliphaunt_exec_simple_query accepted null SQL\n");
        oliphaunt_free_response(&response);
        return 1;
    }
    if (expect_error_contains(db, "oliphaunt_exec_simple_query null SQL", "invalid oliphaunt_exec_simple_query arguments") != 0) {
        return 1;
    }
    if (oliphaunt_exec_simple_query(db, "SELECT 1", strlen("SELECT 1"), NULL) == 0) {
        fprintf(stderr, "oliphaunt_exec_simple_query accepted null response out parameter\n");
        return 1;
    }
    if (expect_error_contains(db, "oliphaunt_exec_simple_query null out", "invalid oliphaunt_exec_simple_query arguments") != 0) {
        return 1;
    }
    static const char interior_nul_query[] = {'S', 'E', 'L', 'E', 'C', 'T', ' ', '1', '\0', '2'};
    if (oliphaunt_exec_simple_query(db, interior_nul_query, sizeof(interior_nul_query), &response) == 0) {
        fprintf(stderr, "oliphaunt_exec_simple_query accepted interior NUL SQL\n");
        oliphaunt_free_response(&response);
        return 1;
    }
    if (expect_error_contains(db, "oliphaunt_exec_simple_query interior NUL", "interior NUL") != 0) {
        return 1;
    }
    return 0;
}

static int expect_malformed_exec_rejected(
    OliphauntHandle *db,
    const char *context,
    const unsigned char *request,
    size_t request_len,
    const char *needle) {
    OliphauntResponse response = {0};
    if (oliphaunt_exec_protocol(db, request, request_len, &response) == 0) {
        fprintf(stderr, "%s was accepted as a raw protocol request\n", context);
        oliphaunt_free_response(&response);
        return 1;
    }
    if (response.data != NULL || response.len != 0) {
        fprintf(stderr, "%s unexpectedly produced a response\n", context);
        oliphaunt_free_response(&response);
        return 1;
    }
    return expect_error_contains(db, context, needle);
}

static int expect_malformed_stream_rejected(
    OliphauntHandle *db,
    const char *context,
    const unsigned char *request,
    size_t request_len,
    const char *needle) {
    StreamAccumulator acc = {0};
    if (oliphaunt_exec_protocol_stream(db, request, request_len, append_stream_chunk, &acc) == 0) {
        fprintf(stderr, "%s was accepted as a streaming raw protocol request\n", context);
        free(acc.data);
        return 1;
    }
    if (acc.chunks != 0 || acc.data != NULL || acc.len != 0) {
        fprintf(stderr, "%s unexpectedly invoked the stream callback\n", context);
        free(acc.data);
        return 1;
    }
    return expect_error_contains(db, context, needle);
}

static int exec_malformed_frame_checks(OliphauntHandle *db) {
    static const unsigned char too_short_header[] = {'Q', 0, 0};
    static const unsigned char short_length[] = {'Q', 0, 0, 0, 3};
    static const unsigned char truncated_body[] = {'Q', 0, 0, 0, 64, 'S', 'E', 'L'};

    if (expect_malformed_exec_rejected(db, "empty raw protocol request", NULL, 0, "empty request") != 0) {
        return 1;
    }
    if (expect_malformed_exec_rejected(
            db,
            "truncated raw protocol header",
            too_short_header,
            sizeof(too_short_header),
            "truncated message header") != 0) {
        return 1;
    }
    if (expect_malformed_exec_rejected(
            db,
            "short raw protocol message length",
            short_length,
            sizeof(short_length),
            "message length is smaller") != 0) {
        return 1;
    }
    if (expect_malformed_exec_rejected(
            db,
            "truncated raw protocol body",
            truncated_body,
            sizeof(truncated_body),
            "truncated message body") != 0) {
        return 1;
    }
    if (expect_malformed_stream_rejected(
            db,
            "truncated streaming protocol body",
            truncated_body,
            sizeof(truncated_body),
            "truncated message body") != 0) {
        return 1;
    }
    return 0;
}

static int32_t append_stream_chunk(void *context, const uint8_t *data, size_t len) {
    StreamAccumulator *acc = (StreamAccumulator *)context;
    acc->chunks++;
    if (len == 0) {
        return 0;
    }
    if (acc->len + len > acc->cap) {
        size_t next = acc->cap ? acc->cap : 8192;
        while (next < acc->len + len) {
            next *= 2;
        }
        unsigned char *grown = (unsigned char *)realloc(acc->data, next);
        if (grown == NULL) {
            return -1;
        }
        acc->data = grown;
        acc->cap = next;
    }
    memcpy(acc->data + acc->len, data, len);
    acc->len += len;
    return 0;
}

static int32_t fail_stream_chunk(void *context, const uint8_t *data, size_t len) {
    (void)data;
    (void)len;
    StreamAccumulator *acc = (StreamAccumulator *)context;
    acc->chunks++;
    return -1;
}

static int exec_stream_expect_tags(
    OliphauntHandle *db,
    const char *sql,
    const unsigned char *tags,
    size_t tag_count) {
    unsigned char *query = NULL;
    size_t query_len = 0;
    push_query(&query, &query_len, sql);

    StreamAccumulator acc = {0};
    fprintf(stderr, "streaming raw protocol: %s\n", sql);
    int rc = oliphaunt_exec_protocol_stream(db, query, query_len, append_stream_chunk, &acc);
    free(query);
    if (rc != 0) {
        fprintf(stderr, "oliphaunt_exec_protocol_stream failed: %s\n", oliphaunt_last_error(db));
        free(acc.data);
        return 1;
    }
    OliphauntResponse response = {
        .data = acc.data,
        .len = acc.len,
    };
    for (size_t i = 0; i < tag_count; i++) {
        if (!contains_tag(&response, tags[i])) {
            fprintf(stderr, "stream response for %s did not contain protocol tag %c\n", sql, tags[i]);
            free(acc.data);
            return 1;
        }
    }
    if (acc.chunks == 0) {
        fprintf(stderr, "stream response for %s did not invoke callback\n", sql);
        free(acc.data);
        return 1;
    }
    free(acc.data);
    return 0;
}

static int exec_stream_callback_failure_recovers(OliphauntHandle *db) {
    unsigned char *query = NULL;
    size_t query_len = 0;
    push_query(&query, &query_len, "SELECT repeat('z', 4096) AS callback_failure");

    StreamAccumulator acc = {0};
    fprintf(stderr, "streaming raw protocol with failing callback\n");
    int rc = oliphaunt_exec_protocol_stream(db, query, query_len, fail_stream_chunk, &acc);
    free(query);
    free(acc.data);
    if (rc == 0) {
        fprintf(stderr, "oliphaunt_exec_protocol_stream succeeded despite callback failure\n");
        return 1;
    }
    if (acc.chunks == 0) {
        fprintf(stderr, "failing stream callback was not invoked\n");
        return 1;
    }
    if (expect_error_contains(db, "stream callback failure", "protocol stream callback failed") != 0) {
        return 1;
    }
    const unsigned char select_tags[] = {'T', 'D', 'C', 'Z'};
    return exec_query_expect_tags(db, "SELECT 4 AS recovered_after_callback_failure", select_tags, sizeof(select_tags));
}

static void *cancel_query_thread_main(void *context) {
    CancelQueryThread *state = (CancelQueryThread *)context;
    unsigned char *query = NULL;
    size_t query_len = 0;
    push_query(&query, &query_len, "SELECT pg_sleep(5) AS should_cancel");

    OliphauntResponse response = {0};
    fprintf(stderr, "executing cancellable raw protocol query\n");
    int rc = oliphaunt_exec_protocol(state->db, query, query_len, &response);
    free(query);
    if (rc != 0) {
        fprintf(stderr, "cancellable query failed at ABI level: %s\n", oliphaunt_last_error(state->db));
        state->status = 1;
        return NULL;
    }

    if (!contains_tag(&response, 'E') || !contains_tag(&response, 'Z')) {
        fprintf(stderr, "cancellable query response did not contain ErrorResponse and ReadyForQuery\n");
        oliphaunt_free_response(&response);
        state->status = 1;
        return NULL;
    }
    if (!contains_bytes(&response, "canceling statement due to user request")) {
        fprintf(stderr, "cancellable query response did not contain PostgreSQL cancel message\n");
        oliphaunt_free_response(&response);
        state->status = 1;
        return NULL;
    }

    oliphaunt_free_response(&response);
    state->status = 0;
    return NULL;
}

static int exec_cancel_recovers(OliphauntHandle *db) {
    CancelQueryThread state = {
        .db = db,
        .status = 1,
    };
    pthread_t thread;
    if (pthread_create(&thread, NULL, cancel_query_thread_main, &state) != 0) {
        fprintf(stderr, "failed to create cancellation smoke thread\n");
        return 1;
    }

    smoke_sleep_millis(100);
    fprintf(stderr, "cancelling active raw protocol query\n");
    if (oliphaunt_cancel(db) != 0) {
        fprintf(stderr, "oliphaunt_cancel failed: %s\n", oliphaunt_last_error(db));
        pthread_join(thread, NULL);
        return 1;
    }
    pthread_join(thread, NULL);
    if (state.status != 0) {
        return 1;
    }

    const unsigned char select_tags[] = {'T', 'D', 'C', 'Z'};
    return exec_query_expect_tags(db, "SELECT 5 AS recovered_after_cancel", select_tags, sizeof(select_tags));
}

static int exec_static_extension_registry_smoke(OliphauntHandle *db) {
    int before = liboliphaunt_smoke_static_init_calls;
    if (exec_simple_query_expect_bytes(
            db,
            "CREATE OR REPLACE FUNCTION liboliphaunt_static_answer() "
            "RETURNS integer AS 'liboliphaunt_smoke_static', 'liboliphaunt_smoke_static_answer' "
            "LANGUAGE C STRICT; "
            "SELECT liboliphaunt_static_answer()",
            "2718") != 0) {
        return 1;
    }
    if (liboliphaunt_smoke_static_init_calls != before + 1) {
        fprintf(stderr,
                "static extension init was not called exactly once: before=%d after=%d\n",
                before,
                liboliphaunt_smoke_static_init_calls);
        return 1;
    }
    if (expect_static_extension_registration_fails(
            NULL,
            0,
            "static extension registry freeze",
            "static extension registry cannot be changed after backend startup") != 0) {
        return 1;
    }
    return 0;
}

static int exec_plpgsql_smoke(OliphauntHandle *db) {
    return exec_simple_query_expect_bytes(
        db,
        "CREATE OR REPLACE FUNCTION liboliphaunt_plpgsql_answer() "
        "RETURNS integer LANGUAGE plpgsql AS $$ "
        "BEGIN "
        "RETURN 31415; "
        "END "
        "$$; "
        "SELECT liboliphaunt_plpgsql_answer()",
        "31415");
}

static int file_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

static int parent_path(const char *path, char *out, size_t out_len) {
    if (path == NULL || out == NULL || out_len == 0) {
        return -1;
    }
    if (snprintf(out, out_len, "%s", path) >= (int)out_len) {
        return -1;
    }
    char *slash = strrchr(out, '/');
    if (slash == NULL) {
        return snprintf(out, out_len, ".") >= (int)out_len ? -1 : 0;
    }
    if (slash == out) {
        slash[1] = '\0';
        return 0;
    }
    *slash = '\0';
    return 0;
}

static int root_sibling_path(
    char *out,
    size_t out_len,
    const char *pgdata,
    const char *suffix_format,
    ...) {
    char root[4096];
    if (parent_path(pgdata, root, sizeof(root)) != 0) {
        return -1;
    }
    int prefix_len = snprintf(out, out_len, "%s", root);
    if (prefix_len < 0 || (size_t)prefix_len >= out_len) {
        return -1;
    }
    va_list args;
    va_start(args, suffix_format);
    int suffix_len = vsnprintf(out + prefix_len, out_len - (size_t)prefix_len, suffix_format, args);
    va_end(args);
    return suffix_len < 0 || (size_t)suffix_len >= out_len - (size_t)prefix_len ? -1 : 0;
}

static int verify_no_in_root_lock_file(const char *pgdata) {
    char root[4096];
    char lock_path[4096];
    if (parent_path(pgdata, root, sizeof(root)) != 0 ||
        snprintf(lock_path, sizeof(lock_path), "%s/.oliphaunt.lock", root) >= (int)sizeof(lock_path)) {
        fprintf(stderr, "failed to resolve removed in-root lock path\n");
        return 1;
    }
    if (file_exists(lock_path)) {
        fprintf(stderr, "native runtime created removed in-root lock file %s\n", lock_path);
        return 1;
    }
    return 0;
}

static int is_stable_root_lock_name(const char *name) {
    const char *prefix = ".oliphaunt-root-";
    const char *suffix = ".lock";
    const size_t prefix_len = strlen(prefix);
    const size_t digest_len = 32;
    const size_t suffix_len = strlen(suffix);
    size_t len = strlen(name);
    if (len != prefix_len + digest_len + suffix_len ||
        strncmp(name, prefix, prefix_len) != 0 ||
        strcmp(name + prefix_len + digest_len, suffix) != 0) {
        return 0;
    }
    for (size_t i = prefix_len; i < prefix_len + digest_len; i++) {
        if (!((name[i] >= '0' && name[i] <= '9') || (name[i] >= 'a' && name[i] <= 'f'))) {
            return 0;
        }
    }
    return 1;
}

static int count_stable_root_lock_files(const char *lock_dir, int *found) {
    *found = 0;
#ifdef _WIN32
    char pattern[4096];
    if (snprintf(pattern, sizeof(pattern), "%s/.oliphaunt-root-*.lock", lock_dir) >= (int)sizeof(pattern)) {
        fprintf(stderr, "stable native root lock glob path is too long\n");
        return 1;
    }
    WIN32_FIND_DATAA data;
    HANDLE handle = FindFirstFileA(pattern, &data);
    if (handle == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
            return 0;
        }
        fprintf(stderr, "open native root lock directory failed: %lu\n", (unsigned long)error);
        return 1;
    }
    do {
        if (is_stable_root_lock_name(data.cFileName)) {
            (*found)++;
        }
    } while (FindNextFileA(handle, &data));
    DWORD error = GetLastError();
    FindClose(handle);
    if (error != ERROR_NO_MORE_FILES) {
        fprintf(stderr, "read native root lock directory failed: %lu\n", (unsigned long)error);
        return 1;
    }
    return 0;
#else
    DIR *dir = opendir(lock_dir);
    if (dir == NULL) {
        perror("open native root lock directory");
        return 1;
    }
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (is_stable_root_lock_name(entry->d_name)) {
            (*found)++;
        }
    }
    closedir(dir);
    return 0;
#endif
}

static int verify_stable_root_lock_file(const char *pgdata) {
    char root[4096];
    if (parent_path(pgdata, root, sizeof(root)) != 0) {
        fprintf(stderr, "failed to resolve stable native root\n");
        return 1;
    }
    char lock_dir[4096];
    if (parent_path(root, lock_dir, sizeof(lock_dir)) != 0) {
        fprintf(stderr, "failed to resolve stable native root lock directory\n");
        return 1;
    }
    int found = 0;
    if (count_stable_root_lock_files(lock_dir, &found) != 0) {
        return 1;
    }
    if (found == 0) {
        fprintf(stderr, "stable native root lock file was not created under %s\n", lock_dir);
        return 1;
    }
    return 0;
}

static void test_tar_write_octal(unsigned char *field, size_t width, unsigned long long value) {
    memset(field, '0', width);
    char scratch[32];
    snprintf(scratch, sizeof(scratch), "%0*llo", (int)width - 1, value);
    size_t len = strlen(scratch);
    if (len >= width) {
        memset(field, '7', width - 1);
        field[width - 1] = '\0';
        return;
    }
    memcpy(field + (width - 1 - len), scratch, len);
    field[width - 1] = '\0';
}

static void test_tar_rewrite_checksum(unsigned char *header) {
    memset(header + 148, ' ', 8);
    unsigned int checksum = 0;
    for (size_t i = 0; i < 512; i++) {
        checksum += header[i];
    }
    snprintf((char *)header + 148, 8, "%06o", checksum);
    header[154] = '\0';
    header[155] = ' ';
}

static unsigned long long test_tar_read_octal(const unsigned char *field, size_t width) {
    unsigned long long value = 0;
    size_t index = 0;
    while (index < width && (field[index] == ' ' || field[index] == '\0')) {
        index++;
    }
    while (index < width && field[index] >= '0' && field[index] <= '7') {
        value = (value << 3) | (unsigned long long)(field[index] - '0');
        index++;
    }
    return value;
}

static int verify_tar_entry_mode(
    const OliphauntResponse *archive,
    const char *expected_name,
    char expected_type,
    unsigned long long expected_mode) {
    size_t offset = 0;
    while (offset + 512 <= archive->len) {
        const unsigned char *header = archive->data + offset;
        if (header[0] == 0) {
            break;
        }
        char name[101];
        memcpy(name, header, 100);
        name[100] = '\0';
        char type = header[156] == 0 ? '0' : (char)header[156];
        if (strcmp(name, expected_name) == 0) {
            unsigned long long mode = test_tar_read_octal(header + 100, 8);
            if (type == expected_type && mode == expected_mode) {
                return 0;
            }
            fprintf(stderr,
                    "physical archive entry %s has type %c mode %04llo, expected %c %04llo\n",
                    expected_name,
                    type,
                    mode,
                    expected_type,
                    expected_mode);
            return 1;
        }
        unsigned long long size = test_tar_read_octal(header + 124, 12);
        size_t padded = ((size_t)size + 511) & ~(size_t)511;
        if (padded > archive->len - offset - 512) {
            break;
        }
        offset += 512 + padded;
    }
    fprintf(stderr, "physical archive omitted mode-check entry %s\n", expected_name);
    return 1;
}

static int verify_tar_identity_metadata_is_normalized(const OliphauntResponse *archive) {
    size_t offset = 0;
    while (offset + 512 <= archive->len) {
        const unsigned char *header = archive->data + offset;
        if (header[0] == 0) {
            return 0;
        }
        unsigned long long uid = test_tar_read_octal(header + 108, 8);
        unsigned long long gid = test_tar_read_octal(header + 116, 8);
        unsigned long long mtime = test_tar_read_octal(header + 136, 12);
        if (uid != 0 || gid != 0 || mtime != 0) {
            fprintf(stderr,
                    "physical archive entry has uid=%llu gid=%llu mtime=%llu; expected zeroed identity metadata\n",
                    uid,
                    gid,
                    mtime);
            return 1;
        }
        unsigned long long size = test_tar_read_octal(header + 124, 12);
        size_t padded = ((size_t)size + 511) & ~(size_t)511;
        if (padded > archive->len - offset - 512) {
            break;
        }
        offset += 512 + padded;
    }
    fprintf(stderr, "physical archive ended before normalized metadata could be verified\n");
    return 1;
}

static int verify_pg_control_archive_order(const OliphauntResponse *archive) {
    size_t offset = 0;
    size_t pg_version_offset = SIZE_MAX;
    size_t pg_control_offset = SIZE_MAX;
    size_t backup_label_offset = SIZE_MAX;
    size_t pg_control_count = 0;
    while (offset + 512 <= archive->len) {
        const unsigned char *header = archive->data + offset;
        if (header[0] == 0) {
            break;
        }
        char name[101];
        memcpy(name, header, 100);
        name[100] = '\0';
        if (strcmp(name, "pgdata/PG_VERSION") == 0) {
            pg_version_offset = offset;
        } else if (strcmp(name, "pgdata/global/pg_control") == 0) {
            pg_control_offset = offset;
            pg_control_count++;
        } else if (strcmp(name, "pgdata/backup_label") == 0) {
            backup_label_offset = offset;
        }
        unsigned long long size = test_tar_read_octal(header + 124, 12);
        offset += 512 + (((size_t)size + 511) & ~(size_t)511);
    }
    if (pg_control_count != 1 ||
        pg_version_offset == SIZE_MAX ||
        backup_label_offset == SIZE_MAX ||
        !(pg_version_offset < pg_control_offset && pg_control_offset < backup_label_offset)) {
        fprintf(stderr, "physical archive must contain one late pg_control before backup_label\n");
        return 1;
    }
    return 0;
}

static size_t tar_entry_count(const OliphauntResponse *archive, const char *expected_name) {
    size_t offset = 0;
    size_t count = 0;
    while (offset + 512 <= archive->len) {
        const unsigned char *header = archive->data + offset;
        if (header[0] == 0) {
            break;
        }
        char name[101];
        memcpy(name, header, 100);
        name[100] = '\0';
        if (strcmp(name, expected_name) == 0) {
            count++;
        }
        unsigned long long size = test_tar_read_octal(header + 124, 12);
        offset += 512 + (((size_t)size + 511) & ~(size_t)511);
    }
    return count;
}

static int test_tar_append_header(TestTarArchive *archive, const char *name, char typeflag, size_t size, const char *link_name) {
    if (archive->len + 512 > sizeof(archive->data) || strlen(name) > 100) {
        return -1;
    }
    unsigned char *header = archive->data + archive->len;
    memset(header, 0, 512);
    memcpy(header, name, strlen(name));
    test_tar_write_octal(header + 100, 8, 0600);
    test_tar_write_octal(header + 108, 8, 0);
    test_tar_write_octal(header + 116, 8, 0);
    test_tar_write_octal(header + 124, 12, (unsigned long long)size);
    test_tar_write_octal(header + 136, 12, 0);
    memset(header + 148, ' ', 8);
    header[156] = (unsigned char)typeflag;
    if (link_name != NULL) {
        size_t link_len = strlen(link_name);
        if (link_len > 100) {
            return -1;
        }
        memcpy(header + 157, link_name, link_len);
    }
    memcpy(header + 257, "ustar", 5);
    memcpy(header + 263, "00", 2);
    test_tar_rewrite_checksum(header);
    archive->len += 512;
    return 0;
}

static int test_tar_append_file(TestTarArchive *archive, const char *name, const char *contents) {
    size_t size = strlen(contents);
    size_t padded = (size + 511) & ~(size_t)511;
    if (archive->len + 512 + padded > sizeof(archive->data)) {
        return -1;
    }
    if (test_tar_append_header(archive, name, '0', size, NULL) != 0) {
        return -1;
    }
    memcpy(archive->data + archive->len, contents, size);
    memset(archive->data + archive->len + size, 0, padded - size);
    archive->len += padded;
    return 0;
}

static int test_tar_append_special(TestTarArchive *archive, const char *name, char typeflag, const char *link_name) {
    return test_tar_append_header(archive, name, typeflag, 0, link_name);
}

static int test_tar_finish(TestTarArchive *archive) {
    if (archive->len + 1024 > sizeof(archive->data)) {
        return -1;
    }
    memset(archive->data + archive->len, 0, 1024);
    archive->len += 1024;
    return 0;
}

static int test_tar_append_zero_block(TestTarArchive *archive) {
    if (archive->len + 512 > sizeof(archive->data)) {
        return -1;
    }
    memset(archive->data + archive->len, 0, 512);
    archive->len += 512;
    return 0;
}

static int test_tar_append_nonzero_block(TestTarArchive *archive) {
    if (archive->len + 512 > sizeof(archive->data)) {
        return -1;
    }
    memset(archive->data + archive->len, 'x', 512);
    archive->len += 512;
    return 0;
}

static int append_required_pgdata_files(TestTarArchive *archive) {
    return test_tar_append_file(archive, "pgdata/PG_VERSION", "18\n") != 0 ||
            test_tar_append_file(archive, "pgdata/global/pg_control", "control") != 0 ||
            test_tar_append_file(archive, "pgdata/backup_label", "label") != 0
        ? -1
        : 0;
}

static int append_required_pgdata_entries(TestTarArchive *archive) {
    return append_required_pgdata_files(archive) != 0 ||
            test_tar_append_header(archive, "pgdata/base", '5', 0, NULL) != 0 ||
            test_tar_append_header(archive, "pgdata/pg_wal", '5', 0, NULL) != 0
        ? -1
        : 0;
}

static int append_required_restore_entries(TestTarArchive *archive) {
    static const char manifest[] =
        "archiveLayout=oliphaunt-physical-archive-v1\n"
        "product=oliphaunt\n"
        "engineFamily=native\n"
        "physicalFormat=native-pg18-v1\n"
        "postgresMajor=18\n";
    if (append_required_pgdata_entries(archive) != 0 ||
        test_tar_append_file(archive, ".oliphaunt/backup-manifest.properties", manifest) != 0) {
        return -1;
    }
    return 0;
}

static int verify_restore_rejects_inexact_manifest(const char *pgdata, const char *manifest, const char *case_name) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_pgdata_entries(&archive) != 0 ||
        (manifest != NULL &&
         test_tar_append_file(&archive, ".oliphaunt/backup-manifest.properties", manifest) != 0) ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build %s physical archive fixture\n", case_name);
        return 1;
    }
    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-manifest-%s.%ld", case_name, (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted %s physical archive manifest\n", case_name);
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore physical archive manifest", "manifest");
}

static int verify_restore_rejects_invalid_pg_wal(const char *pgdata, const char *case_name, char typeflag) {
    static const char manifest[] =
        "archiveLayout=oliphaunt-physical-archive-v1\n"
        "product=oliphaunt\n"
        "engineFamily=native\n"
        "physicalFormat=native-pg18-v1\n"
        "postgresMajor=18\n";
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_pgdata_files(&archive) != 0 ||
        test_tar_append_header(&archive, "pgdata/base", '5', 0, NULL) != 0 ||
        (typeflag == '0' && test_tar_append_file(&archive, "pgdata/pg_wal", "not-a-directory") != 0) ||
        (typeflag == '2' && test_tar_append_header(&archive, "pgdata/pg_wal", '2', 0, "pgdata") != 0) ||
        test_tar_append_file(&archive, ".oliphaunt/backup-manifest.properties", manifest) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build %s pg_wal physical archive fixture\n", case_name);
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-pg-wal-%s.%ld", case_name, (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted %s pgdata/pg_wal\n", case_name);
        return 1;
    }
    const char *expected = typeflag == '2' ? "unsupported tar entry type" : "required directory pgdata/pg_wal";
    return expect_error_contains(NULL, "oliphaunt_restore invalid pg_wal", expected);
}

static int verify_restore_rejects_missing_base(const char *pgdata) {
    static const char manifest[] =
        "archiveLayout=oliphaunt-physical-archive-v1\n"
        "product=oliphaunt\n"
        "engineFamily=native\n"
        "physicalFormat=native-pg18-v1\n"
        "postgresMajor=18\n";
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_pgdata_files(&archive) != 0 ||
        test_tar_append_header(&archive, "pgdata/pg_wal", '5', 0, NULL) != 0 ||
        test_tar_append_file(&archive, ".oliphaunt/backup-manifest.properties", manifest) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build missing base physical archive fixture\n");
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-missing-base.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0 || file_exists(restore_root)) {
        fprintf(stderr, "oliphaunt_restore accepted or published PGDATA without base\n");
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore missing base", "required directory pgdata/base");
}

static int verify_restore_rejects_invalid_pgdata_markers(
    const char *pgdata,
    const char *case_name,
    const char *version,
    const char *control,
    const char *backup_label,
    const char *expected_error) {
    static const char manifest[] =
        "archiveLayout=oliphaunt-physical-archive-v1\n"
        "product=oliphaunt\n"
        "engineFamily=native\n"
        "physicalFormat=native-pg18-v1\n"
        "postgresMajor=18\n";
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (test_tar_append_file(&archive, "pgdata/PG_VERSION", version) != 0 ||
        test_tar_append_file(&archive, "pgdata/global/pg_control", control) != 0 ||
        test_tar_append_file(&archive, "pgdata/backup_label", backup_label) != 0 ||
        test_tar_append_header(&archive, "pgdata/base", '5', 0, NULL) != 0 ||
        test_tar_append_header(&archive, "pgdata/pg_wal", '5', 0, NULL) != 0 ||
        test_tar_append_file(&archive, ".oliphaunt/backup-manifest.properties", manifest) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build %s PGDATA marker archive fixture\n", case_name);
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-markers-%s.%ld", case_name, (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0 || file_exists(restore_root)) {
        fprintf(stderr, "oliphaunt_restore accepted or published %s PGDATA markers\n", case_name);
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore invalid PGDATA markers", expected_error);
}

static int verify_restore_rejects_process_state_file(const char *pgdata, const char *name) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    char archive_path[128];
    snprintf(archive_path, sizeof(archive_path), "pgdata/%s", name);
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_append_file(&archive, archive_path, "stale process state") != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build %s physical archive fixture\n", name);
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-%s.%ld", name, (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0 || file_exists(restore_root)) {
        fprintf(stderr, "oliphaunt_restore accepted or published %s\n", archive_path);
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore process-state file", "process-state file");
}

static int build_archive_with_special_entry(TestTarArchive *archive, char typeflag) {
    memset(archive, 0, sizeof(*archive));
    if (append_required_restore_entries(archive) != 0) {
        return -1;
    }
    const char *link_name = typeflag == '2' || typeflag == '1' ? "pgdata/PG_VERSION" : NULL;
    if (test_tar_append_special(archive, "pgdata/base/special-entry", typeflag, link_name) != 0) {
        return -1;
    }
    return test_tar_finish(archive);
}

static int verify_restore_rejects_special_archive_entry(const char *pgdata, char typeflag) {
    TestTarArchive archive;
    if (build_archive_with_special_entry(&archive, typeflag) != 0) {
        fprintf(stderr, "failed to build malicious physical archive fixture\n");
        return 1;
    }
    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-%c.%ld", typeflag, (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted unsupported tar entry type '%c'\n", typeflag);
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore unsupported archive entry", "unsupported tar entry type");
}

static int verify_restore_rejects_directory_entry_with_payload(const char *pgdata) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_append_header(&archive, "pgdata/base/nonzero-dir", '5', 1, NULL) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build directory-payload physical archive fixture\n");
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-nonzero-dir.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted a directory archive entry with payload bytes\n");
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore directory entry with payload", "directory entry pgdata/base/nonzero-dir has non-zero size");
}

static int verify_restore_rejects_bad_tar_checksum(const char *pgdata) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build checksum physical archive fixture\n");
        return 1;
    }
    archive.data[148] = archive.data[148] == '0' ? '1' : '0';

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-checksum.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted an archive with an invalid tar checksum\n");
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore invalid tar checksum", "invalid tar checksum");
}

static int verify_restore_rejects_bad_tar_checksum_field(const char *pgdata) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build checksum-field physical archive fixture\n");
        return 1;
    }
    archive.data[148] = 'x';

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-checksum-field.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted an archive with an invalid tar checksum field\n");
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore invalid tar checksum field", "invalid tar checksum field");
}

static int verify_restore_rejects_bad_tar_magic(const char *pgdata) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build tar-format physical archive fixture\n");
        return 1;
    }
    archive.data[257] = archive.data[257] == 'u' ? 'x' : 'u';
    test_tar_rewrite_checksum(archive.data);

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-magic.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted an archive with an unsupported tar header format\n");
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore unsupported tar header format", "unsupported tar header format");
}

static int verify_restore_rejects_bad_tar_numeric_field(const char *pgdata, size_t field_offset, const char *label) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build invalid-%s physical archive fixture\n", label);
        return 1;
    }
    archive.data[field_offset] = 'x';
    test_tar_rewrite_checksum(archive.data);

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-%s-field.%ld", label, (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted an archive with an invalid tar %s field\n", label);
        return 1;
    }
    char expected[128];
    snprintf(expected, sizeof(expected), "invalid tar %s field", label);
    return expect_error_contains(NULL, "oliphaunt_restore invalid tar numeric field", expected);
}

static int verify_restore_masks_tar_modes(const char *pgdata) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 || test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build safe-mode physical archive fixture\n");
        return 1;
    }
    size_t offset = 0;
    while (offset + 512 <= archive.len && archive.data[offset] != 0) {
        unsigned char *header = archive.data + offset;
        unsigned long long size = test_tar_read_octal(header + 124, 12);
        test_tar_write_octal(header + 100, 8, header[156] == '5' ? 01777 : 06755);
        test_tar_rewrite_checksum(header);
        offset += 512 + (((size_t)size + 511) & ~(size_t)511);
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".restore-safe-mode.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) != 0) {
        fprintf(stderr, "oliphaunt_restore rejected masked archive modes: %s\n", oliphaunt_last_error(NULL));
        return 1;
    }

    char restored_pgdata[4096];
    char restored_version[4096];
    char restored_descriptor[4096];
    snprintf(restored_pgdata, sizeof(restored_pgdata), "%s/pgdata", restore_root);
    snprintf(restored_version, sizeof(restored_version), "%s/pgdata/PG_VERSION", restore_root);
    snprintf(restored_descriptor, sizeof(restored_descriptor), "%s/.oliphaunt.json", restore_root);
    if (!file_exists(restored_version) || !file_exists(restored_descriptor)) {
        fprintf(stderr, "masked-mode restore omitted managed-root files\n");
        return 1;
    }
#ifndef _WIN32
    struct stat pgdata_stat;
    struct stat version_stat;
    struct stat descriptor_stat;
    if (stat(restored_pgdata, &pgdata_stat) != 0 ||
        stat(restored_version, &version_stat) != 0 ||
        stat(restored_descriptor, &descriptor_stat) != 0 ||
        (pgdata_stat.st_mode & 0777) != 0700 ||
        (version_stat.st_mode & 0777) != 0600 ||
        (descriptor_stat.st_mode & 0777) != 0600) {
        fprintf(stderr, "restore did not normalize managed-root permissions to 0700/0600\n");
        return 1;
    }
#endif
    return 0;
}

static int verify_restore_rejects_bad_tar_string_field(const char *pgdata, size_t field_offset, const char *label) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build invalid-%s physical archive fixture\n", label);
        return 1;
    }
    archive.data[field_offset] = 'x';
    test_tar_rewrite_checksum(archive.data);

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-%s-field.%ld", label, (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted an archive with an invalid tar %s field\n", label);
        return 1;
    }
    char expected[128];
    snprintf(expected, sizeof(expected), "invalid tar %s field", label);
    return expect_error_contains(NULL, "oliphaunt_restore invalid tar string field", expected);
}

static int verify_restore_rejects_truncated_tar_terminator(const char *pgdata) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_append_zero_block(&archive) != 0) {
        fprintf(stderr, "failed to build truncated-terminator physical archive fixture\n");
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-short-terminator.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted an archive with a truncated tar terminator\n");
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore truncated tar terminator", "final tar zero block");
}

static int verify_restore_rejects_trailing_tar_data(const char *pgdata) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_append_zero_block(&archive) != 0 ||
        test_tar_append_nonzero_block(&archive) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build trailing-data physical archive fixture\n");
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-trailing.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted an archive with trailing data after the tar terminator\n");
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore trailing tar data", "trailing data after tar terminator");
}

static int verify_restore_rejects_duplicate_tar_entry(const char *pgdata, const char *duplicate_path) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_append_file(&archive, duplicate_path, "duplicate") != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build duplicate-entry physical archive fixture\n");
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-duplicate.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted a duplicate archive entry %s\n", duplicate_path);
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore duplicate archive entry", "duplicate entry pgdata/PG_VERSION");
}

static int verify_restore_rejects_file_tree_collision(const char *pgdata, int parent_first) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    int rc = append_required_restore_entries(&archive);
    if (rc == 0 && parent_first) {
        rc = test_tar_append_file(&archive, "pgdata/collision", "parent-file");
        if (rc == 0) {
            rc = test_tar_append_file(&archive, "pgdata/collision/child", "child-file");
        }
    } else if (rc == 0) {
        rc = test_tar_append_file(&archive, "pgdata/collision/child", "child-file");
        if (rc == 0) {
            rc = test_tar_append_file(&archive, "pgdata/collision", "parent-file");
        }
    }
    if (rc != 0 || test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build file-tree-collision physical archive fixture\n");
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-file-tree.%ld.%d", (long)getpid(), parent_first);
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted a file/tree archive collision\n");
        return 1;
    }
    const char *expected = parent_first
        ? "entry pgdata/collision/child is nested under file entry pgdata/collision"
        : "file entry pgdata/collision conflicts with existing child entries";
    return expect_error_contains(NULL, "oliphaunt_restore file/tree archive collision", expected);
}

static int verify_restore_rejects_regular_tar_link_metadata(const char *pgdata) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    if (append_required_restore_entries(&archive) != 0 ||
        test_tar_append_header(
            &archive,
            "pgdata/base/regular-link-metadata",
            '0',
            0,
            "pgdata/PG_VERSION") != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build regular-file-link-metadata physical archive fixture\n");
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".reject-link-metadata.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) == 0) {
        fprintf(stderr, "oliphaunt_restore accepted regular file link metadata\n");
        return 1;
    }
    return expect_error_contains(NULL, "oliphaunt_restore regular file link metadata", "unexpected link target");
}

static int verify_restore_accepts_canonicalized_tar_paths(const char *pgdata) {
    TestTarArchive archive;
    memset(&archive, 0, sizeof(archive));
    static const char manifest[] =
        "archiveLayout=oliphaunt-physical-archive-v1\n"
        "product=oliphaunt\n"
        "engineFamily=native\n"
        "physicalFormat=native-pg18-v1\n"
        "postgresMajor=18\n";
    if (test_tar_append_file(&archive, "pgdata/PG_VERSION", "18\n") != 0 ||
        test_tar_append_header(&archive, "pgdata/./base", '5', 0, NULL) != 0 ||
        test_tar_append_file(&archive, "pgdata/./global/pg_control", "control") != 0 ||
        test_tar_append_file(&archive, "pgdata/backup_label", "label") != 0 ||
        test_tar_append_header(&archive, "pgdata/pg_wal", '5', 0, NULL) != 0 ||
        test_tar_append_file(&archive, ".oliphaunt/backup-manifest.properties", manifest) != 0 ||
        test_tar_finish(&archive) != 0) {
        fprintf(stderr, "failed to build canonicalized-path physical archive fixture\n");
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".restore-canonical.%ld", (long)getpid());
    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&options) != 0) {
        fprintf(stderr, "oliphaunt_restore rejected a canonicalizable archive path: %s\n", oliphaunt_last_error(NULL));
        return 1;
    }

    char pg_control[4096];
    snprintf(pg_control, sizeof(pg_control), "%s/pgdata/global/pg_control", restore_root);
    if (!file_exists(pg_control)) {
        fprintf(stderr, "oliphaunt_restore did not materialize canonical pg_control path\n");
        return 1;
    }
    return 0;
}

static int verify_backup_rejects_symlinked_pgdata_entry(OliphauntHandle *db, const char *pgdata) {
#ifdef _WIN32
    (void)db;
    (void)pgdata;
    fprintf(stderr, "skipping POSIX symlinked PGDATA backup rejection smoke on Windows\n");
    return 0;
#else
    char link_path[4096];
    snprintf(link_path, sizeof(link_path), "%s/liboliphaunt-smoke-symlink-%ld", pgdata, (long)getpid());
    (void)unlink(link_path);
    if (symlink("/tmp", link_path) != 0) {
        perror("create symlinked PGDATA smoke entry");
        return 1;
    }
    OliphauntResponse archive = {0};
    int rc = oliphaunt_backup(db, &archive);
    (void)unlink(link_path);
    if (rc == 0) {
        fprintf(stderr, "oliphaunt_backup accepted symlinked PGDATA entry\n");
        oliphaunt_free_response(&archive);
        return 1;
    }
    return expect_error_contains(db, "oliphaunt_backup symlinked PGDATA entry", "symlinked PGDATA entry");
#endif
}

static int verify_backup_restore_contract(OliphauntHandle *db, const char *pgdata) {
    OliphauntResponse invalid = {0};
    if (oliphaunt_backup(NULL, &invalid) == 0) {
        fprintf(stderr, "oliphaunt_backup accepted a null handle\n");
        oliphaunt_free_response(&invalid);
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_backup null handle", "invalid oliphaunt_backup arguments") != 0) {
        return 1;
    }
    if (verify_restore_rejects_special_archive_entry(pgdata, '2') != 0 ||
        verify_restore_rejects_special_archive_entry(pgdata, '6') != 0 ||
        verify_restore_rejects_directory_entry_with_payload(pgdata) != 0 ||
        verify_restore_rejects_bad_tar_checksum(pgdata) != 0 ||
        verify_restore_rejects_bad_tar_checksum_field(pgdata) != 0 ||
        verify_restore_rejects_bad_tar_magic(pgdata) != 0 ||
        verify_restore_rejects_bad_tar_numeric_field(pgdata, 124, "size") != 0 ||
        verify_restore_rejects_bad_tar_numeric_field(pgdata, 100, "mode") != 0 ||
        verify_restore_masks_tar_modes(pgdata) != 0 ||
        verify_restore_rejects_bad_tar_numeric_field(pgdata, 108, "uid") != 0 ||
        verify_restore_rejects_bad_tar_numeric_field(pgdata, 116, "gid") != 0 ||
        verify_restore_rejects_bad_tar_numeric_field(pgdata, 136, "mtime") != 0 ||
        verify_restore_rejects_bad_tar_string_field(pgdata, strlen("pgdata/PG_VERSION") + 1, "name") != 0 ||
        verify_restore_rejects_bad_tar_string_field(pgdata, 158, "linkname") != 0 ||
        verify_restore_rejects_bad_tar_string_field(pgdata, 346, "prefix") != 0 ||
        verify_restore_rejects_truncated_tar_terminator(pgdata) != 0 ||
        verify_restore_rejects_trailing_tar_data(pgdata) != 0 ||
        verify_restore_rejects_duplicate_tar_entry(pgdata, "pgdata/PG_VERSION") != 0 ||
        verify_restore_rejects_duplicate_tar_entry(pgdata, "pgdata/./PG_VERSION") != 0 ||
        verify_restore_rejects_file_tree_collision(pgdata, 1) != 0 ||
        verify_restore_rejects_file_tree_collision(pgdata, 0) != 0 ||
        verify_restore_rejects_regular_tar_link_metadata(pgdata) != 0 ||
        verify_restore_rejects_inexact_manifest(pgdata, NULL, "missing") != 0 ||
        verify_restore_rejects_inexact_manifest(
            pgdata,
            "archiveLayout=oliphaunt-physical-archive-v1\n"
            "product=oliphaunt\n"
            "engineFamily=native\n"
            "physicalFormat=native-pg18-v1\n"
            "postgresMajor=18\n"
            "extra=unsupported\n",
            "extra-field") != 0 ||
        verify_restore_rejects_invalid_pg_wal(pgdata, "missing", '\0') != 0 ||
        verify_restore_rejects_invalid_pg_wal(pgdata, "file", '0') != 0 ||
        verify_restore_rejects_invalid_pg_wal(pgdata, "symlink", '2') != 0 ||
        verify_restore_rejects_missing_base(pgdata) != 0 ||
        verify_restore_rejects_invalid_pgdata_markers(
            pgdata, "wrong-version", "17\n", "control", "label", "PostgreSQL 17 PGDATA") != 0 ||
        verify_restore_rejects_invalid_pgdata_markers(
            pgdata, "empty-control", "18\n", "", "label", "regular file with content") != 0 ||
        verify_restore_rejects_invalid_pgdata_markers(
            pgdata, "empty-backup-label", "18\n", "control", "", "missing required file pgdata/backup_label") != 0 ||
        verify_restore_rejects_process_state_file(pgdata, "postmaster.pid") != 0 ||
        verify_restore_rejects_process_state_file(pgdata, "postmaster.opts") != 0 ||
        verify_restore_accepts_canonicalized_tar_paths(pgdata) != 0 ||
        verify_backup_rejects_symlinked_pgdata_entry(db, pgdata) != 0) {
        return 1;
    }

    if (exec_query_expect_tags(
            db,
            "CREATE TABLE IF NOT EXISTS liboliphaunt_backup_smoke(value integer); "
            "TRUNCATE liboliphaunt_backup_smoke; "
            "INSERT INTO liboliphaunt_backup_smoke VALUES (42)",
            (const unsigned char[]){'C', 'Z'},
            2) != 0) {
        return 1;
    }
    if (exec_query_expect_tags(
            db,
            "SELECT value FROM liboliphaunt_backup_smoke",
            (const unsigned char[]){'T', 'D', 'C', 'Z'},
            4) != 0) {
        return 1;
    }

    OliphauntResponse archive = {0};
    char transient_backup_manifest[4096];
    char transient_ds_store[4096];
    char transient_internal_init[4096];
    snprintf(transient_backup_manifest, sizeof(transient_backup_manifest), "%s/backup_manifest", pgdata);
    snprintf(transient_ds_store, sizeof(transient_ds_store), "%s/base/.DS_Store", pgdata);
    snprintf(transient_internal_init, sizeof(transient_internal_init), "%s/base/pg_internal.init.1", pgdata);
    FILE *transient = fopen(transient_backup_manifest, "wb");
    if (transient == NULL) {
        fprintf(stderr, "failed to create transient PGDATA backup_manifest fixture\n");
        return 1;
    }
    int transient_write_rc = fputs("stale test manifest\n", transient);
    int transient_close_rc = fclose(transient);
    if (transient_write_rc < 0 || transient_close_rc != 0) {
        fprintf(stderr, "failed to write transient PGDATA backup_manifest fixture\n");
        return 1;
    }
    transient = fopen(transient_internal_init, "wb");
    if (transient == NULL) {
        (void)remove(transient_backup_manifest);
        (void)remove(transient_ds_store);
        fprintf(stderr, "failed to create transient PGDATA pg_internal.init fixture\n");
        return 1;
    }
    transient_write_rc = fputs("transient relation cache\n", transient);
    transient_close_rc = fclose(transient);
    if (transient_write_rc < 0 || transient_close_rc != 0) {
        (void)remove(transient_backup_manifest);
        (void)remove(transient_ds_store);
        (void)remove(transient_internal_init);
        fprintf(stderr, "failed to write transient PGDATA pg_internal.init fixture\n");
        return 1;
    }
    transient = fopen(transient_ds_store, "wb");
    if (transient == NULL) {
        (void)remove(transient_backup_manifest);
        (void)remove(transient_internal_init);
        fprintf(stderr, "failed to create transient PGDATA .DS_Store fixture\n");
        return 1;
    }
    transient_write_rc = fputs("Finder metadata\n", transient);
    transient_close_rc = fclose(transient);
    if (transient_write_rc < 0 || transient_close_rc != 0) {
        (void)remove(transient_backup_manifest);
        (void)remove(transient_ds_store);
        (void)remove(transient_internal_init);
        fprintf(stderr, "failed to write transient PGDATA .DS_Store fixture\n");
        return 1;
    }
    fprintf(stderr, "creating physical backup through C ABI\n");
    if (oliphaunt_backup(db, &archive) != 0) {
        (void)remove(transient_backup_manifest);
        (void)remove(transient_ds_store);
        fprintf(stderr, "oliphaunt_backup failed: %s\n", oliphaunt_last_error(db));
        return 1;
    }
    (void)remove(transient_backup_manifest);
    (void)remove(transient_ds_store);
    (void)remove(transient_internal_init);
    if (archive.data == NULL || archive.len < 1024 || !contains_bytes(&archive, "backup_label")) {
        fprintf(stderr, "physical backup archive did not contain expected tar payload\n");
        oliphaunt_free_response(&archive);
        return 1;
    }
    if (verify_tar_entry_mode(&archive, "pgdata/", '5', 0700) != 0 ||
        verify_tar_entry_mode(&archive, "pgdata/PG_VERSION", '0', 0600) != 0 ||
        verify_tar_entry_mode(&archive, ".oliphaunt/backup-manifest.properties", '0', 0600) != 0 ||
        verify_tar_identity_metadata_is_normalized(&archive) != 0 ||
        verify_pg_control_archive_order(&archive) != 0 ||
        tar_entry_count(&archive, "pgdata/backup_manifest") != 0 ||
        tar_entry_count(&archive, "pgdata/base/.DS_Store") != 0 ||
        tar_entry_count(&archive, "pgdata/base/pg_internal.init.1") != 0) {
        if (tar_entry_count(&archive, "pgdata/backup_manifest") != 0) {
            fprintf(stderr, "physical archive included transient PGDATA backup_manifest\n");
        }
        if (tar_entry_count(&archive, "pgdata/base/.DS_Store") != 0) {
            fprintf(stderr, "physical archive included transient .DS_Store\n");
        }
        if (tar_entry_count(&archive, "pgdata/base/pg_internal.init.1") != 0) {
            fprintf(stderr, "physical archive included transient pg_internal.init file\n");
        }
        oliphaunt_free_response(&archive);
        return 1;
    }
    char expected_archive_manifest[512];
    if (load_native_archive_manifest_fixture(
            expected_archive_manifest,
            sizeof(expected_archive_manifest)) != 0 ||
        !contains_bytes(&archive, ".oliphaunt/backup-manifest.properties") ||
        !contains_bytes(&archive, expected_archive_manifest) ||
        contains_bytes(&archive, ".oliphaunt.json")) {
        fprintf(stderr, "physical backup archive has incorrect identity metadata\n");
        oliphaunt_free_response(&archive);
        return 1;
    }

    char restore_root[4096];
    root_sibling_path(restore_root, sizeof(restore_root), pgdata, ".restore.%ld", (long)getpid());
    char empty_restore_root[4096];
    root_sibling_path(empty_restore_root, sizeof(empty_restore_root), pgdata, ".restore-empty.%ld", (long)getpid());
#ifdef _WIN32
    int create_empty_restore_root = _mkdir(empty_restore_root);
#else
    int create_empty_restore_root = mkdir(empty_restore_root, 0700);
#endif
    if (create_empty_restore_root != 0) {
        fprintf(stderr, "failed to create empty restore target %s\n", empty_restore_root);
        oliphaunt_free_response(&archive);
        return 1;
    }
    OliphauntRestoreOptions empty_root_options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = empty_restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&empty_root_options) != 0) {
        fprintf(stderr, "oliphaunt_restore rejected an existing empty target: %s\n", oliphaunt_last_error(NULL));
        oliphaunt_free_response(&archive);
        return 1;
    }
    char empty_root_pg_version[4096];
    snprintf(empty_root_pg_version, sizeof(empty_root_pg_version), "%s/pgdata/PG_VERSION", empty_restore_root);
    if (!file_exists(empty_root_pg_version)) {
        fprintf(stderr, "oliphaunt_restore did not publish into the existing empty target\n");
        oliphaunt_free_response(&archive);
        return 1;
    }
    if (oliphaunt_restore(&empty_root_options) == 0) {
        fprintf(stderr, "oliphaunt_restore replaced an existing nonempty target\n");
        oliphaunt_free_response(&archive);
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_restore existing nonempty target", "not empty") != 0) {
        oliphaunt_free_response(&archive);
        return 1;
    }

    char live_root[4096];
    if (parent_path(pgdata, live_root, sizeof(live_root)) != 0) {
        fprintf(stderr, "failed to resolve live native root from PGDATA\n");
        oliphaunt_free_response(&archive);
        return 1;
    }
    OliphauntRestoreOptions live_root_options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = live_root,
        .data = archive.data,
        .len = archive.len,
    };
    if (oliphaunt_restore(&live_root_options) == 0) {
        fprintf(stderr, "oliphaunt_restore replaced a live locked native root\n");
        oliphaunt_free_response(&archive);
        return 1;
    }
    if (expect_error_contains(NULL, "oliphaunt_restore live locked root", "already locked") != 0) {
        oliphaunt_free_response(&archive);
        return 1;
    }

    OliphauntRestoreOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .destination = restore_root,
        .data = archive.data,
        .len = archive.len,
    };
    fprintf(stderr, "restoring physical backup through C ABI: %s\n", restore_root);
    if (oliphaunt_restore(&options) != 0) {
        fprintf(stderr, "oliphaunt_restore failed: %s\n", oliphaunt_last_error(NULL));
        oliphaunt_free_response(&archive);
        return 1;
    }

    char pg_version[4096];
    char backup_label[4096];
    char root_descriptor[4096];
    char archive_manifest[4096];
    snprintf(pg_version, sizeof(pg_version), "%s/pgdata/PG_VERSION", restore_root);
    snprintf(backup_label, sizeof(backup_label), "%s/pgdata/backup_label", restore_root);
    snprintf(root_descriptor, sizeof(root_descriptor), "%s/.oliphaunt.json", restore_root);
    snprintf(archive_manifest, sizeof(archive_manifest), "%s/.oliphaunt/backup-manifest.properties", restore_root);
    if (!file_exists(pg_version) || !file_exists(backup_label) ||
        !file_exists(root_descriptor) || file_exists(archive_manifest)) {
        fprintf(stderr, "restored physical archive has incorrect live-root metadata\n");
        oliphaunt_free_response(&archive);
        return 1;
    }
    oliphaunt_free_response(&archive);
    return 0;
}

static int run_cycle(const char *pgdata, const char *runtime_dir) {
    static const char *const startup_args[] = {
        "-c",
        "application_name=liboliphaunt_smoke",
    };
    OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = pgdata,
        .runtime_dir = runtime_dir,
        .username = "postgres",
        .database = "postgres",
        .reserved_flags = 0,
        .startup_args = startup_args,
        .startup_arg_count = sizeof(startup_args) / sizeof(startup_args[0]),
    };
    OliphauntHandle *db = NULL;
    fprintf(stderr, "opening pgdata: %s\n", pgdata);
    int rc = oliphaunt_init(&config, &db);
    if (rc != 0 || db == NULL) {
        fprintf(stderr, "oliphaunt_init failed: %s\n", oliphaunt_last_error(db));
        return 1;
    }
    uint64_t first_generation = oliphaunt_logical_generation(db);
    if (first_generation == 0) {
        fprintf(stderr, "oliphaunt_init did not publish a non-zero logical generation\n");
        oliphaunt_close(db);
        return 1;
    }
    uint64_t non_owner_generation =
        first_generation == UINT64_MAX ? 1 : first_generation + 1;
    if (oliphaunt_close_if_generation(non_owner_generation) != 1) {
        fprintf(stderr, "oliphaunt_close_if_generation did not reject a non-owner generation\n");
        oliphaunt_close(db);
        return 1;
    }
    if (expect_pgdata_env("oliphaunt_init active backend", pgdata) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    const unsigned char select_tags[] = {'T', 'D', 'C', 'Z'};
    if (verify_stable_root_lock_file(pgdata) != 0 || verify_no_in_root_lock_file(pgdata) != 0) {
        oliphaunt_close(db);
        return 1;
    }
    if (exec_query_expect_tags(db, "SELECT 1 AS value", select_tags, sizeof(select_tags)) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_simple_query_expect_bytes(db, "SELECT 11 AS simple_query_value", "11") != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_query_expect_bytes(
            db,
            "SELECT CASE WHEN "
            "to_tsvector('pg_catalog.english', 'the quick foxes running') "
            "@@ to_tsquery('pg_catalog.english', 'run & fox') "
            "THEN 'english-snowball-ok' ELSE 'english-snowball-failed' END AS value",
            "english-snowball-ok") != 0) {
        fprintf(stderr, "PostgreSQL core English Snowball text search failed\n");
        oliphaunt_close(db);
        return 1;
    }

    if (exec_query_expect_bytes(db, "SELECT current_setting('application_name')", "liboliphaunt_smoke") != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_invalid_argument_checks(db) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_malformed_frame_checks(db) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_query_expect_tags(db, "SELECT 3 AS recovered_after_invalid_args", select_tags, sizeof(select_tags)) != 0) {
        oliphaunt_close(db);
        return 1;
    }


    const unsigned char error_tags[] = {'E', 'Z'};
    if (exec_query_expect_tags(db, "SELECT * FROM liboliphaunt_missing_table", error_tags, sizeof(error_tags)) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_query_expect_tags(db, "SELECT 2 AS recovered", select_tags, sizeof(select_tags)) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_query_expect_tags(db, "SELECT repeat('y', 131072) AS large_owned_response", select_tags, sizeof(select_tags)) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_stream_expect_tags(db, "SELECT repeat('x', 65536) AS streamed", select_tags, sizeof(select_tags)) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_stream_callback_failure_recovers(db) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_cancel_recovers(db) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_plpgsql_smoke(db) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (exec_static_extension_registry_smoke(db) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    if (verify_backup_restore_contract(db, pgdata) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    OliphauntHandle *duplicate = NULL;
    if (oliphaunt_init(&config, &duplicate) == 0 || duplicate != NULL) {
        fprintf(stderr, "oliphaunt_init unexpectedly allowed two active logical direct handles\n");
        if (duplicate != NULL) {
            oliphaunt_close(duplicate);
        } else {
            oliphaunt_close(db);
        }
        return 1;
    }
    if (expect_error_contains(NULL, "duplicate oliphaunt_init", "active logical direct handle") != 0) {
        oliphaunt_close(db);
        return 1;
    }

    fprintf(stderr, "detaching logical database handle\n");
    rc = oliphaunt_detach(db);
    if (rc != 0) {
        fprintf(stderr, "oliphaunt_detach failed: %s\n", oliphaunt_last_error(db));
        oliphaunt_close(db);
        return 1;
    }
    OliphauntResponse detached_response = {0};
    if (oliphaunt_exec_simple_query(db, "SELECT 1", strlen("SELECT 1"), &detached_response) == 0) {
        fprintf(stderr, "detached logical handle unexpectedly accepted a query\n");
        oliphaunt_free_response(&detached_response);
        oliphaunt_close(db);
        return 1;
    }
    oliphaunt_free_response(&detached_response);
    if (expect_error_contains(db, "detached logical query", "logical handle is closed") != 0) {
        oliphaunt_close(db);
        return 1;
    }
    if (expect_pgdata_env("oliphaunt_detach resident backend", pgdata) != 0) {
        oliphaunt_close(db);
        return 1;
    }

    OliphauntConfig mismatched_config = config;
    mismatched_config.database = "template1";
    if (oliphaunt_init(&mismatched_config, &duplicate) == 0 || duplicate != NULL) {
        fprintf(stderr, "oliphaunt_init unexpectedly attached to a different resident database identity\n");
        oliphaunt_close(duplicate != NULL ? duplicate : db);
        return 1;
    }
    if (expect_error_contains(NULL, "mismatched resident oliphaunt_init", "different root") != 0) {
        oliphaunt_close(db);
        return 1;
    }

    fprintf(stderr, "reattaching logical database handle\n");
    OliphauntHandle *reopened = NULL;
    rc = oliphaunt_init(&config, &reopened);
    if (rc != 0 || reopened == NULL) {
        fprintf(stderr, "same-process logical reopen failed: %s\n", oliphaunt_last_error(NULL));
        oliphaunt_close(db);
        return 1;
    }
    uint64_t reopened_generation = oliphaunt_logical_generation(reopened);
    if (reopened_generation == 0 || reopened_generation == first_generation) {
        fprintf(stderr, "same-process logical reopen did not advance its generation\n");
        oliphaunt_close(reopened);
        return 1;
    }
    if (oliphaunt_close_if_generation(first_generation) != 1) {
        fprintf(stderr, "stale logical generation unexpectedly claimed the reopened runtime\n");
        oliphaunt_close(reopened);
        return 1;
    }
    if (exec_query_expect_tags(reopened, "SELECT 42 AS reopened_after_stale_close", select_tags, sizeof(select_tags)) != 0) {
        oliphaunt_close(reopened);
        return 1;
    }

    fprintf(stderr, "terminal shutdown of resident database runtime\n");
    rc = oliphaunt_close_if_generation(reopened_generation);
    if (rc != 0) {
        fprintf(stderr, "generation-guarded oliphaunt close failed\n");
        return 1;
    }
    if (oliphaunt_close_if_generation(reopened_generation) != 0) {
        fprintf(stderr, "repeated close of the same logical generation was not idempotent\n");
        return 1;
    }
    if (oliphaunt_close_if_generation(first_generation) != 0) {
        fprintf(stderr, "terminally closed runtime did not treat stale cleanup as satisfied\n");
        return 1;
    }
    return 0;
}

static int expect_terminal_shutdown_reopen_rejected(const char *pgdata, const char *runtime_dir) {
    OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = pgdata,
        .runtime_dir = runtime_dir,
        .username = "postgres",
        .database = "postgres",
        .reserved_flags = 0,
    };
    OliphauntHandle *db = NULL;
    fprintf(stderr, "verifying terminal direct shutdown remains process-final\n");
    int rc = oliphaunt_init(&config, &db);
    if (rc == 0 || db != NULL) {
        fprintf(stderr, "terminal shutdown reopen unexpectedly succeeded\n");
        if (db != NULL) {
            oliphaunt_close(db);
        }
        return 1;
    }
    return expect_error_contains(NULL, "terminal shutdown reopen", "process lifetime has already been used");
}

int main(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: %s <pgdata> <runtime-dir> <archive-manifest-fixture>\n", argv[0]);
        return 2;
    }
    native_archive_manifest_fixture_path = argv[3];

    fprintf(stderr, "liboliphaunt version: %s\n", oliphaunt_version());
    if (verify_global_contract() != 0 ||
        verify_free_response_contract() != 0 ||
        verify_shared_wal_range_fixture() != 0 ||
        verify_wal_range_archive_selection(argv[1]) != 0 ||
        verify_static_extension_registry_rejects_invalid_entries() != 0) {
        return 1;
    }
    if (register_static_extension_fixture() != 0) {
        return 1;
    }

    const char *host_pgdata = "/tmp/oliphaunt-host-pgdata-sentinel";
    if (set_pgdata_env_for_smoke(host_pgdata) != 0) {
        return 1;
    }
    if (run_cycle(argv[1], argv[2]) != 0) {
        return 1;
    }
    if (expect_pgdata_env("oliphaunt_close", host_pgdata) != 0) {
        return 1;
    }
    if (expect_terminal_shutdown_reopen_rejected(argv[1], argv[2]) != 0) {
        return 1;
    }
    if (expect_pgdata_env("rejected oliphaunt_init", host_pgdata) != 0) {
        return 1;
    }

    fprintf(stderr, "native liboliphaunt smoke passed\n");
    return 0;
}
