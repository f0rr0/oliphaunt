#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "../include/oliphaunt.h"
#include "liboliphaunt_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef _WIN32
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif
#include <time.h>

static uint32_t read_be32(const unsigned char *ptr) {
    return ((uint32_t)ptr[0] << 24) |
           ((uint32_t)ptr[1] << 16) |
           ((uint32_t)ptr[2] << 8) |
           (uint32_t)ptr[3];
}

typedef struct OliphauntBackupStopFiles {
    char *wal_file;
    char *backup_label;
    char *tablespace_map;
} OliphauntBackupStopFiles;

typedef struct OliphauntBackupStart {
    char *wal_file;
    uint64_t wal_segment_size;
} OliphauntBackupStart;

static const char physical_archive_manifest_path[] = ".oliphaunt/backup-manifest.properties";
static const uint8_t physical_archive_manifest_core[] =
    "archiveLayout=oliphaunt-physical-archive-v1\n"
    "product=oliphaunt\n"
    "engineFamily=native\n"
    "physicalFormat=native-pg18-v1\n"
    "postgresMajor=18\n";

static int build_simple_query(OliphauntHandle *handle, const char *sql, uint8_t **out, size_t *out_len) {
    size_t sql_len = strlen(sql);
    if (sql_len > UINT32_MAX - 5) {
        set_error(handle, "SQL query is too large for PostgreSQL simple-query protocol");
        return -1;
    }
    size_t len = 1 + 4 + sql_len + 1;
    uint32_t msg_len = (uint32_t)(4 + sql_len + 1);
    uint8_t *bytes = (uint8_t *)malloc(len);
    if (bytes == NULL) {
        set_error(handle, "out of memory building simple-query protocol message");
        return -1;
    }
    bytes[0] = 'Q';
    bytes[1] = (uint8_t)(msg_len >> 24);
    bytes[2] = (uint8_t)(msg_len >> 16);
    bytes[3] = (uint8_t)(msg_len >> 8);
    bytes[4] = (uint8_t)msg_len;
    memcpy(bytes + 5, sql, sql_len);
    bytes[5 + sql_len] = 0;
    *out = bytes;
    *out_len = len;
    return 0;
}

static int exec_simple_query(OliphauntHandle *handle, const char *sql, OliphauntResponse *response) {
    uint8_t *request = NULL;
    size_t request_len = 0;
    if (build_simple_query(handle, sql, &request, &request_len) != 0) {
        return -1;
    }
    int32_t rc = oliphaunt_exec_protocol(handle, request, request_len, response);
    free(request);
    return rc;
}

static void postgres_error_message(const uint8_t *body, size_t len, char *out, size_t out_len) {
    const char *localized_severity = NULL;
    size_t localized_severity_len = 0;
    const char *severity = NULL;
    size_t severity_len = 0;
    const char *message = NULL;
    size_t message_len = 0;
    size_t off = 0;
    while (off < len && body[off] != 0) {
        uint8_t field = body[off++];
        size_t start = off;
        while (off < len && body[off] != 0) {
            off++;
        }
        if (off >= len) {
            break;
        }
        if (field == 'V' && severity == NULL) {
            severity = (const char *)body + start;
            severity_len = off - start;
        } else if (field == 'S' && localized_severity == NULL) {
            localized_severity = (const char *)body + start;
            localized_severity_len = off - start;
        } else if (field == 'M') {
            message = (const char *)body + start;
            message_len = off - start;
        }
        off++;
    }
    if (severity == NULL) {
        severity = localized_severity;
        severity_len = localized_severity_len;
    }
    if (severity != NULL && message != NULL) {
        snprintf(out, out_len, "%.*s: %.*s", (int)severity_len, severity, (int)message_len, message);
    } else if (message != NULL) {
        snprintf(out, out_len, "%.*s", (int)message_len, message);
    } else {
        snprintf(out, out_len, "PostgreSQL ErrorResponse");
    }
}

static int copy_first_data_row(
    OliphauntHandle *handle,
    const OliphauntResponse *response,
    const char *context,
    uint16_t expected_columns,
    char **values) {
    for (uint16_t column = 0; column < expected_columns; column++) {
        values[column] = NULL;
    }
    size_t off = 0;
    while (off < response->len) {
        if (response->len - off < 5) {
            set_error(handle, "truncated PostgreSQL backend message header");
            return -1;
        }
        uint8_t tag = response->data[off];
        uint32_t len = read_be32(response->data + off + 1);
        if (len < 4 || (size_t)len + 1 > response->len - off) {
            set_error(handle, "truncated PostgreSQL backend message body");
            return -1;
        }
        const uint8_t *body = response->data + off + 5;
        size_t body_len = (size_t)len - 4;
        if (tag == 'E') {
            char pg_error[512];
            char message[1024];
            postgres_error_message(body, body_len, pg_error, sizeof(pg_error));
            snprintf(message, sizeof(message), "%s failed: %s", context, pg_error);
            set_error(handle, message);
            return -1;
        }
        if (tag == 'D') {
            if (body_len < 2) {
                set_error(handle, "truncated PostgreSQL DataRow column count");
                return -1;
            }
            uint16_t columns = ((uint16_t)body[0] << 8) | (uint16_t)body[1];
            const uint8_t *p = body + 2;
            size_t remaining = body_len - 2;
            if (columns != expected_columns) {
                char message[256];
                snprintf(message, sizeof(message), "%s returned an unexpected column count", context);
                set_error(handle, message);
                return -1;
            }
            for (uint16_t column = 0; column < columns; column++) {
                if (remaining < 4) {
                    set_error(handle, "truncated PostgreSQL DataRow column length");
                    goto fail;
                }
                uint32_t raw_value_len = ((uint32_t)p[0] << 24) |
                                         ((uint32_t)p[1] << 16) |
                                         ((uint32_t)p[2] << 8) |
                                         (uint32_t)p[3];
                int32_t value_len = (int32_t)raw_value_len;
                p += 4;
                remaining -= 4;
                if (value_len == -1) {
                    continue;
                }
                if (value_len < 0 || (size_t)value_len > remaining) {
                    set_error(handle, "truncated PostgreSQL DataRow column value");
                    goto fail;
                }
                values[column] = (char *)malloc((size_t)value_len + 1);
                if (values[column] == NULL) {
                    set_error(handle, "out of memory copying physical backup result");
                    goto fail;
                }
                memcpy(values[column], p, (size_t)value_len);
                values[column][value_len] = '\0';
                p += value_len;
                remaining -= (size_t)value_len;
            }
            return 0;
fail:
            for (uint16_t column = 0; column < expected_columns; column++) {
                free(values[column]);
                values[column] = NULL;
            }
            return -1;
        }
        off += (size_t)len + 1;
    }
    char message[256];
    snprintf(message, sizeof(message), "%s returned no DataRow", context);
    set_error(handle, message);
    return -1;
}

static int start_physical_backup(OliphauntHandle *handle, OliphauntBackupStart *out) {
    memset(out, 0, sizeof(*out));
    OliphauntResponse response = {NULL, 0};
    int rc = exec_simple_query(
        handle,
        "SELECT pg_walfile_name(start_lsn), "
        "pg_size_bytes(current_setting('wal_segment_size'))::text "
        "FROM (SELECT pg_backup_start(label => 'liboliphaunt physical archive', fast => true) AS start_lsn) backup",
        &response);
    char *values[2] = {NULL, NULL};
    if (rc == 0) {
        rc = copy_first_data_row(handle, &response, "pg_backup_start", 2, values);
    }
    if (rc == 0 &&
        (values[0] == NULL || values[0][0] == '\0' || values[1] == NULL || values[1][0] == '\0')) {
        set_error(handle, "pg_backup_start returned incomplete WAL metadata");
        rc = -1;
    }
    if (rc == 0) {
        char *end = NULL;
        errno = 0;
        unsigned long long parsed = strtoull(values[1], &end, 10);
        if (errno != 0 || end == values[1] || *end != '\0' || parsed == 0) {
            set_error(handle, "pg_backup_start returned an invalid WAL segment size");
            rc = -1;
        } else {
            out->wal_file = values[0];
            values[0] = NULL;
            out->wal_segment_size = (uint64_t)parsed;
        }
    }
    free(values[0]);
    free(values[1]);
    oliphaunt_free_response(&response);
    return rc;
}

static int parse_stop_backup_response(OliphauntHandle *handle, const OliphauntResponse *response, OliphauntBackupStopFiles *out) {
    memset(out, 0, sizeof(*out));
    char *values[3] = {NULL, NULL, NULL};
    if (copy_first_data_row(handle, response, "pg_backup_stop", 3, values) != 0) {
        return -1;
    }
    if (values[0] == NULL || values[0][0] == '\0') {
        set_error(handle, "pg_backup_stop returned an empty WAL filename");
        goto fail;
    }
    if (values[1] == NULL || values[1][0] == '\0') {
        set_error(handle, "pg_backup_stop returned an empty backup_label");
        goto fail;
    }
    out->wal_file = values[0];
    out->backup_label = values[1];
    out->tablespace_map = values[2];
    return 0;
fail:
    free(values[0]);
    free(values[1]);
    free(values[2]);
    return -1;
}

static int stop_physical_backup(OliphauntHandle *handle, OliphauntBackupStopFiles *out) {
    OliphauntResponse response = {NULL, 0};
    int rc = exec_simple_query(
        handle,
        "SELECT pg_walfile_name(lsn), labelfile, spcmapfile "
        "FROM pg_backup_stop(wait_for_archive => false)",
        &response);
    if (rc == 0) {
        rc = parse_stop_backup_response(handle, &response, out);
    }
    oliphaunt_free_response(&response);
    return rc;
}

static void free_backup_stop_files(OliphauntBackupStopFiles *files) {
    free(files->wal_file);
    free(files->backup_label);
    free(files->tablespace_map);
    files->wal_file = NULL;
    files->backup_label = NULL;
    files->tablespace_map = NULL;
}

static void free_backup_start(OliphauntBackupStart *start) {
    free(start->wal_file);
    start->wal_file = NULL;
    start->wal_segment_size = 0;
}

static int append_default_backup_manifest(OliphauntByteBuffer *archive, OliphauntHandle *handle) {
    return oliphaunt_archive_append_bytes(
        archive,
        handle,
        physical_archive_manifest_path,
        physical_archive_manifest_core,
        sizeof(physical_archive_manifest_core) - 1);
}

static bool backup_trace_enabled(void) {
    const char *value = getenv("OLIPHAUNT_TRACE_BACKUP");
    return value != NULL && value[0] != '\0' && strcmp(value, "0") != 0 && strcmp(value, "false") != 0;
}

static void print_backup_trace_phase(
    bool trace,
    const char *phase,
    uint64_t started_ns,
    const OliphauntByteBuffer *archive) {
    if (!trace) {
        return;
    }
    fprintf(
        stderr,
        "oliphaunt_backup_trace phase=%s elapsed_us=%llu archive_bytes=%llu\n",
        phase,
        (unsigned long long)(oliphaunt_elapsed_ns(started_ns) / 1000),
        (unsigned long long)(archive == NULL ? 0 : archive->len));
}

static int32_t oliphaunt_backup_impl(
    OliphauntHandle *handle,
    OliphauntResponse *out) {
    if (handle == NULL || out == NULL) {
        set_error(handle, "invalid oliphaunt_backup arguments");
        return -1;
    }
    out->data = NULL;
    out->len = 0;
    bool trace = backup_trace_enabled();
    uint64_t total_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
    uint64_t phase_started_ns = total_started_ns;
    OliphauntBackupStart start = {0};
    if (start_physical_backup(handle, &start) != 0) {
        return -1;
    }
    print_backup_trace_phase(trace, "pg_backup_start", phase_started_ns, NULL);

    OliphauntByteBuffer archive = {0};
    OliphauntBackupStopFiles stop_files = {0};
    bool backup_stopped = false;
    phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
    int rc = oliphaunt_archive_append_pgdata_tree(&archive, handle, oliphaunt_handle_pgdata(handle));
    print_backup_trace_phase(trace, "append_pgdata", phase_started_ns, &archive);
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = oliphaunt_archive_append_pg_control(&archive, handle, oliphaunt_handle_pgdata(handle));
        print_backup_trace_phase(trace, "append_pg_control", phase_started_ns, &archive);
    }
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = stop_physical_backup(handle, &stop_files);
        backup_stopped = rc == 0;
        print_backup_trace_phase(trace, "pg_backup_stop", phase_started_ns, &archive);
    }
    if (rc != 0 && !backup_stopped) {
        char primary_error[sizeof(handle->last_error)];
        snprintf(primary_error, sizeof(primary_error), "%s", handle->last_error);
        OliphauntBackupStopFiles ignored = {0};
        (void)stop_physical_backup(handle, &ignored);
        free_backup_stop_files(&ignored);
        set_error(handle, primary_error);
    }
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = oliphaunt_archive_append_wal_range(
            &archive,
            handle,
            oliphaunt_handle_pgdata(handle),
            start.wal_file,
            stop_files.wal_file,
            start.wal_segment_size);
        print_backup_trace_phase(trace, "append_pg_wal", phase_started_ns, &archive);
    }
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = oliphaunt_archive_append_text(&archive, handle, "pgdata/backup_label", stop_files.backup_label);
        print_backup_trace_phase(trace, "append_backup_label", phase_started_ns, &archive);
    }
    if (rc == 0 && stop_files.tablespace_map != NULL && stop_files.tablespace_map[0] != '\0') {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = oliphaunt_archive_append_text(&archive, handle, "pgdata/tablespace_map", stop_files.tablespace_map);
        print_backup_trace_phase(trace, "append_tablespace_map", phase_started_ns, &archive);
    }
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = append_default_backup_manifest(&archive, handle);
        print_backup_trace_phase(trace, "append_manifest", phase_started_ns, &archive);
    }
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = oliphaunt_archive_finish(&archive, handle);
        print_backup_trace_phase(trace, "finish", phase_started_ns, &archive);
    }
    free_backup_stop_files(&stop_files);
    free_backup_start(&start);
    if (rc != 0) {
        free(archive.data);
        return -1;
    }
    out->data = archive.data;
    out->len = archive.len;
    print_backup_trace_phase(trace, "total", total_started_ns, &archive);
    return 0;
}

int32_t oliphaunt_backup(
    OliphauntHandle *handle,
    OliphauntResponse *out) {
    return oliphaunt_backup_impl(handle, out);
}

static int validate_restored_backup_manifest(OliphauntHandle *handle, const char *staging_root) {
    char *path = oliphaunt_join_path(staging_root, physical_archive_manifest_path);
    if (path == NULL) {
        set_error(handle, "out of memory resolving physical archive manifest");
        return -1;
    }
    int reparse = oliphaunt_path_is_reparse_point(path);
    struct stat st;
    if (lstat(path, &st) != 0) {
        char message[1024];
        if (errno == ENOENT) {
            snprintf(message, sizeof(message), "physical archive is missing required manifest %s", path);
        } else {
            snprintf(message, sizeof(message), "stat physical archive manifest %s: %s", path, strerror(errno));
        }
        set_error(handle, message);
        free(path);
        return -1;
    }
    if (reparse > 0 || !S_ISREG(st.st_mode) || st.st_size != (off_t)(sizeof(physical_archive_manifest_core) - 1)) {
        set_error(handle, "physical archive manifest does not exactly match the native physical archive contract");
        free(path);
        return -1;
    }
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "open physical archive manifest %s: %s", path, strerror(errno));
        set_error(handle, message);
        free(path);
        return -1;
    }
    size_t size = sizeof(physical_archive_manifest_core) - 1;
    uint8_t text[sizeof(physical_archive_manifest_core) - 1];
    size_t read_size = fread(text, 1, size, file);
    int read_failed = ferror(file);
    int close_failed = fclose(file) != 0;
    if (read_failed || close_failed || read_size != size || memchr(text, '\0', size) != NULL) {
        free(path);
        set_error(handle, "physical archive manifest is unreadable or contains NUL bytes");
        return -1;
    }
    bool compatible = memcmp(text, physical_archive_manifest_core, size) == 0;
    if (!compatible) {
        free(path);
        set_error(handle, "physical archive manifest has incompatible archive identity");
        return -1;
    }

    if (unlink(path) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "remove consumed physical archive manifest %s: %s", path, strerror(errno));
        set_error(handle, message);
        free(path);
        return -1;
    }
    free(path);

    char *metadata_dir = oliphaunt_join_path(staging_root, ".oliphaunt");
    if (metadata_dir == NULL) {
        set_error(handle, "out of memory resolving consumed physical archive metadata directory");
        return -1;
    }
    if (rmdir(metadata_dir) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "remove consumed physical archive metadata directory %s: %s", metadata_dir, strerror(errno));
        set_error(handle, message);
        free(metadata_dir);
        return -1;
    }
    free(metadata_dir);
    return 0;
}

static int validate_restored_pgdata(OliphauntHandle *handle, const char *staging_root) {
    const char *required[] = {
        "pgdata/PG_VERSION",
        "pgdata/global/pg_control",
        "pgdata/backup_label",
    };
    for (size_t i = 0; i < sizeof(required) / sizeof(required[0]); i++) {
        char *path = oliphaunt_join_path(staging_root, required[i]);
        if (path == NULL) {
            set_error(handle, "out of memory validating restored PGDATA");
            return -1;
        }
        struct stat st;
        int reparse = oliphaunt_path_is_reparse_point(path);
        int ok = reparse == 0 && lstat(path, &st) == 0 && S_ISREG(st.st_mode);
        if (ok && strcmp(required[i], "pgdata/backup_label") == 0 && st.st_size == 0) {
            ok = 0;
        }
        free(path);
        if (!ok) {
            char message[1024];
            snprintf(message, sizeof(message), "physical archive is missing required file %s", required[i]);
            set_error(handle, message);
            return -1;
        }
    }
    char *pg_wal = oliphaunt_join_path(staging_root, "pgdata/pg_wal");
    if (pg_wal == NULL) {
        set_error(handle, "out of memory validating restored pg_wal");
        return -1;
    }
    struct stat pg_wal_st;
    int pg_wal_ok = oliphaunt_path_is_reparse_point(pg_wal) == 0 &&
                    lstat(pg_wal, &pg_wal_st) == 0 &&
                    S_ISDIR(pg_wal_st.st_mode);
    free(pg_wal);
    if (!pg_wal_ok) {
        set_error(handle, "physical archive is missing required directory pgdata/pg_wal");
        return -1;
    }
    if (validate_restored_backup_manifest(handle, staging_root) != 0) {
        return -1;
    }
    char *pgdata = oliphaunt_join_path(staging_root, "pgdata");
    if (pgdata == NULL) {
        set_error(handle, "out of memory resolving restored PGDATA");
        return -1;
    }
    int rc = oliphaunt_publish_native_root_descriptor(handle, pgdata);
    if (rc == 0) {
        rc = oliphaunt_validate_managed_root(handle, pgdata);
    }
    free(pgdata);
    return rc;
}

static char *unique_sibling_path_c(const char *target_root, const char *suffix) {
    char *parent = oliphaunt_path_parent_dup(target_root);
    char *name = oliphaunt_path_file_name_dup(target_root);
    if (parent == NULL || name == NULL) {
        free(parent);
        free(name);
        return NULL;
    }
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    for (int attempt = 0; attempt < 100; attempt++) {
        char leaf[512];
        snprintf(
            leaf,
            sizeof(leaf),
            ".%s-%s-%ld-%lld-%d",
            name,
            suffix,
            (long)getpid(),
            (long long)ts.tv_nsec,
            attempt);
        char *candidate = oliphaunt_join_path(parent, leaf);
        if (candidate == NULL) {
            free(parent);
            free(name);
            return NULL;
        }
        if (!oliphaunt_path_exists(candidate)) {
            free(parent);
            free(name);
            return candidate;
        }
        free(candidate);
    }
    free(parent);
    free(name);
    return NULL;
}

static int validate_restore_destination(OliphauntHandle *handle, const char *target_root) {
    struct stat st;
    if (lstat(target_root, &st) == 0) {
        if (S_ISDIR(st.st_mode)) {
            int empty = oliphaunt_directory_is_empty(target_root);
            if (empty > 0) {
                return 0;
            }
            if (empty < 0) {
                char message[1024];
                snprintf(message, sizeof(message), "inspect restore target %s: %s", target_root, strerror(errno));
                set_error(handle, message);
                return -1;
            }
        }
        char message[1024];
        snprintf(message, sizeof(message), "restore target %s already exists and is not empty", target_root);
        set_error(handle, message);
        return -1;
    } else if (errno != ENOENT) {
        char message[1024];
        snprintf(message, sizeof(message), "stat restore target %s: %s", target_root, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    return 0;
}

static int publish_restore_without_replacement(OliphauntHandle *handle, const char *staging_root, const char *target_root) {
    struct stat st;
    if (lstat(target_root, &st) == 0) {
        if (validate_restore_destination(handle, target_root) != 0) {
            return -1;
        }
        if (rmdir(target_root) != 0) {
            char message[1024];
            snprintf(message, sizeof(message), "remove empty restore target %s: %s", target_root, strerror(errno));
            set_error(handle, message);
            return -1;
        }
    } else if (errno != ENOENT) {
        char message[1024];
        snprintf(message, sizeof(message), "stat restore target %s: %s", target_root, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    if (rename(staging_root, target_root) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "publish restored root %s: %s", target_root, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    return 0;
}

int32_t oliphaunt_restore(const OliphauntRestoreOptions *options) {
    if (options == NULL ||
        options->abi_version != OLIPHAUNT_ABI_VERSION ||
        options->destination == NULL ||
        options->destination[0] == '\0' ||
        options->data == NULL ||
        options->len == 0) {
        set_error(NULL, "invalid oliphaunt_restore options");
        return -1;
    }
    int destination_is_root = oliphaunt_path_is_filesystem_root(options->destination);
    if (destination_is_root > 0) {
        set_error(NULL, "refusing to restore over filesystem root");
        return -1;
    }
    if (destination_is_root < 0) {
        set_error(NULL, "cannot resolve restore destination for filesystem-root validation");
        return -1;
    }

    char *parent = oliphaunt_path_parent_dup(options->destination);
    if (parent == NULL) {
        set_error(NULL, "out of memory resolving restore parent");
        return -1;
    }
    if (oliphaunt_mkdir_p(parent, 0700) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "create restore parent directory %s: %s", parent, strerror(errno));
        set_error(NULL, message);
        free(parent);
        return -1;
    }
    free(parent);

    int stable_lock_fd = -1;
    char *stable_lock_path = NULL;
    if (oliphaunt_acquire_stable_root_lock(NULL, options->destination, &stable_lock_fd, &stable_lock_path) != 0) {
        return -1;
    }
    if (validate_restore_destination(NULL, options->destination) != 0) {
        oliphaunt_release_file_lock(&stable_lock_fd, &stable_lock_path);
        return -1;
    }

    char *staging_root = unique_sibling_path_c(options->destination, "restore-staging");
    if (staging_root == NULL) {
        set_error(NULL, "out of memory resolving restore staging path");
        oliphaunt_release_file_lock(&stable_lock_fd, &stable_lock_path);
        return -1;
    }
    if (mkdir(staging_root, 0700) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "create restore staging directory %s: %s", staging_root, strerror(errno));
        set_error(NULL, message);
        free(staging_root);
        oliphaunt_release_file_lock(&stable_lock_fd, &stable_lock_path);
        return -1;
    }

    int rc = oliphaunt_unpack_physical_archive(NULL, options->data, options->len, staging_root);
    if (rc == 0) {
        rc = validate_restored_pgdata(NULL, staging_root);
    }
    if (rc == 0) {
        rc = publish_restore_without_replacement(NULL, staging_root, options->destination);
    }
    if (rc != 0) {
        (void)oliphaunt_remove_tree(staging_root);
    }
    oliphaunt_release_file_lock(&stable_lock_fd, &stable_lock_path);
    free(staging_root);
    return rc;
}
