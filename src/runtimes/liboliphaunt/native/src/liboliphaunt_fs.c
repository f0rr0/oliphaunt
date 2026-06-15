#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "liboliphaunt_internal.h"

#ifndef _WIN32
#include <dirent.h>
#endif
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef _WIN32
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

typedef struct OliphauntSha256Ctx {
    uint32_t state[8];
    uint64_t bitcount;
    uint8_t buffer[64];
} OliphauntSha256Ctx;

extern void pg_sha256_init(OliphauntSha256Ctx *ctx);
extern void pg_sha256_update(OliphauntSha256Ctx *ctx, const uint8_t *data, size_t len);
extern void pg_sha256_final(OliphauntSha256Ctx *ctx, uint8_t *dest);

static bool oliphaunt_is_path_separator(char value) {
    return value == '/'
#ifdef _WIN32
           || value == '\\'
#endif
        ;
}

int oliphaunt_path_exists(const char *path) {
    struct stat st;
    return path != NULL && stat(path, &st) == 0;
}

char *oliphaunt_join_path(const char *left, const char *right) {
    if (left == NULL || right == NULL) {
        return NULL;
    }
    size_t left_len = strlen(left);
    size_t right_len = strlen(right);
    bool needs_slash = left_len > 0 && !oliphaunt_is_path_separator(left[left_len - 1]);
    char *out = (char *)malloc(left_len + (needs_slash ? 1 : 0) + right_len + 1);
    if (out == NULL) {
        return NULL;
    }
    memcpy(out, left, left_len);
    size_t off = left_len;
    if (needs_slash) {
        out[off++] = '/';
    }
    memcpy(out + off, right, right_len + 1);
    return out;
}

char *oliphaunt_path_parent_dup(const char *path) {
    const char *slash = NULL;
    for (const char *cursor = path; cursor != NULL && *cursor != '\0'; cursor++) {
        if (oliphaunt_is_path_separator(*cursor)) {
            slash = cursor;
        }
    }
    if (slash == NULL) {
        return strdup(".");
    }
    if (slash == path) {
        return strdup("/");
    }
    size_t len = (size_t)(slash - path);
    char *out = (char *)malloc(len + 1);
    if (out == NULL) {
        return NULL;
    }
    memcpy(out, path, len);
    out[len] = '\0';
    return out;
}

char *oliphaunt_path_file_name_dup(const char *path) {
    const char *slash = NULL;
    for (const char *cursor = path; cursor != NULL && *cursor != '\0'; cursor++) {
        if (oliphaunt_is_path_separator(*cursor)) {
            slash = cursor;
        }
    }
    const char *name = slash == NULL ? path : slash + 1;
    return strdup(name[0] == '\0' ? "root" : name);
}

static char *oliphaunt_trim_trailing_slashes_dup(const char *path) {
    if (path == NULL) {
        return NULL;
    }
    size_t len = strlen(path);
    while (len > 1 && oliphaunt_is_path_separator(path[len - 1])) {
        len--;
    }
    if (len == 0) {
        return strdup(".");
    }
    char *out = (char *)malloc(len + 1);
    if (out == NULL) {
        return NULL;
    }
    memcpy(out, path, len);
    out[len] = '\0';
    return out;
}

static char *oliphaunt_canonicalish_path_dup(const char *path) {
    char *trimmed = oliphaunt_trim_trailing_slashes_dup(path);
    if (trimmed == NULL) {
        return NULL;
    }

    char *resolved = realpath(trimmed, NULL);
    if (resolved != NULL) {
        free(trimmed);
        return resolved;
    }

    char *parent = oliphaunt_path_parent_dup(trimmed);
    char *name = oliphaunt_path_file_name_dup(trimmed);
    free(trimmed);
    if (parent == NULL || name == NULL) {
        free(parent);
        free(name);
        return NULL;
    }

    char *canonical_parent = realpath(parent, NULL);
    if (canonical_parent == NULL && strcmp(parent, ".") != 0 && strcmp(parent, "/") != 0) {
        canonical_parent = oliphaunt_canonicalish_path_dup(parent);
    }
    if (canonical_parent == NULL) {
        char cwd[4096];
        if (getcwd(cwd, sizeof(cwd)) == NULL) {
            free(parent);
            free(name);
            return NULL;
        }
        canonical_parent = parent[0] == '/' ? strdup("/") : strdup(cwd);
    }
    free(parent);
    if (canonical_parent == NULL) {
        free(name);
        return NULL;
    }

    char *joined = oliphaunt_join_path(canonical_parent, name);
    free(canonical_parent);
    free(name);
    return joined;
}

static char *oliphaunt_mkdir_p_scan_start(char *path) {
#ifdef _WIN32
    if (path[0] != '\0' && path[1] == ':') {
        path += 2;
        if (oliphaunt_is_path_separator(*path)) {
            path++;
        }
        return path;
    }
    if (oliphaunt_is_path_separator(path[0]) && oliphaunt_is_path_separator(path[1])) {
        path += 2;
        while (*path != '\0' && !oliphaunt_is_path_separator(*path)) {
            path++;
        }
        if (oliphaunt_is_path_separator(*path)) {
            path++;
        }
        while (*path != '\0' && !oliphaunt_is_path_separator(*path)) {
            path++;
        }
        if (oliphaunt_is_path_separator(*path)) {
            path++;
        }
        return path;
    }
#endif
    return path + 1;
}

int oliphaunt_mkdir_p(const char *path, mode_t mode) {
    if (path == NULL || path[0] == '\0') {
        return -1;
    }
    char *copy = strdup(path);
    if (copy == NULL) {
        return -1;
    }
    size_t len = strlen(copy);
    while (len > 1 && oliphaunt_is_path_separator(copy[len - 1])) {
        copy[--len] = '\0';
    }

    struct stat existing;
    if (stat(copy, &existing) == 0) {
        if (S_ISDIR(existing.st_mode)) {
            free(copy);
            return 0;
        }
        free(copy);
        errno = ENOTDIR;
        return -1;
    }

    for (char *p = oliphaunt_mkdir_p_scan_start(copy); *p != '\0'; p++) {
        if (oliphaunt_is_path_separator(*p)) {
            char separator = *p;
            *p = '\0';
            if (mkdir(copy, mode) != 0 && errno != EEXIST) {
                free(copy);
                return -1;
            }
            *p = separator;
        }
    }
    int rc = mkdir(copy, mode);
    if (rc != 0 && errno == EEXIST) {
        rc = 0;
    }
    free(copy);
    return rc;
}

#ifdef _WIN32
static int oliphaunt_remove_tree_windows(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) {
        return errno == ENOENT ? 0 : -1;
    }
    if (S_ISDIR(st.st_mode)) {
        char *pattern = oliphaunt_join_path(path, "*");
        if (pattern == NULL) {
            errno = ENOMEM;
            return -1;
        }
        WIN32_FIND_DATAA data;
        HANDLE find = FindFirstFileA(pattern, &data);
        free(pattern);
        if (find == INVALID_HANDLE_VALUE) {
            DWORD error = GetLastError();
            if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) {
                errno = EACCES;
                return -1;
            }
        } else {
            do {
                if (strcmp(data.cFileName, ".") == 0 || strcmp(data.cFileName, "..") == 0) {
                    continue;
                }
                char *child = oliphaunt_join_path(path, data.cFileName);
                if (child == NULL) {
                    FindClose(find);
                    errno = ENOMEM;
                    return -1;
                }
                int rc = oliphaunt_remove_tree_windows(child);
                free(child);
                if (rc != 0) {
                    FindClose(find);
                    return -1;
                }
            } while (FindNextFileA(find, &data));
            DWORD error = GetLastError();
            FindClose(find);
            if (error != ERROR_NO_MORE_FILES) {
                errno = EACCES;
                return -1;
            }
        }
        return rmdir(path);
    }
    return unlink(path);
}

static int oliphaunt_directory_is_empty_windows(const char *path) {
    char *pattern = oliphaunt_join_path(path, "*");
    if (pattern == NULL) {
        errno = ENOMEM;
        return -1;
    }
    WIN32_FIND_DATAA data;
    HANDLE find = FindFirstFileA(pattern, &data);
    free(pattern);
    if (find == INVALID_HANDLE_VALUE) {
        return -1;
    }
    do {
        if (strcmp(data.cFileName, ".") != 0 && strcmp(data.cFileName, "..") != 0) {
            FindClose(find);
            return 0;
        }
    } while (FindNextFileA(find, &data));
    FindClose(find);
    return 1;
}
#endif

int oliphaunt_remove_tree(const char *path) {
#ifdef _WIN32
    return oliphaunt_remove_tree_windows(path);
#else
    struct stat st;
    if (lstat(path, &st) != 0) {
        return errno == ENOENT ? 0 : -1;
    }
    if (S_ISDIR(st.st_mode)) {
        DIR *dir = opendir(path);
        if (dir == NULL) {
            return -1;
        }
        struct dirent *entry;
        while ((entry = readdir(dir)) != NULL) {
            if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
                continue;
            }
            char *child = oliphaunt_join_path(path, entry->d_name);
            if (child == NULL) {
                closedir(dir);
                return -1;
            }
            int rc = oliphaunt_remove_tree(child);
            free(child);
            if (rc != 0) {
                closedir(dir);
                return -1;
            }
        }
        closedir(dir);
        return rmdir(path);
    }
    return unlink(path);
#endif
}

int oliphaunt_directory_is_empty(const char *path) {
#ifdef _WIN32
    return oliphaunt_directory_is_empty_windows(path);
#else
    DIR *dir = opendir(path);
    if (dir == NULL) {
        return -1;
    }
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
            closedir(dir);
            return 0;
        }
    }
    closedir(dir);
    return 1;
#endif
}

static char *oliphaunt_root_from_pgdata(const char *pgdata) {
    return oliphaunt_path_parent_dup(pgdata);
}

static void oliphaunt_stable_root_lock_suffix(const char *root_key, char out[33]) {
    uint8_t digest[32];
    static const char hex[] = "0123456789abcdef";
    OliphauntSha256Ctx ctx;
    pg_sha256_init(&ctx);
    pg_sha256_update(&ctx, (const uint8_t *)root_key, strlen(root_key));
    pg_sha256_final(&ctx, digest);
    for (size_t i = 0; i < 16; i++) {
        out[i * 2] = hex[digest[i] >> 4];
        out[i * 2 + 1] = hex[digest[i] & 0x0f];
    }
    out[32] = '\0';
}

static char *oliphaunt_existing_lock_dir_dup(const char *root_key) {
    char *cursor = oliphaunt_path_parent_dup(root_key);
    while (cursor != NULL) {
        struct stat st;
        if (stat(cursor, &st) == 0 && S_ISDIR(st.st_mode)) {
            return cursor;
        }
        if (strcmp(cursor, "/") == 0 || strcmp(cursor, ".") == 0) {
            free(cursor);
            return NULL;
        }
        char *parent = oliphaunt_path_parent_dup(cursor);
        free(cursor);
        cursor = parent;
    }
    return NULL;
}

int oliphaunt_acquire_stable_root_lock(OliphauntHandle *handle, const char *root, int *out_fd, char **out_path) {
    if (root == NULL || root[0] == '\0' || out_fd == NULL || out_path == NULL) {
        set_error(handle, "invalid stable root lock arguments");
        return -1;
    }
    *out_fd = -1;
    *out_path = NULL;

    char *root_key = oliphaunt_canonicalish_path_dup(root);
    if (root_key == NULL) {
        set_error(handle, "out of memory resolving stable native root lock key");
        return -1;
    }
    char *lock_dir = oliphaunt_existing_lock_dir_dup(root_key);
    if (lock_dir == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "native root %s has no parent directory for stable lock", root_key);
        set_error(handle, message);
        free(root_key);
        return -1;
    }

    char suffix[33];
    char leaf[128];
    oliphaunt_stable_root_lock_suffix(root_key, suffix);
    snprintf(leaf, sizeof(leaf), ".oliphaunt-root-%s.lock", suffix);
    char *lock_path = oliphaunt_join_path(lock_dir, leaf);
    free(lock_dir);
    if (lock_path == NULL) {
        set_error(handle, "out of memory resolving stable native root lock path");
        free(root_key);
        return -1;
    }

    int fd = open(lock_path, O_RDWR | O_CREAT, 0600);
    if (fd < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "open stable native root lock %s: %s", lock_path, strerror(errno));
        set_error(handle, message);
        free(root_key);
        free(lock_path);
        return -1;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "native root %s is already locked: %s", root_key, strerror(errno));
        set_error(handle, message);
        free(root_key);
        close(fd);
        free(lock_path);
        return -1;
    }

    free(root_key);
    *out_fd = fd;
    *out_path = lock_path;
    return 0;
}

void oliphaunt_release_file_lock(int *fd, char **path) {
    if (fd != NULL && *fd >= 0) {
        (void)flock(*fd, LOCK_UN);
        close(*fd);
        *fd = -1;
    }
    if (path != NULL) {
        free(*path);
        *path = NULL;
    }
}

int oliphaunt_acquire_root_marker_lock(OliphauntHandle *handle, const char *pgdata) {
    if (handle == NULL || pgdata == NULL || pgdata[0] == '\0') {
        set_error(handle, "invalid root lock arguments");
        return -1;
    }
    char *root = oliphaunt_root_from_pgdata(pgdata);
    if (root == NULL) {
        set_error(handle, "out of memory resolving native root lock directory");
        return -1;
    }
    if (oliphaunt_acquire_stable_root_lock(handle, root, &handle->stable_root_lock_fd, &handle->stable_root_lock_path) != 0) {
        free(root);
        return -1;
    }
    if (oliphaunt_mkdir_p(root, 0700) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "create native root lock directory %s: %s", root, strerror(errno));
        set_error(handle, message);
        oliphaunt_release_file_lock(&handle->stable_root_lock_fd, &handle->stable_root_lock_path);
        free(root);
        return -1;
    }
    char *lock_path = oliphaunt_join_path(root, ".oliphaunt.lock");
    free(root);
    if (lock_path == NULL) {
        set_error(handle, "out of memory resolving native root lock path");
        oliphaunt_release_file_lock(&handle->stable_root_lock_fd, &handle->stable_root_lock_path);
        return -1;
    }
    int fd = open(lock_path, O_RDWR | O_CREAT, 0600);
    if (fd < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "open native root lock %s: %s", lock_path, strerror(errno));
        set_error(handle, message);
        free(lock_path);
        oliphaunt_release_file_lock(&handle->stable_root_lock_fd, &handle->stable_root_lock_path);
        return -1;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "native root %s is already locked: %s", pgdata, strerror(errno));
        set_error(handle, message);
        close(fd);
        free(lock_path);
        oliphaunt_release_file_lock(&handle->stable_root_lock_fd, &handle->stable_root_lock_path);
        return -1;
    }
    handle->root_marker_lock_fd = fd;
    handle->root_marker_lock_path = lock_path;
    return 0;
}

void oliphaunt_release_root_marker_lock(OliphauntHandle *handle) {
    if (handle == NULL) {
        return;
    }
    oliphaunt_release_file_lock(&handle->root_marker_lock_fd, &handle->root_marker_lock_path);
    oliphaunt_release_file_lock(&handle->stable_root_lock_fd, &handle->stable_root_lock_path);
}
