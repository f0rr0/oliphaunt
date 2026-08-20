#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "liboliphaunt_internal.h"

#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#ifndef _WIN32
#include <unistd.h>
#endif

static int path_exists(const char *path) {
    struct stat st;
    return path != NULL && stat(path, &st) == 0;
}

char *oliphaunt_dup_config_string(const char *value, const char *fallback) {
    const char *source = value && value[0] ? value : fallback;
    return strdup(source);
}

static char *runtime_tool_path(const char *runtime_dir, const char *tool_name) {
    if (runtime_dir == NULL || runtime_dir[0] == '\0' ||
        tool_name == NULL || tool_name[0] == '\0') {
        return NULL;
    }
    const char *bin_sep =
#ifdef _WIN32
        "\\bin\\";
#else
        "/bin/";
#endif
    size_t dir_len = strlen(runtime_dir);
    size_t sep_len = strlen(bin_sep);
    size_t tool_len = strlen(tool_name);
    char *path = (char *)malloc(dir_len + sep_len + tool_len + 1);
    if (path == NULL) {
        return NULL;
    }
    memcpy(path, runtime_dir, dir_len);
    memcpy(path + dir_len, bin_sep, sep_len);
    memcpy(path + dir_len + sep_len, tool_name, tool_len + 1);
    if (access(path, X_OK) == 0 || path_exists(path)) {
        return path;
    }
#ifdef _WIN32
    static const char exe_suffix[] = ".exe";
    if (tool_len < sizeof(exe_suffix) - 1 ||
        strcmp(tool_name + tool_len - (sizeof(exe_suffix) - 1), exe_suffix) != 0) {
        char *exe_path = (char *)malloc(dir_len + sep_len + tool_len + sizeof(exe_suffix));
        if (exe_path == NULL) {
            free(path);
            return NULL;
        }
        memcpy(exe_path, path, dir_len + sep_len + tool_len);
        memcpy(exe_path + dir_len + sep_len + tool_len, exe_suffix, sizeof(exe_suffix));
        if (access(exe_path, X_OK) == 0 || path_exists(exe_path)) {
            free(path);
            return exe_path;
        }
        free(exe_path);
    }
#endif
    free(path);
    return NULL;
}

char *oliphaunt_resolve_postgres_argv0(const char *runtime_dir) {
    char *from_runtime = runtime_tool_path(runtime_dir, "postgres");
    if (from_runtime != NULL) {
        return from_runtime;
    }
    const char *postgres = getenv("OLIPHAUNT_POSTGRES");
    if (postgres != NULL && postgres[0] != '\0') {
        return strdup(postgres);
    }
    return strdup("postgres");
}

int oliphaunt_dup_startup_args(OliphauntHandle *handle, const OliphauntConfig *config) {
    if (config->startup_arg_count == 0) {
        return 0;
    }
    if (config->startup_args == NULL) {
        set_error(handle, "startup_arg_count is non-zero but startup_args is null");
        return -1;
    }
    handle->startup_args = (char **)calloc(config->startup_arg_count, sizeof(char *));
    if (handle->startup_args == NULL) {
        set_error(handle, "out of memory allocating startup arguments");
        return -1;
    }
    handle->startup_arg_count = config->startup_arg_count;
    for (size_t i = 0; i < config->startup_arg_count; i++) {
        if (config->startup_args[i] == NULL) {
            set_error(handle, "startup argument must not be null");
            return -1;
        }
        handle->startup_args[i] = strdup(config->startup_args[i]);
        if (handle->startup_args[i] == NULL) {
            set_error(handle, "out of memory copying startup argument");
            return -1;
        }
    }
    return 0;
}
