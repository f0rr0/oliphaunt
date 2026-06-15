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
    char *backup_label;
    char *tablespace_map;
} OliphauntBackupStopFiles;

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
        if ((field == 'S' || field == 'V') && severity == NULL) {
            severity = (const char *)body + start;
            severity_len = off - start;
        } else if (field == 'M') {
            message = (const char *)body + start;
            message_len = off - start;
        }
        off++;
    }
    if (severity != NULL && message != NULL) {
        snprintf(out, out_len, "%.*s: %.*s", (int)severity_len, severity, (int)message_len, message);
    } else if (message != NULL) {
        snprintf(out, out_len, "%.*s", (int)message_len, message);
    } else {
        snprintf(out, out_len, "PostgreSQL ErrorResponse");
    }
}

static int scan_response_for_error(OliphauntHandle *handle, const OliphauntResponse *response, const char *context) {
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
        off += (size_t)len + 1;
    }
    return 0;
}

static int ensure_simple_query_ok(OliphauntHandle *handle, const char *sql, const char *context) {
    OliphauntResponse response = {NULL, 0};
    if (exec_simple_query(handle, sql, &response) != 0) {
        return -1;
    }
    int rc = scan_response_for_error(handle, &response, context);
    oliphaunt_free_response(&response);
    return rc;
}

static int parse_stop_backup_response(OliphauntHandle *handle, const OliphauntResponse *response, OliphauntBackupStopFiles *out) {
    memset(out, 0, sizeof(*out));
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
            snprintf(message, sizeof(message), "stop physical backup failed: %s", pg_error);
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
            if (columns != 2) {
                set_error(handle, "pg_backup_stop returned an unexpected column count");
                return -1;
            }
            char *values[2] = {NULL, NULL};
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
                    set_error(handle, "out of memory copying pg_backup_stop result");
                    goto fail;
                }
                memcpy(values[column], p, (size_t)value_len);
                values[column][value_len] = '\0';
                p += value_len;
                remaining -= (size_t)value_len;
            }
            if (values[0] == NULL || values[0][0] == '\0') {
                set_error(handle, "pg_backup_stop returned an empty backup_label");
                goto fail;
            }
            out->backup_label = values[0];
            out->tablespace_map = values[1];
            return 0;
fail:
            free(values[0]);
            free(values[1]);
            return -1;
        }
        off += (size_t)len + 1;
    }
    set_error(handle, "pg_backup_stop returned no DataRow");
    return -1;
}

static int stop_physical_backup(OliphauntHandle *handle, OliphauntBackupStopFiles *out) {
    OliphauntResponse response = {NULL, 0};
    int rc = exec_simple_query(
        handle,
        "SELECT labelfile, spcmapfile FROM pg_backup_stop(wait_for_archive => false)",
        &response);
    if (rc == 0) {
        rc = parse_stop_backup_response(handle, &response, out);
    }
    oliphaunt_free_response(&response);
    return rc;
}

static void free_backup_stop_files(OliphauntBackupStopFiles *files) {
    free(files->backup_label);
    free(files->tablespace_map);
    files->backup_label = NULL;
    files->tablespace_map = NULL;
}

static bool path_has_component(const char *path, const char *component) {
    size_t component_len = strlen(component);
    const char *p = path;
    while (*p != '\0') {
        while (*p == '/'
#ifdef _WIN32
               || *p == '\\'
#endif
        ) {
            p++;
        }
        const char *start = p;
        while (*p != '\0' && *p != '/'
#ifdef _WIN32
               && *p != '\\'
#endif
        ) {
            p++;
        }
        if ((size_t)(p - start) == component_len && strncmp(start, component, component_len) == 0) {
            return true;
        }
    }
    return false;
}

static bool is_external_generated_archive_path(const char *path) {
    return strcmp(path, "manifest.properties") == 0 || strncmp(path, ".oliphaunt/", 11) == 0;
}

static int validate_generated_backup_files(OliphauntHandle *handle, const OliphauntArchiveFile *files, size_t count) {
    if (count == 0) {
        return 0;
    }
    if (files == NULL) {
        set_error(handle, "backup options provided generated file count without generated files");
        return -1;
    }
    for (size_t i = 0; i < count; i++) {
        const OliphauntArchiveFile *file = &files[i];
        if (file->reserved_flags != 0) {
            set_error(handle, "generated backup file reserved_flags must be zero");
            return -1;
        }
        if (file->path == NULL || file->path[0] == '\0' || file->path[0] == '/' ||
            path_has_component(file->path, "..") || !is_external_generated_archive_path(file->path)) {
            set_error(handle, "generated backup files must target manifest.properties or .oliphaunt/ metadata paths");
            return -1;
        }
        if (file->len > 0 && file->data == NULL) {
            set_error(handle, "generated backup file has bytes but no data pointer");
            return -1;
        }
        if (file->mode != 0 && (file->mode & ~0777u) != 0) {
            set_error(handle, "generated backup file mode must contain only permission bits");
            return -1;
        }
        for (size_t j = 0; j < i; j++) {
            if (strcmp(files[j].path, file->path) == 0) {
                set_error(handle, "generated backup file paths must be unique");
                return -1;
            }
        }
    }
    return 0;
}

static int append_generated_backup_files(
    OliphauntByteBuffer *archive,
    OliphauntHandle *handle,
    const OliphauntArchiveFile *files,
    size_t count) {
    for (size_t i = 0; i < count; i++) {
        if (oliphaunt_archive_append_generated_bytes(
                archive,
                handle,
                files[i].path,
                files[i].data,
                files[i].len,
                files[i].mode == 0 ? 0600u : files[i].mode) != 0) {
            return -1;
        }
    }
    return 0;
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
    uint32_t format,
    const OliphauntArchiveFile *generated_files,
    size_t generated_file_count,
    OliphauntResponse *out) {
    if (handle == NULL || out == NULL) {
        set_error(handle, "invalid oliphaunt_backup arguments");
        return -1;
    }
    out->data = NULL;
    out->len = 0;
    if (format != OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE) {
        set_error(handle, "native direct backup currently supports only physicalArchive format");
        return -1;
    }
    if (validate_generated_backup_files(handle, generated_files, generated_file_count) != 0) {
        return -1;
    }

    bool trace = backup_trace_enabled();
    uint64_t total_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
    uint64_t phase_started_ns = total_started_ns;
    if (ensure_simple_query_ok(
            handle,
            "SELECT pg_backup_start(label => 'liboliphaunt physical archive', fast => true)",
            "start physical backup") != 0) {
        return -1;
    }
    print_backup_trace_phase(trace, "pg_backup_start", phase_started_ns, NULL);

    OliphauntByteBuffer archive = {0};
    OliphauntBackupStopFiles stop_files = {0};
    phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
    int rc = oliphaunt_archive_append_pgdata_tree(&archive, handle, oliphaunt_handle_pgdata(handle));
    print_backup_trace_phase(trace, "append_pgdata", phase_started_ns, &archive);
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = stop_physical_backup(handle, &stop_files);
        print_backup_trace_phase(trace, "pg_backup_stop", phase_started_ns, &archive);
    } else {
        OliphauntBackupStopFiles ignored = {0};
        (void)stop_physical_backup(handle, &ignored);
        free_backup_stop_files(&ignored);
    }
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = oliphaunt_archive_append_pg_wal_tree(&archive, handle, oliphaunt_handle_pgdata(handle));
        print_backup_trace_phase(trace, "append_pg_wal", phase_started_ns, &archive);
    }
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = oliphaunt_archive_append_generated_file(&archive, handle, "pgdata/backup_label", stop_files.backup_label);
        print_backup_trace_phase(trace, "append_backup_label", phase_started_ns, &archive);
    }
    if (rc == 0 && stop_files.tablespace_map != NULL && stop_files.tablespace_map[0] != '\0') {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = oliphaunt_archive_append_generated_file(&archive, handle, "pgdata/tablespace_map", stop_files.tablespace_map);
        print_backup_trace_phase(trace, "append_tablespace_map", phase_started_ns, &archive);
    }
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = append_generated_backup_files(&archive, handle, generated_files, generated_file_count);
        print_backup_trace_phase(trace, "append_generated_files", phase_started_ns, &archive);
    }
    if (rc == 0) {
        phase_started_ns = trace ? oliphaunt_monotonic_ns() : 0;
        rc = oliphaunt_archive_finish(&archive, handle);
        print_backup_trace_phase(trace, "finish", phase_started_ns, &archive);
    }
    free_backup_stop_files(&stop_files);
    if (rc != 0) {
        free(archive.data);
        return -1;
    }
    out->data = archive.data;
    out->len = archive.len;
    print_backup_trace_phase(trace, "total", total_started_ns, &archive);
    return 0;
}

int32_t oliphaunt_backup(OliphauntHandle *handle, uint32_t format, OliphauntResponse *out) {
    return oliphaunt_backup_impl(handle, format, NULL, 0, out);
}

int32_t oliphaunt_backup_ex(
    OliphauntHandle *handle,
    const OliphauntBackupOptions *options,
    OliphauntResponse *out) {
    if (options == NULL || options->abi_version != OLIPHAUNT_ABI_VERSION || options->reserved_flags != 0) {
        set_error(handle, "invalid oliphaunt_backup_ex options");
        return -1;
    }
    return oliphaunt_backup_impl(
        handle,
        options->format,
        options->generated_files,
        options->generated_file_count,
        out);
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
        int ok = stat(path, &st) == 0 && S_ISREG(st.st_mode);
        free(path);
        if (!ok) {
            char message[1024];
            snprintf(message, sizeof(message), "physical archive is missing required file %s", required[i]);
            set_error(handle, message);
            return -1;
        }
    }
    return 0;
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

static int publish_restore_without_replacement(OliphauntHandle *handle, const char *staging_root, const char *target_root) {
    struct stat st;
    if (lstat(target_root, &st) == 0) {
        if (!S_ISDIR(st.st_mode)) {
            char message[1024];
            snprintf(message, sizeof(message), "refusing to restore over non-directory target %s", target_root);
            set_error(handle, message);
            return -1;
        }
        int empty = oliphaunt_directory_is_empty(target_root);
        if (empty < 0) {
            char message[1024];
            snprintf(message, sizeof(message), "read restore target %s: %s", target_root, strerror(errno));
            set_error(handle, message);
            return -1;
        }
        if (!empty) {
            char message[1024];
            snprintf(message, sizeof(message), "refusing to restore into non-empty target %s; use replaceExisting to replace it", target_root);
            set_error(handle, message);
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

static int acquire_restore_lock(OliphauntHandle *handle, const char *target_root) {
    char *lock_path = oliphaunt_join_path(target_root, ".oliphaunt.lock");
    if (lock_path == NULL) {
        set_error(handle, "out of memory resolving restore lock path");
        return -1;
    }
    int fd = open(lock_path, O_RDWR | O_CREAT, 0600);
    if (fd < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "open restore lock %s: %s", lock_path, strerror(errno));
        set_error(handle, message);
        free(lock_path);
        return -1;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "restore target %s is already locked: %s", target_root, strerror(errno));
        set_error(handle, message);
        close(fd);
        free(lock_path);
        return -1;
    }
    free(lock_path);
    return fd;
}

static int publish_restore_with_replacement(OliphauntHandle *handle, const char *staging_root, const char *target_root) {
    struct stat st;
    if (lstat(target_root, &st) != 0) {
        if (errno == ENOENT) {
            return publish_restore_without_replacement(handle, staging_root, target_root);
        }
        char message[1024];
        snprintf(message, sizeof(message), "stat restore target %s: %s", target_root, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    if (!S_ISDIR(st.st_mode)) {
        char message[1024];
        snprintf(message, sizeof(message), "refusing to replace non-directory restore target %s", target_root);
        set_error(handle, message);
        return -1;
    }
    int lock_fd = acquire_restore_lock(handle, target_root);
    if (lock_fd < 0) {
        return -1;
    }
    char *displaced = unique_sibling_path_c(target_root, "restore-replaced");
    if (displaced == NULL) {
        close(lock_fd);
        set_error(handle, "out of memory resolving displaced restore target path");
        return -1;
    }
    if (rename(target_root, displaced) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "move existing root aside for restore: %s", strerror(errno));
        set_error(handle, message);
        free(displaced);
        close(lock_fd);
        return -1;
    }
    if (rename(staging_root, target_root) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "publish restored root %s: %s", target_root, strerror(errno));
        set_error(handle, message);
        (void)rename(displaced, target_root);
        free(displaced);
        close(lock_fd);
        return -1;
    }
    close(lock_fd);
    int rc = oliphaunt_remove_tree(displaced);
    free(displaced);
    if (rc != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "remove replaced restore target: %s", strerror(errno));
        set_error(handle, message);
        return -1;
    }
    return 0;
}

int32_t oliphaunt_restore(const OliphauntRestoreOptions *options) {
    if (options == NULL ||
        options->abi_version != OLIPHAUNT_ABI_VERSION ||
        options->root == NULL ||
        options->root[0] == '\0' ||
        options->data == NULL ||
        options->len == 0) {
        set_error(NULL, "invalid oliphaunt_restore options");
        return -1;
    }
    if (strcmp(options->root, "/") == 0) {
        set_error(NULL, "refusing to restore over filesystem root");
        return -1;
    }
    if (options->format != OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE) {
        set_error(NULL, "restore currently supports only physicalArchive format");
        return -1;
    }
    if ((options->flags & ~OLIPHAUNT_RESTORE_REPLACE_EXISTING) != 0) {
        set_error(NULL, "invalid oliphaunt_restore flags");
        return -1;
    }

    int stable_lock_fd = -1;
    char *stable_lock_path = NULL;
    if (oliphaunt_acquire_stable_root_lock(NULL, options->root, &stable_lock_fd, &stable_lock_path) != 0) {
        return -1;
    }

    char *parent = oliphaunt_path_parent_dup(options->root);
    if (parent == NULL) {
        set_error(NULL, "out of memory resolving restore parent");
        oliphaunt_release_file_lock(&stable_lock_fd, &stable_lock_path);
        return -1;
    }
    if (oliphaunt_mkdir_p(parent, 0700) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "create restore parent directory %s: %s", parent, strerror(errno));
        set_error(NULL, message);
        free(parent);
        oliphaunt_release_file_lock(&stable_lock_fd, &stable_lock_path);
        return -1;
    }
    free(parent);

    char *staging_root = unique_sibling_path_c(options->root, "restore-staging");
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
        if ((options->flags & OLIPHAUNT_RESTORE_REPLACE_EXISTING) != 0) {
            rc = publish_restore_with_replacement(NULL, staging_root, options->root);
        } else {
            rc = publish_restore_without_replacement(NULL, staging_root, options->root);
        }
    }
    if (rc != 0) {
        (void)oliphaunt_remove_tree(staging_root);
    }
    oliphaunt_release_file_lock(&stable_lock_fd, &stable_lock_path);
    free(staging_root);
    return rc;
}
