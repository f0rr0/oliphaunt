#include "liboliphaunt_internal.h"

#include <errno.h>
#include <sched.h>
#include <stdatomic.h>
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
    oliphaunt_wait_for_active_handle_calls();
    return 0;
}

typedef struct StaleCloseContext {
    int result;
    OliphauntHandle *claimed;
} StaleCloseContext;

typedef struct RetirementContext {
    OliphauntHandle *handle;
    atomic_int started;
    atomic_int acquired;
    int result;
} RetirementContext;

typedef struct LeaseCloseContext {
    uint64_t generation;
    atomic_int claimed;
    atomic_int closed;
    int result;
    OliphauntHandle *handle;
} LeaseCloseContext;

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

static void *retire_current_handle(void *data) {
    RetirementContext *context = (RetirementContext *)data;
    atomic_store(&context->started, 1);
    context->result = oliphaunt_begin_handle_retirement(context->handle);
    if (context->result == 0) {
        atomic_store(&context->acquired, 1);
        oliphaunt_end_handle_retirement();
    }
    return NULL;
}

static void *claim_and_close_current_generation(void *data) {
    LeaseCloseContext *context = (LeaseCloseContext *)data;
    OliphauntHandle *claimed = NULL;
    context->result = oliphaunt_claim_global_instance_for_close(
        NULL,
        context->generation,
        true,
        &claimed);
    context->handle = claimed;
    atomic_store(&context->claimed, 1);
    if (context->result == 0) {
        (void)oliphaunt_close_claimed_global_instance(claimed);
        atomic_store(&context->closed, 1);
    }
    return NULL;
}

int main(void) {
    char *startup_args[] = {"-c", "search_path=public"};
    OliphauntHandle resident_config;
    memset(&resident_config, 0, sizeof(resident_config));
    resident_config.pgdata = "/managed/pgdata";
    resident_config.runtime_dir = "/runtime";
    resident_config.module_dir = "/modules";
    resident_config.username = "postgres";
    resident_config.database = "postgres";
    resident_config.startup_args = startup_args;
    resident_config.startup_arg_count = 2;
    OliphauntConfig reopen_config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = "/managed/pgdata",
        .runtime_dir = "/runtime",
        .module_dir = "/modules",
        .username = "postgres",
        .database = "postgres",
        .flags = 0,
        .startup_args = (const char *const *)startup_args,
        .startup_arg_count = 2,
    };
    CHECK(oliphaunt_config_matches_resident_runtime(&resident_config, &reopen_config),
          "an internally locked resident runtime must accept the same reopen mode");
    reopen_config.flags = OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK;
    CHECK(!oliphaunt_config_matches_resident_runtime(&resident_config, &reopen_config),
          "an internally locked resident runtime must reject external-lock reopen");
    resident_config.external_root_lock = true;
    CHECK(oliphaunt_config_matches_resident_runtime(&resident_config, &reopen_config),
          "an externally locked resident runtime must accept the same reopen mode");
    reopen_config.flags = 0;
    CHECK(!oliphaunt_config_matches_resident_runtime(&resident_config, &reopen_config),
          "an externally locked resident runtime must reject internal-lock reopen");

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

    CHECK(oliphaunt_begin_handle_call(&handle) == 0,
          "current handle call lease must be acquired");
    RetirementContext retirement = {
        .handle = &handle,
        .started = 0,
        .acquired = 0,
        .result = -1,
    };
    pthread_t retirement_thread;
    CHECK(pthread_create(
              &retirement_thread,
              NULL,
              retire_current_handle,
              &retirement) == 0,
          "cannot start concurrent logical-retirement check");
    while (!atomic_load(&retirement.started)) {
        sched_yield();
    }
    for (;;) {
        int admission = oliphaunt_begin_handle_call(&handle);
        if (admission != 0) {
            break;
        }
        oliphaunt_end_handle_call();
        sched_yield();
    }
    CHECK(!atomic_load(&retirement.acquired),
          "logical retirement crossed an active public-call boundary");
    oliphaunt_end_handle_call();
    CHECK(pthread_join(retirement_thread, NULL) == 0,
          "cannot join concurrent logical-retirement check");
    CHECK(retirement.result == 0 && atomic_load(&retirement.acquired),
          "logical retirement did not resume after the active call ended");
    CHECK(oliphaunt_begin_handle_call(&handle) == 0,
          "completed logical retirement left the call gate closed");
    oliphaunt_end_handle_call();

    handle.streaming = true;
    CHECK(oliphaunt_claim_global_instance_for_close(
              NULL,
              2,
              true,
              &claimed) == -1,
          "raw stream callback reentry must not claim terminal close");
    CHECK(claimed == NULL,
          "raw stream callback reentry unexpectedly returned a claimed handle");
    CHECK(strstr(handle.last_error, "busy delivering a raw protocol stream") != NULL,
          "raw stream callback reentry must report the active stream owner");
    CHECK(oliphaunt_begin_handle_retirement(&handle) == -1,
          "raw stream callback reentry must not begin logical retirement");
    CHECK(oliphaunt_logical_generation(&handle) == 2,
          "rejected callback close must leave the current generation published");
    handle.streaming = false;

    CHECK(oliphaunt_begin_handle_call(&handle) == 0,
          "stream wrapper tail must retain its active-call lease");
    LeaseCloseContext close = {
        .generation = 2,
        .claimed = 0,
        .closed = 0,
        .result = -1,
        .handle = NULL,
    };
    pthread_t close_thread;
    CHECK(pthread_create(
              &close_thread,
              NULL,
              claim_and_close_current_generation,
              &close) == 0,
          "cannot start terminal-close lease check");
    while (!atomic_load(&close.claimed)) {
        sched_yield();
    }
    CHECK(close.result == 0 && close.handle == &handle,
          "current generation did not atomically claim terminal close");
    CHECK(!atomic_load(&close.closed),
          "terminal close crossed the active stream wrapper boundary");
    CHECK(oliphaunt_begin_handle_call(&handle) != 0,
          "terminal claim admitted a new public handle call");
    oliphaunt_end_handle_call();
    CHECK(pthread_join(close_thread, NULL) == 0,
          "cannot join terminal-close lease check");
    CHECK(atomic_load(&close.closed),
          "terminal close did not resume after the active call ended");

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
