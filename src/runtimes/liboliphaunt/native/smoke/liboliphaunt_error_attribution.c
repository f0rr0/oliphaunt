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
    pthread_mutex_destroy(&handle.error_mutex);
}

static void check_unscoped_same_thread_error(void) {
    complete_failed_operation("older_operation", "older operation error");
    oliphaunt_set_error(NULL, "new unscoped helper error");
    char copied[128];
    (void)oliphaunt_copy_last_error(NULL, copied, sizeof(copied));
    CHECK(strcmp(copied, "new unscoped helper error") == 0,
          "same-thread unscoped set_error must replace an older operation snapshot");
}

int main(void) {
    check_concurrent_operation_attribution();
    check_nested_scope_semantics();
    check_handle_fallback();
    check_unscoped_same_thread_error();
    puts("liboliphaunt operation-local error attribution passed");
    return 0;
}
