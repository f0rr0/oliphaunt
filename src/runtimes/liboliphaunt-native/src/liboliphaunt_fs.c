#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "liboliphaunt_internal.h"

#ifndef _WIN32
#include <dirent.h>
#include <dlfcn.h>
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

int oliphaunt_path_is_directory(const char *path) {
    struct stat st;
    return path != NULL && stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

int oliphaunt_path_is_reparse_point(const char *path) {
#ifdef _WIN32
    DWORD attributes = GetFileAttributesA(path);
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        DWORD error = GetLastError();
        errno = error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ENOENT : EACCES;
        return -1;
    }
    return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ? 1 : 0;
#else
    (void)path;
    return 0;
#endif
}

static char *oliphaunt_canonicalish_path_dup(const char *path);

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

char *oliphaunt_runtime_icu_data_dir(const char *runtime_dir) {
    if (runtime_dir != NULL && runtime_dir[0] != '\0') {
        char *path = oliphaunt_join_path(runtime_dir, "share/icu");
        if (path == NULL) {
            return NULL;
        }
        if (oliphaunt_path_exists(path)) {
            return path;
        }
        free(path);
    }

    const char *external = getenv(OLIPHAUNT_ICU_DATA_DIR_ENV);
    if (external == NULL || external[0] == '\0' || !oliphaunt_path_exists(external)) {
        return NULL;
    }
    return strdup(external);
}

static char *oliphaunt_loaded_library_path_dup(void) {
#ifdef _WIN32
    HMODULE module = NULL;
    if (!GetModuleHandleExA(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            (LPCSTR)&oliphaunt_loaded_library_path_dup,
            &module)) {
        return NULL;
    }

    DWORD capacity = MAX_PATH;
    for (;;) {
        char *buffer = (char *)malloc((size_t)capacity + 1);
        if (buffer == NULL) {
            return NULL;
        }
        DWORD written = GetModuleFileNameA(module, buffer, capacity);
        if (written == 0) {
            free(buffer);
            return NULL;
        }
        if (written < capacity) {
            buffer[written] = '\0';
            char *resolved = realpath(buffer, NULL);
            free(buffer);
            return resolved;
        }
        free(buffer);
        if (capacity > 32768) {
            return NULL;
        }
        capacity *= 2;
    }
#else
    Dl_info info;
    if (dladdr((void *)&oliphaunt_loaded_library_path_dup, &info) == 0 ||
        info.dli_fname == NULL || info.dli_fname[0] == '\0') {
        return NULL;
    }
    return oliphaunt_canonicalish_path_dup(info.dli_fname);
#endif
}

static char *oliphaunt_existing_module_dir(char *candidate) {
    if (candidate == NULL) {
        return NULL;
    }
    if (oliphaunt_path_is_directory(candidate)) {
        return candidate;
    }
    free(candidate);
    return NULL;
}

char *oliphaunt_resolve_embedded_module_dir(const char *module_dir, const char *runtime_dir) {
    /* A per-handle selection is authoritative and must never fall through. */
    if (module_dir != NULL && module_dir[0] != '\0') {
        return oliphaunt_existing_module_dir(strdup(module_dir));
    }

    const char *override = getenv(OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV);
    if (override != NULL && override[0] != '\0' && oliphaunt_path_is_directory(override)) {
        return strdup(override);
    }

    char *library_path = oliphaunt_loaded_library_path_dup();
    if (library_path != NULL) {
        char *library_dir = oliphaunt_path_parent_dup(library_path);
        if (library_dir != NULL) {
            char *candidate = oliphaunt_existing_module_dir(oliphaunt_join_path(library_dir, "modules"));
            if (candidate != NULL) {
                free(library_dir);
                free(library_path);
                return candidate;
            }

            char *release_root = oliphaunt_path_parent_dup(library_dir);
            if (release_root != NULL) {
                candidate = oliphaunt_existing_module_dir(oliphaunt_join_path(release_root, "lib/modules"));
                if (candidate != NULL) {
                    free(release_root);
                    free(library_dir);
                    free(library_path);
                    return candidate;
                }
                free(release_root);
            }
            free(library_dir);
        }
        free(library_path);
    }

    if (runtime_dir != NULL && runtime_dir[0] != '\0') {
        char *work_root = oliphaunt_path_parent_dup(runtime_dir);
        if (work_root != NULL) {
            char *candidate = oliphaunt_existing_module_dir(oliphaunt_join_path(work_root, "out/modules"));
            free(work_root);
            if (candidate != NULL) {
                return candidate;
            }
        }
    }

    return NULL;
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
#ifdef _WIN32
    if (slash == path + 2 && path[1] == ':') {
        char *out = (char *)malloc(4);
        if (out == NULL) {
            return NULL;
        }
        memcpy(out, path, 3);
        out[3] = '\0';
        return out;
    }
#endif
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
    size_t minimum = 1;
#ifdef _WIN32
    if (len >= 3 && path[1] == ':' && oliphaunt_is_path_separator(path[2])) {
        minimum = 3;
    }
#endif
    while (len > minimum && oliphaunt_is_path_separator(path[len - 1])) {
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

int oliphaunt_path_is_filesystem_root(const char *path) {
    if (path == NULL || path[0] == '\0') {
        return -1;
    }
#ifdef _WIN32
    DWORD full_capacity = GetFullPathNameA(path, 0, NULL, NULL);
    if (full_capacity == 0) {
        return -1;
    }
    char *full = (char *)malloc((size_t)full_capacity + 1);
    char *volume = (char *)malloc((size_t)full_capacity + 1);
    if (full == NULL || volume == NULL) {
        free(full);
        free(volume);
        return -1;
    }
    if (GetFullPathNameA(path, full_capacity + 1, full, NULL) == 0 ||
        !GetVolumePathNameA(full, volume, full_capacity + 1)) {
        free(full);
        free(volume);
        return -1;
    }
    size_t full_len = strlen(full);
    size_t volume_len = strlen(volume);
    while (full_len > 0 && oliphaunt_is_path_separator(full[full_len - 1])) {
        full[--full_len] = '\0';
    }
    while (volume_len > 0 && oliphaunt_is_path_separator(volume[volume_len - 1])) {
        volume[--volume_len] = '\0';
    }
    int is_root = _stricmp(full, volume) == 0;
    free(full);
    free(volume);
    return is_root;
#else
    char *canonical = oliphaunt_canonicalish_path_dup(path);
    if (canonical == NULL) {
        return -1;
    }
    int is_root = strcmp(canonical, "/") == 0;
    free(canonical);
    return is_root;
#endif
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
    DWORD attributes = GetFileAttributesA(path);
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        DWORD error = GetLastError();
        errno = error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ENOENT : EACCES;
        return errno == ENOENT ? 0 : -1;
    }
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        return (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? rmdir(path) : unlink(path);
    }
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

static int oliphaunt_validate_managed_root_topology(OliphauntHandle *handle, const char *root) {
#ifdef _WIN32
    char *pattern = oliphaunt_join_path(root, "*");
    if (pattern == NULL) {
        set_error(handle, "out of memory enumerating native database root");
        return -1;
    }
    WIN32_FIND_DATAA data;
    HANDLE find = FindFirstFileA(pattern, &data);
    free(pattern);
    if (find == INVALID_HANDLE_VALUE) {
        set_error(handle, "could not enumerate native database root");
        return -1;
    }
    do {
        if (strcmp(data.cFileName, ".") == 0 || strcmp(data.cFileName, "..") == 0 ||
            strcmp(data.cFileName, ".oliphaunt.json") == 0 || strcmp(data.cFileName, "pgdata") == 0) {
            continue;
        }
        char message[1024];
        snprintf(
            message,
            sizeof(message),
            "managed root %s contains unsupported top-level entry %s; expected only .oliphaunt.json and pgdata",
            root,
            data.cFileName);
        FindClose(find);
        set_error(handle, message);
        return -1;
    } while (FindNextFileA(find, &data));
    DWORD error = GetLastError();
    FindClose(find);
    if (error != ERROR_NO_MORE_FILES) {
        set_error(handle, "could not enumerate native database root");
        return -1;
    }
#else
    DIR *dir = opendir(root);
    if (dir == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "could not enumerate native database root %s: %s", root, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0 ||
            strcmp(entry->d_name, ".oliphaunt.json") == 0 || strcmp(entry->d_name, "pgdata") == 0) {
            continue;
        }
        char message[1024];
        snprintf(
            message,
            sizeof(message),
            "managed root %s contains unsupported top-level entry %s; expected only .oliphaunt.json and pgdata",
            root,
            entry->d_name);
        closedir(dir);
        set_error(handle, message);
        return -1;
    }
    int read_error = errno;
    if (closedir(dir) != 0 && read_error == 0) {
        read_error = errno;
    }
    if (read_error != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "could not enumerate native database root %s: %s", root, strerror(read_error));
        set_error(handle, message);
        return -1;
    }
#endif
    return 0;
}

static char *oliphaunt_root_from_pgdata(const char *pgdata) {
    char *trimmed = oliphaunt_trim_trailing_slashes_dup(pgdata);
    if (trimmed == NULL) {
        return NULL;
    }
    char *root = oliphaunt_path_parent_dup(trimmed);
    free(trimmed);
    return root;
}

static char *oliphaunt_stable_root_identity_dup(const char *root_key) {
    char *identity = strdup(root_key);
    if (identity == NULL) {
        return NULL;
    }
#ifdef _WIN32
    if (strncmp(identity, "\\\\?\\UNC\\", 8) == 0) {
        size_t suffix_len = strlen(identity + 8);
        memmove(identity + 2, identity + 8, suffix_len + 1);
        identity[0] = '\\';
        identity[1] = '\\';
    } else if (strncmp(identity, "\\\\?\\", 4) == 0) {
        memmove(identity, identity + 4, strlen(identity + 4) + 1);
    }
    for (char *cursor = identity; *cursor != '\0'; cursor++) {
        if (*cursor == '/') {
            *cursor = '\\';
        } else if (*cursor >= 'A' && *cursor <= 'Z') {
            *cursor = (char)(*cursor - 'A' + 'a');
        }
    }
#endif
    return identity;
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
    char *lock_dir = oliphaunt_path_parent_dup(root_key);
    struct stat lock_dir_stat;
    if (lock_dir == NULL || stat(lock_dir, &lock_dir_stat) != 0 || !S_ISDIR(lock_dir_stat.st_mode)) {
        char message[1024];
        snprintf(message, sizeof(message), "native root %s has no immediate parent directory for its stable lock", root_key);
        set_error(handle, message);
        free(lock_dir);
        free(root_key);
        return -1;
    }

    char suffix[33];
    char leaf[128];
    char *root_identity = oliphaunt_stable_root_identity_dup(root_key);
    if (root_identity == NULL) {
        set_error(handle, "out of memory resolving stable native root lock identity");
        free(lock_dir);
        free(root_key);
        return -1;
    }
    oliphaunt_stable_root_lock_suffix(root_identity, suffix);
    free(root_identity);
    snprintf(leaf, sizeof(leaf), ".oliphaunt-root-%s.lock", suffix);
    char *lock_path = oliphaunt_join_path(lock_dir, leaf);
    free(lock_dir);
    if (lock_path == NULL) {
        set_error(handle, "out of memory resolving stable native root lock path");
        free(root_key);
        return -1;
    }

    int fd = open(lock_path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
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

int oliphaunt_acquire_root_lock(OliphauntHandle *handle, const char *pgdata) {
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
    free(root);
    return 0;
}

static int oliphaunt_read_small_file(
    OliphauntHandle *handle,
    const char *path,
    char *out,
    size_t capacity,
    bool *out_exists) {
    *out_exists = false;
#ifdef _WIN32
    HANDLE file_handle = CreateFileA(
        path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        NULL);
    if (file_handle == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
            return 0;
        }
        char message[1024];
        snprintf(message, sizeof(message), "open managed-root metadata %s: Windows error %lu", path, (unsigned long)error);
        set_error(handle, message);
        return -1;
    }
    BY_HANDLE_FILE_INFORMATION file_info;
    if (!GetFileInformationByHandle(file_handle, &file_info)) {
        DWORD error = GetLastError();
        CloseHandle(file_handle);
        char message[1024];
        snprintf(message, sizeof(message), "inspect opened managed-root metadata %s: Windows error %lu", path, (unsigned long)error);
        set_error(handle, message);
        return -1;
    }
    if ((file_info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
        CloseHandle(file_handle);
        char message[1024];
        snprintf(message, sizeof(message), "%s is not a regular managed-root metadata file", path);
        set_error(handle, message);
        return -1;
    }
    int fd = _open_osfhandle((intptr_t)file_handle, _O_RDONLY | _O_BINARY);
    if (fd < 0) {
        CloseHandle(file_handle);
        char message[1024];
        snprintf(message, sizeof(message), "read %s: %s", path, strerror(errno));
        set_error(handle, message);
        return -1;
    }
#else
    int reparse = oliphaunt_path_is_reparse_point(path);
    if (reparse > 0) {
        char message[1024];
        snprintf(message, sizeof(message), "%s must not be a Windows reparse point", path);
        set_error(handle, message);
        return -1;
    }
    struct stat before;
    if (lstat(path, &before) != 0) {
        if (errno == ENOENT) {
            return 0;
        }
        char message[1024];
        snprintf(message, sizeof(message), "inspect %s: %s", path, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    if (!S_ISREG(before.st_mode)) {
        char message[1024];
        snprintf(message, sizeof(message), "%s is not a regular managed-root metadata file", path);
        set_error(handle, message);
        return -1;
    }
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "read %s: %s", path, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    struct stat opened;
    int stat_rc = fstat(fd, &opened);
    if (stat_rc != 0 || !S_ISREG(opened.st_mode) ||
        opened.st_dev != before.st_dev || opened.st_ino != before.st_ino) {
        char message[1024];
        snprintf(message, sizeof(message), "%s changed while its metadata was opened", path);
        close(fd);
        set_error(handle, message);
        return -1;
    }
#endif
    size_t length = 0;
    while (length + 1 < capacity) {
        ssize_t count = read(fd, out + length, capacity - length - 1);
        if (count < 0) {
            char message[1024];
            snprintf(message, sizeof(message), "read %s: %s", path, strerror(errno));
            close(fd);
            set_error(handle, message);
            return -1;
        }
        if (count == 0) {
            break;
        }
        length += (size_t)count;
    }
    char extra;
    ssize_t extra_count = read(fd, &extra, 1);
    if (close(fd) != 0 && extra_count >= 0) {
        extra_count = -1;
    }
    if (extra_count < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "read %s: %s", path, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    if (extra_count > 0) {
        char message[1024];
        snprintf(message, sizeof(message), "%s exceeds the managed-root metadata limit", path);
        set_error(handle, message);
        return -1;
    }
    out[length] = '\0';
    *out_exists = true;
    return 0;
}

#ifndef _WIN32
static int oliphaunt_sync_directory(OliphauntHandle *handle, const char *path) {
    int flags = O_RDONLY | O_CLOEXEC;
#ifdef O_DIRECTORY
    flags |= O_DIRECTORY;
#endif
    int fd = open(path, flags);
    if (fd < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "open native root directory %s for sync: %s", path, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    int sync_rc = fsync(fd);
    int sync_errno = errno;
    int close_rc = close(fd);
    if (sync_rc != 0 || close_rc != 0) {
        if (sync_rc != 0) {
            errno = sync_errno;
        }
        char message[1024];
        snprintf(message, sizeof(message), "sync native root directory %s: %s", path, strerror(errno));
        set_error(handle, message);
        return -1;
    }
    return 0;
}
#endif

static int oliphaunt_write_native_root_descriptor(
    OliphauntHandle *handle,
    const char *root,
    const char *descriptor_path,
    const char *contents) {
    int open_flags = O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC;
#ifdef _WIN32
    open_flags |= O_BINARY;
#endif
    char *staging = NULL;
    int fd = -1;
    struct timespec now;
    (void)clock_gettime(CLOCK_REALTIME, &now);
    for (int attempt = 0; attempt < 100; attempt++) {
        char staging_leaf[128];
        snprintf(
            staging_leaf,
            sizeof(staging_leaf),
            ".oliphaunt.json.tmp-%ld-%lld-%d",
            (long)getpid(),
            (long long)now.tv_nsec,
            attempt);
        staging = oliphaunt_join_path(root, staging_leaf);
        if (staging == NULL) {
            set_error(handle, "out of memory resolving native root descriptor staging path");
            return -1;
        }
        fd = open(staging, open_flags, 0600);
        if (fd >= 0 || errno != EEXIST) {
            break;
        }
        free(staging);
        staging = NULL;
    }
    if (fd < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "write native root descriptor staging file: %s", strerror(errno));
        set_error(handle, message);
        free(staging);
        return -1;
    }
    size_t length = strlen(contents);
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = write(fd, contents + offset, length - offset);
        if (count <= 0) {
            char message[1024];
            snprintf(message, sizeof(message), "write native root descriptor %s: %s", staging, strerror(errno));
            close(fd);
            unlink(staging);
            set_error(handle, message);
            free(staging);
            return -1;
        }
        offset += (size_t)count;
    }
#ifdef _WIN32
    int sync_rc = _commit(fd);
#else
    int sync_rc = fsync(fd);
#endif
    int sync_errno = errno;
    int close_rc = close(fd);
    if (sync_rc != 0 || close_rc != 0) {
        if (sync_rc != 0) {
            errno = sync_errno;
        }
        char message[1024];
        snprintf(message, sizeof(message), "sync native root descriptor %s: %s", staging, strerror(errno));
        unlink(staging);
        set_error(handle, message);
        free(staging);
        return -1;
    }
#ifdef _WIN32
    if (!MoveFileExA(staging, descriptor_path, MOVEFILE_WRITE_THROUGH)) {
        DWORD publish_error = GetLastError();
        char message[1024];
        snprintf(message, sizeof(message), "publish native root descriptor %s: Windows error %lu", descriptor_path, (unsigned long)publish_error);
        unlink(staging);
        set_error(handle, message);
        free(staging);
        return -1;
    }
#else
    if (rename(staging, descriptor_path) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "publish native root descriptor %s: %s", descriptor_path, strerror(errno));
        unlink(staging);
        set_error(handle, message);
        free(staging);
        return -1;
    }
    if (oliphaunt_sync_directory(handle, root) != 0) {
        free(staging);
        return -1;
    }
#endif
    free(staging);
    return 0;
}

static const char oliphaunt_native_root_descriptor[] =
    "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\"}\n";

static void oliphaunt_json_skip_space(const char *text, size_t *offset) {
    while (text[*offset] == ' ' || text[*offset] == '\t' ||
           text[*offset] == '\r' || text[*offset] == '\n') {
        (*offset)++;
    }
}

static int oliphaunt_json_hex(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

/* Decode the small ASCII strings used by the managed-root schema. */
static bool oliphaunt_json_string(
    const char *text,
    size_t *offset,
    char *out,
    size_t capacity) {
    if (text[*offset] != '"' || capacity == 0) return false;
    (*offset)++;
    size_t length = 0;
    while (text[*offset] != '\0' && text[*offset] != '"') {
        unsigned char value = (unsigned char)text[(*offset)++];
        if (value < 0x20) return false;
        if (value == '\\') {
            char escaped = text[(*offset)++];
            switch (escaped) {
                case '"': value = '"'; break;
                case '\\': value = '\\'; break;
                case '/': value = '/'; break;
                case 'b': value = '\b'; break;
                case 'f': value = '\f'; break;
                case 'n': value = '\n'; break;
                case 'r': value = '\r'; break;
                case 't': value = '\t'; break;
                case 'u': {
                    unsigned codepoint = 0;
                    for (int index = 0; index < 4; index++) {
                        int digit = oliphaunt_json_hex(text[(*offset)++]);
                        if (digit < 0) return false;
                        codepoint = codepoint * 16u + (unsigned)digit;
                    }
                    if (codepoint == 0 || codepoint > 0x7f) return false;
                    value = (unsigned char)codepoint;
                    break;
                }
                default: return false;
            }
        }
        if (length + 1 >= capacity) return false;
        out[length++] = (char)value;
    }
    if (text[*offset] != '"') return false;
    (*offset)++;
    out[length] = '\0';
    return true;
}

static bool oliphaunt_parse_root_descriptor(const char *text) {
    enum {
        ROOT_SCHEMA = 1u << 0,
        ROOT_FAMILY = 1u << 1,
        ROOT_PGDATA = 1u << 2,
        ROOT_MAJOR = 1u << 3,
        ROOT_FORMAT = 1u << 4,
        ROOT_ALL = ROOT_SCHEMA | ROOT_FAMILY | ROOT_PGDATA | ROOT_MAJOR | ROOT_FORMAT,
    };
    size_t offset = 0;
    unsigned seen = 0;
    char family[16] = {0};
    char format[32] = {0};
    oliphaunt_json_skip_space(text, &offset);
    if (text[offset++] != '{') return false;
    oliphaunt_json_skip_space(text, &offset);
    while (text[offset] != '}') {
        char key[32];
        char value[64];
        if (!oliphaunt_json_string(text, &offset, key, sizeof(key))) return false;
        oliphaunt_json_skip_space(text, &offset);
        if (text[offset++] != ':') return false;
        oliphaunt_json_skip_space(text, &offset);

        unsigned field = 0;
        const char *expected = NULL;
        char *captured = NULL;
        size_t captured_capacity = 0;
        if (strcmp(key, "schema") == 0) {
            field = ROOT_SCHEMA;
            expected = "oliphaunt-database-root-v1";
        } else if (strcmp(key, "engineFamily") == 0) {
            field = ROOT_FAMILY;
            captured = family;
            captured_capacity = sizeof(family);
        } else if (strcmp(key, "pgdata") == 0) {
            field = ROOT_PGDATA;
            expected = "pgdata";
        } else if (strcmp(key, "postgresMajor") == 0) {
            field = ROOT_MAJOR;
            if (text[offset++] != '1' || text[offset++] != '8' ||
                !strchr(",} \t\r\n", text[offset])) return false;
        } else if (strcmp(key, "physicalFormat") == 0) {
            field = ROOT_FORMAT;
            captured = format;
            captured_capacity = sizeof(format);
        } else {
            return false;
        }
        if ((seen & field) != 0) return false;
        seen |= field;
        if (field != ROOT_MAJOR) {
            if (!oliphaunt_json_string(text, &offset, value, sizeof(value))) return false;
            if (expected != NULL && strcmp(value, expected) != 0) return false;
            if (captured != NULL) {
                if (strlen(value) >= captured_capacity) return false;
                strcpy(captured, value);
            }
        }
        oliphaunt_json_skip_space(text, &offset);
        if (text[offset] == ',') {
            offset++;
            oliphaunt_json_skip_space(text, &offset);
            if (text[offset] == '}') return false;
            continue;
        }
        if (text[offset] != '}') return false;
    }
    offset++;
    oliphaunt_json_skip_space(text, &offset);
    if (text[offset] != '\0' || seen != ROOT_ALL) return false;
    return (strcmp(family, "native") == 0 && strcmp(format, "native-pg18-v1") == 0) ||
           (strcmp(family, "wasix") == 0 && strcmp(format, "wasix-pg18-v1") == 0);
}

int oliphaunt_publish_native_root_descriptor(OliphauntHandle *handle, const char *pgdata) {
    char *root = oliphaunt_root_from_pgdata(pgdata);
    char *trimmed = oliphaunt_trim_trailing_slashes_dup(pgdata);
    char *leaf = trimmed == NULL ? NULL : oliphaunt_path_file_name_dup(trimmed);
    char *path = root == NULL ? NULL : oliphaunt_join_path(root, ".oliphaunt.json");
    free(trimmed);
    if (root == NULL || leaf == NULL || path == NULL) {
        free(root);
        free(leaf);
        free(path);
        set_error(handle, "out of memory resolving native root descriptor");
        return -1;
    }
    if (strcmp(leaf, "pgdata") != 0 || oliphaunt_path_exists(path)) {
        set_error(handle, "cannot publish native root descriptor outside a new managed root");
        free(root);
        free(leaf);
        free(path);
        return -1;
    }
    int rc = oliphaunt_write_native_root_descriptor(
        handle, root, path, oliphaunt_native_root_descriptor);
    free(root);
    free(leaf);
    free(path);
    return rc;
}

static int oliphaunt_require_managed_root_path(
    OliphauntHandle *handle,
    const char *path,
    bool directory,
    bool nonempty,
    const char *label) {
    struct stat st;
    int reparse = oliphaunt_path_is_reparse_point(path);
    bool expected_type = false;
    if (reparse == 0 && lstat(path, &st) == 0) {
        expected_type = directory ? S_ISDIR(st.st_mode) : S_ISREG(st.st_mode);
    }
    if (reparse != 0 || !expected_type || (nonempty && st.st_size <= 0)) {
        char message[1024];
        snprintf(message, sizeof(message), "%s %s must be a %s%s", label, path,
                 directory ? "real directory" : "regular file",
                 nonempty ? " with content" : "");
        set_error(handle, message);
        return -1;
    }
    return 0;
}

int oliphaunt_validate_managed_root(OliphauntHandle *handle, const char *pgdata) {
    if (pgdata == NULL || pgdata[0] == '\0') {
        set_error(handle, "invalid managed-root arguments");
        return -1;
    }
    char *root = oliphaunt_root_from_pgdata(pgdata);
    if (root == NULL) {
        set_error(handle, "out of memory resolving native database root");
        return -1;
    }

    char *trimmed_pgdata = oliphaunt_trim_trailing_slashes_dup(pgdata);
    char *pgdata_leaf = trimmed_pgdata == NULL ? NULL : oliphaunt_path_file_name_dup(trimmed_pgdata);
    free(trimmed_pgdata);
    if (pgdata_leaf == NULL) {
        free(root);
        set_error(handle, "out of memory resolving native PGDATA leaf");
        return -1;
    }

    char *descriptor_path = oliphaunt_join_path(root, ".oliphaunt.json");
    char *version_path = oliphaunt_join_path(pgdata, "PG_VERSION");
    char *global_path = oliphaunt_join_path(pgdata, "global");
    char *control_path = oliphaunt_join_path(pgdata, "global/pg_control");
    char *wal_path = oliphaunt_join_path(pgdata, "pg_wal");
    if (descriptor_path == NULL || version_path == NULL || global_path == NULL || control_path == NULL || wal_path == NULL) {
        free(descriptor_path);
        free(version_path);
        free(global_path);
        free(control_path);
        free(wal_path);
        free(pgdata_leaf);
        free(root);
        set_error(handle, "out of memory resolving native root metadata paths");
        return -1;
    }

    if (strcmp(pgdata_leaf, "pgdata") != 0) {
        char message[1024];
        snprintf(
            message,
            sizeof(message),
            "database root %s declares PGDATA at pgdata, but liboliphaunt was configured with %s",
            root,
            pgdata_leaf);
        set_error(handle, message);
        free(descriptor_path);
        free(version_path);
        free(global_path);
        free(control_path);
        free(wal_path);
        free(pgdata_leaf);
        free(root);
        return -1;
    }
    free(pgdata_leaf);

    if (oliphaunt_require_managed_root_path(handle, root, true, false, "managed root") != 0 ||
        oliphaunt_require_managed_root_path(handle, pgdata, true, false, "managed PGDATA") != 0 ||
        oliphaunt_validate_managed_root_topology(handle, root) != 0) {
        free(descriptor_path);
        free(version_path);
        free(global_path);
        free(control_path);
        free(wal_path);
        free(root);
        return -1;
    }

    char existing[512];
    bool has_descriptor = false;
    if (oliphaunt_read_small_file(handle, descriptor_path, existing, sizeof(existing), &has_descriptor) != 0) {
        free(descriptor_path);
        free(version_path);
        free(global_path);
        free(control_path);
        free(wal_path);
        free(root);
        return -1;
    }
    if (!has_descriptor || !oliphaunt_parse_root_descriptor(existing)) {
        char message[1024];
        snprintf(message, sizeof(message), "managed root %s has no supported .oliphaunt.json descriptor", root);
        set_error(handle, message);
        free(descriptor_path);
        free(version_path);
        free(global_path);
        free(control_path);
        free(wal_path);
        free(root);
        return -1;
    }

    char version[32];
    bool has_version = false;
    if (oliphaunt_read_small_file(handle, version_path, version, sizeof(version), &has_version) != 0) {
        free(descriptor_path);
        free(version_path);
        free(global_path);
        free(control_path);
        free(wal_path);
        free(root);
        return -1;
    }
    if (has_version) {
        size_t length = strlen(version);
        while (length > 0 && (version[length - 1] == '\n' || version[length - 1] == '\r' ||
                              version[length - 1] == ' ' || version[length - 1] == '\t')) {
            version[--length] = '\0';
        }
        if (strcmp(version, "18") != 0) {
            char message[1024];
            snprintf(
                message,
                sizeof(message),
                "native root %s contains PostgreSQL %s PGDATA; oliphaunt currently supports PostgreSQL 18 roots",
                root,
                version[0] != '\0' ? version : "an unknown version");
            set_error(handle, message);
            free(descriptor_path);
            free(version_path);
            free(global_path);
            free(control_path);
            free(wal_path);
            free(root);
            return -1;
        }
    } else {
        set_error(handle, "managed PGDATA is missing regular file PG_VERSION");
        free(descriptor_path);
        free(version_path);
        free(global_path);
        free(control_path);
        free(wal_path);
        free(root);
        return -1;
    }

    if (oliphaunt_require_managed_root_path(
            handle, global_path, true, false, "managed global") != 0 ||
        oliphaunt_require_managed_root_path(
            handle, control_path, false, true, "managed pg_control") != 0 ||
        oliphaunt_require_managed_root_path(
            handle, wal_path, true, false, "managed pg_wal") != 0) {
        free(descriptor_path);
        free(version_path);
        free(global_path);
        free(control_path);
        free(wal_path);
        free(root);
        return -1;
    }

    free(descriptor_path);
    free(version_path);
    free(global_path);
    free(control_path);
    free(wal_path);
    free(root);
    return 0;
}

void oliphaunt_release_root_lock(OliphauntHandle *handle) {
    if (handle == NULL) {
        return;
    }
    oliphaunt_release_file_lock(&handle->stable_root_lock_fd, &handle->stable_root_lock_path);
}
