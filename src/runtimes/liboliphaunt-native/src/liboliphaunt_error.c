#include "../include/oliphaunt.h"
#include "liboliphaunt_internal.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

static char global_last_error[OLIPHAUNT_ERROR_CAPACITY];
static pthread_mutex_t global_last_error_mutex = PTHREAD_MUTEX_INITIALIZER;

#if defined(_MSC_VER)
#define OLIPHAUNT_THREAD_LOCAL __declspec(thread)
#else
#define OLIPHAUNT_THREAD_LOCAL _Thread_local
#endif

static OLIPHAUNT_THREAD_LOCAL char completed_operation_error[OLIPHAUNT_ERROR_CAPACITY];
static OLIPHAUNT_THREAD_LOCAL bool completed_operation_error_valid;
static OLIPHAUNT_THREAD_LOCAL OliphauntErrorScope *active_error_scope;

_Static_assert(
    OLIPHAUNT_ERROR_CAPTURE_CAPACITY == OLIPHAUNT_ERROR_CAPACITY,
    "public error captures must hold one complete native error");
_Static_assert(
    sizeof(((OliphauntErrorCapture *)0)->message) == OLIPHAUNT_ERROR_CAPACITY,
    "error capture layout must match the native error capacity");
_Static_assert(
    offsetof(OliphauntErrorCapture, message) == sizeof(uint32_t),
    "error capture message must immediately follow its length");
_Static_assert(
    sizeof(OliphauntErrorCapture) == sizeof(uint32_t) + OLIPHAUNT_ERROR_CAPACITY,
    "error capture layout must not contain trailing padding");

static void copy_error_text(char *target, const char *message) {
    snprintf(
        target,
        OLIPHAUNT_ERROR_CAPACITY,
        "%s",
        message != NULL ? message : "unknown native liboliphaunt error");
}

static size_t copy_shared_last_error(OliphauntHandle *handle, char *out, size_t capacity) {
    bool use_handle = handle != NULL && handle->error_mutex_initialized;
    pthread_mutex_t *mutex = use_handle ? &handle->error_mutex : &global_last_error_mutex;
    const char *source = use_handle ? handle->last_error : global_last_error;
    pthread_mutex_lock(mutex);
    size_t length = strlen(source);
    if (capacity > 0 && out != NULL) {
        size_t copied = length < capacity - 1 ? length : capacity - 1;
        memcpy(out, source, copied);
        out[copied] = '\0';
    }
    pthread_mutex_unlock(mutex);
    return length;
}

void oliphaunt_error_scope_begin(
    OliphauntErrorScope *scope,
    OliphauntHandle *fallback_handle,
    const char *operation) {
    scope->parent = active_error_scope;
    scope->fallback_handle = fallback_handle;
    scope->operation = operation;
    scope->error[0] = '\0';
    scope->has_error = false;
    if (scope->parent == NULL) {
        completed_operation_error[0] = '\0';
        completed_operation_error_valid = false;
    }
    active_error_scope = scope;
}

void oliphaunt_error_scope_capture_shared(OliphauntHandle *fallback_handle) {
    if (active_error_scope == NULL || active_error_scope->has_error ||
        fallback_handle == NULL) {
        return;
    }

    char snapshot[OLIPHAUNT_ERROR_CAPACITY];
    (void)copy_shared_last_error(
        fallback_handle,
        snapshot,
        sizeof(snapshot));
    if (snapshot[0] == '\0') {
        return;
    }
    copy_error_text(active_error_scope->error, snapshot);
    active_error_scope->has_error = true;
}

void oliphaunt_error_scope_end(OliphauntErrorScope *scope, bool failed) {
    if (active_error_scope != scope) {
        /* This is an internal programming error. Do not leave a dangling TLS
         * pointer or publish an unrelated shared error as this operation's. */
        active_error_scope = scope->parent;
        if (scope->parent == NULL) {
            snprintf(
                completed_operation_error,
                sizeof(completed_operation_error),
                "%s failed with an invalid native error scope",
                scope->operation != NULL ? scope->operation : "native operation");
            completed_operation_error_valid = true;
        }
        return;
    }

    if (failed && !scope->has_error) {
        (void)copy_shared_last_error(
            scope->fallback_handle,
            scope->error,
            sizeof(scope->error));
        scope->has_error = scope->error[0] != '\0';
    }
    if (failed && !scope->has_error) {
        char missing_error[OLIPHAUNT_ERROR_CAPACITY];
        snprintf(
            missing_error,
            sizeof(missing_error),
            "%s failed without setting an error",
            scope->operation != NULL ? scope->operation : "native operation");
        oliphaunt_set_error(scope->fallback_handle, missing_error);
    }

    active_error_scope = scope->parent;
    if (!failed) {
        return;
    }
    if (scope->parent != NULL) {
        copy_error_text(scope->parent->error, scope->error);
        scope->parent->has_error = true;
        return;
    }
    copy_error_text(completed_operation_error, scope->error);
    completed_operation_error_valid = true;
}

void oliphaunt_set_error(OliphauntHandle *handle, const char *message) {
    const char *normalized = message != NULL ? message : "unknown native liboliphaunt error";
    if (active_error_scope != NULL) {
        if (normalized[0] == '\0') {
            active_error_scope->error[0] = '\0';
            active_error_scope->has_error = false;
        } else {
            copy_error_text(active_error_scope->error, normalized);
            active_error_scope->has_error = true;
        }
    } else if (normalized[0] == '\0') {
        completed_operation_error[0] = '\0';
        completed_operation_error_valid = false;
    } else {
        /* Internal helpers and backend-thread paths can report an error
         * outside a public operation wrapper. On that same thread this is the
         * newest attributable error; replacing its older completed snapshot
         * avoids returning stale operation state while retaining isolation
         * from updates made by other threads. */
        copy_error_text(completed_operation_error, normalized);
        completed_operation_error_valid = true;
    }
    bool use_handle = handle != NULL && handle->error_mutex_initialized;
    pthread_mutex_t *mutex = use_handle ? &handle->error_mutex : &global_last_error_mutex;
    char *target = use_handle ? handle->last_error : global_last_error;
    pthread_mutex_lock(mutex);
    copy_error_text(target, normalized);
    pthread_mutex_unlock(mutex);
}

size_t oliphaunt_copy_last_error(OliphauntHandle *handle, char *out, size_t capacity) {
    const char *source = NULL;
    if (active_error_scope != NULL && active_error_scope->has_error) {
        source = active_error_scope->error;
    } else if (completed_operation_error_valid) {
        source = completed_operation_error;
    }
    if (source == NULL) {
        if (handle != NULL && oliphaunt_try_begin_handle_call(handle)) {
            size_t length = copy_shared_last_error(handle, out, capacity);
            oliphaunt_end_handle_call();
            return length;
        }
        /* A stale or retiring opaque pointer must not be dereferenced. The
         * process-global slot is the only lifetime-safe fallback. */
        return copy_shared_last_error(NULL, out, capacity);
    }

    size_t length = strlen(source);
    if (capacity > 0 && out != NULL) {
        size_t copied = length < capacity - 1 ? length : capacity - 1;
        memcpy(out, source, copied);
        out[copied] = '\0';
    }
    return length;
}

void oliphaunt_error_capture_current(
    OliphauntErrorCapture *capture,
    OliphauntHandle *fallback_handle,
    bool failed) {
    if (capture == NULL) {
        return;
    }
    memset(capture, 0, sizeof(*capture));
    if (!failed) {
        return;
    }

    size_t length = oliphaunt_copy_last_error(
        fallback_handle,
        capture->message,
        sizeof(capture->message));
    /* Every native error source is bounded by the same public capacity. */
    if (length >= sizeof(capture->message)) {
        length = sizeof(capture->message) - 1;
        capture->message[length] = '\0';
    }
    capture->length = (uint32_t)length;
}
