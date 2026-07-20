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
    OliphauntHandle *handle = NULL;
    pthread_mutex_lock(&global_instance_mutex);
    if (global_instance_state == OLIPHAUNT_GLOBAL_ACTIVE && global_instance != NULL) {
        handle = global_instance;
        global_instance = NULL;
        global_instance_state = OLIPHAUNT_GLOBAL_SPENT;
    }
    pthread_mutex_unlock(&global_instance_mutex);

    if (handle != NULL) {
        (void)oliphaunt_close(handle);
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
    if (global_instance_state == OLIPHAUNT_GLOBAL_ACTIVE) {
        if (existing != NULL && global_instance != NULL) {
            *existing = global_instance;
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
    pthread_mutex_unlock(&global_instance_mutex);
}

void oliphaunt_clear_global_instance(OliphauntHandle *handle, bool spent) {
    pthread_mutex_lock(&global_instance_mutex);
    if (global_instance == handle || global_instance == NULL) {
        global_instance = NULL;
        global_instance_state = spent ? OLIPHAUNT_GLOBAL_SPENT : OLIPHAUNT_GLOBAL_UNUSED;
    }
    pthread_mutex_unlock(&global_instance_mutex);
}
