#ifndef _WIN32
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#endif

#include "../include/oliphaunt.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#error "The retained configured-identity negative control currently targets Linux only."
#endif

static const char probe_role[] = "oliphaunt_probe_user";

static const char missing_role[] = "oliphaunt_probe_missing_role";
static const char nologin_role[] = "oliphaunt_probe_nologin";
static const char connection_limited_role[] = "oliphaunt_probe_role_limit";
static const char connect_revoked_database[] = "oliphaunt_probe_no_connect";
static const char connections_disabled_database[] = "oliphaunt_probe_no_connections";
static const char connection_limited_database[] = "oliphaunt_probe_database_limit";

static const char seed_sql[] =
    "CREATE ROLE oliphaunt_probe_user LOGIN;"
    "ALTER ROLE oliphaunt_probe_user "
    "SET oliphaunt_probe.role_value TO 'role-setting-v1';"
    "ALTER DATABASE postgres "
    "SET oliphaunt_probe.database_value TO 'database-setting-v1';"
    "ALTER ROLE oliphaunt_probe_user IN DATABASE postgres "
    "SET oliphaunt_probe.combined_value TO 'role-database-setting-v1';"
    "SELECT 'seed-complete-v1'::text;";

static const char observe_sql[] =
    "SELECT current_user::text, session_user::text,"
    " COALESCE(current_setting('oliphaunt_probe.role_value', true), '<unset>'),"
    " COALESCE(current_setting('oliphaunt_probe.database_value', true), '<unset>'),"
    " COALESCE(current_setting('oliphaunt_probe.combined_value', true), '<unset>');";

/*
 * CREATE DATABASE cannot share an implicit transaction with another command,
 * so each entry is sent as its own simple-query cycle while retaining one
 * Direct backend.  The event trigger is installed last: the next configured
 * session must therefore account for exactly one login-trigger execution.
 */
static const char *const seed_contract_sql[] = {
    "CREATE ROLE oliphaunt_probe_switch_role NOLOGIN;"
    "GRANT oliphaunt_probe_switch_role TO oliphaunt_probe_user;"
    "CREATE ROLE oliphaunt_probe_nologin NOLOGIN;"
    "CREATE ROLE oliphaunt_probe_role_limit LOGIN CONNECTION LIMIT 0;",
    "CREATE DATABASE oliphaunt_probe_no_connect;",
    "CREATE DATABASE oliphaunt_probe_no_connections;",
    "CREATE DATABASE oliphaunt_probe_database_limit CONNECTION LIMIT 0;",
    "REVOKE CONNECT ON DATABASE oliphaunt_probe_no_connect FROM PUBLIC;"
    "ALTER DATABASE oliphaunt_probe_no_connections ALLOW_CONNECTIONS false;",
    "CREATE TABLE public.oliphaunt_probe_login_audit ("
    " session_name text NOT NULL, current_name text NOT NULL);"
    "REVOKE ALL ON public.oliphaunt_probe_login_audit FROM PUBLIC;"
    "GRANT SELECT ON public.oliphaunt_probe_login_audit TO oliphaunt_probe_user;"
    "CREATE FUNCTION public.oliphaunt_probe_record_login() RETURNS event_trigger "
    "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$"
    "BEGIN INSERT INTO public.oliphaunt_probe_login_audit(session_name, current_name) "
    "VALUES (session_user::text, current_user::text); END$$;"
    "CREATE EVENT TRIGGER oliphaunt_probe_login_trigger ON login "
    "EXECUTE FUNCTION public.oliphaunt_probe_record_login();",
    "SELECT 'contract-seed-complete-v1'::text;",
};

static const char observe_contract_sql[] =
    "SELECT 'initial'::text AS phase,"
    " current_user::text AS current_user,"
    " session_user::text AS session_user,"
    " CASE WHEN system_user IS NULL THEN 'true' ELSE 'false' END AS system_user_is_null,"
    " COALESCE(current_setting('oliphaunt_probe.role_value', true), '<unset>') AS role_setting,"
    " COALESCE(current_setting('oliphaunt_probe.database_value', true), '<unset>') AS database_setting,"
    " COALESCE(current_setting('oliphaunt_probe.combined_value', true), '<unset>') AS combined_setting,"
    " (SELECT count(*)::text FROM public.oliphaunt_probe_login_audit"
    "   WHERE session_name = session_user::text) AS login_count,"
    " current_setting('io_method') AS io_method,"
    " current_setting('max_worker_processes') AS max_worker_processes,"
    " current_setting('max_parallel_workers') AS max_parallel_workers,"
    " current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather,"
    " current_setting('max_parallel_maintenance_workers') AS max_parallel_maintenance_workers,"
    " current_setting('max_wal_senders') AS max_wal_senders;"
    "SET ROLE oliphaunt_probe_switch_role;"
    "SELECT 'set-role'::text AS phase, current_user::text AS current_user,"
    " session_user::text AS session_user;"
    "RESET ROLE;"
    "SELECT 'reset-role'::text AS phase, current_user::text AS current_user,"
    " session_user::text AS session_user;";

#if defined(_MSC_VER)
#define OLIPHAUNT_SMOKE_THREAD_LOCAL __declspec(thread)
#else
#define OLIPHAUNT_SMOKE_THREAD_LOCAL _Thread_local
#endif

static OLIPHAUNT_SMOKE_THREAD_LOCAL char
    last_error_buffer[OLIPHAUNT_ERROR_CAPTURE_CAPACITY];

static const char *last_error_message(OliphauntHandle *handle) {
    (void)oliphaunt_copy_last_error(
        handle,
        last_error_buffer,
        sizeof(last_error_buffer));
    return last_error_buffer;
}

typedef struct RejectionScenario {
    const char *mode;
    const char *username;
    const char *database;
} RejectionScenario;

static const RejectionScenario rejection_scenarios[] = {
    {"reject-missing-role", missing_role, "postgres"},
    {"reject-nologin", nologin_role, "postgres"},
    {"reject-connect", probe_role, connect_revoked_database},
    {"reject-datallowconn", probe_role, connections_disabled_database},
    {"reject-role-connection-limit", connection_limited_role, "postgres"},
    {"reject-database-connection-limit", probe_role, connection_limited_database},
};

static int fail(const char *context, OliphauntHandle *handle) {
    const char *error = last_error_message(handle);
    fprintf(
        stderr,
        "configured identity probe failed: %s: %s\n",
        context,
        error != NULL ? error : "(no liboliphaunt error)");
    return 1;
}

static char *hex_encode(const uint8_t *data, size_t length) {
    static const char digits[] = "0123456789abcdef";
    if (length > (SIZE_MAX - 1u) / 2u) {
        return NULL;
    }
    char *encoded = (char *)malloc(length * 2u + 1u);
    if (encoded == NULL) {
        return NULL;
    }
    for (size_t index = 0; index < length; index++) {
        encoded[index * 2u] = digits[data[index] >> 4u];
        encoded[index * 2u + 1u] = digits[data[index] & 0x0fu];
    }
    encoded[length * 2u] = '\0';
    return encoded;
}

static int append_bytes(
    uint8_t **target,
    size_t *target_length,
    const uint8_t *source,
    size_t source_length) {
    if (source_length == 0) {
        return 0;
    }
    if (*target_length > SIZE_MAX - source_length) {
        return -1;
    }
    const size_t next_length = *target_length + source_length;
    uint8_t *grown = (uint8_t *)realloc(*target, next_length);
    if (grown == NULL) {
        return -1;
    }
    memcpy(grown + *target_length, source, source_length);
    *target = grown;
    *target_length = next_length;
    return 0;
}

static int execute_queries_mode(
    const char *mode,
    const char *username,
    const char *database,
    const char *const *queries,
    size_t query_count,
    const char *pgdata,
    const char *runtime_dir,
    const char *module_dir) {
    OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = pgdata,
        .runtime_dir = runtime_dir,
        .module_dir = module_dir,
        .username = username,
        .database = database,
        .flags = 0,
        .startup_args = NULL,
        .startup_arg_count = 0,
    };
    OliphauntHandle *handle = NULL;
    uint8_t *combined_response = NULL;
    size_t combined_response_length = 0;

    if (oliphaunt_init(&config, &handle) != 0 || handle == NULL) {
        return fail("oliphaunt_init", handle);
    }

    for (size_t index = 0; index < query_count; index++) {
        const char *sql = queries[index];
        OliphauntResponse response = {0};
        if (oliphaunt_exec_simple_query(handle, sql, strlen(sql), &response) != 0) {
            int result = fail("oliphaunt_exec_simple_query", handle);
            oliphaunt_free_response(&response);
            free(combined_response);
            (void)oliphaunt_close(handle);
            return result;
        }
        if (append_bytes(
                &combined_response,
                &combined_response_length,
                response.data,
                response.len) != 0) {
            oliphaunt_free_response(&response);
            free(combined_response);
            (void)oliphaunt_close(handle);
            fprintf(stderr, "configured identity probe failed: combine query responses\n");
            return 1;
        }
        oliphaunt_free_response(&response);
    }

    char *response_hex = hex_encode(combined_response, combined_response_length);
    free(combined_response);
    if (response_hex == NULL) {
        (void)oliphaunt_close(handle);
        fprintf(stderr, "configured identity probe failed: encode query response\n");
        return 1;
    }
    if (oliphaunt_close(handle) != 0) {
        free(response_hex);
        return fail("oliphaunt_close", NULL);
    }

    printf(
        "{\"schema\":\"oliphaunt-native-configured-identity-child-v1\","
        "\"mode\":\"%s\",\"configuredUsername\":\"%s\","
        "\"configuredDatabase\":\"%s\",\"responseBytes\":%zu,"
        "\"responseHex\":\"%s\"}\n",
        mode,
        username,
        database,
        combined_response_length,
        response_hex);
    free(response_hex);
    return 0;
}

static int execute_rejection_mode(
    const RejectionScenario *scenario,
    const char *pgdata,
    const char *runtime_dir,
    const char *module_dir) {
    OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = pgdata,
        .runtime_dir = runtime_dir,
        .module_dir = module_dir,
        .username = scenario->username,
        .database = scenario->database,
        .flags = 0,
        .startup_args = NULL,
        .startup_arg_count = 0,
    };
    OliphauntHandle *handle = NULL;
    const int init_result = oliphaunt_init(&config, &handle);
    const bool startup_accepted = init_result == 0 && handle != NULL;
    const char *error = startup_accepted ? "" : last_error_message(handle);
    if (error == NULL) {
        error = "";
    }
    char *error_hex = hex_encode((const uint8_t *)error, strlen(error));
    if (error_hex == NULL) {
        if (startup_accepted) {
            (void)oliphaunt_close(handle);
        }
        fprintf(stderr, "configured identity probe failed: encode startup result\n");
        return 1;
    }
    if (startup_accepted && oliphaunt_close(handle) != 0) {
        free(error_hex);
        return fail("oliphaunt_close", NULL);
    }

    printf(
        "{\"schema\":\"oliphaunt-native-configured-identity-child-v1\","
        "\"mode\":\"%s\",\"configuredUsername\":\"%s\","
        "\"configuredDatabase\":\"%s\",\"startupAccepted\":%s,"
        "\"startupErrorBytes\":%zu,\"startupErrorHex\":\"%s\","
        "\"responseBytes\":0,\"responseHex\":\"\"}\n",
        scenario->mode,
        scenario->username,
        scenario->database,
        startup_accepted ? "true" : "false",
        strlen(error),
        error_hex);
    free(error_hex);
    return 0;
}

static const RejectionScenario *find_rejection_scenario(const char *mode) {
    for (size_t index = 0;
         index < sizeof(rejection_scenarios) / sizeof(rejection_scenarios[0]);
         index++) {
        if (strcmp(mode, rejection_scenarios[index].mode) == 0) {
            return &rejection_scenarios[index];
        }
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc != 5) {
        fprintf(
            stderr,
            "usage: %s <seed|observe|seed-contract|observe-contract|reject-*> "
            "<pgdata> <runtime-dir> <module-dir>\n",
            argv[0]);
        return 2;
    }

    const char *single_query[1];
    if (strcmp(argv[1], "seed") == 0) {
        single_query[0] = seed_sql;
        return execute_queries_mode(
            argv[1], "postgres", "postgres", single_query, 1,
            argv[2], argv[3], argv[4]);
    }
    if (strcmp(argv[1], "observe") == 0) {
        single_query[0] = observe_sql;
        return execute_queries_mode(
            argv[1], probe_role, "postgres", single_query, 1,
            argv[2], argv[3], argv[4]);
    }
    if (strcmp(argv[1], "seed-contract") == 0) {
        return execute_queries_mode(
            argv[1], "postgres", "postgres", seed_contract_sql,
            sizeof(seed_contract_sql) / sizeof(seed_contract_sql[0]),
            argv[2], argv[3], argv[4]);
    }
    if (strcmp(argv[1], "observe-contract") == 0) {
        single_query[0] = observe_contract_sql;
        return execute_queries_mode(
            argv[1], probe_role, "postgres", single_query, 1,
            argv[2], argv[3], argv[4]);
    }

    const RejectionScenario *scenario = find_rejection_scenario(argv[1]);
    if (scenario != NULL) {
        return execute_rejection_mode(scenario, argv[2], argv[3], argv[4]);
    }

    fprintf(stderr, "configured identity probe failed: unknown mode %s\n", argv[1]);
    return 2;
}
