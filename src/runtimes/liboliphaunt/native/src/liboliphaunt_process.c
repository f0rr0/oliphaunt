#include "liboliphaunt_internal.h"

#include <stdlib.h>

static pthread_mutex_t global_instance_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t process_exit_shutdown_once = PTHREAD_ONCE_INIT;
static enum {
    OLIPHAUNT_GLOBAL_UNUSED = 0,
    OLIPHAUNT_GLOBAL_ACTIVE,
    OLIPHAUNT_GLOBAL_SPENT,
} global_instance_state = OLIPHAUNT_GLOBAL_UNUSED;
static OliphauntHandle *global_instance = NULL;

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
