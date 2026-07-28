#include "liboliphaunt_internal.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#define CHECK(condition, message) \
    do { \
        if (!(condition)) { \
            fprintf(stderr, "liboliphaunt generation lifecycle failed: %s\n", message); \
            return 1; \
        } \
    } while (0)

void oliphaunt_set_error(OliphauntHandle *handle, const char *message) {
    if (handle != NULL) {
        snprintf(handle->last_error, sizeof(handle->last_error), "%s", message != NULL ? message : "");
    }
}

int32_t oliphaunt_close_claimed_global_instance(OliphauntHandle *handle) {
    (void)handle;
    return 0;
}

typedef struct StaleCloseContext {
    int result;
    OliphauntHandle *claimed;
} StaleCloseContext;

static void *claim_stale_generation(void *data) {
    StaleCloseContext *context = (StaleCloseContext *)data;
    context->result = oliphaunt_claim_global_instance_for_close(
        NULL,
        1,
        true,
        &context->claimed);
    return NULL;
}

int main(void) {
    OliphauntHandle handle;
    memset(&handle, 0, sizeof(handle));
    CHECK(pthread_mutex_init(&handle.mutex, NULL) == 0, "cannot initialize fake resident mutex");
    handle.sync_initialized = true;

    OliphauntHandle *existing = NULL;
    CHECK(oliphaunt_acquire_global_instance(&existing) == 0,
          "initial process-wide reservation must succeed");
    CHECK(existing == NULL, "initial reservation unexpectedly returned a resident handle");

    handle.logical_generation = 1;
    handle.logical_active = true;
    oliphaunt_publish_global_instance(&handle);
    CHECK(oliphaunt_logical_generation(&handle) == 1,
          "initial resident lease must expose generation one");

    CHECK(oliphaunt_acquire_global_instance(&existing) == 1,
          "resident acquire must return the published handle");
    CHECK(existing == &handle, "resident acquire returned the wrong handle");
    CHECK(pthread_mutex_trylock(&handle.mutex) == EBUSY,
          "resident acquire must retain the handle mutex across reopen");

    /*
     * Model a stale cleanup racing detach/reopen. The acquire path already
     * holds handle.mutex, so close must wait until generation two is published
     * and then observe itself as stale.
     */
    StaleCloseContext stale_close = {.result = -1, .claimed = NULL};
    pthread_t stale_close_thread;
    CHECK(pthread_create(
              &stale_close_thread,
              NULL,
              claim_stale_generation,
              &stale_close) == 0,
          "cannot start concurrent stale-close check");
    handle.logical_active = false;
    handle.logical_generation = 2;
    handle.logical_active = true;
    pthread_mutex_unlock(&handle.mutex);
    CHECK(pthread_join(stale_close_thread, NULL) == 0,
          "cannot join concurrent stale-close check");
    CHECK(stale_close.result == 1,
          "stale generation won a close race against mutex-protected reopen");
    CHECK(stale_close.claimed == NULL,
          "concurrent stale generation unexpectedly returned a claimed handle");

    OliphauntHandle *claimed = NULL;
    CHECK(oliphaunt_claim_global_instance_for_close(
              NULL,
              1,
              true,
              &claimed) == 1,
          "stale generation must not claim the reopened resident runtime");
    CHECK(claimed == NULL, "stale generation unexpectedly returned a claimed handle");
    CHECK(oliphaunt_logical_generation(&handle) == 2,
          "stale close must leave the reopened generation published");

    CHECK(oliphaunt_claim_global_instance_for_close(
              NULL,
              2,
              true,
              &claimed) == 0,
          "current generation must atomically claim terminal close");
    CHECK(claimed == &handle, "current generation claimed the wrong resident handle");

    claimed = NULL;
    CHECK(oliphaunt_claim_global_instance_for_close(
              NULL,
              1,
              true,
              &claimed) == 2,
          "SPENT must satisfy later cleanup before resident handle access");
    CHECK(claimed == NULL, "SPENT cleanup unexpectedly returned a resident handle");
    CHECK(oliphaunt_logical_generation(&handle) == 0,
          "SPENT runtime must not expose a logical generation");

    pthread_mutex_destroy(&handle.mutex);
    fprintf(stderr, "liboliphaunt generation lifecycle passed\n");
    return 0;
}
