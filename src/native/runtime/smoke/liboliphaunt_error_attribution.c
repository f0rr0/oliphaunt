#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "liboliphaunt_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition, message) \
    do { \
        if (!(condition)) { \
            fprintf(stderr, "liboliphaunt error attribution failed: %s\n", message); \
            exit(1); \
        } \
    } while (0)

typedef struct ErrorRaceGate {
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    unsigned int arrived;
    bool released;
} ErrorRaceGate;

typedef struct ErrorRaceWorker {
    ErrorRaceGate *gate;
    const char *operation;
    const char *expected;
    size_t required;
    size_t copied_length;
    size_t truncated_length;
    char copied[128];
    char truncated[4];
} ErrorRaceWorker;

typedef struct SharedFallbackSnapshotWorker {
    ErrorRaceGate *gate;
    OliphauntHandle *handle;
    char copied[128];
} SharedFallbackSnapshotWorker;

static bool permit_synthetic_handle_call = true;
static size_t synthetic_handle_calls_begun;
static size_t synthetic_handle_calls_ended;

/* The focused error unit links no process registry. Treat its synthetic
 * initialized handle as pinned while copy_last_error exercises fallback. */
bool oliphaunt_try_begin_handle_call(OliphauntHandle *handle) {
    synthetic_handle_calls_begun++;
    return handle != NULL && permit_synthetic_handle_call;
}

void oliphaunt_end_handle_call(void) {
    synthetic_handle_calls_ended++;
}

static void complete_failed_operation(const char *operation, const char *error) {
    OliphauntErrorScope scope;
    oliphaunt_error_scope_begin(&scope, NULL, operation);
    oliphaunt_set_error(NULL, error);
    oliphaunt_error_scope_end(&scope, true);
}

static void *run_error_race_worker(void *opaque) {
    ErrorRaceWorker *worker = (ErrorRaceWorker *)opaque;
    complete_failed_operation(worker->operation, worker->expected);
    worker->required = oliphaunt_copy_last_error(NULL, NULL, 0);

    pthread_mutex_lock(&worker->gate->mutex);
    worker->gate->arrived++;
    pthread_cond_broadcast(&worker->gate->condition);
    while (!worker->gate->released) {
        pthread_cond_wait(&worker->gate->condition, &worker->gate->mutex);
    }
    pthread_mutex_unlock(&worker->gate->mutex);

    worker->copied_length = oliphaunt_copy_last_error(
        NULL,
        worker->copied,
        sizeof(worker->copied));
    worker->truncated_length = oliphaunt_copy_last_error(
        NULL,
        worker->truncated,
        sizeof(worker->truncated));
    return NULL;
}

static void check_concurrent_operation_attribution(void) {
    ErrorRaceGate gate;
    CHECK(pthread_mutex_init(&gate.mutex, NULL) == 0, "race mutex initialization");
    CHECK(pthread_cond_init(&gate.condition, NULL) == 0, "race condition initialization");
    gate.arrived = 0;
    gate.released = false;

    ErrorRaceWorker workers[2] = {
        {
            .gate = &gate,
            .operation = "first_failure",
            .expected = "first operation failed",
        },
        {
            .gate = &gate,
            .operation = "second_failure",
            .expected = "second operation failed differently",
        },
    };
    pthread_t threads[2];
    CHECK(pthread_create(&threads[0], NULL, run_error_race_worker, &workers[0]) == 0,
          "first race worker startup");
    CHECK(pthread_create(&threads[1], NULL, run_error_race_worker, &workers[1]) == 0,
          "second race worker startup");

    pthread_mutex_lock(&gate.mutex);
    while (gate.arrived != 2) {
        pthread_cond_wait(&gate.condition, &gate.mutex);
    }
    pthread_mutex_unlock(&gate.mutex);

    /* Both size probes have completed. Replace the shared fallback before
     * either worker copies so the test deterministically exercises TLS. */
    oliphaunt_set_error(NULL, "out-of-band shared error overwrite");

    pthread_mutex_lock(&gate.mutex);
    gate.released = true;
    pthread_cond_broadcast(&gate.condition);
    pthread_mutex_unlock(&gate.mutex);
    CHECK(pthread_join(threads[0], NULL) == 0, "first race worker join");
    CHECK(pthread_join(threads[1], NULL) == 0, "second race worker join");

    for (size_t i = 0; i < 2; i++) {
        CHECK(workers[i].required == strlen(workers[i].expected),
              "size probe must use the worker's operation error");
        CHECK(workers[i].copied_length == workers[i].required,
              "copy must retain the probed operation error length");
        CHECK(strcmp(workers[i].copied, workers[i].expected) == 0,
              "copy must retain the worker's operation error");
        CHECK(workers[i].truncated_length == workers[i].required,
              "repeated truncated copy must retain the full length");
        CHECK(workers[i].truncated[sizeof(workers[i].truncated) - 1] == '\0',
              "repeated truncated copy must terminate output");
    }

    pthread_cond_destroy(&gate.condition);
    pthread_mutex_destroy(&gate.mutex);
}

static void check_nested_scope_semantics(void) {
    char copied[128];
    OliphauntErrorScope outer;
    OliphauntErrorScope inner;

    oliphaunt_error_scope_begin(&outer, NULL, "outer_failure");
    oliphaunt_set_error(NULL, "outer failure survives cleanup");
    oliphaunt_error_scope_begin(&inner, NULL, "successful_cleanup");
    oliphaunt_set_error(NULL, "successful cleanup scratch error");
    oliphaunt_error_scope_end(&inner, false);
    oliphaunt_error_scope_end(&outer, true);
    (void)oliphaunt_copy_last_error(NULL, copied, sizeof(copied));
    CHECK(strcmp(copied, "outer failure survives cleanup") == 0,
          "successful nested operation must not erase its outer failure");

    oliphaunt_error_scope_begin(&outer, NULL, "outer_propagation");
    oliphaunt_error_scope_begin(&inner, NULL, "failed_inner_operation");
    oliphaunt_set_error(NULL, "inner operation failure");
    oliphaunt_error_scope_end(&inner, true);
    oliphaunt_error_scope_begin(&inner, NULL, "later_successful_cleanup");
    oliphaunt_set_error(NULL, "later cleanup scratch error");
    oliphaunt_error_scope_end(&inner, false);
    oliphaunt_error_scope_end(&outer, true);
    (void)oliphaunt_copy_last_error(NULL, copied, sizeof(copied));
    CHECK(strcmp(copied, "inner operation failure") == 0,
          "failed nested operation must propagate through later successful cleanup");
}

static void *set_handle_fallback_on_other_thread(void *opaque) {
    oliphaunt_set_error((OliphauntHandle *)opaque, "handle-wide fallback error");
    return NULL;
}

static void *set_global_fallback_on_other_thread(void *opaque) {
    (void)opaque;
    oliphaunt_set_error(NULL, "global fallback for a stale handle");
    return NULL;
}

static void *capture_shared_fallback_before_unlock(void *opaque) {
    SharedFallbackSnapshotWorker *worker =
        (SharedFallbackSnapshotWorker *)opaque;
    OliphauntErrorScope scope;
    oliphaunt_error_scope_begin(
        &scope,
        worker->handle,
        "backend_owned_failure");
    oliphaunt_error_scope_capture_shared(worker->handle);

    pthread_mutex_lock(&worker->gate->mutex);
    worker->gate->arrived++;
    pthread_cond_broadcast(&worker->gate->condition);
    while (!worker->gate->released) {
        pthread_cond_wait(&worker->gate->condition, &worker->gate->mutex);
    }
    pthread_mutex_unlock(&worker->gate->mutex);

    oliphaunt_error_scope_end(&scope, true);
    (void)oliphaunt_copy_last_error(
        NULL,
        worker->copied,
        sizeof(worker->copied));
    return NULL;
}

static void check_locked_shared_fallback_snapshot(void) {
    OliphauntHandle handle = {0};
    CHECK(pthread_mutex_init(&handle.error_mutex, NULL) == 0,
          "shared snapshot handle mutex initialization");
    handle.error_mutex_initialized = true;
    oliphaunt_set_error(&handle, "backend-thread stream queue failure");

    ErrorRaceGate gate;
    CHECK(pthread_mutex_init(&gate.mutex, NULL) == 0,
          "shared snapshot gate mutex initialization");
    CHECK(pthread_cond_init(&gate.condition, NULL) == 0,
          "shared snapshot gate condition initialization");
    gate.arrived = 0;
    gate.released = false;
    SharedFallbackSnapshotWorker worker = {
        .gate = &gate,
        .handle = &handle,
    };
    pthread_t thread;
    CHECK(pthread_create(
              &thread,
              NULL,
              capture_shared_fallback_before_unlock,
              &worker) == 0,
          "shared snapshot worker startup");

    pthread_mutex_lock(&gate.mutex);
    while (gate.arrived != 1) {
        pthread_cond_wait(&gate.condition, &gate.mutex);
    }
    pthread_mutex_unlock(&gate.mutex);

    /* Model the next admitted operation replacing handle->last_error after the
     * failing stream releases handle->mutex but before its scope ends. */
    oliphaunt_set_error(&handle, "later operation overwrote shared fallback");
    pthread_mutex_lock(&gate.mutex);
    gate.released = true;
    pthread_cond_broadcast(&gate.condition);
    pthread_mutex_unlock(&gate.mutex);

    CHECK(pthread_join(thread, NULL) == 0, "shared snapshot worker join");
    CHECK(strcmp(worker.copied, "backend-thread stream queue failure") == 0,
          "locked shared-error snapshot must survive a later operation overwrite");

    pthread_cond_destroy(&gate.condition);
    pthread_mutex_destroy(&gate.mutex);
    pthread_mutex_destroy(&handle.error_mutex);
}

static void check_handle_fallback(void) {
    OliphauntErrorScope success;
    oliphaunt_error_scope_begin(&success, NULL, "successful_operation");
    oliphaunt_error_scope_end(&success, false);

    OliphauntHandle handle = {0};
    CHECK(pthread_mutex_init(&handle.error_mutex, NULL) == 0,
          "handle fallback mutex initialization");
    handle.error_mutex_initialized = true;
    pthread_t setter;
    CHECK(pthread_create(&setter, NULL, set_handle_fallback_on_other_thread, &handle) == 0,
          "handle fallback setter startup");
    CHECK(pthread_join(setter, NULL) == 0, "handle fallback setter join");
    char copied[128];
    size_t length = oliphaunt_copy_last_error(&handle, copied, sizeof(copied));
    CHECK(length == strlen("handle-wide fallback error"),
          "handle-wide fallback must report its full length");
    CHECK(strcmp(copied, "handle-wide fallback error") == 0,
          "handle-wide fallback must remain available without an operation snapshot");
    CHECK(synthetic_handle_calls_begun == 1 && synthetic_handle_calls_ended == 1,
          "handle-wide fallback must remain leased through its shared error copy");
    pthread_mutex_destroy(&handle.error_mutex);
}

static void check_stale_handle_fallback(void) {
    pthread_t setter;
    CHECK(pthread_create(&setter, NULL, set_global_fallback_on_other_thread, NULL) == 0,
          "global fallback setter startup");
    CHECK(pthread_join(setter, NULL) == 0, "global fallback setter join");

    size_t begun_before = synthetic_handle_calls_begun;
    size_t ended_before = synthetic_handle_calls_ended;
    permit_synthetic_handle_call = false;
    char copied[128];
    size_t length = oliphaunt_copy_last_error(
        (OliphauntHandle *)(uintptr_t)1,
        copied,
        sizeof(copied));
    permit_synthetic_handle_call = true;
    CHECK(length == strlen("global fallback for a stale handle"),
          "stale handle fallback must report the global error length");
    CHECK(strcmp(copied, "global fallback for a stale handle") == 0,
          "stale handle fallback must copy the global error without dereferencing the handle");
    CHECK(synthetic_handle_calls_begun == begun_before + 1 &&
          synthetic_handle_calls_ended == ended_before,
          "a rejected stale-handle lease must not be ended or dereferenced");
}

static void check_unscoped_same_thread_error(void) {
    complete_failed_operation("older_operation", "older operation error");
    oliphaunt_set_error(NULL, "new unscoped helper error");
    char copied[128];
    (void)oliphaunt_copy_last_error(NULL, copied, sizeof(copied));
    CHECK(strcmp(copied, "new unscoped helper error") == 0,
          "same-thread unscoped set_error must replace an older operation snapshot");
}

static void check_fixed_error_capture(void) {
    OliphauntErrorCapture capture;
    memset(&capture, 0xa5, sizeof(capture));
    oliphaunt_error_capture_current(&capture, NULL, false);
    for (size_t i = 0; i < sizeof(capture); i++) {
        CHECK(((const unsigned char *)&capture)[i] == 0,
              "successful same-call capture must zero its complete fixed layout");
    }

    complete_failed_operation("captured_failure", "same-call captured failure");
    memset(&capture, 0xa5, sizeof(capture));
    oliphaunt_error_capture_current(&capture, NULL, true);
    CHECK(capture.length == strlen("same-call captured failure"),
          "failed same-call capture must report its exact byte length");
    CHECK(strcmp(capture.message, "same-call captured failure") == 0,
          "failed same-call capture must copy its operation-local error");
}

int main(void) {
    check_concurrent_operation_attribution();
    check_nested_scope_semantics();
    check_locked_shared_fallback_snapshot();
    check_handle_fallback();
    check_stale_handle_fallback();
    check_unscoped_same_thread_error();
    check_fixed_error_capture();
    puts("liboliphaunt operation-local error attribution passed");
    return 0;
}
