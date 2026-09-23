#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "liboliphaunt_internal.h"

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif
#define OLIPHAUNT_DESKTOP_DYNAMIC_SCOPE 0
#if defined(__linux__) && !defined(__ANDROID__)
#undef OLIPHAUNT_DESKTOP_DYNAMIC_SCOPE
#define OLIPHAUNT_DESKTOP_DYNAMIC_SCOPE 1
#elif defined(__APPLE__)
#if TARGET_OS_OSX
#undef OLIPHAUNT_DESKTOP_DYNAMIC_SCOPE
#define OLIPHAUNT_DESKTOP_DYNAMIC_SCOPE 1
#endif
#endif
#if OLIPHAUNT_DESKTOP_DYNAMIC_SCOPE
#include <dlfcn.h>
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static pthread_mutex_t global_instance_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t global_instance_cond = PTHREAD_COND_INITIALIZER;
static pthread_once_t process_exit_shutdown_once = PTHREAD_ONCE_INIT;
#if OLIPHAUNT_DESKTOP_DYNAMIC_SCOPE
static pthread_once_t extension_symbol_scope_once = PTHREAD_ONCE_INIT;
static void *extension_symbol_scope_handle = NULL;
static int extension_symbol_scope_status = -1;
static char extension_symbol_scope_error[512];
#endif
static enum {
    OLIPHAUNT_GLOBAL_UNUSED = 0,
    OLIPHAUNT_GLOBAL_ACTIVE,
    OLIPHAUNT_GLOBAL_SPENT,
} global_instance_state = OLIPHAUNT_GLOBAL_UNUSED;
static OliphauntHandle *global_instance = NULL;
static size_t global_active_handle_calls = 0;
static bool global_handle_retirement = false;

#if defined(_MSC_VER)
#define OLIPHAUNT_PROCESS_THREAD_LOCAL __declspec(thread)
#else
#define OLIPHAUNT_PROCESS_THREAD_LOCAL _Thread_local
#endif

/* Only the retirement owner may promote a poisoned detach to terminal close. */
static OLIPHAUNT_PROCESS_THREAD_LOCAL OliphauntHandle *owned_retirement_handle;

static bool current_instance_locked(OliphauntHandle *handle) {
    return global_instance_state == OLIPHAUNT_GLOBAL_ACTIVE &&
        global_instance != NULL && global_instance == handle;
}

static void set_stale_handle_error(void) {
    set_error(NULL, "native liboliphaunt handle is stale or terminally closed");
}

int oliphaunt_begin_handle_call(OliphauntHandle *handle) {
    if (handle == NULL) {
        set_error(NULL, "native liboliphaunt handle is null");
        return -1;
    }

    pthread_mutex_lock(&global_instance_mutex);
    if (!current_instance_locked(handle)) {
        pthread_mutex_unlock(&global_instance_mutex);
        set_stale_handle_error();
        return -1;
    }
    if (global_handle_retirement && owned_retirement_handle != handle) {
        pthread_mutex_unlock(&global_instance_mutex);
        set_error(NULL, "native liboliphaunt logical handle is closing");
        return -1;
    }
    global_active_handle_calls++;
    pthread_mutex_unlock(&global_instance_mutex);
    return 0;
}

bool oliphaunt_try_begin_handle_call(OliphauntHandle *handle) {
    if (handle == NULL) {
        return false;
    }
    pthread_mutex_lock(&global_instance_mutex);
    bool acquired = current_instance_locked(handle) && !global_handle_retirement;
    if (acquired) {
        global_active_handle_calls++;
    }
    pthread_mutex_unlock(&global_instance_mutex);
    return acquired;
}

void oliphaunt_end_handle_call(void) {
    pthread_mutex_lock(&global_instance_mutex);
    if (global_active_handle_calls > 0) {
        global_active_handle_calls--;
        if (global_active_handle_calls == 0) {
            pthread_cond_broadcast(&global_instance_cond);
        }
    }
    pthread_mutex_unlock(&global_instance_mutex);
}

int oliphaunt_begin_handle_retirement(OliphauntHandle *handle) {
    if (handle == NULL) {
        return 0;
    }

    pthread_mutex_lock(&global_instance_mutex);
    for (;;) {
        if (!current_instance_locked(handle)) {
            pthread_mutex_unlock(&global_instance_mutex);
            set_stale_handle_error();
            return -1;
        }
        if (!global_handle_retirement) {
            break;
        }
        if (owned_retirement_handle == handle) {
            pthread_mutex_unlock(&global_instance_mutex);
            set_error(NULL, "native liboliphaunt logical retirement is already active on this thread");
            return -1;
        }
        pthread_cond_wait(&global_instance_cond, &global_instance_mutex);
    }

    /* Check callback reentry before installing a gate that the stream owner
     * would otherwise have to release itself. */
    int lock_rc = pthread_mutex_lock(&handle->mutex);
    if (lock_rc != 0) {
        pthread_mutex_unlock(&global_instance_mutex);
        set_error(NULL, "cannot lock the resident native liboliphaunt instance for logical close");
        return -1;
    }
    int stream_rc = oliphaunt_reject_if_streaming_locked(handle);
    pthread_mutex_unlock(&handle->mutex);
    if (stream_rc != 0) {
        pthread_mutex_unlock(&global_instance_mutex);
        return -1;
    }

    global_handle_retirement = true;
    owned_retirement_handle = handle;
    while (global_active_handle_calls != 0) {
        pthread_cond_wait(&global_instance_cond, &global_instance_mutex);
    }
    pthread_mutex_unlock(&global_instance_mutex);
    return 0;
}

void oliphaunt_end_handle_retirement(void) {
    pthread_mutex_lock(&global_instance_mutex);
    if (global_handle_retirement) {
        global_handle_retirement = false;
        pthread_cond_broadcast(&global_instance_cond);
    }
    owned_retirement_handle = NULL;
    pthread_mutex_unlock(&global_instance_mutex);
}

void oliphaunt_wait_for_active_handle_calls(void) {
    pthread_mutex_lock(&global_instance_mutex);
    while (global_active_handle_calls != 0) {
        pthread_cond_wait(&global_instance_cond, &global_instance_mutex);
    }
    pthread_mutex_unlock(&global_instance_mutex);
}

#if OLIPHAUNT_DESKTOP_DYNAMIC_SCOPE
static void oliphaunt_promote_extension_symbol_scope_once(void) {
    Dl_info info;
    memset(&info, 0, sizeof(info));
    if (dladdr((const void *)&global_instance_mutex, &info) == 0 ||
        info.dli_fname == NULL || info.dli_fname[0] == '\0') {
        snprintf(
            extension_symbol_scope_error,
            sizeof(extension_symbol_scope_error),
            "cannot identify the loaded liboliphaunt image for PostgreSQL extension symbol scope");
        return;
    }

    (void)dlerror();
    extension_symbol_scope_handle = dlopen(info.dli_fname, RTLD_NOW | RTLD_GLOBAL);
    if (extension_symbol_scope_handle == NULL) {
        const char *detail = dlerror();
        snprintf(
            extension_symbol_scope_error,
            sizeof(extension_symbol_scope_error),
            "cannot promote loaded liboliphaunt image %s to process-global PostgreSQL extension symbol scope: %s",
            info.dli_fname,
            detail != NULL ? detail : "unknown dynamic loader error");
        return;
    }

    /* Retain this reference for the process lifetime. PostgreSQL extension
     * DSOs resolve backend globals from this image after initialization. */
    extension_symbol_scope_status = 0;
}
#endif

int oliphaunt_ensure_extension_symbol_scope(char *error, size_t error_capacity) {
#if OLIPHAUNT_DESKTOP_DYNAMIC_SCOPE
    int once_rc = pthread_once(
        &extension_symbol_scope_once,
        oliphaunt_promote_extension_symbol_scope_once);
    if (once_rc == 0 && extension_symbol_scope_status == 0) {
        return 0;
    }
    if (error != NULL && error_capacity > 0) {
        if (once_rc != 0) {
            snprintf(
                error,
                error_capacity,
                "cannot initialize process-global PostgreSQL extension symbol scope: pthread_once failed: %d",
                once_rc);
        } else {
            snprintf(error, error_capacity, "%s", extension_symbol_scope_error);
        }
    }
    return -1;
#else
    (void)error;
    (void)error_capacity;
    return 0;
#endif
}

static void oliphaunt_shutdown_global_instance_at_exit(void) {
    OliphauntHandle *claimed = NULL;
    int claim_rc = oliphaunt_claim_current_global_instance_for_close(&claimed);
    if (claim_rc == 0 && claimed != NULL) {
        (void)oliphaunt_close_claimed_global_instance(claimed);
    }
}

static void oliphaunt_register_process_exit_shutdown_once(void) {
    (void)atexit(oliphaunt_shutdown_global_instance_at_exit);
}

void oliphaunt_register_process_exit_shutdown(void) {
    (void)pthread_once(
        &process_exit_shutdown_once,
        oliphaunt_register_process_exit_shutdown_once);
}

int oliphaunt_acquire_global_instance(OliphauntHandle **existing) {
    if (existing != NULL) {
        *existing = NULL;
    }
    pthread_mutex_lock(&global_instance_mutex);
    while (global_handle_retirement) {
        pthread_cond_wait(&global_instance_cond, &global_instance_mutex);
    }
    if (global_instance_state == OLIPHAUNT_GLOBAL_ACTIVE) {
        if (existing != NULL && global_instance != NULL) {
            OliphauntHandle *handle = global_instance;
            int lock_rc = pthread_mutex_lock(&handle->mutex);
            if (lock_rc != 0) {
                pthread_mutex_unlock(&global_instance_mutex);
                set_error(NULL, "cannot lock the resident native liboliphaunt instance");
                return -1;
            }
            *existing = handle;
            pthread_mutex_unlock(&global_instance_mutex);
            return 1;
        }
        pthread_mutex_unlock(&global_instance_mutex);
        set_error(NULL, "native liboliphaunt already has an active process-wide instance");
        return -1;
    }
    if (global_instance_state == OLIPHAUNT_GLOBAL_SPENT) {
        pthread_mutex_unlock(&global_instance_mutex);
        set_error(NULL, "native liboliphaunt process lifetime has already been used");
        return -1;
    }
    global_instance_state = OLIPHAUNT_GLOBAL_ACTIVE;
    pthread_mutex_unlock(&global_instance_mutex);
    return 0;
}

void oliphaunt_publish_global_instance(OliphauntHandle *handle) {
    pthread_mutex_lock(&global_instance_mutex);
    if (global_instance_state == OLIPHAUNT_GLOBAL_ACTIVE) {
        global_instance = handle;
    }
    pthread_mutex_unlock(&global_instance_mutex);
}

void oliphaunt_release_global_instance(bool spent) {
    pthread_mutex_lock(&global_instance_mutex);
    global_instance_state = spent ? OLIPHAUNT_GLOBAL_SPENT : OLIPHAUNT_GLOBAL_UNUSED;
    global_instance = NULL;
    global_handle_retirement = false;
    pthread_cond_broadcast(&global_instance_cond);
    pthread_mutex_unlock(&global_instance_mutex);
}

uint64_t oliphaunt_logical_generation(OliphauntHandle *handle) {
    if (handle == NULL) {
        return 0;
    }

    uint64_t generation = 0;
    pthread_mutex_lock(&global_instance_mutex);
    if (global_instance_state == OLIPHAUNT_GLOBAL_ACTIVE && global_instance == handle) {
        int lock_rc = pthread_mutex_lock(&handle->mutex);
        if (lock_rc == 0) {
            generation = handle->logical_generation;
            pthread_mutex_unlock(&handle->mutex);
        }
    }
    pthread_mutex_unlock(&global_instance_mutex);
    return generation;
}

int oliphaunt_claim_global_instance_for_close(
    OliphauntHandle *handle,
    uint64_t generation,
    bool require_generation,
    OliphauntHandle **claimed) {
    if (claimed == NULL) {
        return -1;
    }
    *claimed = NULL;

    pthread_mutex_lock(&global_instance_mutex);
    while (global_handle_retirement && owned_retirement_handle != global_instance) {
        pthread_cond_wait(&global_instance_cond, &global_instance_mutex);
    }
    if (global_instance_state == OLIPHAUNT_GLOBAL_SPENT) {
        pthread_mutex_unlock(&global_instance_mutex);
        return 2;
    }
    if (global_instance_state != OLIPHAUNT_GLOBAL_ACTIVE || global_instance == NULL) {
        pthread_mutex_unlock(&global_instance_mutex);
        return 1;
    }

    OliphauntHandle *current = global_instance;
    int lock_rc = pthread_mutex_lock(&current->mutex);
    if (lock_rc != 0) {
        pthread_mutex_unlock(&global_instance_mutex);
        set_error(NULL, "cannot lock the resident native liboliphaunt instance for terminal close");
        return -1;
    }
    bool owns_close = require_generation
        ? generation == current->logical_generation
        : handle == NULL || handle == current;
    if (!owns_close) {
        pthread_mutex_unlock(&current->mutex);
        pthread_mutex_unlock(&global_instance_mutex);
        return 1;
    }
    if (oliphaunt_reject_if_streaming_locked(current) != 0) {
        pthread_mutex_unlock(&current->mutex);
        pthread_mutex_unlock(&global_instance_mutex);
        return -1;
    }

    global_instance = NULL;
    global_instance_state = OLIPHAUNT_GLOBAL_SPENT;
    if (global_handle_retirement) {
        global_handle_retirement = false;
        owned_retirement_handle = NULL;
        pthread_cond_broadcast(&global_instance_cond);
    }
    *claimed = current;
    pthread_mutex_unlock(&current->mutex);
    pthread_mutex_unlock(&global_instance_mutex);
    return 0;
}

int oliphaunt_claim_current_global_instance_for_close(OliphauntHandle **claimed) {
    return oliphaunt_claim_global_instance_for_close(
        NULL,
        0,
        false,
        claimed);
}
