#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "liboliphaunt_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#ifndef _WIN32
#if defined(__APPLE__) && defined(__has_include)
#if __has_include(<TargetConditionals.h>)
#include <TargetConditionals.h>
#endif
#endif

#ifndef TARGET_OS_IPHONE
#define TARGET_OS_IPHONE 0
#endif
#ifndef TARGET_OS_TV
#define TARGET_OS_TV 0
#endif
#ifndef TARGET_OS_WATCH
#define TARGET_OS_WATCH 0
#endif
#ifndef TARGET_OS_VISION
#define TARGET_OS_VISION 0
#endif

#if TARGET_OS_IPHONE || TARGET_OS_TV || TARGET_OS_WATCH || TARGET_OS_VISION
#define OLIPHAUNT_CAN_EXEC_INITDB 0
#else
#define OLIPHAUNT_CAN_EXEC_INITDB 1
#endif

#if OLIPHAUNT_CAN_EXEC_INITDB
#include <sys/wait.h>
#endif
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

static char *sibling_postgres_path(const char *initdb_path) {
    if (initdb_path == NULL || initdb_path[0] == '\0') {
        return NULL;
    }
    const char *slash = strrchr(initdb_path, '/');
#ifdef _WIN32
    const char *backslash = strrchr(initdb_path, '\\');
    if (backslash != NULL && (slash == NULL || backslash > slash)) {
        slash = backslash;
    }
#endif
    if (slash == NULL) {
        return NULL;
    }
    size_t dir_len = (size_t)(slash - initdb_path);
    const char *leaf =
#ifdef _WIN32
        "\\postgres.exe";
#else
        "/postgres";
#endif
    size_t leaf_len = strlen(leaf);
    char *path = (char *)malloc(dir_len + leaf_len + 1);
    if (path == NULL) {
        return NULL;
    }
    memcpy(path, initdb_path, dir_len);
    memcpy(path + dir_len, leaf, leaf_len + 1);
    return path;
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

    const char *initdb = getenv("OLIPHAUNT_INITDB");
    char *from_initdb = sibling_postgres_path(initdb);
    if (from_initdb != NULL) {
        return from_initdb;
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

#if defined(_WIN32) || OLIPHAUNT_CAN_EXEC_INITDB
static int set_initdb_env_var(
    OliphauntHandle *handle,
    const char *name,
    const char *value,
    char **previous,
    bool *had_previous,
    bool *overridden) {
    const char *current = getenv(name);
    *had_previous = current != NULL;
    if (current != NULL) {
        *previous = strdup(current);
        if (*previous == NULL) {
            snprintf(handle->last_error, sizeof(handle->last_error), "out of memory saving %s environment", name);
            return -1;
        }
    }
    if (setenv(name, value, 1) != 0) {
        snprintf(handle->last_error, sizeof(handle->last_error), "set %s environment for initdb: %s", name, strerror(errno));
        free(*previous);
        *previous = NULL;
        *had_previous = false;
        return -1;
    }
    *overridden = true;
    return 0;
}

#ifdef _WIN32
static void restore_initdb_env_var(
    const char *name,
    char **previous,
    bool *had_previous,
    bool *overridden) {
    if (!*overridden) {
        return;
    }
    if (*had_previous) {
        (void)setenv(name, *previous != NULL ? *previous : "", 1);
    } else {
        (void)unsetenv(name);
    }
    free(*previous);
    *previous = NULL;
    *had_previous = false;
    *overridden = false;
}
#endif

static int set_initdb_icu_data_env(
    OliphauntHandle *handle,
    char **previous,
    bool *had_previous,
    bool *overridden) {
    char *icu_data_dir = oliphaunt_runtime_icu_data_dir(handle->runtime_dir);
    if (icu_data_dir == NULL) {
        return 0;
    }
    int rc = set_initdb_env_var(handle, "ICU_DATA", icu_data_dir, previous, had_previous, overridden);
    free(icu_data_dir);
    return rc;
}

static int set_initdb_runtime_library_env(
    OliphauntHandle *handle,
    char **previous,
    bool *had_previous,
    bool *overridden) {
#ifdef _WIN32
    const char *name = "PATH";
    const char *relative_dir = "bin";
    const char separator = ';';
#elif defined(__APPLE__)
    const char *name = "DYLD_LIBRARY_PATH";
    const char *relative_dir = "lib";
    const char separator = ':';
#else
    const char *name = "LD_LIBRARY_PATH";
    const char *relative_dir = "lib";
    const char separator = ':';
#endif
    if (handle->runtime_dir == NULL || handle->runtime_dir[0] == '\0') {
        return 0;
    }
    char *library_dir = oliphaunt_join_path(handle->runtime_dir, relative_dir);
    if (library_dir == NULL) {
        snprintf(handle->last_error, sizeof(handle->last_error), "out of memory resolving initdb runtime library directory");
        return -1;
    }
    const char *current = getenv(name);
    size_t library_len = strlen(library_dir);
    size_t current_len = current != NULL ? strlen(current) : 0;
    size_t value_len = library_len + (current_len > 0 ? 1 + current_len : 0);
    char *value = malloc(value_len + 1);
    if (value == NULL) {
        free(library_dir);
        snprintf(handle->last_error, sizeof(handle->last_error), "out of memory preparing initdb runtime library environment");
        return -1;
    }
    memcpy(value, library_dir, library_len);
    if (current_len > 0) {
        value[library_len] = separator;
        memcpy(value + library_len + 1, current, current_len);
    }
    value[value_len] = '\0';
    int rc = set_initdb_env_var(handle, name, value, previous, had_previous, overridden);
    free(value);
    free(library_dir);
    return rc;
}
#endif

#ifdef _WIN32
static int run_initdb_command(OliphauntHandle *handle, const char *initdb) {
    const char *argv[] = {
        initdb,
        "-D",
        handle->pgdata,
        "-U",
        handle->username,
        "--auth=trust",
        "--no-sync",
        "--locale-provider=libc",
        "--locale=C",
        "--encoding=UTF8",
        NULL,
    };
    char *previous_icu_data = NULL;
    bool had_previous_icu_data = false;
    bool icu_data_overridden = false;
    char *previous_library_path = NULL;
    bool had_previous_library_path = false;
    bool library_path_overridden = false;
    if (set_initdb_runtime_library_env(handle, &previous_library_path, &had_previous_library_path, &library_path_overridden) != 0) {
        return -1;
    }
    if (set_initdb_icu_data_env(handle, &previous_icu_data, &had_previous_icu_data, &icu_data_overridden) != 0) {
        restore_initdb_env_var("PATH", &previous_library_path, &had_previous_library_path, &library_path_overridden);
        return -1;
    }
    intptr_t status = _spawnvp(_P_WAIT, initdb, argv);
    int spawn_errno = errno;
    restore_initdb_env_var("ICU_DATA", &previous_icu_data, &had_previous_icu_data, &icu_data_overridden);
    restore_initdb_env_var("PATH", &previous_library_path, &had_previous_library_path, &library_path_overridden);
    if (status == -1) {
        snprintf(handle->last_error, sizeof(handle->last_error), "spawn initdb %s failed: %s", initdb, strerror(spawn_errno));
        return -1;
    }
    if (status == 0) {
        return 0;
    }
    snprintf(
        handle->last_error,
        sizeof(handle->last_error),
        "initdb %s failed with exit status %ld for PGDATA %s",
        initdb,
        (long)status,
        handle->pgdata);
    return -1;
}
#elif OLIPHAUNT_CAN_EXEC_INITDB
static void report_initdb_child_error(int fd, int error_code) {
    const unsigned char *data = (const unsigned char *)&error_code;
    size_t offset = 0;
    while (offset < sizeof(error_code)) {
        ssize_t written = write(fd, data + offset, sizeof(error_code) - offset);
        if (written > 0) {
            offset += (size_t)written;
            continue;
        }
        if (written < 0 && errno == EINTR) {
            continue;
        }
        break;
    }
}

static ssize_t read_initdb_child_error(int fd, int *error_code) {
    unsigned char *data = (unsigned char *)error_code;
    size_t offset = 0;
    while (offset < sizeof(*error_code)) {
        ssize_t read_count = read(fd, data + offset, sizeof(*error_code) - offset);
        if (read_count > 0) {
            offset += (size_t)read_count;
            continue;
        }
        if (read_count == 0) {
            break;
        }
        if (errno != EINTR) {
            return -1;
        }
    }
    return (ssize_t)offset;
}

static int run_initdb_command(OliphauntHandle *handle, const char *initdb) {
    int exec_error_pipe[2];
    if (pipe(exec_error_pipe) != 0) {
        snprintf(handle->last_error, sizeof(handle->last_error), "create initdb exec pipe failed: %s", strerror(errno));
        return -1;
    }

    if (fcntl(exec_error_pipe[1], F_SETFD, FD_CLOEXEC) < 0) {
        int fcntl_errno = errno;
        close(exec_error_pipe[0]);
        close(exec_error_pipe[1]);
        snprintf(handle->last_error, sizeof(handle->last_error), "configure initdb exec pipe failed: %s", strerror(fcntl_errno));
        return -1;
    }

    pid_t pid = fork();
    if (pid < 0) {
        int fork_errno = errno;
        close(exec_error_pipe[0]);
        close(exec_error_pipe[1]);
        snprintf(handle->last_error, sizeof(handle->last_error), "fork initdb failed: %s", strerror(fork_errno));
        return -1;
    }

    if (pid == 0) {
        close(exec_error_pipe[0]);
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) {
            (void)dup2(devnull, STDOUT_FILENO);
            close(devnull);
        }

        char *previous_icu_data = NULL;
        bool had_previous_icu_data = false;
        bool icu_data_overridden = false;
        char *previous_library_path = NULL;
        bool had_previous_library_path = false;
        bool library_path_overridden = false;
        if (set_initdb_runtime_library_env(handle, &previous_library_path, &had_previous_library_path, &library_path_overridden) != 0) {
            int env_errno = errno != 0 ? errno : EIO;
            report_initdb_child_error(exec_error_pipe[1], env_errno);
            _exit(127);
        }
        if (set_initdb_icu_data_env(handle, &previous_icu_data, &had_previous_icu_data, &icu_data_overridden) != 0) {
            int env_errno = errno != 0 ? errno : EIO;
            report_initdb_child_error(exec_error_pipe[1], env_errno);
            _exit(127);
        }

        execlp(
            initdb,
            initdb,
            "-D",
            handle->pgdata,
            "-U",
            handle->username,
            "--auth=trust",
            "--no-sync",
            "--locale-provider=libc",
            "--locale=C",
            "--encoding=UTF8",
            (char *)NULL);

        int exec_errno = errno != 0 ? errno : EIO;
        report_initdb_child_error(exec_error_pipe[1], exec_errno);
        _exit(127);
    }

    close(exec_error_pipe[1]);
    int exec_errno = 0;
    ssize_t read_len = read_initdb_child_error(exec_error_pipe[0], &exec_errno);
    int read_errno = read_len < 0 ? errno : 0;
    close(exec_error_pipe[0]);

    int status = 0;
    pid_t waited;
    do {
        waited = waitpid(pid, &status, 0);
    } while (waited < 0 && errno == EINTR);
    if (waited < 0) {
        snprintf(handle->last_error, sizeof(handle->last_error), "wait for initdb failed: %s", strerror(errno));
        return -1;
    }

    if (read_len < 0) {
        snprintf(handle->last_error, sizeof(handle->last_error), "read initdb exec error failed: %s", strerror(read_errno));
        return -1;
    }
    if (read_len != 0 && read_len != (ssize_t)sizeof(exec_errno)) {
        snprintf(
            handle->last_error,
            sizeof(handle->last_error),
            "read truncated initdb exec error (%zd of %zu bytes)",
            read_len,
            sizeof(exec_errno));
        return -1;
    }
    if (read_len == (ssize_t)sizeof(exec_errno) && exec_errno != 0) {
        snprintf(
            handle->last_error,
            sizeof(handle->last_error),
            "prepare or exec initdb %s failed: %s",
            initdb,
            strerror(exec_errno));
        return -1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        return 0;
    }
    if (WIFEXITED(status)) {
        snprintf(
            handle->last_error,
            sizeof(handle->last_error),
            "initdb %s failed with exit status %d for PGDATA %s",
            initdb,
            WEXITSTATUS(status),
            handle->pgdata);
        return -1;
    }
    if (WIFSIGNALED(status)) {
        snprintf(
            handle->last_error,
            sizeof(handle->last_error),
            "initdb %s terminated by signal %d for PGDATA %s",
            initdb,
            WTERMSIG(status),
            handle->pgdata);
        return -1;
    }
    snprintf(handle->last_error, sizeof(handle->last_error), "initdb %s failed for PGDATA %s", initdb, handle->pgdata);
    return -1;
}
#else
static int run_initdb_command(OliphauntHandle *handle, const char *initdb) {
    (void)initdb;
    snprintf(
        handle->last_error,
        sizeof(handle->last_error),
        "PGDATA %s is not initialized and this platform cannot execute initdb; hydrate the root from packaged template PGDATA before oliphaunt_init",
        handle->pgdata ? handle->pgdata : "(null)");
    return -1;
}
#endif

int oliphaunt_run_initdb_if_needed(OliphauntHandle *handle) {
    char version_path[4096];
    snprintf(version_path, sizeof(version_path), "%s/PG_VERSION", handle->pgdata);
    if (path_exists(version_path)) {
        return 0;
    }

    char *pgdata_parent = oliphaunt_path_parent_dup(handle->pgdata);
    if (pgdata_parent == NULL) {
        snprintf(handle->last_error, sizeof(handle->last_error), "out of memory resolving PGDATA parent for %s", handle->pgdata);
        return -1;
    }
    if (oliphaunt_mkdir_p(pgdata_parent, 0700) != 0) {
        int mkdir_errno = errno;
        snprintf(
            handle->last_error,
            sizeof(handle->last_error),
            "create PGDATA parent directory %s: %s",
            pgdata_parent,
            strerror(mkdir_errno));
        free(pgdata_parent);
        return -1;
    }
    free(pgdata_parent);

    const char *initdb = getenv("OLIPHAUNT_INITDB");
    char *runtime_initdb = NULL;
    if (initdb == NULL || initdb[0] == '\0') {
        runtime_initdb = runtime_tool_path(handle->runtime_dir, "initdb");
        initdb = runtime_initdb;
        if (initdb == NULL) {
            initdb = "initdb";
        }
    }

    int rc = run_initdb_command(handle, initdb);
    free(runtime_initdb);
    return rc;
}
