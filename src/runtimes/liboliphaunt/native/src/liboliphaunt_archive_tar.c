#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "liboliphaunt_internal.h"

#ifndef _WIN32
#include <dirent.h>
#endif
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef _WIN32
#include <sys/stat.h>
#include <unistd.h>
#endif
#include <time.h>

#ifndef O_BINARY
#define O_BINARY 0
#endif

static int buffer_reserve(OliphauntByteBuffer *buffer, size_t additional) {
    if (additional > SIZE_MAX - buffer->len) {
        return -1;
    }
    size_t required = buffer->len + additional;
    if (required <= buffer->cap) {
        return 0;
    }
    size_t next = buffer->cap == 0 ? 4096 : buffer->cap;
    while (next < required) {
        if (next > SIZE_MAX / 2) {
            next = required;
            break;
        }
        next *= 2;
    }
    uint8_t *data = (uint8_t *)realloc(buffer->data, next);
    if (data == NULL) {
        return -1;
    }
    buffer->data = data;
    buffer->cap = next;
    return 0;
}

static int buffer_append(OliphauntByteBuffer *buffer, const void *data, size_t len) {
    if (len == 0) {
        return 0;
    }
    if (buffer_reserve(buffer, len) != 0) {
        return -1;
    }
    memcpy(buffer->data + buffer->len, data, len);
    buffer->len += len;
    return 0;
}

static int buffer_append_zeros(OliphauntByteBuffer *buffer, size_t len) {
    static const uint8_t zeros[512] = {0};
    while (len > 0) {
        size_t take = len < sizeof(zeros) ? len : sizeof(zeros);
        if (buffer_append(buffer, zeros, take) != 0) {
            return -1;
        }
        len -= take;
    }
    return 0;
}

static int reserve_tar_entry(OliphauntByteBuffer *archive, OliphauntHandle *handle, size_t payload_size) {
    size_t padding = (512 - (payload_size % 512)) % 512;
    if (payload_size > SIZE_MAX - 512 || payload_size + 512 > SIZE_MAX - padding) {
        set_error(handle, "physical backup tar entry size overflows");
        return -1;
    }
    if (buffer_reserve(archive, 512 + payload_size + padding) != 0) {
        set_error(handle, "out of memory reserving physical backup tar entry");
        return -1;
    }
    return 0;
}

static int compare_string_ptrs(const void *left, const void *right) {
    const char *const *a = (const char *const *)left;
    const char *const *b = (const char *const *)right;
    return strcmp(*a, *b);
}

static bool is_platform_separator(char value) {
    return value == '/'
#ifdef _WIN32
           || value == '\\'
#endif
        ;
}

static int sorted_dir_names(OliphauntHandle *handle, const char *path, char ***out, size_t *out_count) {
    *out = NULL;
    *out_count = 0;
#ifdef _WIN32
    char *pattern = oliphaunt_join_path(path, "*");
    if (pattern == NULL) {
        set_error(handle, "out of memory preparing backup directory scan");
        return -1;
    }
    WIN32_FIND_DATAA data;
    HANDLE find = FindFirstFileA(pattern, &data);
    free(pattern);
    if (find == INVALID_HANDLE_VALUE) {
        char message[1024];
        snprintf(message, sizeof(message), "read directory %s for backup: Windows error %lu", path, GetLastError());
        set_error(handle, message);
        return -1;
    }
    char **items = NULL;
    size_t len = 0;
    size_t cap = 0;
    do {
        if (strcmp(data.cFileName, ".") == 0 || strcmp(data.cFileName, "..") == 0) {
            continue;
        }
        if (len == cap) {
            size_t next = cap == 0 ? 16 : cap * 2;
            char **grown = (char **)realloc(items, next * sizeof(char *));
            if (grown == NULL) {
                FindClose(find);
                for (size_t i = 0; i < len; i++) {
                    free(items[i]);
                }
                free(items);
                set_error(handle, "out of memory sorting backup directory entries");
                return -1;
            }
            items = grown;
            cap = next;
        }
        items[len] = strdup(data.cFileName);
        if (items[len] == NULL) {
            FindClose(find);
            for (size_t i = 0; i < len; i++) {
                free(items[i]);
            }
            free(items);
            set_error(handle, "out of memory copying backup directory entry");
            return -1;
        }
        len++;
    } while (FindNextFileA(find, &data));
    DWORD error = GetLastError();
    FindClose(find);
    if (error != ERROR_NO_MORE_FILES) {
        for (size_t i = 0; i < len; i++) {
            free(items[i]);
        }
        free(items);
        char message[1024];
        snprintf(message, sizeof(message), "read directory %s for backup: Windows error %lu", path, error);
        set_error(handle, message);
        return -1;
    }
    qsort(items, len, sizeof(char *), compare_string_ptrs);
    *out = items;
    *out_count = len;
    return 0;
#else
    DIR *dir = opendir(path);
    if (dir == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "read directory %s for backup: %s", path, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    char **items = NULL;
    size_t len = 0;
    size_t cap = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        if (len == cap) {
            size_t next = cap == 0 ? 16 : cap * 2;
            char **grown = (char **)realloc(items, next * sizeof(char *));
            if (grown == NULL) {
                closedir(dir);
                for (size_t i = 0; i < len; i++) {
                    free(items[i]);
                }
                free(items);
                set_error(handle, "out of memory sorting backup directory entries");
                return -1;
            }
            items = grown;
            cap = next;
        }
        items[len] = strdup(entry->d_name);
        if (items[len] == NULL) {
            closedir(dir);
            for (size_t i = 0; i < len; i++) {
                free(items[i]);
            }
            free(items);
            set_error(handle, "out of memory copying backup directory entry");
            return -1;
        }
        len++;
    }
    closedir(dir);
    qsort(items, len, sizeof(char *), compare_string_ptrs);
    *out = items;
    *out_count = len;
    return 0;
#endif
}

static void free_string_list(char **items, size_t len) {
    for (size_t i = 0; i < len; i++) {
        free(items[i]);
    }
    free(items);
}

static int string_list_contains(char **items, size_t len, const char *value) {
    for (size_t i = 0; i < len; i++) {
        if (strcmp(items[i], value) == 0) {
            return 1;
        }
    }
    return 0;
}

static int has_component(const char *path, const char *component) {
    size_t component_len = strlen(component);
    const char *p = path;
    while (*p != '\0') {
        while (is_platform_separator(*p)) {
            p++;
        }
        const char *start = p;
        while (*p != '\0' && !is_platform_separator(*p)) {
            p++;
        }
        if ((size_t)(p - start) == component_len && strncmp(start, component, component_len) == 0) {
            return 1;
        }
    }
    return 0;
}

static int validate_relative_archive_path(const char *path, bool require_pgdata_prefix) {
    if (path == NULL || path[0] == '\0' || is_platform_separator(path[0]) || has_component(path, "..")) {
        return -1;
    }
    if (!require_pgdata_prefix) {
        return 0;
    }
    if (strcmp(path, "pgdata") == 0 || strncmp(path, "pgdata/", 7) == 0) {
        return 0;
    }
    if (strcmp(path, "manifest.properties") == 0 ||
        strcmp(path, ".oliphaunt/backup-manifest.properties") == 0) {
        return 0;
    }
    return -1;
}

static char *canonical_relative_archive_path(OliphauntHandle *handle, const char *path, bool require_pgdata_prefix) {
    if (path == NULL || path[0] == '\0' || is_platform_separator(path[0])) {
        set_error(handle, "physical archive entry is unsafe or outside pgdata");
        return NULL;
    }

    size_t input_len = strlen(path);
    char *out = (char *)malloc(input_len + 1);
    if (out == NULL) {
        set_error(handle, "out of memory canonicalizing archive path");
        return NULL;
    }
    size_t out_len = 0;
    size_t component_count = 0;
    const char *p = path;
    while (*p != '\0') {
        while (is_platform_separator(*p)) {
            p++;
        }
        const char *start = p;
        while (*p != '\0' && !is_platform_separator(*p)) {
            p++;
        }
        size_t len = (size_t)(p - start);
        if (len == 0 || (len == 1 && start[0] == '.')) {
            continue;
        }
        if (len == 2 && start[0] == '.' && start[1] == '.') {
            free(out);
            set_error(handle, "physical archive entry is unsafe or outside pgdata");
            return NULL;
        }
        if (component_count == 0 && require_pgdata_prefix &&
            !(len == 6 && memcmp(start, "pgdata", 6) == 0) &&
            !(len == 19 && memcmp(start, "manifest.properties", 19) == 0) &&
            !(len == 10 && memcmp(start, ".oliphaunt", 10) == 0)) {
            free(out);
            set_error(handle, "physical archive entry is unsafe or outside pgdata");
            return NULL;
        }
        if (out_len > 0) {
            out[out_len++] = '/';
        }
        memcpy(out + out_len, start, len);
        out_len += len;
        component_count++;
    }
    if (component_count == 0) {
        free(out);
        set_error(handle, "physical archive entry is unsafe or outside pgdata");
        return NULL;
    }
    out[out_len] = '\0';
    if (require_pgdata_prefix && validate_relative_archive_path(out, true) != 0) {
        free(out);
        set_error(handle, "physical archive entry is unsafe or outside pgdata");
        return NULL;
    }
    return out;
}

static int remember_archive_path(OliphauntHandle *handle, char ***paths, size_t *count, size_t *cap, const char *path) {
    for (size_t i = 0; i < *count; i++) {
        if (strcmp((*paths)[i], path) == 0) {
            char message[1024];
            snprintf(message, sizeof(message), "physical archive contains duplicate entry %s", path);
            set_error(handle, message);
            return -1;
        }
    }
    if (*count == *cap) {
        size_t next = *cap == 0 ? 32 : *cap * 2;
        char **grown = (char **)realloc(*paths, next * sizeof(char *));
        if (grown == NULL) {
            set_error(handle, "out of memory tracking physical archive paths");
            return -1;
        }
        *paths = grown;
        *cap = next;
    }
    (*paths)[*count] = strdup(path);
    if ((*paths)[*count] == NULL) {
        set_error(handle, "out of memory tracking physical archive path");
        return -1;
    }
    (*count)++;
    return 0;
}

static int remember_archive_string_if_absent(
    OliphauntHandle *handle,
    char ***paths,
    size_t *count,
    size_t *cap,
    const char *path,
    size_t path_len,
    const char *oom_message) {
    for (size_t i = 0; i < *count; i++) {
        if (strlen((*paths)[i]) == path_len && strncmp((*paths)[i], path, path_len) == 0) {
            return 0;
        }
    }
    if (*count == *cap) {
        size_t next = *cap == 0 ? 32 : *cap * 2;
        char **grown = (char **)realloc(*paths, next * sizeof(char *));
        if (grown == NULL) {
            set_error(handle, oom_message);
            return -1;
        }
        *paths = grown;
        *cap = next;
    }
    char *copy = (char *)malloc(path_len + 1);
    if (copy == NULL) {
        set_error(handle, oom_message);
        return -1;
    }
    memcpy(copy, path, path_len);
    copy[path_len] = '\0';
    (*paths)[*count] = copy;
    (*count)++;
    return 0;
}

static const char *archive_file_ancestor(char **file_paths, size_t file_count, const char *path) {
    for (size_t i = 0; i < file_count; i++) {
        size_t len = strlen(file_paths[i]);
        if (strncmp(path, file_paths[i], len) == 0 && path[len] == '/') {
            return file_paths[i];
        }
    }
    return NULL;
}

static int remember_archive_ancestors(
    OliphauntHandle *handle,
    char ***ancestors,
    size_t *count,
    size_t *cap,
    const char *path) {
    for (const char *slash = strchr(path, '/'); slash != NULL; slash = strchr(slash + 1, '/')) {
        if (remember_archive_string_if_absent(
                handle,
                ancestors,
                count,
                cap,
                path,
                (size_t)(slash - path),
                "out of memory tracking physical archive ancestors") != 0) {
            return -1;
        }
    }
    return 0;
}

static int tar_set_name(uint8_t *header, const char *path) {
    size_t len = strlen(path);
    if (len <= 100) {
        memcpy(header, path, len);
        return 0;
    }
    const char *split = path + len;
    while (split > path) {
        split--;
        if (*split != '/') {
            continue;
        }
        size_t prefix_len = (size_t)(split - path);
        size_t name_len = len - prefix_len - 1;
        if (prefix_len <= 155 && name_len <= 100) {
            memcpy(header, split + 1, name_len);
            memcpy(header + 345, path, prefix_len);
            return 0;
        }
    }
    return -1;
}

static void tar_write_octal(uint8_t *field, size_t width, unsigned long long value) {
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

static int tar_append_header(
    OliphauntByteBuffer *archive,
    OliphauntHandle *handle,
    const char *archive_path,
    char typeflag,
    size_t size,
    mode_t mode,
    uid_t uid,
    gid_t gid,
    time_t mtime,
    const char *link_name) {
    if (validate_relative_archive_path(archive_path, false) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "refusing to archive unsafe path %s", archive_path);
        set_error(handle, message);
        return -1;
    }

    char path_with_slash[512];
    const char *path_for_header = archive_path;
    if (typeflag == '5') {
        size_t len = strlen(archive_path);
        if (len + 1 >= sizeof(path_with_slash)) {
            set_error(handle, "backup directory path is too long for ustar header");
            return -1;
        }
        memcpy(path_with_slash, archive_path, len);
        if (len == 0 || archive_path[len - 1] != '/') {
            path_with_slash[len++] = '/';
        }
        path_with_slash[len] = '\0';
        path_for_header = path_with_slash;
    }

    uint8_t header[512];
    memset(header, 0, sizeof(header));
    if (tar_set_name(header, path_for_header) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "backup path %s is too long for ustar header", path_for_header);
        set_error(handle, message);
        return -1;
    }
    tar_write_octal(header + 100, 8, (unsigned long long)(mode & 07777));
    tar_write_octal(header + 108, 8, (unsigned long long)uid);
    tar_write_octal(header + 116, 8, (unsigned long long)gid);
    tar_write_octal(header + 124, 12, (unsigned long long)size);
    tar_write_octal(header + 136, 12, (unsigned long long)(mtime < 0 ? 0 : mtime));
    memset(header + 148, ' ', 8);
    header[156] = (uint8_t)typeflag;
    if (link_name != NULL && link_name[0] != '\0') {
        size_t link_len = strlen(link_name);
        if (link_len > 100 || validate_relative_archive_path(link_name, false) != 0) {
            set_error(handle, "backup symlink target is unsafe or too long for ustar header");
            return -1;
        }
        memcpy(header + 157, link_name, link_len);
    }
    memcpy(header + 257, "ustar", 5);
    memcpy(header + 263, "00", 2);

    unsigned int checksum = 0;
    for (size_t i = 0; i < sizeof(header); i++) {
        checksum += header[i];
    }
    snprintf((char *)header + 148, 8, "%06o", checksum);
    header[154] = '\0';
    header[155] = ' ';
    if (buffer_append(archive, header, sizeof(header)) != 0) {
        set_error(handle, "out of memory appending tar header");
        return -1;
    }
    return 0;
}

static int tar_append_file_contents(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *source, size_t size) {
    int fd = open(source, O_RDONLY | O_CLOEXEC | O_BINARY);
    if (fd < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "open %s for physical backup: %s", source, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    uint8_t chunk[64 * 1024];
    size_t remaining = size;
    while (remaining > 0) {
        size_t take = remaining < sizeof(chunk) ? remaining : sizeof(chunk);
        ssize_t read_count;
        do {
            read_count = read(fd, chunk, take);
        } while (read_count < 0 && errno == EINTR);
        if (read_count < 0) {
            char message[1024];
            snprintf(message, sizeof(message), "read %s for physical backup: %s", source, strerror(errno));
            close(fd);
            set_error(handle, message);
            return -1;
        }
        if (read_count == 0) {
            char message[1024];
            snprintf(message, sizeof(message), "short read %s for physical backup", source);
            close(fd);
            set_error(handle, message);
            return -1;
        }
        if (buffer_append(archive, chunk, (size_t)read_count) != 0) {
            close(fd);
            set_error(handle, "out of memory appending tar file contents");
            return -1;
        }
        remaining -= (size_t)read_count;
    }
    close(fd);
    size_t padding = (512 - (size % 512)) % 512;
    if (buffer_append_zeros(archive, padding) != 0) {
        set_error(handle, "out of memory appending tar file padding");
        return -1;
    }
    return 0;
}

static int tar_append_file(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *source, const char *archive_path, const struct stat *st) {
    if (reserve_tar_entry(archive, handle, (size_t)st->st_size) != 0) {
        return -1;
    }
    if (tar_append_header(
            archive,
            handle,
            archive_path,
            '0',
            (size_t)st->st_size,
            st->st_mode,
            st->st_uid,
            st->st_gid,
            st->st_mtime,
            NULL) != 0) {
        return -1;
    }
    return tar_append_file_contents(archive, handle, source, (size_t)st->st_size);
}

static int tar_append_directory(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *archive_path, const struct stat *st) {
    if (reserve_tar_entry(archive, handle, 0) != 0) {
        return -1;
    }
    return tar_append_header(
        archive,
        handle,
        archive_path,
        '5',
        0,
        st->st_mode,
        st->st_uid,
        st->st_gid,
        st->st_mtime,
        NULL);
}

static int should_skip_pgdata_entry(const char *relative, bool include_wal_contents) {
    if (strcmp(relative, "postmaster.pid") == 0 || strcmp(relative, "postmaster.opts") == 0) {
        return 1;
    }
    if (strcmp(relative, ".oliphaunt.lock") == 0) {
        return 1;
    }
    const char *name = strrchr(relative, '/');
    name = name == NULL ? relative : name + 1;
    if (strcmp(name, "pg_internal.init") == 0 || strncmp(name, "pgsql_tmp", 9) == 0) {
        return 1;
    }
    const char *slash = strchr(relative, '/');
    if (slash == NULL) {
        return 0;
    }
    size_t first_len = (size_t)(slash - relative);
    static const char *transient[] = {
        "pg_dynshmem",
        "pg_notify",
        "pg_serial",
        "pg_snapshots",
        "pg_stat_tmp",
        "pg_subtrans",
    };
    for (size_t i = 0; i < sizeof(transient) / sizeof(transient[0]); i++) {
        if (strlen(transient[i]) == first_len && strncmp(relative, transient[i], first_len) == 0) {
            return 1;
        }
    }
    return first_len == 6 && strncmp(relative, "pg_wal", 6) == 0 && !include_wal_contents;
}

static int append_pgdata_entry(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *pgdata, const char *relative, bool include_wal_contents);

static int append_children(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *pgdata, const char *relative_dir, bool include_wal_contents) {
    char *source_dir = relative_dir[0] == '\0' ? strdup(pgdata) : oliphaunt_join_path(pgdata, relative_dir);
    if (source_dir == NULL) {
        set_error(handle, "out of memory building backup source path");
        return -1;
    }
    char **names = NULL;
    size_t count = 0;
    if (sorted_dir_names(handle, source_dir, &names, &count) != 0) {
        free(source_dir);
        return -1;
    }
    for (size_t i = 0; i < count; i++) {
        char *child_relative = relative_dir[0] == '\0' ? strdup(names[i]) : oliphaunt_join_path(relative_dir, names[i]);
        if (child_relative == NULL) {
            free_string_list(names, count);
            free(source_dir);
            set_error(handle, "out of memory building backup relative path");
            return -1;
        }
        int rc = append_pgdata_entry(archive, handle, pgdata, child_relative, include_wal_contents);
        free(child_relative);
        if (rc != 0) {
            free_string_list(names, count);
            free(source_dir);
            return -1;
        }
    }
    free_string_list(names, count);
    free(source_dir);
    return 0;
}

static int append_pgdata_entry(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *pgdata, const char *relative, bool include_wal_contents) {
    if (should_skip_pgdata_entry(relative, include_wal_contents)) {
        return 0;
    }
    char *source = oliphaunt_join_path(pgdata, relative);
    char *archive_path = oliphaunt_join_path("pgdata", relative);
    if (source == NULL || archive_path == NULL) {
        free(source);
        free(archive_path);
        set_error(handle, "out of memory building backup archive path");
        return -1;
    }
    struct stat st;
    if (lstat(source, &st) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "stat %s for physical backup: %s", source, strerror(errno));
        free(source);
        free(archive_path);
        set_error(handle, message);
        return -1;
    }
    int rc = 0;
    if (S_ISDIR(st.st_mode)) {
        rc = tar_append_directory(archive, handle, archive_path, &st);
        if (rc == 0) {
            rc = append_children(archive, handle, pgdata, relative, include_wal_contents);
        }
    } else if (S_ISREG(st.st_mode)) {
        rc = tar_append_file(archive, handle, source, archive_path, &st);
    } else if (S_ISLNK(st.st_mode)) {
        char message[1024];
        snprintf(message, sizeof(message),
                 "physical archive does not support symlinked PGDATA entry %s; external tablespaces and linked WAL directories are not portable in liboliphaunt archives",
                 archive_path);
        set_error(handle, message);
        rc = -1;
    } else {
        char message[1024];
        snprintf(message, sizeof(message),
                 "physical archive does not support non-regular PGDATA entry %s; liboliphaunt archives only support regular files and directories",
                 archive_path);
        set_error(handle, message);
        rc = -1;
    }
    free(source);
    free(archive_path);
    return rc;
}

int oliphaunt_archive_append_pgdata_tree(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *pgdata) {
    struct stat st;
    if (lstat(pgdata, &st) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "stat PGDATA %s for physical backup: %s", pgdata, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    if (!S_ISDIR(st.st_mode)) {
        char message[1024];
        snprintf(message, sizeof(message), "physical backup PGDATA %s is not a directory", pgdata);
        set_error(handle, message);
        return -1;
    }
    if (tar_append_directory(archive, handle, "pgdata", &st) != 0) {
        return -1;
    }
    return append_children(archive, handle, pgdata, "", false);
}

int oliphaunt_archive_append_pg_wal_tree(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *pgdata) {
    char *pg_wal = oliphaunt_join_path(pgdata, "pg_wal");
    if (pg_wal == NULL) {
        set_error(handle, "out of memory building pg_wal path");
        return -1;
    }
    struct stat st;
    if (lstat(pg_wal, &st) != 0 || !S_ISDIR(st.st_mode)) {
        free(pg_wal);
        return 0;
    }
    free(pg_wal);
    return append_children(archive, handle, pgdata, "pg_wal", true);
}

int oliphaunt_archive_append_generated_file(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *archive_path, const char *contents) {
    size_t len = contents == NULL ? 0 : strlen(contents);
    return oliphaunt_archive_append_generated_bytes(
        archive,
        handle,
        archive_path,
        (const uint8_t *)contents,
        len,
        0600);
}

int oliphaunt_archive_append_generated_bytes(
    OliphauntByteBuffer *archive,
    OliphauntHandle *handle,
    const char *archive_path,
    const uint8_t *contents,
    size_t len,
    uint32_t mode) {
    if (len > 0 && contents == NULL) {
        set_error(handle, "generated backup file has bytes but no data pointer");
        return -1;
    }
    mode_t file_mode = mode == 0 ? 0600 : (mode_t)(mode & 0777u);
    if (reserve_tar_entry(archive, handle, len) != 0) {
        return -1;
    }
    if (tar_append_header(archive, handle, archive_path, '0', len, file_mode, 0, 0, time(NULL), NULL) != 0) {
        return -1;
    }
    if (buffer_append(archive, contents, len) != 0 ||
        buffer_append_zeros(archive, (512 - (len % 512)) % 512) != 0) {
        set_error(handle, "out of memory appending generated backup file");
        return -1;
    }
    return 0;
}

int oliphaunt_archive_finish(OliphauntByteBuffer *archive, OliphauntHandle *handle) {
    if (buffer_append_zeros(archive, 1024) != 0) {
        set_error(handle, "out of memory finishing physical backup archive");
        return -1;
    }
    return 0;
}

static int parse_tar_octal(const uint8_t *field, size_t len, unsigned long long *out) {
    unsigned long long value = 0;
    int saw_digit = 0;
    size_t index = 0;
    while (index < len && (field[index] == ' ' || field[index] == '\0')) {
        index++;
    }
    for (; index < len; index++) {
        if (field[index] >= '0' && field[index] <= '7') {
            unsigned long long digit = (unsigned long long)(field[index] - '0');
            if (value > (ULLONG_MAX - digit) / 8) {
                return -1;
            }
            saw_digit = 1;
            value = (value << 3) + digit;
            continue;
        }
        if (field[index] == ' ' || field[index] == '\0') {
            for (index++; index < len; index++) {
                if (field[index] != ' ' && field[index] != '\0') {
                    return -1;
                }
            }
            break;
        }
        return -1;
    }
    if (!saw_digit) {
        return -1;
    }
    *out = value;
    return 0;
}

static unsigned int tar_header_checksum(const uint8_t *header) {
    unsigned int checksum = 0;
    for (size_t i = 0; i < 512; i++) {
        checksum += (i >= 148 && i < 156) ? (unsigned int)' ' : (unsigned int)header[i];
    }
    return checksum;
}

static int parse_tar_octal_field(
    OliphauntHandle *handle,
    const uint8_t *field,
    size_t len,
    const char *label,
    int allow_empty,
    unsigned long long *out) {
    if (parse_tar_octal(field, len, out) == 0) {
        return 0;
    }
    int empty = 1;
    for (size_t i = 0; i < len; i++) {
        if (field[i] != ' ' && field[i] != '\0') {
            empty = 0;
            break;
        }
    }
    if (empty && allow_empty) {
        *out = 0;
        return 0;
    }
    char message[128];
    snprintf(message, sizeof(message), "physical archive entry has invalid tar %s field", label);
    set_error(handle, message);
    return -1;
}

static int validate_tar_header_checksum(OliphauntHandle *handle, const uint8_t *header) {
    unsigned long long stored = 0;
    if (parse_tar_octal_field(handle, header + 148, 8, "checksum", 0, &stored) != 0) {
        return -1;
    }
    if (stored != (unsigned long long)tar_header_checksum(header)) {
        set_error(handle, "physical archive entry has invalid tar checksum");
        return -1;
    }
    return 0;
}

static int validate_tar_numeric_metadata(OliphauntHandle *handle, const uint8_t *header, unsigned long long *size, unsigned long long *mode) {
    unsigned long long ignored = 0;
    if (parse_tar_octal_field(handle, header + 100, 8, "mode", 0, mode) != 0 ||
        parse_tar_octal_field(handle, header + 108, 8, "uid", 1, &ignored) != 0 ||
        parse_tar_octal_field(handle, header + 116, 8, "gid", 1, &ignored) != 0 ||
        parse_tar_octal_field(handle, header + 124, 12, "size", 0, size) != 0 ||
        parse_tar_octal_field(handle, header + 136, 12, "mtime", 1, &ignored) != 0) {
        return -1;
    }
    return 0;
}

static int validate_tar_string_field(OliphauntHandle *handle, const uint8_t *field, size_t len, const char *label, int allow_empty) {
    size_t index = 0;
    while (index < len && field[index] != '\0') {
        index++;
    }
    if (index == 0 && !allow_empty) {
        char message[128];
        snprintf(message, sizeof(message), "physical archive entry has invalid tar %s field", label);
        set_error(handle, message);
        return -1;
    }
    if (index == len) {
        return 0;
    }
    for (index++; index < len; index++) {
        if (field[index] != '\0') {
            char message[128];
            snprintf(message, sizeof(message), "physical archive entry has invalid tar %s field", label);
            set_error(handle, message);
            return -1;
        }
    }
    return 0;
}

static int validate_tar_string_metadata(OliphauntHandle *handle, const uint8_t *header) {
    if (validate_tar_string_field(handle, header, 100, "name", 0) != 0 ||
        validate_tar_string_field(handle, header + 157, 100, "linkname", 1) != 0 ||
        validate_tar_string_field(handle, header + 345, 155, "prefix", 1) != 0) {
        return -1;
    }
    return 0;
}

static int tar_header_format_is_supported(const uint8_t *header) {
    if (memcmp(header + 257, "ustar\0", 6) == 0 &&
        memcmp(header + 263, "00", 2) == 0) {
        return 1;
    }
    if (memcmp(header + 257, "ustar ", 6) == 0 &&
        memcmp(header + 263, " \0", 2) == 0) {
        return 1;
    }
    return 0;
}

static int tar_block_is_zero(const uint8_t *block) {
    for (size_t i = 0; i < 512; i++) {
        if (block[i] != 0) {
            return 0;
        }
    }
    return 1;
}

static char *tar_entry_name(const uint8_t *header) {
    char name[101];
    char prefix[156];
    memcpy(name, header, 100);
    name[100] = '\0';
    memcpy(prefix, header + 345, 155);
    prefix[155] = '\0';
    size_t name_len = strnlen(name, sizeof(name));
    size_t prefix_len = strnlen(prefix, sizeof(prefix));
    if (name_len == 0) {
        return NULL;
    }
    if (prefix_len == 0) {
        return strdup(name);
    }
    char *out = (char *)malloc(prefix_len + 1 + name_len + 1);
    if (out == NULL) {
        return NULL;
    }
    memcpy(out, prefix, prefix_len);
    out[prefix_len] = '/';
    memcpy(out + prefix_len + 1, name, name_len);
    out[prefix_len + 1 + name_len] = '\0';
    return out;
}

static char *tar_link_name(const uint8_t *header) {
    char link[101];
    memcpy(link, header + 157, 100);
    link[100] = '\0';
    size_t len = strnlen(link, sizeof(link));
    if (len == 0) {
        return NULL;
    }
    return strdup(link);
}

static int ensure_parent_dir_for_path(OliphauntHandle *handle, const char *path) {
    char *parent = oliphaunt_path_parent_dup(path);
    if (parent == NULL) {
        set_error(handle, "out of memory resolving restore parent directory");
        return -1;
    }
    int rc = oliphaunt_mkdir_p(parent, 0700);
    if (rc != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "create restore parent directory %s: %s", parent, strerror(errno));
        set_error(handle, message);
    }
    free(parent);
    return rc;
}

static int unpack_tar_file(OliphauntHandle *handle, const char *path, const uint8_t *data, size_t len, mode_t mode) {
    if (ensure_parent_dir_for_path(handle, path) != 0) {
        return -1;
    }
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_BINARY, mode & 07777);
    if (fd < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "create restored file %s: %s", path, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    size_t off = 0;
    while (off < len) {
        ssize_t written = write(fd, data + off, len - off);
        if (written < 0) {
            char message[1024];
            snprintf(message, sizeof(message), "write restored file %s: %s", path, strerror(errno));
            close(fd);
            set_error(handle, message);
            return -1;
        }
        off += (size_t)written;
    }
    (void)fchmod(fd, mode & 07777);
    close(fd);
    return 0;
}

static int process_physical_archive(OliphauntHandle *handle, const uint8_t *data, size_t len, const char *staging_root, bool write_entries) {
    if (len < 1024 || (len % 512) != 0) {
        set_error(handle, "physical archive has invalid tar block framing");
        return -1;
    }
    if (!tar_block_is_zero(data + len - 1024) || !tar_block_is_zero(data + len - 512)) {
        set_error(handle, "physical archive ended before final tar zero block");
        return -1;
    }

    char **seen_paths = NULL;
    size_t seen_count = 0;
    size_t seen_cap = 0;
    char **file_paths = NULL;
    size_t file_count = 0;
    size_t file_cap = 0;
    char **entry_ancestors = NULL;
    size_t ancestor_count = 0;
    size_t ancestor_cap = 0;
    char *name = NULL;
    char *canonical_name = NULL;
    char *dest = NULL;
    char *link = NULL;
    int result = -1;
    size_t off = 0;
    while (off + 512 <= len) {
        const uint8_t *header = data + off;
        off += 512;
        if (tar_block_is_zero(header)) {
            if (off + 512 > len) {
                set_error(handle, "physical archive ended before final tar zero block");
                goto cleanup;
            }
            if (!tar_block_is_zero(data + off)) {
                set_error(handle, "physical archive has trailing data after tar terminator");
                goto cleanup;
            }
            off += 512;
            while (off < len) {
                if (!tar_block_is_zero(data + off)) {
                    set_error(handle, "physical archive has trailing data after tar terminator");
                    goto cleanup;
                }
                off += 512;
            }
            result = 0;
            goto cleanup;
        }
        if (validate_tar_header_checksum(handle, header) != 0) {
            goto cleanup;
        }
        if (!tar_header_format_is_supported(header)) {
            set_error(handle, "physical archive entry has unsupported tar header format");
            goto cleanup;
        }
        if (validate_tar_string_metadata(handle, header) != 0) {
            goto cleanup;
        }
        unsigned long long size = 0;
        unsigned long long mode = 0;
        if (validate_tar_numeric_metadata(handle, header, &size, &mode) != 0) {
            goto cleanup;
        }
        name = tar_entry_name(header);
        if (name == NULL) {
            set_error(handle, "physical archive contains an empty path");
            goto cleanup;
        }
        canonical_name = canonical_relative_archive_path(handle, name, true);
        if (canonical_name == NULL) {
            goto cleanup;
        }
        if (remember_archive_path(handle, &seen_paths, &seen_count, &seen_cap, canonical_name) != 0) {
            goto cleanup;
        }
        if (size > SIZE_MAX || (size_t)size > len - off) {
            set_error(handle, "physical archive entry is truncated");
            goto cleanup;
        }
        if ((size_t)size > SIZE_MAX - 511) {
            set_error(handle, "physical archive entry size overflows");
            goto cleanup;
        }
        size_t padded = ((size_t)size + 511) & ~(size_t)511;
        if (padded > len - off) {
            set_error(handle, "physical archive entry padding is truncated");
            goto cleanup;
        }
        char type = header[156] == '\0' ? '0' : (char)header[156];
        if (type != '0' && type != '5') {
            char message[1024];
            snprintf(message, sizeof(message),
                     "physical archive entry %s has unsupported tar entry type '%c'; liboliphaunt physical archives only support regular files and directories",
                     canonical_name,
                     type >= 32 && type <= 126 ? type : '?');
            set_error(handle, message);
            goto cleanup;
        }
        link = tar_link_name(header);
        if (link != NULL) {
            char message[1024];
            snprintf(message, sizeof(message),
                     "physical archive entry %s has an unexpected link target; liboliphaunt physical archives must contain concrete root files",
                     canonical_name);
            set_error(handle, message);
            goto cleanup;
        }
        if (type == '5') {
            if (size != 0) {
                char message[1024];
                snprintf(message, sizeof(message), "physical archive directory entry %s has non-zero size", canonical_name);
                set_error(handle, message);
                goto cleanup;
            }
        }
        const char *ancestor = archive_file_ancestor(file_paths, file_count, canonical_name);
        if (ancestor != NULL) {
            char message[1024];
            snprintf(message, sizeof(message),
                     "physical archive entry %s is nested under file entry %s",
                     canonical_name,
                     ancestor);
            set_error(handle, message);
            goto cleanup;
        }
        if (type != '5') {
            if (string_list_contains(entry_ancestors, ancestor_count, canonical_name)) {
                char message[1024];
                snprintf(message, sizeof(message),
                         "physical archive file entry %s conflicts with existing child entries",
                         canonical_name);
                set_error(handle, message);
                goto cleanup;
            }
            if (remember_archive_string_if_absent(
                    handle,
                    &file_paths,
                    &file_count,
                    &file_cap,
                    canonical_name,
                    strlen(canonical_name),
                    "out of memory tracking physical archive file paths") != 0) {
                goto cleanup;
            }
        }
        if (remember_archive_ancestors(handle, &entry_ancestors, &ancestor_count, &ancestor_cap, canonical_name) != 0) {
            goto cleanup;
        }
        if (write_entries) {
            dest = oliphaunt_join_path(staging_root, canonical_name);
            if (dest == NULL) {
                set_error(handle, "out of memory resolving restore destination");
                goto cleanup;
            }
            int rc = 0;
            if (type == '5') {
                rc = oliphaunt_mkdir_p(dest, (mode_t)(mode == 0 ? 0700 : mode));
                if (rc != 0) {
                    char message[1024];
                    snprintf(message, sizeof(message), "create restored directory %s: %s", dest, strerror(errno));
                    set_error(handle, message);
                }
            } else {
                rc = unpack_tar_file(handle, dest, data + off, (size_t)size, (mode_t)(mode == 0 ? 0600 : mode));
            }
            free(dest);
            dest = NULL;
            if (rc != 0) {
                goto cleanup;
            }
        }
        free(canonical_name);
        canonical_name = NULL;
        free(name);
        name = NULL;
        off += padded;
    }
    set_error(handle, "physical archive ended before final tar zero block");
cleanup:
    free(link);
    free(dest);
    free(canonical_name);
    free(name);
    free_string_list(seen_paths, seen_count);
    free_string_list(file_paths, file_count);
    free_string_list(entry_ancestors, ancestor_count);
    return result;
}

int oliphaunt_unpack_physical_archive(OliphauntHandle *handle, const uint8_t *data, size_t len, const char *staging_root) {
    if (process_physical_archive(handle, data, len, NULL, false) != 0) {
        return -1;
    }
    return process_physical_archive(handle, data, len, staging_root, true);
}
