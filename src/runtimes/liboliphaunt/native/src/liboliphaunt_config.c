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

static bool config_string_matches(
    const char *actual,
    const char *requested,
    const char *fallback) {
    const char *expected = requested != NULL ? requested : fallback;
    return strcmp(actual != NULL ? actual : "", expected != NULL ? expected : "") == 0;
}

static bool startup_args_match(
    const OliphauntHandle *handle,
    const OliphauntConfig *config) {
    if (handle->startup_arg_count != config->startup_arg_count) {
        return false;
    }
    for (size_t i = 0; i < handle->startup_arg_count; i++) {
        const char *expected = config->startup_args != NULL ? config->startup_args[i] : NULL;
        if (expected == NULL || strcmp(handle->startup_args[i], expected) != 0) {
            return false;
        }
    }
    return true;
}

bool oliphaunt_config_matches_resident_runtime(
    const OliphauntHandle *handle,
    const OliphauntConfig *config) {
    return handle != NULL &&
           config != NULL &&
           handle->external_root_lock ==
               ((config->flags & OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK) != 0) &&
           config_string_matches(handle->pgdata, config->pgdata, "") &&
           config_string_matches(handle->runtime_dir, config->runtime_dir, "") &&
           config_string_matches(handle->module_dir, config->module_dir, "") &&
           config_string_matches(handle->username, config->username, "postgres") &&
           config_string_matches(handle->database, config->database, "postgres") &&
           startup_args_match(handle, config);
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

static int ascii_case_equal(const char *value, size_t length, const char *expected) {
    size_t expected_length = strlen(expected);
    if (length != expected_length) {
        return 0;
    }
    for (size_t i = 0; i < length; i++) {
        unsigned char left = (unsigned char)value[i];
        unsigned char right = (unsigned char)expected[i];
        if (left >= 'A' && left <= 'Z') {
            left = (unsigned char)(left - 'A' + 'a');
        }
        if (right >= 'A' && right <= 'Z') {
            right = (unsigned char)(right - 'A' + 'a');
        }
        if (left != right) {
            return 0;
        }
    }
    return 1;
}

static int is_ascii_alpha(unsigned char value) {
    return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
}

static int is_portable_guc_name(const char *name, size_t length) {
    int at_component_start = 1;
    for (size_t i = 0; i < length; i++) {
        unsigned char value = (unsigned char)name[i];
        if (at_component_start) {
            if (!is_ascii_alpha(value) && value != '_') {
                return 0;
            }
            at_component_start = 0;
        } else if (value == '.') {
            at_component_start = 1;
        } else if (!is_ascii_alpha(value) && !(value >= '0' && value <= '9') &&
                   value != '_' && value != '$') {
            return 0;
        }
    }
    return !at_component_start;
}

int oliphaunt_validate_startup_args(
    OliphauntHandle *handle,
    const OliphauntConfig *config) {
    if (config->startup_arg_count == 0) {
        return 0;
    }
    if (config->startup_args == NULL || config->startup_arg_count % 2 != 0) {
        set_error(handle, "startup_args must contain complete '-c', 'name=value' pairs");
        return -1;
    }
    for (size_t i = 0; i < config->startup_arg_count; i += 2) {
        const char *flag = config->startup_args[i];
        const char *assignment = config->startup_args[i + 1];
        if (flag == NULL || assignment == NULL || strcmp(flag, "-c") != 0) {
            set_error(handle, "startup_args must contain only '-c', 'name=value' pairs");
            return -1;
        }
        const char *equals = strchr(assignment, '=');
        if (equals == NULL) {
            set_error(handle, "PostgreSQL startup GUC must use name=value syntax");
            return -1;
        }
        const char *name = assignment;
        while (name < equals && (*name == ' ' || *name == '\t' || *name == '\r' || *name == '\n')) {
            name++;
        }
        const char *name_end = equals;
        while (name_end > name &&
               (name_end[-1] == ' ' || name_end[-1] == '\t' || name_end[-1] == '\r' ||
                name_end[-1] == '\n')) {
            name_end--;
        }
        size_t name_length = (size_t)(name_end - name);
        if (name_length == 0) {
            set_error(handle, "PostgreSQL startup GUC name must not be empty");
            return -1;
        }
        if (!is_portable_guc_name(name, name_length)) {
            set_error(
                handle,
                "PostgreSQL startup GUC name must use dot-separated components that start with an ASCII letter or '_' and continue with ASCII letters, digits, '_', or '$'");
            return -1;
        }
        if (ascii_case_equal(name, name_length, "config_file") ||
            ascii_case_equal(name, name_length, "data_directory")) {
            set_error(
                handle,
                "Oliphaunt owns PostgreSQL config_file and data_directory; configure storage through the Oliphaunt API");
            return -1;
        }
    }
    return 0;
}

int oliphaunt_dup_startup_args(OliphauntHandle *handle, const OliphauntConfig *config) {
    if (config->startup_arg_count == 0) {
        return 0;
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
