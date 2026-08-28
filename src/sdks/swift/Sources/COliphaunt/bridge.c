#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE 1
#endif

#include "COliphaunt.h"

#include <dlfcn.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int32_t (*OliphauntInitFn)(const OliphauntConfig *config, OliphauntHandle **out);
typedef int32_t (*OliphauntExecProtocolFn)(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out);
typedef int32_t (*OliphauntExecProtocolRawStreamFn)(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context);
typedef int32_t (*OliphauntCancelFn)(OliphauntHandle *handle);
typedef int32_t (*OliphauntDetachFn)(OliphauntHandle *handle);
typedef int32_t (*OliphauntCloseFn)(OliphauntHandle *handle);
typedef int32_t (*OliphauntRegisterStaticExtensionsFn)(const OliphauntStaticExtension *extensions, size_t count);
typedef const OliphauntStaticExtension *(*OliphauntSelectedStaticExtensionsFn)(size_t *count);
typedef size_t (*OliphauntCopyLastErrorFn)(
    OliphauntHandle *handle,
    char *out,
    size_t capacity);
typedef const char *(*OliphauntVersionFn)(void);
typedef void (*OliphauntFreeResponseFn)(OliphauntResponse *response);
typedef int32_t (*OliphauntBackupFn)(
    OliphauntHandle *handle,
    OliphauntResponse *out);
typedef int32_t (*OliphauntRestoreFn)(const OliphauntRestoreOptions *options);

typedef struct OliphauntSymbols {
    void *library;
    bool owns_library;
    OliphauntInitFn init;
    OliphauntExecProtocolFn exec_protocol;
    OliphauntExecProtocolRawStreamFn exec_protocol_raw_stream;
    OliphauntCancelFn cancel;
    OliphauntDetachFn detach;
    OliphauntCloseFn close;
    OliphauntRegisterStaticExtensionsFn register_static_extensions;
    OliphauntCopyLastErrorFn copy_last_error;
    OliphauntVersionFn version;
    OliphauntFreeResponseFn free_response;
    OliphauntBackupFn backup;
    OliphauntRestoreFn restore;
} OliphauntSymbols;

struct OliphauntSession {
    OliphauntSymbols symbols;
    OliphauntHandle *handle;
    pthread_mutex_t error_lock;
    char *last_error;
};

static char *global_last_error;
static pthread_mutex_t global_error_lock = PTHREAD_MUTEX_INITIALIZER;

static void set_global_error(const char *message) {
    const char *resolved = message ? message : "unknown liboliphaunt Swift bridge error";
    char *owned = strdup(resolved);
    pthread_mutex_lock(&global_error_lock);
    if (owned != NULL) {
        free(global_last_error);
        global_last_error = owned;
    }
    pthread_mutex_unlock(&global_error_lock);
}

static void set_session_error(OliphauntSession *session, const char *message) {
    if (session == NULL) {
        set_global_error(message);
        return;
    }
    const char *resolved = message ? message : "unknown liboliphaunt Swift bridge error";
    char *owned = strdup(resolved);
    pthread_mutex_lock(&session->error_lock);
    if (owned != NULL) {
        free(session->last_error);
        session->last_error = owned;
    }
    pthread_mutex_unlock(&session->error_lock);
}

static char *copy_native_error(
    OliphauntSymbols *symbols,
    OliphauntHandle *handle,
    const char *fallback) {
    if (symbols == NULL || symbols->copy_last_error == NULL) {
        return strdup(fallback);
    }
    size_t required = symbols->copy_last_error(handle, NULL, 0);
    for (int attempt = 0; attempt < 3 && required < SIZE_MAX; attempt += 1) {
        char *message = (char *)calloc(required + 1, 1);
        if (message == NULL) {
            break;
        }
        size_t current_required = symbols->copy_last_error(
            handle,
            message,
            required + 1);
        if (current_required <= required) {
            if (message[0] != '\0') {
                return message;
            }
            free(message);
            break;
        }
        free(message);
        required = current_required;
    }
    return strdup(fallback);
}

static void set_global_native_error(
    OliphauntSymbols *symbols,
    OliphauntHandle *handle,
    const char *fallback) {
    char *message = copy_native_error(
        symbols,
        handle,
        fallback);
    set_global_error(message);
    free(message);
}

static void set_session_native_error(
    OliphauntSession *session,
    const char *fallback) {
    if (session == NULL) {
        set_global_error(fallback);
        return;
    }
    char *message = copy_native_error(
        &session->symbols,
        session->handle,
        fallback);
    set_session_error(session, message);
    free(message);
}

static const char *env_library_path(void) {
    const char *path = getenv("OLIPHAUNT_SWIFT_LIBRARY");
    if (path == NULL || path[0] == '\0') {
        path = getenv("LIBOLIPHAUNT_PATH");
    }
    if (path == NULL || path[0] == '\0') {
        path = getenv("OLIPHAUNT_LIBRARY");
    }
    return path != NULL && path[0] != '\0' ? path : NULL;
}

static void *symbol_lookup_handle(OliphauntSymbols *symbols) {
    return symbols->library != NULL ? symbols->library : RTLD_DEFAULT;
}

static int load_symbol(OliphauntSymbols *symbols, const char *name, void **out) {
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

static void unload_symbols(OliphauntSymbols *symbols) {
    /*
     * liboliphaunt embeds PostgreSQL, which owns process-global runtime state
     * while a backend session is active. Ordinary SDK close calls oliphaunt_detach;
     * oliphaunt_close is terminal for the process lifetime. Unloading the code
     * image can leave host-process callbacks or handlers pointing at unmapped
     * addresses. Keep the native engine resident once it has been loaded.
     */
    memset(symbols, 0, sizeof(*symbols));
}

static int load_symbols(const char *library_path, OliphauntSymbols *symbols) {
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
        load_symbol(symbols, "oliphaunt_exec_protocol_raw_stream", (void **)&symbols->exec_protocol_raw_stream) != 0 ||
        load_symbol(symbols, "oliphaunt_cancel", (void **)&symbols->cancel) != 0 ||
        load_symbol(symbols, "oliphaunt_detach", (void **)&symbols->detach) != 0 ||
        load_symbol(symbols, "oliphaunt_close", (void **)&symbols->close) != 0 ||
        load_symbol(symbols, "oliphaunt_register_static_extensions", (void **)&symbols->register_static_extensions) != 0 ||
        load_symbol(symbols, "oliphaunt_copy_last_error", (void **)&symbols->copy_last_error) != 0 ||
        load_symbol(symbols, "oliphaunt_version", (void **)&symbols->version) != 0 ||
        load_symbol(symbols, "oliphaunt_free_response", (void **)&symbols->free_response) != 0 ||
        load_symbol(symbols, "oliphaunt_backup", (void **)&symbols->backup) != 0 ||
        load_symbol(symbols, "oliphaunt_restore", (void **)&symbols->restore) != 0) {
        unload_symbols(symbols);
        return -1;
    }

    return 0;
}

static int register_selected_static_extensions(OliphauntSymbols *symbols) {
    dlerror();
    OliphauntSelectedStaticExtensionsFn selected = NULL;
    if (symbols->library != NULL) {
        selected = (OliphauntSelectedStaticExtensionsFn)dlsym(
            symbols->library,
            "liboliphaunt_selected_static_extensions");
        const char *library_error = dlerror();
        if (library_error != NULL) {
            selected = NULL;
        }
        dlerror();
    }
    if (selected == NULL) {
        selected = (OliphauntSelectedStaticExtensionsFn)dlsym(
            RTLD_DEFAULT,
            "liboliphaunt_selected_static_extensions");
    }
    const char *error = dlerror();
    if (selected == NULL || error != NULL) {
        return 0;
    }
    size_t count = 0;
    const OliphauntStaticExtension *extensions = selected(&count);
    if (count == 0) {
        return 0;
    }
    if (extensions == NULL) {
        set_global_error("selected liboliphaunt static extension registry returned null extensions");
        return -1;
    }
    if (symbols->register_static_extensions(extensions, count) != 0) {
        set_global_native_error(
            symbols,
            NULL,
            "liboliphaunt static extension registration failed");
        return -1;
    }
    return 0;
}

int32_t oliphaunt_swift_open(
    const char *library_path,
    const OliphauntConfig *config,
    OliphauntSession **out) {
    if (out == NULL) {
        set_global_error("oliphaunt_swift_open out parameter is null");
        return -1;
    }
    *out = NULL;
    if (config == NULL) {
        set_global_error("oliphaunt_swift_open config is null");
        return -1;
    }

    OliphauntSession *session = (OliphauntSession *)calloc(1, sizeof(OliphauntSession));
    if (session == NULL) {
        set_global_error("out of memory allocating OliphauntSession");
        return -1;
    }
    int error_lock_status = pthread_mutex_init(&session->error_lock, NULL);
    if (error_lock_status != 0) {
        char message[256];
        snprintf(
            message,
            sizeof(message),
            "failed to initialize OliphauntSession error mutex: %s (%d)",
            strerror(error_lock_status),
            error_lock_status);
        set_global_error(message);
        free(session);
        return -1;
    }
    if (load_symbols(library_path, &session->symbols) != 0) {
        pthread_mutex_destroy(&session->error_lock);
        free(session->last_error);
        free(session);
        return -1;
    }
    if (register_selected_static_extensions(&session->symbols) != 0) {
        unload_symbols(&session->symbols);
        pthread_mutex_destroy(&session->error_lock);
        free(session->last_error);
        free(session);
        return -1;
    }
    if (session->symbols.init(config, &session->handle) != 0) {
        set_global_native_error(
            &session->symbols,
            session->handle,
            "unknown liboliphaunt Swift runtime error");
        unload_symbols(&session->symbols);
        pthread_mutex_destroy(&session->error_lock);
        free(session->last_error);
        free(session);
        return -1;
    }

    *out = session;
    return 0;
}

int32_t oliphaunt_swift_exec_protocol(
    OliphauntSession *session,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out) {
    if (session == NULL || out == NULL) {
        set_session_error(session, "invalid oliphaunt_swift_exec_protocol arguments");
        return -1;
    }
    int32_t rc = session->symbols.exec_protocol(session->handle, request, request_len, out);
    if (rc != 0) {
        set_session_native_error(session, "unknown liboliphaunt Swift runtime error");
    }
    return rc;
}

int32_t oliphaunt_swift_exec_protocol_raw_stream(
    OliphauntSession *session,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context) {
    if (session == NULL || callback == NULL) {
        set_session_error(session, "invalid oliphaunt_swift_exec_protocol_raw_stream arguments");
        return -1;
    }
    int32_t rc = session->symbols.exec_protocol_raw_stream(
        session->handle,
        request,
        request_len,
        callback,
        callback_context);
    if (rc != 0) {
        set_session_native_error(session, "unknown liboliphaunt Swift runtime error");
    }
    return rc;
}

int32_t oliphaunt_swift_backup(OliphauntSession *session, OliphauntResponse *out) {
    if (session == NULL || out == NULL) {
        set_session_error(session, "invalid oliphaunt_swift_backup arguments");
        return -1;
    }
    int32_t rc = session->symbols.backup(session->handle, out);
    if (rc != 0) {
        set_session_native_error(session, "unknown liboliphaunt Swift runtime error");
    }
    return rc;
}

int32_t oliphaunt_swift_restore(const char *library_path, const OliphauntRestoreOptions *options) {
    OliphauntSymbols symbols;
    if (load_symbols(library_path, &symbols) != 0) {
        return -1;
    }
    int32_t rc = symbols.restore(options);
    if (rc != 0) {
        set_global_native_error(
            &symbols,
            NULL,
            "unknown liboliphaunt Swift restore error");
    }
    unload_symbols(&symbols);
    return rc;
}

int32_t oliphaunt_swift_cancel(OliphauntSession *session) {
    if (session == NULL) {
        set_global_error("invalid oliphaunt_swift_cancel arguments");
        return -1;
    }
    int32_t rc = session->symbols.cancel(session->handle);
    if (rc != 0) {
        set_session_native_error(session, "unknown liboliphaunt Swift runtime error");
    }
    return rc;
}

int32_t oliphaunt_swift_close(OliphauntSession *session) {
    if (session == NULL) {
        return 0;
    }
    int32_t rc = 0;
    if (session->symbols.detach != NULL && session->handle != NULL) {
        rc = session->symbols.detach(session->handle);
        if (rc != 0) {
            set_session_native_error(session, "unknown liboliphaunt Swift close error");
            pthread_mutex_lock(&session->error_lock);
            set_global_error(session->last_error);
            pthread_mutex_unlock(&session->error_lock);
        }
        if (rc != 0) {
            return rc;
        }
        session->handle = NULL;
    }
    unload_symbols(&session->symbols);
    free(session->last_error);
    pthread_mutex_destroy(&session->error_lock);
    free(session);
    return rc;
}

size_t oliphaunt_swift_copy_last_error(
    OliphauntSession *session,
    char *out,
    size_t capacity) {
    pthread_mutex_t *lock = session != NULL ? &session->error_lock : &global_error_lock;
    pthread_mutex_lock(lock);
    const char *message = session != NULL ? session->last_error : global_last_error;
    if (message == NULL) {
        message = "unknown liboliphaunt Swift bridge error";
    }
    size_t length = strlen(message);
    if (capacity > 0 && out != NULL) {
        size_t copied = length < capacity - 1 ? length : capacity - 1;
        memcpy(out, message, copied);
        out[copied] = '\0';
    }
    pthread_mutex_unlock(lock);
    return length;
}

const char *oliphaunt_swift_version(OliphauntSession *session) {
    if (session == NULL || session->symbols.version == NULL) {
        return "";
    }
    return session->symbols.version();
}

void oliphaunt_swift_free_response(OliphauntSession *session, OliphauntResponse *response) {
    if (session == NULL || response == NULL || session->symbols.free_response == NULL) {
        return;
    }
    session->symbols.free_response(response);
}
