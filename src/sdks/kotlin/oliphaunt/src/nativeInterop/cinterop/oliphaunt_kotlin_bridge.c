#define _XOPEN_SOURCE 700

#include "oliphaunt_kotlin_bridge.h"

#include <dlfcn.h>
#include <ftw.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef RTLD_DEFAULT
#define RTLD_DEFAULT ((void *)-2)
#endif

typedef int32_t (*OliphauntInitFn)(const OliphauntConfig *config, OliphauntHandle **out);
typedef int32_t (*OliphauntExecProtocolFn)(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out);
typedef int32_t (*OliphauntExecProtocolStreamFn)(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context);
typedef int32_t (*OliphauntCancelFn)(OliphauntHandle *handle);
typedef int32_t (*OliphauntDetachFn)(OliphauntHandle *handle);
typedef int32_t (*OliphauntCloseFn)(OliphauntHandle *handle);
typedef const char *(*OliphauntLastErrorFn)(OliphauntHandle *handle);
typedef uint64_t (*OliphauntCapabilitiesFn)(void);
typedef void (*OliphauntFreeResponseFn)(OliphauntResponse *response);
typedef int32_t (*OliphauntBackupFn)(OliphauntHandle *handle, uint32_t format, OliphauntResponse *out);
typedef int32_t (*OliphauntRestoreFn)(const OliphauntRestoreOptions *options);

typedef struct OliphauntKotlinSymbols {
    void *library;
    bool owns_library;
    OliphauntInitFn init;
    OliphauntExecProtocolFn exec_protocol;
    OliphauntExecProtocolStreamFn exec_protocol_stream;
    OliphauntCancelFn cancel;
    OliphauntDetachFn detach;
    OliphauntCloseFn close;
    OliphauntLastErrorFn last_error;
    OliphauntCapabilitiesFn capabilities;
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
        symbols->library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
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
        load_symbol(symbols, "oliphaunt_exec_protocol_stream", (void **)&symbols->exec_protocol_stream) != 0 ||
        load_symbol(symbols, "oliphaunt_cancel", (void **)&symbols->cancel) != 0 ||
        load_symbol(symbols, "oliphaunt_detach", (void **)&symbols->detach) != 0 ||
        load_symbol(symbols, "oliphaunt_close", (void **)&symbols->close) != 0 ||
        load_symbol(symbols, "oliphaunt_last_error", (void **)&symbols->last_error) != 0 ||
        load_symbol(symbols, "oliphaunt_capabilities", (void **)&symbols->capabilities) != 0 ||
        load_symbol(symbols, "oliphaunt_free_response", (void **)&symbols->free_response) != 0 ||
        load_symbol(symbols, "oliphaunt_backup", (void **)&symbols->backup) != 0 ||
        load_symbol(symbols, "oliphaunt_restore", (void **)&symbols->restore) != 0) {
        unload_symbols(symbols);
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

int32_t oliphaunt_kotlin_exec_protocol_stream(
    OliphauntKotlinSession *session,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context) {
    if (session == NULL || callback == NULL) {
        set_session_error(session, "invalid oliphaunt_kotlin_exec_protocol_stream arguments");
        return -1;
    }
    int32_t rc = session->symbols.exec_protocol_stream(
        session->handle,
        request,
        request_len,
        callback,
        callback_context);
    if (rc != 0 && session->symbols.last_error != NULL) {
        set_session_error(session, session->symbols.last_error(session->handle));
    }
    return rc;
}

int32_t oliphaunt_kotlin_backup(OliphauntKotlinSession *session, uint32_t format, OliphauntResponse *out) {
    if (session == NULL || out == NULL) {
        set_session_error(session, "invalid oliphaunt_kotlin_backup arguments");
        return -1;
    }
    int32_t rc = session->symbols.backup(session->handle, format, out);
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
        session->handle = NULL;
    }
    unload_symbols(&session->symbols);
    free(session);
    return rc;
}

const char *oliphaunt_kotlin_last_error(OliphauntKotlinSession *session) {
    return session != NULL ? session->last_error : global_last_error;
}

uint64_t oliphaunt_kotlin_capabilities(OliphauntKotlinSession *session) {
    if (session == NULL || session->symbols.capabilities == NULL) {
        return 0;
    }
    return session->symbols.capabilities();
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
