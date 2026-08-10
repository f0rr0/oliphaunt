#include "COliphaunt.h"

#include <pthread.h>
#include <stdio.h>
#include <string.h>

typedef struct OpenResult {
    const char *path;
    int32_t rc;
    OliphauntSession *session;
    char error[1024];
} OpenResult;

static pthread_mutex_t coordination_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t coordination_changed = PTHREAD_COND_INITIALIZER;
static int first_open_complete;
static int second_open_complete;

static void open_missing_library(OpenResult *result) {
    OliphauntConfig config = {0};
    result->rc = oliphaunt_swift_open(result->path, &config, &result->session);
}

static void *run_first_open(void *context) {
    OpenResult *result = context;
    open_missing_library(result);

    pthread_mutex_lock(&coordination_lock);
    first_open_complete = 1;
    pthread_cond_broadcast(&coordination_changed);
    while (!second_open_complete) {
        pthread_cond_wait(&coordination_changed, &coordination_lock);
    }
    snprintf(
        result->error,
        sizeof(result->error),
        "%s",
        oliphaunt_swift_last_error(NULL));
    pthread_mutex_unlock(&coordination_lock);
    return NULL;
}

static int assert_missing_library_error(const OpenResult *result) {
    if (result->rc == 0 || result->session != NULL) {
        fprintf(stderr, "opening missing library unexpectedly succeeded: %s\n", result->path);
        return 1;
    }
    if (strstr(result->error, result->path) == NULL) {
        fprintf(
            stderr,
            "missing-library error crossed threads: expected %s in %s\n",
            result->path,
            result->error);
        return 1;
    }
    return 0;
}

int main(void) {
    OpenResult first = {
        .path = "/oliphaunt-swift-missing/thread-a/liboliphaunt.dylib",
    };
    OpenResult second = {
        .path = "/oliphaunt-swift-missing/thread-b/liboliphaunt.dylib",
    };
    pthread_t first_thread;

    if (pthread_create(&first_thread, NULL, run_first_open, &first) != 0) {
        fputs("failed to create bridge error isolation thread\n", stderr);
        return 1;
    }

    pthread_mutex_lock(&coordination_lock);
    while (!first_open_complete) {
        pthread_cond_wait(&coordination_changed, &coordination_lock);
    }
    pthread_mutex_unlock(&coordination_lock);

    open_missing_library(&second);
    snprintf(
        second.error,
        sizeof(second.error),
        "%s",
        oliphaunt_swift_last_error(NULL));

    pthread_mutex_lock(&coordination_lock);
    second_open_complete = 1;
    pthread_cond_broadcast(&coordination_changed);
    pthread_mutex_unlock(&coordination_lock);

    if (pthread_join(first_thread, NULL) != 0) {
        fputs("failed to join bridge error isolation thread\n", stderr);
        return 1;
    }

    return assert_missing_library_error(&first)
        || assert_missing_library_error(&second);
}
