#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "../include/oliphaunt.h"
#include "liboliphaunt_internal.h"

#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifndef _WIN32
#include <unistd.h>
#endif

#define OLIPHAUNT_PRODUCT_VERSION "0.1.1" /* x-release-please-version */

extern int oliphaunt_embedded_main(
    int argc,
    char **argv,
    const char *dbname,
    const char *username,
    OliphauntEmbeddedIO *io);

typedef struct Latch Latch;

extern volatile sig_atomic_t InterruptPending;
extern volatile sig_atomic_t QueryCancelPending;
extern Latch *MyLatch;
extern void SetLatch(Latch *latch);

static int32_t close_unpublished_handle(OliphauntHandle *handle);

static bool last_error_is_empty(OliphauntHandle *handle) {
    char snapshot[OLIPHAUNT_ERROR_CAPACITY];
    (void)oliphaunt_copy_last_error(handle, snapshot, sizeof(snapshot));
    return snapshot[0] == '\0';
}

const char *oliphaunt_handle_pgdata(OliphauntHandle *handle) {
    return handle != NULL ? handle->pgdata : NULL;
}

static int advance_logical_generation_locked(OliphauntHandle *handle) {
    if (handle->logical_generation == UINT64_MAX) {
        return -1;
    }
    handle->logical_generation++;
    return 0;
}

/*
 * oliphaunt_acquire_global_instance returns an existing resident handle with
 * its mutex held. Keeping that lock across validation and lease activation
 * prevents terminal close from claiming and freeing the resident allocation
 * between lookup and reopen.
 */
static int reopen_resident_runtime_locked(
    OliphauntHandle *handle,
    const OliphauntConfig *config,
    OliphauntHandle **out) {
    if (handle == NULL) {
        set_error(NULL, "native liboliphaunt process-wide runtime is unavailable");
        return -1;
    }
    if (handle->logical_active) {
        pthread_mutex_unlock(&handle->mutex);
        set_error(NULL, "native liboliphaunt already has an active logical direct handle");
        return -1;
    }
    if (handle->backend_exited || handle->closing) {
        pthread_mutex_unlock(&handle->mutex);
        set_error(NULL, "native liboliphaunt resident runtime has already shut down");
        return -1;
    }
    if (!oliphaunt_config_matches_resident_runtime(handle, config)) {
        pthread_mutex_unlock(&handle->mutex);
        set_error(NULL, "native liboliphaunt resident runtime is bound to a different root, identity, runtime, root-lock ownership mode, or extension startup configuration");
        return -1;
    }
    if (advance_logical_generation_locked(handle) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        set_error(NULL, "native liboliphaunt logical generation space is exhausted");
        return -1;
    }
    handle->logical_active = true;
    oliphaunt_set_error(handle, "");
    *out = handle;
    pthread_mutex_unlock(&handle->mutex);
    return 0;
}

static int set_backend_env_var(
    OliphauntHandle *handle,
    const char *name,
    const char *value,
    char **previous,
    bool *had_previous,
    bool *overridden,
    const char *label) {
    const char *current = getenv(name);
    *had_previous = current != NULL;
    if (current != NULL) {
        *previous = strdup(current);
        if (*previous == NULL) {
            char message[1024];
            snprintf(message, sizeof(message), "out of memory saving %s environment", name);
            set_error(handle, message);
            return -1;
        }
    }
    if (setenv(name, value, 1) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "set %s environment for embedded backend %s: %s", name, label, strerror(errno));
        set_error(handle, message);
        free(*previous);
        *previous = NULL;
        *had_previous = false;
        return -1;
    }
    *overridden = true;
    return 0;
}

static void restore_backend_env_var(
    const char *name,
    char **previous,
    bool *had_previous,
    bool *overridden) {
    if (!*overridden) {
        return;
    }
    if (*had_previous) {
        (void)setenv(name, *previous != NULL ? *previous : "", 1);
    } else {
        (void)unsetenv(name);
    }
    free(*previous);
    *previous = NULL;
    *had_previous = false;
    *overridden = false;
}

static int unset_backend_env_var(
    OliphauntHandle *handle,
    const char *name,
    char **previous,
    bool *had_previous,
    bool *overridden,
    const char *label) {
    const char *current = getenv(name);
    *had_previous = current != NULL;
    if (current == NULL) {
        return 0;
    }
    *previous = strdup(current);
    if (*previous == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "out of memory saving %s environment", name);
        set_error(handle, message);
        return -1;
    }
    if (unsetenv(name) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "clear %s environment for embedded backend %s: %s", name, label, strerror(errno));
        set_error(handle, message);
        free(*previous);
        *previous = NULL;
        *had_previous = false;
        return -1;
    }
    *overridden = true;
    return 0;
}

static int set_backend_pgdata_env(OliphauntHandle *handle) {
    return set_backend_env_var(
        handle,
        "PGDATA",
        handle->pgdata,
        &handle->previous_pgdata_env,
        &handle->had_previous_pgdata_env,
        &handle->pgdata_env_overridden,
        "data directory");
}

static int clear_backend_internal_collation_env(OliphauntHandle *handle) {
    if (unset_backend_env_var(
            handle,
            "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY",
            &handle->previous_skip_system_collation_discovery_env,
            &handle->had_previous_skip_system_collation_discovery_env,
            &handle->skip_system_collation_discovery_env_overridden,
            "collation discovery") != 0 ||
        unset_backend_env_var(
            handle,
            "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY",
            &handle->previous_skip_icu_collation_discovery_env,
            &handle->had_previous_skip_icu_collation_discovery_env,
            &handle->skip_icu_collation_discovery_env_overridden,
            "ICU collation discovery") != 0 ||
        unset_backend_env_var(
            handle,
            "OLIPHAUNT_INTERNAL_ICU_READY",
            &handle->previous_internal_icu_ready_env,
            &handle->had_previous_internal_icu_ready_env,
            &handle->internal_icu_ready_env_overridden,
            "ICU initdb readiness") != 0) {
        return -1;
    }
    return 0;
}

static int set_backend_icu_data_env(OliphauntHandle *handle) {
    char *icu_data_dir = oliphaunt_runtime_icu_data_dir(handle->runtime_dir);
    if (icu_data_dir == NULL) {
        return unset_backend_env_var(
            handle,
            "ICU_DATA",
            &handle->previous_icu_data_env,
            &handle->had_previous_icu_data_env,
            &handle->icu_data_env_overridden,
            "ICU data");
    }
    int rc = set_backend_env_var(
        handle,
        "ICU_DATA",
        icu_data_dir,
        &handle->previous_icu_data_env,
        &handle->had_previous_icu_data_env,
        &handle->icu_data_env_overridden,
        "ICU data");
    free(icu_data_dir);
    return rc;
}

static int set_backend_proj_data_env(OliphauntHandle *handle) {
    if (handle->runtime_dir == NULL || handle->runtime_dir[0] == '\0') {
        return 0;
    }
    char *proj_dir = oliphaunt_join_path(handle->runtime_dir, "share/postgresql/proj");
    if (proj_dir == NULL) {
        set_error(handle, "out of memory resolving PostGIS PROJ data directory");
        return -1;
    }
    char *proj_db = oliphaunt_join_path(proj_dir, "proj.db");
    if (proj_db == NULL) {
        free(proj_dir);
        set_error(handle, "out of memory resolving PostGIS proj.db path");
        return -1;
    }
    int has_proj_db = oliphaunt_path_exists(proj_db);
    free(proj_db);
    if (!has_proj_db) {
        free(proj_dir);
        return 0;
    }

    int rc = set_backend_env_var(
        handle,
        "PROJ_DATA",
        proj_dir,
        &handle->previous_proj_data_env,
        &handle->had_previous_proj_data_env,
        &handle->proj_data_env_overridden,
        "PostGIS PROJ data");
    free(proj_dir);
    return rc;
}

static int set_backend_embedded_module_dir_env(OliphauntHandle *handle) {
    char *module_dir = oliphaunt_resolve_embedded_module_dir(handle->module_dir, handle->runtime_dir);
    if (module_dir == NULL) {
        if (handle->module_dir != NULL && handle->module_dir[0] != '\0') {
            set_error(handle, "configured embedded module directory is no longer available");
            return -1;
        }
        return 0;
    }
    int rc = set_backend_env_var(
        handle,
        OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV,
        module_dir,
        &handle->previous_module_dir_env,
        &handle->had_previous_module_dir_env,
        &handle->module_dir_env_overridden,
        "embedded module directory");
    free(module_dir);
    return rc;
}

static int set_backend_runtime_env(OliphauntHandle *handle) {
    if (set_backend_pgdata_env(handle) != 0) {
        return -1;
    }
    if (clear_backend_internal_collation_env(handle) != 0) {
        return -1;
    }
    if (set_backend_icu_data_env(handle) != 0) {
        return -1;
    }
    if (set_backend_proj_data_env(handle) != 0) {
        return -1;
    }
    if (set_backend_embedded_module_dir_env(handle) != 0) {
        return -1;
    }
    return 0;
}

static void restore_backend_runtime_env(OliphauntHandle *handle) {
    if (handle == NULL) {
        return;
    }
    restore_backend_env_var(
        OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV,
        &handle->previous_module_dir_env,
        &handle->had_previous_module_dir_env,
        &handle->module_dir_env_overridden);
    restore_backend_env_var(
        "PROJ_DATA",
        &handle->previous_proj_data_env,
        &handle->had_previous_proj_data_env,
        &handle->proj_data_env_overridden);
    restore_backend_env_var(
        "ICU_DATA",
        &handle->previous_icu_data_env,
        &handle->had_previous_icu_data_env,
        &handle->icu_data_env_overridden);
    restore_backend_env_var(
        "OLIPHAUNT_INTERNAL_ICU_READY",
        &handle->previous_internal_icu_ready_env,
        &handle->had_previous_internal_icu_ready_env,
        &handle->internal_icu_ready_env_overridden);
    restore_backend_env_var(
        "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY",
        &handle->previous_skip_icu_collation_discovery_env,
        &handle->had_previous_skip_icu_collation_discovery_env,
        &handle->skip_icu_collation_discovery_env_overridden);
    restore_backend_env_var(
        "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY",
        &handle->previous_skip_system_collation_discovery_env,
        &handle->had_previous_skip_system_collation_discovery_env,
        &handle->skip_system_collation_discovery_env_overridden);
    restore_backend_env_var(
        "PGDATA",
        &handle->previous_pgdata_env,
        &handle->had_previous_pgdata_env,
        &handle->pgdata_env_overridden);
}

static void mark_backend_failed(OliphauntHandle *handle) {
    pthread_mutex_lock(&handle->mutex);
    if (last_error_is_empty(handle)) {
        set_error(handle, "embedded backend failed before startup");
    }
    handle->backend_status = -1;
    handle->backend_exited = true;
    handle->closing = true;
    pthread_cond_broadcast(&handle->input_cond);
    pthread_cond_broadcast(&handle->output_cond);
    pthread_mutex_unlock(&handle->mutex);
}

static void *backend_thread_main(void *arg) {
    OliphauntHandle *handle = (OliphauntHandle *)arg;
    OliphauntBackendArgv backend_argv = {0};
    if (oliphaunt_build_backend_argv(handle, &backend_argv) != 0) {
        if (last_error_is_empty(handle)) {
            set_error(handle, "failed to build embedded backend argv");
        }
        mark_backend_failed(handle);
        return NULL;
    }
    if (set_backend_runtime_env(handle) != 0) {
        restore_backend_runtime_env(handle);
        oliphaunt_free_backend_argv(&backend_argv);
        mark_backend_failed(handle);
        return NULL;
    }

    int rc = oliphaunt_embedded_main(
        backend_argv.argc,
        backend_argv.argv,
        handle->database,
        handle->username,
        &handle->io);
    restore_backend_runtime_env(handle);
    oliphaunt_free_backend_argv(&backend_argv);

    pthread_mutex_lock(&handle->mutex);
    handle->backend_status = rc;
    handle->backend_exited = true;
    handle->closing = true;
    pthread_cond_broadcast(&handle->input_cond);
    pthread_cond_broadcast(&handle->output_cond);
    pthread_mutex_unlock(&handle->mutex);
    return NULL;
}

static int start_backend(OliphauntHandle *handle) {
    handle->postgres_path = oliphaunt_resolve_postgres_argv0(handle->runtime_dir);
    if (handle->postgres_path == NULL) {
        set_error(handle, "out of memory while resolving postgres path");
        return -1;
    }

    handle->io.context = handle;
    handle->io.read = oliphaunt_embedded_read;
    handle->io.write = oliphaunt_embedded_write;

    pthread_attr_t attr;
    int rc = pthread_attr_init(&attr);
    if (rc != 0) {
        char message[OLIPHAUNT_ERROR_CAPACITY];
        snprintf(message, sizeof(message), "pthread_attr_init failed: %d", rc);
        set_error(handle, message);
        return -1;
    }
    size_t stack_size = oliphaunt_backend_stack_size_bytes();
    rc = pthread_attr_setstacksize(&attr, stack_size);
    if (rc != 0) {
        pthread_attr_destroy(&attr);
        char message[OLIPHAUNT_ERROR_CAPACITY];
        snprintf(
            message,
            sizeof(message),
            "pthread_attr_setstacksize(%zu) failed: %d",
            stack_size,
            rc);
        set_error(handle, message);
        return -1;
    }
    rc = pthread_create(&handle->backend_thread, &attr, backend_thread_main, handle);
    pthread_attr_destroy(&attr);
    if (rc != 0) {
        char message[OLIPHAUNT_ERROR_CAPACITY];
        snprintf(message, sizeof(message), "pthread_create failed: %d", rc);
        set_error(handle, message);
        return -1;
    }
    handle->thread_started = true;

    pthread_mutex_lock(&handle->mutex);
    rc = oliphaunt_wait_for_ready_locked(handle, oliphaunt_startup_timeout_ms());
    if (rc == 0) {
        handle->output_len = 0;
        handle->output_scan_off = 0;
        handle->output_ready = false;
    }
    pthread_mutex_unlock(&handle->mutex);
    return rc;
}

static int32_t oliphaunt_init_impl(const OliphauntConfig *config, OliphauntHandle **out) {
    if (out == NULL) {
        set_error(NULL, "oliphaunt_init out parameter is null");
        return -1;
    }
    *out = NULL;
    if (config == NULL || config->abi_version != OLIPHAUNT_ABI_VERSION || config->pgdata == NULL) {
        set_error(NULL, "invalid oliphaunt_init config");
        return -1;
    }
    if (config->module_dir != NULL &&
        (config->module_dir[0] == '\0' || !oliphaunt_path_is_directory(config->module_dir))) {
        set_error(NULL, "invalid oliphaunt_init module_dir");
        return -1;
    }
    if ((config->flags & ~OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK) != 0) {
        set_error(NULL, "invalid oliphaunt_init config flags");
        return -1;
    }
    if (oliphaunt_validate_startup_args(NULL, config) != 0) {
        return -1;
    }
    char symbol_scope_error[512];
    if (oliphaunt_ensure_extension_symbol_scope(
            symbol_scope_error,
            sizeof(symbol_scope_error)) != 0) {
        set_error(NULL, symbol_scope_error);
        return -1;
    }
    OliphauntHandle *existing = NULL;
    int acquire_rc = oliphaunt_acquire_global_instance(&existing);
    if (acquire_rc < 0) {
        return -1;
    }
    if (acquire_rc > 0) {
        return reopen_resident_runtime_locked(existing, config, out);
    }

    OliphauntHandle *handle = (OliphauntHandle *)calloc(1, sizeof(OliphauntHandle));
    if (handle == NULL) {
        oliphaunt_release_global_instance(false);
        set_error(NULL, "out of memory allocating OliphauntHandle");
        return -1;
    }
    if (pthread_mutex_init(&handle->error_mutex, NULL) != 0) {
        free(handle);
        oliphaunt_release_global_instance(false);
        set_error(NULL, "failed to initialize native liboliphaunt error synchronization");
        return -1;
    }
    handle->error_mutex_initialized = true;
    handle->stable_root_lock_fd = -1;
    handle->external_root_lock =
        (config->flags & OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK) != 0;
    handle->trace_protocol = oliphaunt_trace_enabled();
    handle->transaction_status = 'I';

    handle->pgdata = oliphaunt_dup_config_string(config->pgdata, "");
    handle->runtime_dir = oliphaunt_dup_config_string(config->runtime_dir, "");
    handle->module_dir = oliphaunt_dup_config_string(config->module_dir, "");
    handle->username = oliphaunt_dup_config_string(config->username, "postgres");
    handle->database = oliphaunt_dup_config_string(config->database, "postgres");
    if (handle->pgdata == NULL || handle->runtime_dir == NULL || handle->module_dir == NULL ||
        handle->username == NULL || handle->database == NULL) {
        close_unpublished_handle(handle);
        set_error(NULL, "out of memory copying oliphaunt config");
        return -1;
    }
    if (oliphaunt_dup_startup_args(handle, config) != 0) {
        char message[1024];
        (void)oliphaunt_copy_last_error(handle, message, sizeof(message));
        close_unpublished_handle(handle);
        set_error(NULL, message);
        return -1;
    }
    if ((config->flags & OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK) == 0 &&
        oliphaunt_acquire_root_lock(handle, handle->pgdata) != 0) {
        char message[1024];
        (void)oliphaunt_copy_last_error(handle, message, sizeof(message));
        close_unpublished_handle(handle);
        set_error(NULL, message);
        return -1;
    }
    if (oliphaunt_validate_managed_root(handle, handle->pgdata) != 0) {
        char message[1024];
        (void)oliphaunt_copy_last_error(handle, message, sizeof(message));
        close_unpublished_handle(handle);
        set_error(NULL, message);
        return -1;
    }

    if (pthread_mutex_init(&handle->mutex, NULL) != 0) {
        close_unpublished_handle(handle);
        set_error(NULL, "failed to initialize native liboliphaunt synchronization");
        return -1;
    }
    if (pthread_cond_init(&handle->input_cond, NULL) != 0) {
        pthread_mutex_destroy(&handle->mutex);
        close_unpublished_handle(handle);
        set_error(NULL, "failed to initialize native liboliphaunt synchronization");
        return -1;
    }
    if (pthread_cond_init(&handle->output_cond, NULL) != 0) {
        pthread_cond_destroy(&handle->input_cond);
        pthread_mutex_destroy(&handle->mutex);
        close_unpublished_handle(handle);
        set_error(NULL, "failed to initialize native liboliphaunt synchronization");
        return -1;
    }
    handle->sync_initialized = true;

    if (start_backend(handle) != 0) {
        char message[1024];
        (void)oliphaunt_copy_last_error(handle, message, sizeof(message));
        close_unpublished_handle(handle);
        set_error(NULL, message);
        return -1;
    }

    pthread_mutex_lock(&handle->mutex);
    if (advance_logical_generation_locked(handle) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        close_unpublished_handle(handle);
        set_error(NULL, "native liboliphaunt logical generation space is exhausted");
        return -1;
    }
    handle->logical_active = true;
    pthread_mutex_unlock(&handle->mutex);
    oliphaunt_register_process_exit_shutdown();
    oliphaunt_publish_global_instance(handle);
    *out = handle;
    return 0;
}

static int32_t run_init_operation(
    const OliphauntConfig *config,
    OliphauntHandle **out,
    OliphauntErrorCapture *capture,
    bool capture_required) {
    OliphauntErrorScope error_scope;
    oliphaunt_error_scope_begin(&error_scope, NULL, "oliphaunt_init");
    int32_t rc = -1;
    if (capture_required && capture == NULL) {
        set_error(NULL, "oliphaunt_init error capture is null");
    } else {
        rc = oliphaunt_init_impl(config, out);
    }
    oliphaunt_error_scope_end(&error_scope, rc != 0);
    oliphaunt_error_capture_current(capture, NULL, rc != 0);
    return rc;
}

int32_t oliphaunt_init(const OliphauntConfig *config, OliphauntHandle **out) {
    return run_init_operation(config, out, NULL, false);
}

int32_t oliphaunt_init_with_error(
    const OliphauntConfig *config,
    OliphauntHandle **out,
    OliphauntErrorCapture *error) {
    return run_init_operation(config, out, error, true);
}

static int32_t oliphaunt_detach_impl(OliphauntHandle *handle) {
    if (handle == NULL) {
        return 0;
    }
    pthread_mutex_lock(&handle->mutex);
    if (oliphaunt_reject_if_streaming_locked(handle) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (!handle->logical_active) {
        pthread_mutex_unlock(&handle->mutex);
        return 0;
    }
    bool can_reset = handle->sync_initialized && handle->thread_started && !handle->backend_exited && !handle->closing;
    bool in_transaction = handle->transaction_status != 'I';
    bool backup_mode_exit_unconfirmed = handle->backup_mode_exit_unconfirmed;
    pthread_mutex_unlock(&handle->mutex);

    if (backup_mode_exit_unconfirmed) {
        /* The resident backend cannot be reused safely when PostgreSQL may
         * still be in backup mode. Terminal close releases the root lease and
         * restores process state; PostgreSQL embedding remains one backend per
         * process lifetime, so callers must restart the process before open. */
        return oliphaunt_close(handle);
    }

    if (can_reset) {
        if (in_transaction) {
            OliphauntResponse response = {0};
            static const char rollback_sql[] = "ROLLBACK";
            int32_t rc = oliphaunt_exec_simple_query(handle, rollback_sql, sizeof(rollback_sql) - 1, &response);
            oliphaunt_free_response(&response);
            if (rc != 0) {
                return rc;
            }
        }

        OliphauntResponse response = {0};
        static const char discard_sql[] = "DISCARD ALL";
        int32_t rc = oliphaunt_exec_simple_query(handle, discard_sql, sizeof(discard_sql) - 1, &response);
        oliphaunt_free_response(&response);
        if (rc != 0) {
            return rc;
        }
    }

    pthread_mutex_lock(&handle->mutex);
    handle->logical_active = false;
    handle->output_len = 0;
    handle->output_scan_off = 0;
    handle->output_ready = false;
    oliphaunt_clear_stream_chunks_locked(handle);
    pthread_mutex_unlock(&handle->mutex);
    return 0;
}

static int32_t run_detach_operation(
    OliphauntHandle *handle,
    OliphauntErrorCapture *capture,
    bool capture_required) {
    OliphauntErrorScope error_scope;
    oliphaunt_error_scope_begin(&error_scope, NULL, "oliphaunt_detach");
    int32_t rc = -1;
    bool retiring = false;
    if (capture_required && capture == NULL) {
        set_error(NULL, "oliphaunt_detach error capture is null");
    } else if (handle == NULL) {
        rc = oliphaunt_detach_impl(handle);
    } else if (oliphaunt_begin_handle_retirement(handle) == 0) {
        retiring = true;
        error_scope.fallback_handle = handle;
        rc = oliphaunt_detach_impl(handle);
    }
    oliphaunt_error_scope_end(&error_scope, rc != 0);
    /* A poisoned detach may promote this retirement to terminal close and
     * free the handle. Successful captures are empty and never dereference
     * their fallback; failures leave the retirement owner resident. */
    oliphaunt_error_capture_current(
        capture,
        retiring && rc != 0 ? handle : NULL,
        rc != 0);
    if (retiring) {
        oliphaunt_end_handle_retirement();
    }
    return rc;
}

int32_t oliphaunt_detach(OliphauntHandle *handle) {
    return run_detach_operation(handle, NULL, false);
}

int32_t oliphaunt_detach_with_error(
    OliphauntHandle *handle,
    OliphauntErrorCapture *error) {
    return run_detach_operation(handle, error, true);
}

int32_t oliphaunt_close_claimed_global_instance(OliphauntHandle *handle) {
    if (handle == NULL) {
        return 0;
    }

    if (handle->sync_initialized) {
        pthread_mutex_lock(&handle->mutex);
        handle->logical_active = false;
        if (handle->thread_started && !handle->backend_exited) {
            static const unsigned char terminate[] = {'X', 0, 0, 0, 4};
            handle->closing = true;
            if (handle->input_len == 0) {
                (void)oliphaunt_set_input_locked(handle, terminate, sizeof(terminate));
            } else {
                pthread_cond_broadcast(&handle->input_cond);
            }
        } else {
            handle->closing = true;
            pthread_cond_broadcast(&handle->input_cond);
        }
        pthread_mutex_unlock(&handle->mutex);
    }

    if (handle->thread_started) {
        pthread_join(handle->backend_thread, NULL);
    }

    /* Public wrappers may still be publishing an operation-owned error after
     * their PostgreSQL work released handle->mutex. Keep every field and
     * synchronization primitive alive through that boundary. */
    oliphaunt_wait_for_active_handle_calls();

    if (handle->sync_initialized) {
        pthread_cond_destroy(&handle->input_cond);
        pthread_cond_destroy(&handle->output_cond);
        pthread_mutex_destroy(&handle->mutex);
    }
    if (handle->error_mutex_initialized) {
        pthread_mutex_destroy(&handle->error_mutex);
        handle->error_mutex_initialized = false;
    }

    free(handle->pgdata);
    free(handle->runtime_dir);
    free(handle->module_dir);
    free(handle->username);
    free(handle->database);
    free(handle->postgres_path);
    free(handle->previous_pgdata_env);
    free(handle->previous_proj_data_env);
    free(handle->previous_icu_data_env);
    free(handle->previous_skip_system_collation_discovery_env);
    free(handle->previous_skip_icu_collation_discovery_env);
    free(handle->previous_internal_icu_ready_env);
    free(handle->previous_module_dir_env);
    oliphaunt_release_root_lock(handle);
    for (size_t i = 0; i < handle->startup_arg_count; i++) {
        free(handle->startup_args[i]);
    }
    free(handle->startup_args);
    free(handle->input);
    free(handle->output);
    oliphaunt_clear_stream_chunks_locked(handle);
    free(handle);
    return 0;
}

static int32_t close_unpublished_handle(OliphauntHandle *handle) {
    if (handle == NULL) {
        return 0;
    }
    bool spent = handle->thread_started;
    int32_t rc = oliphaunt_close_claimed_global_instance(handle);
    oliphaunt_release_global_instance(spent);
    return rc;
}

static int32_t oliphaunt_close_if_generation_impl(uint64_t generation) {
    if (generation == 0) {
        set_error(NULL, "invalid oliphaunt_close_if_generation generation");
        return -1;
    }

    OliphauntHandle *claimed = NULL;
    int claim_rc = oliphaunt_claim_global_instance_for_close(
        NULL,
        generation,
        true,
        &claimed);
    if (claim_rc == 1) {
        return 1;
    }
    if (claim_rc == 2) {
        return 0;
    }
    if (claim_rc != 0 || claimed == NULL) {
        return -1;
    }
    return oliphaunt_close_claimed_global_instance(claimed);
}

int32_t oliphaunt_close_if_generation(uint64_t generation) {
    OliphauntErrorScope error_scope;
    oliphaunt_error_scope_begin(&error_scope, NULL, "oliphaunt_close_if_generation");
    int32_t rc = oliphaunt_close_if_generation_impl(generation);
    oliphaunt_error_scope_end(&error_scope, rc < 0);
    return rc;
}

static int32_t oliphaunt_close_impl(OliphauntHandle *handle) {
    if (handle == NULL) {
        return 0;
    }

    OliphauntHandle *claimed = NULL;
    int claim_rc = oliphaunt_claim_global_instance_for_close(
        handle,
        0,
        false,
        &claimed);
    if (claim_rc == 1 || claim_rc == 2) {
        return 0;
    }
    if (claim_rc != 0 || claimed == NULL) {
        return -1;
    }
    return oliphaunt_close_claimed_global_instance(claimed);
}

int32_t oliphaunt_close(OliphauntHandle *handle) {
    OliphauntErrorScope error_scope;
    oliphaunt_error_scope_begin(&error_scope, NULL, "oliphaunt_close");
    int32_t rc = oliphaunt_close_impl(handle);
    oliphaunt_error_scope_end(&error_scope, rc != 0);
    return rc;
}

static int32_t oliphaunt_cancel_impl(OliphauntHandle *handle) {
    if (handle == NULL) {
        set_error(NULL, "invalid oliphaunt_cancel arguments");
        return -1;
    }

    pthread_mutex_lock(&handle->mutex);
    if (!handle->logical_active) {
        set_error(handle, "native liboliphaunt logical handle is closed");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (!handle->thread_started || handle->backend_exited || handle->closing) {
        set_error(handle, "native backend is not running");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }

    InterruptPending = true;
    QueryCancelPending = true;
    if (MyLatch != NULL) {
        SetLatch(MyLatch);
    }
    pthread_cond_broadcast(&handle->input_cond);
    pthread_cond_broadcast(&handle->output_cond);
    pthread_mutex_unlock(&handle->mutex);
    return 0;
}

int32_t oliphaunt_cancel(OliphauntHandle *handle) {
    OliphauntErrorScope error_scope;
    oliphaunt_error_scope_begin(&error_scope, NULL, "oliphaunt_cancel");
    int32_t rc = -1;
    bool leased = false;
    if (handle == NULL) {
        rc = oliphaunt_cancel_impl(handle);
    } else if (oliphaunt_begin_handle_call(handle) == 0) {
        leased = true;
        error_scope.fallback_handle = handle;
        rc = oliphaunt_cancel_impl(handle);
    }
    oliphaunt_error_scope_end(&error_scope, rc != 0);
    if (leased) {
        oliphaunt_end_handle_call();
    }
    return rc;
}

const char *oliphaunt_version(void) {
    return OLIPHAUNT_PRODUCT_VERSION;
}

void oliphaunt_free_response(OliphauntResponse *response) {
    if (response == NULL) {
        return;
    }
    free(response->data);
    response->data = NULL;
    response->len = 0;
}
