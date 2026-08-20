#define _XOPEN_SOURCE 700

#include "oliphaunt_kotlin_bridge.h"

#include <dlfcn.h>
#include <dirent.h>
#include <errno.h>
#include <ftw.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef RTLD_DEFAULT
#define RTLD_DEFAULT ((void *)-2)
#endif

typedef int32_t (*OliphauntInitFn)(const OliphauntConfig *config, OliphauntHandle **out);
typedef int32_t (*OliphauntExecProtocolFn)(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out);
typedef int32_t (*OliphauntCancelFn)(OliphauntHandle *handle);
typedef int32_t (*OliphauntDetachFn)(OliphauntHandle *handle);
typedef int32_t (*OliphauntCloseFn)(OliphauntHandle *handle);
typedef const char *(*OliphauntLastErrorFn)(OliphauntHandle *handle);
typedef void (*OliphauntFreeResponseFn)(OliphauntResponse *response);
typedef int32_t (*OliphauntBackupFn)(
    OliphauntHandle *handle,
    OliphauntResponse *out);
typedef int32_t (*OliphauntRestoreFn)(const OliphauntRestoreOptions *options);

typedef struct OliphauntKotlinSymbols {
    void *library;
    bool owns_library;
    OliphauntInitFn init;
    OliphauntExecProtocolFn exec_protocol;
    OliphauntCancelFn cancel;
    OliphauntDetachFn detach;
    OliphauntCloseFn close;
    OliphauntLastErrorFn last_error;
    OliphauntFreeResponseFn free_response;
    OliphauntBackupFn backup;
    OliphauntRestoreFn restore;
} OliphauntKotlinSymbols;

struct OliphauntKotlinSession {
    OliphauntKotlinSymbols symbols;
    OliphauntHandle *handle;
    char last_error[1024];
};

static char global_last_error[1024];

static void set_global_error(const char *message) {
    snprintf(global_last_error, sizeof(global_last_error), "%s", message ? message : "unknown liboliphaunt Kotlin bridge error");
}

static void set_session_error(OliphauntKotlinSession *session, const char *message) {
    if (session == NULL) {
        set_global_error(message);
        return;
    }
    snprintf(session->last_error, sizeof(session->last_error), "%s", message ? message : "unknown liboliphaunt Kotlin bridge error");
}

static const char *env_library_path(void) {
    const char *path = getenv("OLIPHAUNT_KOTLIN_LIBRARY");
    if (path == NULL || path[0] == '\0') {
        path = getenv("LIBOLIPHAUNT_PATH");
    }
    if (path == NULL || path[0] == '\0') {
        path = getenv("OLIPHAUNT_LIBRARY");
    }
    return path != NULL && path[0] != '\0' ? path : NULL;
}

static void *symbol_lookup_handle(OliphauntKotlinSymbols *symbols) {
    return symbols->library != NULL ? symbols->library : RTLD_DEFAULT;
}

static int load_symbol(OliphauntKotlinSymbols *symbols, const char *name, void **out) {
    dlerror();
    *out = dlsym(symbol_lookup_handle(symbols), name);
    const char *error = dlerror();
    if (error != NULL || *out == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "liboliphaunt symbol %s is unavailable: %s", name, error ? error : "symbol not found");
        set_global_error(message);
        return -1;
    }
    return 0;
}

static void unload_symbols(OliphauntKotlinSymbols *symbols) {
    /*
     * liboliphaunt embeds PostgreSQL, which owns process-global runtime state
     * while a backend session is active. Ordinary SDK close calls oliphaunt_detach;
     * oliphaunt_close is terminal for the process lifetime. Unloading the code
     * image can leave host-process callbacks or handlers pointing at unmapped
     * addresses. Keep the native engine resident once it has been loaded.
     */
    memset(symbols, 0, sizeof(*symbols));
}

static int load_symbols(const char *library_path, OliphauntKotlinSymbols *symbols) {
    memset(symbols, 0, sizeof(*symbols));

    const char *path = library_path != NULL && library_path[0] != '\0'
        ? library_path
        : env_library_path();
    if (path != NULL) {
        symbols->library = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
        if (symbols->library == NULL) {
            char message[1024];
            snprintf(message, sizeof(message), "failed to load liboliphaunt at %s: %s", path, dlerror());
            set_global_error(message);
            return -1;
        }
        symbols->owns_library = true;
    }

    if (load_symbol(symbols, "oliphaunt_init", (void **)&symbols->init) != 0 ||
        load_symbol(symbols, "oliphaunt_exec_protocol", (void **)&symbols->exec_protocol) != 0 ||
        load_symbol(symbols, "oliphaunt_cancel", (void **)&symbols->cancel) != 0 ||
        load_symbol(symbols, "oliphaunt_detach", (void **)&symbols->detach) != 0 ||
        load_symbol(symbols, "oliphaunt_close", (void **)&symbols->close) != 0 ||
        load_symbol(symbols, "oliphaunt_last_error", (void **)&symbols->last_error) != 0 ||
        load_symbol(symbols, "oliphaunt_free_response", (void **)&symbols->free_response) != 0 ||
        load_symbol(symbols, "oliphaunt_backup", (void **)&symbols->backup) != 0 ||
        load_symbol(symbols, "oliphaunt_restore", (void **)&symbols->restore) != 0) {
        unload_symbols(symbols);
        return -1;
    }

    return 0;
}

static int remove_tree_entry(const char *path, const struct stat *statbuf, int typeflag, struct FTW *ftwbuf);

static void remove_partial_pgdata(const char *pgdata) {
    struct stat status;
    if (pgdata != NULL && lstat(pgdata, &status) == 0) {
        (void)nftw(pgdata, remove_tree_entry, 64, FTW_DEPTH | FTW_PHYS);
    }
}

static bool root_is_empty(const char *root) {
    DIR *directory = opendir(root);
    if (directory == NULL) {
        return false;
    }
    bool empty = true;
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
            empty = false;
            break;
        }
    }
    if (errno != 0) {
        empty = false;
    }
    closedir(directory);
    return empty;
}

static bool real_directory(const char *path) {
    struct stat status;
    return lstat(path, &status) == 0 && S_ISDIR(status.st_mode);
}

static bool nonempty_regular_file(const char *path) {
    struct stat status;
    return lstat(path, &status) == 0 && S_ISREG(status.st_mode) && status.st_size > 0;
}

static bool complete_postgres_18_pgdata(const char *pgdata) {
    char version_path[PATH_MAX];
    char global_path[PATH_MAX];
    char control_path[PATH_MAX];
    char wal_path[PATH_MAX];
    if (snprintf(version_path, sizeof(version_path), "%s/PG_VERSION", pgdata) >= (int)sizeof(version_path) ||
        snprintf(global_path, sizeof(global_path), "%s/global", pgdata) >= (int)sizeof(global_path) ||
        snprintf(control_path, sizeof(control_path), "%s/global/pg_control", pgdata) >= (int)sizeof(control_path) ||
        snprintf(wal_path, sizeof(wal_path), "%s/pg_wal", pgdata) >= (int)sizeof(wal_path)) {
        return false;
    }
    if (!nonempty_regular_file(version_path) || !real_directory(global_path) ||
        !nonempty_regular_file(control_path) || !real_directory(wal_path)) {
        return false;
    }
    FILE *version = fopen(version_path, "rb");
    if (version == NULL) {
        return false;
    }
    char text[32] = {0};
    size_t length = fread(text, 1, sizeof(text) - 1, version);
    bool read_ok = ferror(version) == 0;
    fclose(version);
    while (length > 0 && (text[length - 1] == '\n' || text[length - 1] == '\r' ||
                          text[length - 1] == ' ' || text[length - 1] == '\t')) {
        text[--length] = '\0';
    }
    return read_ok && strcmp(text, "18") == 0;
}

static int write_root_descriptor(const char *root) {
    static const char descriptor_json[] =
        "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\"}\n";
    char descriptor[PATH_MAX];
    char temporary[PATH_MAX];
    if (snprintf(descriptor, sizeof(descriptor), "%s/.oliphaunt.json", root) >= (int)sizeof(descriptor) ||
        snprintf(temporary, sizeof(temporary), "%s/.oliphaunt.json.tmp.XXXXXX", root) >= (int)sizeof(temporary)) {
        set_global_error("database root descriptor path is too long");
        return -1;
    }
    int fd = mkstemp(temporary);
    if (fd < 0) {
        set_global_error("failed to create database root descriptor");
        return -1;
    }
    const char *cursor = descriptor_json;
    size_t remaining = sizeof(descriptor_json) - 1;
    while (remaining > 0) {
        ssize_t written = write(fd, cursor, remaining);
        if (written > 0) {
            cursor += written;
            remaining -= (size_t)written;
            continue;
        }
        if (written < 0 && errno == EINTR) {
            continue;
        }
        close(fd);
        unlink(temporary);
        set_global_error("failed to write database root descriptor");
        return -1;
    }
    int sync_result = fsync(fd);
    int close_result = close(fd);
    if (sync_result != 0 || close_result != 0) {
        unlink(temporary);
        set_global_error("failed to persist database root descriptor");
        return -1;
    }
    if (link(temporary, descriptor) != 0) {
        unlink(temporary);
        set_global_error("failed to publish database root descriptor");
        return -1;
    }
    unlink(temporary);
    return 0;
}

int32_t oliphaunt_kotlin_initialize_root(
    const char *root,
    const char *runtime_directory,
    const char *username) {
    if (root == NULL || root[0] == '\0') {
        set_global_error("database storage directory must not be empty");
        return -1;
    }
    char descriptor[PATH_MAX];
    char pgdata[PATH_MAX];
    if (snprintf(descriptor, sizeof(descriptor), "%s/.oliphaunt.json", root) >= (int)sizeof(descriptor) ||
        snprintf(pgdata, sizeof(pgdata), "%s/pgdata", root) >= (int)sizeof(pgdata)) {
        set_global_error("database storage path is too long");
        return -1;
    }
    struct stat status;
    if (lstat(descriptor, &status) == 0) {
        return 0;
    }
    if (errno != ENOENT) {
        set_global_error("failed to inspect database root descriptor");
        return -1;
    }
    if (!root_is_empty(root)) {
        set_global_error("database storage directory is nonempty but has no .oliphaunt.json descriptor");
        return -1;
    }

    const char *configured_initdb = getenv("OLIPHAUNT_INITDB");
    char packaged_initdb[PATH_MAX];
    const char *initdb = configured_initdb;
    if (initdb == NULL || initdb[0] == '\0') {
        if (runtime_directory == NULL || runtime_directory[0] == '\0' ||
            snprintf(packaged_initdb, sizeof(packaged_initdb), "%s/bin/initdb", runtime_directory) >= (int)sizeof(packaged_initdb)) {
            set_global_error("new Kotlin/Native database storage requires packaged initdb; set OLIPHAUNT_INSTALL_DIR or OLIPHAUNT_INITDB");
            return -1;
        }
        initdb = packaged_initdb;
    }
    if (access(initdb, X_OK) != 0) {
        set_global_error("packaged initdb is not executable");
        return -1;
    }

    pid_t child = fork();
    if (child < 0) {
        set_global_error("failed to fork packaged initdb");
        return -1;
    }
    if (child == 0) {
        if (runtime_directory != NULL && runtime_directory[0] != '\0') {
            char library_path[PATH_MAX * 2];
#ifdef __APPLE__
            const char *library_variable = "DYLD_LIBRARY_PATH";
#else
            const char *library_variable = "LD_LIBRARY_PATH";
#endif
            const char *inherited = getenv(library_variable);
            int library_length = snprintf(
                    library_path,
                    sizeof(library_path),
                    inherited != NULL && inherited[0] != '\0' ? "%s/lib:%s" : "%s/lib",
                    runtime_directory,
                    inherited);
            if (library_length >= 0 && library_length < (int)sizeof(library_path)) {
                (void)setenv(library_variable, library_path, 1);
            }
            char icu_data[PATH_MAX];
            if (snprintf(icu_data, sizeof(icu_data), "%s/share/icu", runtime_directory) < (int)sizeof(icu_data) &&
                real_directory(icu_data)) {
                (void)setenv("ICU_DATA", icu_data, 1);
            }
        }
        execl(
            initdb,
            initdb,
            "-D",
            pgdata,
            "-U",
            username != NULL && username[0] != '\0' ? username : "postgres",
            "--auth=trust",
            "--locale-provider=libc",
            "--locale=C",
            "--encoding=UTF8",
            (char *)NULL);
        _exit(127);
    }

    int child_status = 0;
    pid_t waited;
    do {
        waited = waitpid(child, &child_status, 0);
    } while (waited < 0 && errno == EINTR);
    if (waited < 0 || !WIFEXITED(child_status) || WEXITSTATUS(child_status) != 0) {
        remove_partial_pgdata(pgdata);
        set_global_error("packaged initdb failed to initialize PostgreSQL 18 PGDATA");
        return -1;
    }
    if (!complete_postgres_18_pgdata(pgdata)) {
        remove_partial_pgdata(pgdata);
        set_global_error("packaged initdb did not create complete PostgreSQL 18 PGDATA");
        return -1;
    }
    if (write_root_descriptor(root) != 0) {
        remove_partial_pgdata(pgdata);
        return -1;
    }
    return 0;
}

OliphauntKotlinSession *oliphaunt_kotlin_open(
    const char *library_path,
    const OliphauntConfig *config) {
    if (config == NULL) {
        set_global_error("oliphaunt_kotlin_open config is null");
        return NULL;
    }

    OliphauntKotlinSession *session = (OliphauntKotlinSession *)calloc(1, sizeof(OliphauntKotlinSession));
    if (session == NULL) {
        set_global_error("out of memory allocating OliphauntKotlinSession");
        return NULL;
    }
    if (load_symbols(library_path, &session->symbols) != 0) {
        free(session);
        return NULL;
    }
    if (session->symbols.init(config, &session->handle) != 0) {
        const char *error = session->symbols.last_error != NULL
            ? session->symbols.last_error(session->handle)
            : NULL;
        set_global_error(error);
        unload_symbols(&session->symbols);
        free(session);
        return NULL;
    }

    return session;
}

int32_t oliphaunt_kotlin_exec_protocol(
    OliphauntKotlinSession *session,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out) {
    if (session == NULL || out == NULL) {
        set_session_error(session, "invalid oliphaunt_kotlin_exec_protocol arguments");
        return -1;
    }
    int32_t rc = session->symbols.exec_protocol(session->handle, request, request_len, out);
    if (rc != 0 && session->symbols.last_error != NULL) {
        set_session_error(session, session->symbols.last_error(session->handle));
    }
    return rc;
}

int32_t oliphaunt_kotlin_backup(OliphauntKotlinSession *session, OliphauntResponse *out) {
    if (session == NULL || out == NULL) {
        set_session_error(session, "invalid oliphaunt_kotlin_backup arguments");
        return -1;
    }
    int32_t rc = session->symbols.backup(session->handle, out);
    if (rc != 0 && session->symbols.last_error != NULL) {
        set_session_error(session, session->symbols.last_error(session->handle));
    }
    return rc;
}

int32_t oliphaunt_kotlin_restore(const char *library_path, const OliphauntRestoreOptions *options) {
    OliphauntKotlinSymbols symbols;
    if (load_symbols(library_path, &symbols) != 0) {
        return -1;
    }
    int32_t rc = symbols.restore(options);
    if (rc != 0 && symbols.last_error != NULL) {
        set_global_error(symbols.last_error(NULL));
    }
    unload_symbols(&symbols);
    return rc;
}

int32_t oliphaunt_kotlin_cancel(OliphauntKotlinSession *session) {
    if (session == NULL) {
        set_global_error("invalid oliphaunt_kotlin_cancel arguments");
        return -1;
    }
    int32_t rc = session->symbols.cancel(session->handle);
    if (rc != 0 && session->symbols.last_error != NULL) {
        set_session_error(session, session->symbols.last_error(session->handle));
    }
    return rc;
}

int32_t oliphaunt_kotlin_close(OliphauntKotlinSession *session) {
    if (session == NULL) {
        return 0;
    }
    int32_t rc = 0;
    if (session->symbols.detach != NULL && session->handle != NULL) {
        rc = session->symbols.detach(session->handle);
        if (rc != 0 && session->symbols.last_error != NULL) {
            const char *message = session->symbols.last_error(session->handle);
            set_session_error(session, message);
            set_global_error(message);
        }
        if (rc != 0) {
            return rc;
        }
        session->handle = NULL;
    }
    unload_symbols(&session->symbols);
    free(session);
    return rc;
}

const char *oliphaunt_kotlin_last_error(OliphauntKotlinSession *session) {
    return session != NULL ? session->last_error : global_last_error;
}

void oliphaunt_kotlin_free_response(OliphauntKotlinSession *session, OliphauntResponse *response) {
    if (session == NULL || response == NULL || session->symbols.free_response == NULL) {
        return;
    }
    session->symbols.free_response(response);
}

static int remove_tree_entry(const char *path, const struct stat *statbuf, int typeflag, struct FTW *ftwbuf) {
    (void)statbuf;
    (void)typeflag;
    (void)ftwbuf;
    return remove(path);
}

int32_t oliphaunt_kotlin_remove_tree(const char *path) {
    if (path == NULL || path[0] == '\0') {
        return -1;
    }
    return nftw(path, remove_tree_entry, 64, FTW_DEPTH | FTW_PHYS);
}
