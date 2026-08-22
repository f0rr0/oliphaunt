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

typedef struct BackupStopFault {
    int calls;
    int result;
    OliphauntBackupModeState state;
    const char *error;
} BackupStopFault;

static int fault_injected_backup_stop(
    void *data,
    OliphauntBackupModeState *state,
    char *error,
    size_t error_capacity) {
    BackupStopFault *fault = (BackupStopFault *)data;
    fault->calls++;
    *state = fault->state;
    snprintf(error, error_capacity, "%s", fault->error);
    return fault->result;
}

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
    const uint8_t completed_select_one[] = {
        'C', 0, 0, 0, 13, 'S', 'E', 'L', 'E', 'C', 'T', ' ', '1', 0,
        'Z', 0, 0, 0, 5, 'I',
    };
    const uint8_t completed_select_zero[] = {
        'C', 0, 0, 0, 13, 'S', 'E', 'L', 'E', 'C', 'T', ' ', '0', 0,
        'Z', 0, 0, 0, 5, 'I',
    };
    bool command_tag_matches = false;
    CHECK(oliphaunt_response_confirms_command(
              completed_select_one,
              sizeof(completed_select_one),
              "SELECT 1",
              &command_tag_matches) &&
              command_tag_matches,
          "backup completion must require the expected PostgreSQL command tag");
    CHECK(oliphaunt_response_confirms_command(
              completed_select_zero,
              sizeof(completed_select_zero),
              "SELECT 1",
              &command_tag_matches) &&
              !command_tag_matches,
          "an unexpected command tag must preserve confirmed backup-mode exit");

    CHECK(!oliphaunt_backup_cleanup_required(OLIPHAUNT_BACKUP_NOT_ENTERED),
          "PostgreSQL pg_backup_start errors must not trigger pg_backup_stop");
    CHECK(oliphaunt_backup_cleanup_required(OLIPHAUNT_BACKUP_EXIT_REQUIRED),
          "post-start validation and archive failures must trigger pg_backup_stop");
    CHECK(!oliphaunt_backup_cleanup_required(OLIPHAUNT_BACKUP_EXIT_CONFIRMED),
          "confirmed pg_backup_stop must keep the handle reusable without retry");
    CHECK(oliphaunt_backup_cleanup_required(OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED),
          "an unconfirmed first stop must trigger one emergency pg_backup_stop");
    CHECK(oliphaunt_backup_cleanup_outcome(0, OLIPHAUNT_BACKUP_EXIT_CONFIRMED) ==
              OLIPHAUNT_BACKUP_CLEANUP_CONFIRMED,
          "successful emergency cleanup must preserve the primary error and handle reuse");
    CHECK(oliphaunt_backup_cleanup_outcome(-1, OLIPHAUNT_BACKUP_EXIT_CONFIRMED) ==
              OLIPHAUNT_BACKUP_CLEANUP_CONFIRMED_WITH_VALIDATION_FAILURE,
          "successful stop SQL with invalid metadata must report both errors without poisoning");
    CHECK(oliphaunt_backup_cleanup_outcome(-1, OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED) ==
              OLIPHAUNT_BACKUP_CLEANUP_UNCONFIRMED,
          "two unconfirmed stop attempts must report both errors and poison the handle");

    const uint8_t trailing_data_row[] = {0, 1, 0, 0, 0, 1, 'x', 0};
    CHECK(oliphaunt_validate_data_row(
              trailing_data_row,
              sizeof(trailing_data_row),
              1) == OLIPHAUNT_DATA_ROW_TRAILING_BYTES,
          "DataRow parser must reject bytes after all declared columns");

    OliphauntBackupCleanupResult cleanup;
    BackupStopFault should_not_stop = {
        .calls = 0,
        .result = -1,
        .state = OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED,
        .error = "unexpected cleanup",
    };
    oliphaunt_run_failed_backup_cleanup(
        OLIPHAUNT_BACKUP_NOT_ENTERED,
        "pg_backup_start SQL failed",
        fault_injected_backup_stop,
        &should_not_stop,
        &cleanup);
    CHECK(should_not_stop.calls == 0 && !cleanup.poison &&
              strcmp(cleanup.error, "pg_backup_start SQL failed") == 0,
          "a PostgreSQL start error must remain primary without a cleanup stop");

    BackupStopFault confirmed_stop = {
        .calls = 0,
        .result = 0,
        .state = OLIPHAUNT_BACKUP_EXIT_CONFIRMED,
        .error = "",
    };
    const char *pre_stop_failures[] = {
        "pg_backup_start metadata invalid",
        "PGDATA snapshot failed",
        "pg_control refresh failed",
    };
    for (size_t index = 0; index < sizeof(pre_stop_failures) / sizeof(pre_stop_failures[0]); index++) {
        int previous_calls = confirmed_stop.calls;
        oliphaunt_run_failed_backup_cleanup(
            OLIPHAUNT_BACKUP_EXIT_REQUIRED,
            pre_stop_failures[index],
            fault_injected_backup_stop,
            &confirmed_stop,
            &cleanup);
        CHECK(confirmed_stop.calls == previous_calls + 1 &&
                  cleanup.state == OLIPHAUNT_BACKUP_EXIT_CONFIRMED &&
                  !cleanup.poison &&
                  strcmp(cleanup.error, pre_stop_failures[index]) == 0,
              "every failure after a successful start must stop once and preserve its error");
    }

    int previous_calls = confirmed_stop.calls;
    oliphaunt_run_failed_backup_cleanup(
        OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED,
        "primary pg_backup_stop failed",
        fault_injected_backup_stop,
        &confirmed_stop,
        &cleanup);
    CHECK(confirmed_stop.calls == previous_calls + 1 &&
              cleanup.state == OLIPHAUNT_BACKUP_EXIT_CONFIRMED &&
              !cleanup.poison &&
              strcmp(cleanup.error, "primary pg_backup_stop failed") == 0,
          "a failed primary stop must make one successful cleanup stop and keep the session usable");

    const char *post_stop_failures[] = {
        "pg_backup_stop metadata invalid",
        "archive assembly failed after pg_backup_stop",
    };
    for (size_t index = 0; index < sizeof(post_stop_failures) / sizeof(post_stop_failures[0]); index++) {
        previous_calls = should_not_stop.calls;
        oliphaunt_run_failed_backup_cleanup(
            OLIPHAUNT_BACKUP_EXIT_CONFIRMED,
            post_stop_failures[index],
            fault_injected_backup_stop,
            &should_not_stop,
            &cleanup);
        CHECK(should_not_stop.calls == previous_calls && !cleanup.poison &&
                  strcmp(cleanup.error, post_stop_failures[index]) == 0,
              "post-stop validation or archive failure must not retry stop or poison the session");
    }

    BackupStopFault validation_failure = {
        .calls = 0,
        .result = -1,
        .state = OLIPHAUNT_BACKUP_EXIT_CONFIRMED,
        .error = "pg_backup_stop metadata invalid",
    };
    oliphaunt_run_failed_backup_cleanup(
        OLIPHAUNT_BACKUP_EXIT_REQUIRED,
        "pg_backup_start metadata invalid",
        fault_injected_backup_stop,
        &validation_failure,
        &cleanup);
    CHECK(validation_failure.calls == 1,
          "post-start validation failure must invoke one emergency pg_backup_stop");
    CHECK(cleanup.state == OLIPHAUNT_BACKUP_EXIT_CONFIRMED && !cleanup.poison,
          "confirmed stop exchange must keep the handle reusable despite invalid stop metadata");
    CHECK(strstr(cleanup.error, "pg_backup_start metadata invalid") != NULL &&
              strstr(cleanup.error, "pg_backup_stop metadata invalid") != NULL,
          "cleanup must preserve primary and cleanup validation errors");

    BackupStopFault transport_failure = {
        .calls = 0,
        .result = -1,
        .state = OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED,
        .error = "pg_backup_stop transport failed",
    };
    oliphaunt_run_failed_backup_cleanup(
        OLIPHAUNT_BACKUP_EXIT_REQUIRED,
        "pg_backup_start metadata invalid",
        fault_injected_backup_stop,
        &transport_failure,
        &cleanup);
    CHECK(transport_failure.calls == 1,
          "unconfirmed cleanup must make exactly one emergency stop attempt");
    CHECK(cleanup.state == OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED && cleanup.poison,
          "handle must be poisoned only when the stop exchange remains unconfirmed");
    CHECK(strstr(cleanup.error, "pg_backup_start metadata invalid") != NULL &&
              strstr(cleanup.error, "pg_backup_stop transport failed") != NULL,
          "unconfirmed cleanup must preserve primary and cleanup transport errors");

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
