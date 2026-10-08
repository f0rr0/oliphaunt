#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include "../include/oliphaunt.h"

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#if !defined(__linux__)
#error "The retained Native signal-boundary probe currently targets Linux only."
#endif

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

#define ARRAY_LENGTH(value) (sizeof(value) / sizeof((value)[0]))
#define SENTINEL_TIMER_SECONDS 1800
#define MAX_TRACKED_SIGNAL 128
#define COPY_INPUT_WAIT_MILLIS 1000
#define CPU_BOUND_SQL \
    "SELECT count(*) FROM generate_series(1, 1000000000) AS value"

typedef struct SignalSpec {
    int number;
    const char *name;
} SignalSpec;

static const SignalSpec signal_specs[] = {
    {SIGHUP, "SIGHUP"},
    {SIGINT, "SIGINT"},
    {SIGTERM, "SIGTERM"},
    {SIGQUIT, "SIGQUIT"},
    {SIGPIPE, "SIGPIPE"},
    {SIGUSR1, "SIGUSR1"},
    {SIGUSR2, "SIGUSR2"},
    {SIGALRM, "SIGALRM"},
    {SIGCHLD, "SIGCHLD"},
    {SIGURG, "SIGURG"},
    {SIGFPE, "SIGFPE"},
    {SIGWINCH, "SIGWINCH"},
};

typedef enum DispositionKind {
    DISPOSITION_SENTINEL,
    DISPOSITION_DEFAULT,
    DISPOSITION_IGNORE,
    DISPOSITION_OTHER,
} DispositionKind;

typedef struct SignalObservation {
    DispositionKind disposition;
    bool blocked;
} SignalObservation;

typedef struct BoundarySnapshot {
    SignalObservation signals[ARRAY_LENGTH(signal_specs)];
    int64_t timer_value_micros;
    int64_t timer_interval_micros;
    bool timer_sentinel_preserved;
    bool mask_sentinel_preserved;
    int sigurg_sentinel_deliveries;
} BoundarySnapshot;

typedef struct QueryObservation {
    int abi_result;
    size_t response_bytes;
    bool has_error;
    bool has_notice;
    bool has_ready;
    bool diagnostic_matched;
} QueryObservation;

typedef struct CancelThreadState {
    OliphauntHandle *handle;
    const char *sql;
    const char *expected_diagnostic;
    QueryObservation query;
    int64_t query_duration_micros;
} CancelThreadState;

typedef struct ProtocolStreamState {
    OliphauntHandle *handle;
    const char *sql;
    const char *expected_diagnostic;
    pthread_mutex_t callback_mutex;
    pthread_cond_t callback_cond;
    uint8_t *response_data;
    size_t response_len;
    size_t response_capacity;
    bool copy_input_seen;
    bool finished;
    QueryObservation query;
    int64_t query_duration_micros;
} ProtocolStreamState;

static volatile sig_atomic_t sentinel_deliveries[MAX_TRACKED_SIGNAL];

static int64_t monotonic_micros(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return -1;
    }
    return (int64_t)now.tv_sec * INT64_C(1000000) + now.tv_nsec / 1000;
}

static void sentinel_handler(int signo) {
    if (signo > 0 && signo < MAX_TRACKED_SIGNAL) {
        sentinel_deliveries[signo]++;
    }
}

static const char *disposition_name(DispositionKind disposition) {
    switch (disposition) {
        case DISPOSITION_SENTINEL:
            return "sentinel";
        case DISPOSITION_DEFAULT:
            return "default";
        case DISPOSITION_IGNORE:
            return "ignore";
        case DISPOSITION_OTHER:
            return "other";
    }
    return "unknown";
}

static bool response_has_bytes(
    const OliphauntResponse *response,
    const char *expected) {
    const size_t expected_length = strlen(expected);
    if (expected_length == 0) {
        return true;
    }
    if (response->data == NULL || response->len < expected_length) {
        return false;
    }
    for (size_t offset = 0; offset <= response->len - expected_length; offset++) {
        if (memcmp(response->data + offset, expected, expected_length) == 0) {
            return true;
        }
    }
    return false;
}

static bool response_has_tag(const OliphauntResponse *response, uint8_t expected) {
    size_t offset = 0;
    while (offset + 5 <= response->len) {
        const uint32_t frame_length =
            ((uint32_t)response->data[offset + 1] << 24u) |
            ((uint32_t)response->data[offset + 2] << 16u) |
            ((uint32_t)response->data[offset + 3] << 8u) |
            (uint32_t)response->data[offset + 4];
        if (frame_length < 4 || frame_length > response->len - offset - 1) {
            return false;
        }
        if (response->data[offset] == expected) {
            return true;
        }
        offset += (size_t)frame_length + 1u;
    }
    return false;
}

static QueryObservation observe_response(
    int abi_result,
    const OliphauntResponse *response,
    const char *expected_diagnostic) {
    QueryObservation observation = {
        .abi_result = abi_result,
        .response_bytes = response->len,
    };
    if (observation.abi_result == 0) {
        observation.has_error = response_has_tag(response, 'E');
        observation.has_notice = response_has_tag(response, 'N');
        observation.has_ready = response_has_tag(response, 'Z');
        observation.diagnostic_matched = expected_diagnostic == NULL ||
            response_has_bytes(response, expected_diagnostic);
    }
    return observation;
}

static QueryObservation execute_query(
    OliphauntHandle *handle,
    const char *sql,
    const char *expected_diagnostic) {
    OliphauntResponse response = {0};
    const int abi_result = oliphaunt_exec_simple_query(
        handle,
        sql,
        strlen(sql),
        &response);
    const QueryObservation observation = observe_response(
        abi_result,
        &response,
        expected_diagnostic);
    oliphaunt_free_response(&response);
    return observation;
}

static void *cancel_query_main(void *context) {
    CancelThreadState *state = (CancelThreadState *)context;
    const int64_t started_micros = monotonic_micros();
    state->query = execute_query(
        state->handle,
        state->sql,
        state->expected_diagnostic);
    const int64_t finished_micros = monotonic_micros();
    state->query_duration_micros =
        started_micros >= 0 && finished_micros >= started_micros
        ? finished_micros - started_micros
        : -1;
    return NULL;
}

static int initialize_protocol_stream_state(
    ProtocolStreamState *state,
    OliphauntHandle *handle,
    const char *sql,
    const char *expected_diagnostic) {
    state->handle = handle;
    state->sql = sql;
    state->expected_diagnostic = expected_diagnostic;
    state->query_duration_micros = -1;
    if (pthread_mutex_init(&state->callback_mutex, NULL) != 0) {
        return -1;
    }
    if (pthread_cond_init(&state->callback_cond, NULL) != 0) {
        (void)pthread_mutex_destroy(&state->callback_mutex);
        return -1;
    }
    return 0;
}

static void destroy_protocol_stream_state(ProtocolStreamState *state) {
    free(state->response_data);
    state->response_data = NULL;
    state->response_len = 0;
    state->response_capacity = 0;
    (void)pthread_cond_destroy(&state->callback_cond);
    (void)pthread_mutex_destroy(&state->callback_mutex);
}

static uint8_t *simple_query_request(const char *sql, size_t *request_len) {
    const size_t sql_len = strlen(sql);
    if (sql_len > (size_t)UINT32_MAX - 5u) {
        return NULL;
    }
    const uint32_t frame_len = (uint32_t)sql_len + 5u;
    *request_len = sql_len + 6u;
    uint8_t *request = (uint8_t *)malloc(*request_len);
    if (request == NULL) {
        return NULL;
    }
    request[0] = 'Q';
    request[1] = (uint8_t)(frame_len >> 24u);
    request[2] = (uint8_t)(frame_len >> 16u);
    request[3] = (uint8_t)(frame_len >> 8u);
    request[4] = (uint8_t)frame_len;
    memcpy(request + 5u, sql, sql_len);
    request[5u + sql_len] = '\0';
    return request;
}

static int32_t count_unexpected_protocol_chunk(
    void *context,
    const uint8_t *data,
    size_t len) {
    size_t *callback_calls = (size_t *)context;
    (void)data;
    (void)len;
    (*callback_calls)++;
    return 0;
}

/*
 * Native accepts input only as a batch of complete frontend protocol frames.
 * Prove that a valid Query frame followed by a truncated COPY-data frame is
 * rejected before either public raw-protocol API can publish any of the batch
 * to PostgreSQL.  This is the invariant that makes an empty input queue a
 * message boundary, rather than a recoverable partial-message boundary.
 */
static int expect_trailing_partial_copy_frame_rejected(
    OliphauntHandle *handle,
    const char *label,
    const uint8_t *partial_frame,
    size_t partial_frame_len,
    const char *expected_error) {
    size_t query_len = 0;
    uint8_t *query = simple_query_request(
        "COPY oliphaunt_unreachable_partial_input(value) FROM STDIN",
        &query_len);
    if (query == NULL || query_len > SIZE_MAX - partial_frame_len) {
        free(query);
        fprintf(stderr, "signal boundary probe failed: build %s request\n", label);
        return -1;
    }

    const size_t request_len = query_len + partial_frame_len;
    uint8_t *request = (uint8_t *)malloc(request_len);
    if (request == NULL) {
        free(query);
        fprintf(stderr, "signal boundary probe failed: allocate %s request\n", label);
        return -1;
    }
    memcpy(request, query, query_len);
    memcpy(request + query_len, partial_frame, partial_frame_len);
    free(query);

    OliphauntResponse response = {0};
    if (oliphaunt_exec_protocol(handle, request, request_len, &response) == 0) {
        fprintf(stderr, "signal boundary probe failed: exec accepted %s\n", label);
        oliphaunt_free_response(&response);
        free(request);
        return -1;
    }
    if (response.data != NULL || response.len != 0 ||
        strstr(last_error_message(handle), expected_error) == NULL) {
        fprintf(stderr, "signal boundary probe failed: exec %s rejection contract\n", label);
        oliphaunt_free_response(&response);
        free(request);
        return -1;
    }

    size_t callback_calls = 0;
    if (oliphaunt_exec_protocol_raw_stream(
            handle,
            request,
            request_len,
            count_unexpected_protocol_chunk,
            &callback_calls) == 0) {
        fprintf(stderr, "signal boundary probe failed: stream accepted %s\n", label);
        free(request);
        return -1;
    }
    free(request);
    if (callback_calls != 0 ||
        strstr(last_error_message(handle), expected_error) == NULL) {
        fprintf(stderr, "signal boundary probe failed: stream %s rejection contract\n", label);
        return -1;
    }
    return 0;
}

static int32_t observe_protocol_stream_chunk(
    void *context,
    const uint8_t *data,
    size_t len) {
    ProtocolStreamState *state = (ProtocolStreamState *)context;
    int32_t result = 0;
    if (pthread_mutex_lock(&state->callback_mutex) != 0) {
        return -1;
    }
    if (len > 0 && state->response_len > SIZE_MAX - len) {
        result = -1;
    } else if (len > 0 && state->response_len + len > state->response_capacity) {
        size_t next_capacity = state->response_capacity == 0
            ? 1024u
            : state->response_capacity;
        while (next_capacity < state->response_len + len) {
            if (next_capacity > SIZE_MAX / 2u) {
                next_capacity = state->response_len + len;
                break;
            }
            next_capacity *= 2u;
        }
        uint8_t *grown = (uint8_t *)realloc(state->response_data, next_capacity);
        if (grown == NULL) {
            result = -1;
        } else {
            state->response_data = grown;
            state->response_capacity = next_capacity;
        }
    }
    if (result == 0 && len > 0) {
        memcpy(state->response_data + state->response_len, data, len);
        state->response_len += len;
    }
    if (result == 0) {
        const OliphauntResponse response = {
            .data = state->response_data,
            .len = state->response_len,
        };
        if (response_has_tag(&response, 'G')) {
            state->copy_input_seen = true;
            (void)pthread_cond_broadcast(&state->callback_cond);
        }
    }
    (void)pthread_mutex_unlock(&state->callback_mutex);
    return result;
}

static void *protocol_stream_query_main(void *context) {
    ProtocolStreamState *state = (ProtocolStreamState *)context;
    size_t request_len = 0;
    uint8_t *request = simple_query_request(state->sql, &request_len);
    const int64_t started_micros = monotonic_micros();
    int abi_result = -1;
    if (request != NULL) {
        abi_result = oliphaunt_exec_protocol_raw_stream(
            state->handle,
            request,
            request_len,
            observe_protocol_stream_chunk,
            state);
    }
    const int64_t finished_micros = monotonic_micros();
    free(request);

    (void)pthread_mutex_lock(&state->callback_mutex);
    const OliphauntResponse response = {
        .data = state->response_data,
        .len = state->response_len,
    };
    state->query = observe_response(
        abi_result,
        &response,
        state->expected_diagnostic);
    state->query_duration_micros =
        started_micros >= 0 && finished_micros >= started_micros
        ? finished_micros - started_micros
        : -1;
    state->finished = true;
    (void)pthread_cond_broadcast(&state->callback_cond);
    (void)pthread_mutex_unlock(&state->callback_mutex);
    return NULL;
}

static int wait_for_copy_input(ProtocolStreamState *state, int timeout_millis) {
    struct timespec deadline;
    if (clock_gettime(CLOCK_REALTIME, &deadline) != 0) {
        return -1;
    }
    deadline.tv_sec += timeout_millis / 1000;
    deadline.tv_nsec += (long)(timeout_millis % 1000) * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec++;
        deadline.tv_nsec -= 1000000000L;
    }

    if (pthread_mutex_lock(&state->callback_mutex) != 0) {
        return -1;
    }
    int wait_result = 0;
    while (!state->copy_input_seen && !state->finished && wait_result == 0) {
        wait_result = pthread_cond_timedwait(
            &state->callback_cond,
            &state->callback_mutex,
            &deadline);
    }
    const bool copy_input_seen = state->copy_input_seen;
    (void)pthread_mutex_unlock(&state->callback_mutex);
    return copy_input_seen ? 0 : -1;
}

static int isolate_process_group(void) {
    const pid_t process_id = getpid();
    if (getsid(0) != process_id || getpgrp() != process_id) {
        if (setsid() < 0) {
            fprintf(stderr, "signal boundary probe failed: setsid: %s\n", strerror(errno));
            return -1;
        }
    }
    if (getsid(0) != process_id || getpgrp() != process_id) {
        fprintf(stderr, "signal boundary probe failed: child is not its own session/group\n");
        return -1;
    }
    return 0;
}

static int install_sentinels(
    struct sigaction original_actions[ARRAY_LENGTH(signal_specs)],
    size_t *installed_count,
    struct itimerval *original_timer,
    sigset_t *original_mask) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = sentinel_handler;
    action.sa_flags = SA_RESTART;
    if (sigemptyset(&action.sa_mask) != 0) {
        fprintf(stderr, "signal boundary probe failed: sigemptyset: %s\n", strerror(errno));
        return -1;
    }

    *installed_count = 0;
    for (size_t index = 0; index < ARRAY_LENGTH(signal_specs); index++) {
        if (sigaction(signal_specs[index].number, NULL, &original_actions[index]) != 0 ||
            sigaction(signal_specs[index].number, &action, NULL) != 0) {
            fprintf(
                stderr,
                "signal boundary probe failed: install %s sentinel: %s\n",
                signal_specs[index].name,
                strerror(errno));
            return -1;
        }
        *installed_count = index + 1;
    }

    if (sigprocmask(SIG_SETMASK, NULL, original_mask) != 0) {
        fprintf(stderr, "signal boundary probe failed: capture signal mask: %s\n", strerror(errno));
        return -1;
    }
    sigset_t sentinel_mask = *original_mask;
    if (sigaddset(&sentinel_mask, SIGWINCH) != 0 ||
        sigdelset(&sentinel_mask, SIGURG) != 0 ||
        sigprocmask(SIG_SETMASK, &sentinel_mask, NULL) != 0) {
        fprintf(stderr, "signal boundary probe failed: install sentinel mask: %s\n", strerror(errno));
        return -1;
    }

    struct itimerval sentinel_timer;
    memset(&sentinel_timer, 0, sizeof(sentinel_timer));
    sentinel_timer.it_value.tv_sec = SENTINEL_TIMER_SECONDS;
    if (setitimer(ITIMER_REAL, &sentinel_timer, original_timer) != 0) {
        fprintf(stderr, "signal boundary probe failed: install sentinel timer: %s\n", strerror(errno));
        return -1;
    }
    return 0;
}

static int restore_host_state(
    const struct sigaction original_actions[ARRAY_LENGTH(signal_specs)],
    size_t installed_count,
    const struct itimerval *original_timer,
    const sigset_t *original_mask) {
    int failed = 0;
    if (setitimer(ITIMER_REAL, original_timer, NULL) != 0) {
        failed = 1;
    }
    for (size_t index = 0; index < installed_count; index++) {
        if (sigaction(signal_specs[index].number, &original_actions[index], NULL) != 0) {
            failed = 1;
        }
    }
    if (sigprocmask(SIG_SETMASK, original_mask, NULL) != 0) {
        failed = 1;
    }
    return failed == 0 ? 0 : -1;
}

static int64_t timeval_micros(const struct timeval *value) {
    return (int64_t)value->tv_sec * INT64_C(1000000) + (int64_t)value->tv_usec;
}

static int capture_snapshot(BoundarySnapshot *snapshot) {
    sigset_t mask;
    struct itimerval timer;
    if (sigprocmask(SIG_SETMASK, NULL, &mask) != 0 ||
        getitimer(ITIMER_REAL, &timer) != 0) {
        fprintf(stderr, "signal boundary probe failed: capture process state: %s\n", strerror(errno));
        return -1;
    }

    for (size_t index = 0; index < ARRAY_LENGTH(signal_specs); index++) {
        struct sigaction action;
        if (sigaction(signal_specs[index].number, NULL, &action) != 0) {
            fprintf(
                stderr,
                "signal boundary probe failed: inspect %s: %s\n",
                signal_specs[index].name,
                strerror(errno));
            return -1;
        }
        if (action.sa_handler == sentinel_handler) {
            snapshot->signals[index].disposition = DISPOSITION_SENTINEL;
        } else if (action.sa_handler == SIG_DFL) {
            snapshot->signals[index].disposition = DISPOSITION_DEFAULT;
        } else if (action.sa_handler == SIG_IGN) {
            snapshot->signals[index].disposition = DISPOSITION_IGNORE;
        } else {
            snapshot->signals[index].disposition = DISPOSITION_OTHER;
        }
        snapshot->signals[index].blocked =
            sigismember(&mask, signal_specs[index].number) == 1;
    }

    snapshot->timer_value_micros = timeval_micros(&timer.it_value);
    snapshot->timer_interval_micros = timeval_micros(&timer.it_interval);
    snapshot->timer_sentinel_preserved =
        snapshot->timer_interval_micros == 0 &&
        snapshot->timer_value_micros > INT64_C(1500000000);
    snapshot->mask_sentinel_preserved =
        sigismember(&mask, SIGWINCH) == 1 &&
        sigismember(&mask, SIGURG) == 0;
    snapshot->sigurg_sentinel_deliveries = (int)sentinel_deliveries[SIGURG];
    return 0;
}

/*
 * A caller-thread mask snapshot cannot detect PostgreSQL unblocking a signal
 * on its backend pthread.  Send a process-directed blocked signal and require
 * it to remain pending until this caller consumes it synchronously.
 */
static int verify_blocked_signal_routing(const char *phase) {
    const sig_atomic_t deliveries_before = sentinel_deliveries[SIGWINCH];
    if (kill(getpid(), SIGWINCH) != 0) {
        fprintf(stderr, "signal boundary probe failed: %s send SIGWINCH: %s\n",
                phase, strerror(errno));
        return -1;
    }
    struct timespec settle = {.tv_sec = 0, .tv_nsec = 10000000};
    while (nanosleep(&settle, &settle) != 0 && errno == EINTR) {
    }
    sigset_t pending;
    if (sigpending(&pending) != 0 || sigismember(&pending, SIGWINCH) != 1 ||
        sentinel_deliveries[SIGWINCH] != deliveries_before) {
        fprintf(stderr,
                "signal boundary probe failed: %s backend thread accepted blocked SIGWINCH\n",
                phase);
        return -1;
    }
    sigset_t only_sigwinch;
    if (sigemptyset(&only_sigwinch) != 0 ||
        sigaddset(&only_sigwinch, SIGWINCH) != 0) {
        return -1;
    }
    const struct timespec no_wait = {.tv_sec = 0, .tv_nsec = 0};
    if (sigtimedwait(&only_sigwinch, NULL, &no_wait) != SIGWINCH ||
        sentinel_deliveries[SIGWINCH] != deliveries_before) {
        fprintf(stderr,
                "signal boundary probe failed: %s could not consume pending SIGWINCH\n",
                phase);
        return -1;
    }
    return 0;
}

static void print_snapshot(const char *name, const BoundarySnapshot *snapshot, bool comma) {
    printf("\"%s\":{\"signals\":{", name);
    for (size_t index = 0; index < ARRAY_LENGTH(signal_specs); index++) {
        printf(
            "%s\"%s\":{\"disposition\":\"%s\",\"blocked\":%s}",
            index == 0 ? "" : ",",
            signal_specs[index].name,
            disposition_name(snapshot->signals[index].disposition),
            snapshot->signals[index].blocked ? "true" : "false");
    }
    printf(
        "},\"timer\":{\"valueMicros\":%lld,\"intervalMicros\":%lld,"
        "\"sentinelPreserved\":%s},\"maskSentinelPreserved\":%s,"
        "\"sigurgSentinelDeliveries\":%d}%s",
        (long long)snapshot->timer_value_micros,
        (long long)snapshot->timer_interval_micros,
        snapshot->timer_sentinel_preserved ? "true" : "false",
        snapshot->mask_sentinel_preserved ? "true" : "false",
        snapshot->sigurg_sentinel_deliveries,
        comma ? "," : "");
}

static void print_query_observation(const QueryObservation *observation) {
    printf(
        "{\"abiResult\":%d,\"responseBytes\":%zu,\"hasError\":%s,"
        "\"hasNotice\":%s,\"hasReady\":%s,\"diagnosticMatched\":%s}",
        observation->abi_result,
        observation->response_bytes,
        observation->has_error ? "true" : "false",
        observation->has_notice ? "true" : "false",
        observation->has_ready ? "true" : "false",
        observation->diagnostic_matched ? "true" : "false");
}

static int query_is_success(const QueryObservation *observation) {
    return observation->abi_result == 0 &&
        !observation->has_error &&
        observation->has_ready;
}

int main(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: %s <pgdata> <runtime-dir> <module-dir>\n", argv[0]);
        return 2;
    }
    if (isolate_process_group() != 0) {
        return 1;
    }

    struct sigaction original_actions[ARRAY_LENGTH(signal_specs)];
    struct itimerval original_timer;
    sigset_t original_mask;
    size_t installed_count = 0;
    bool sentinels_installed = false;
    OliphauntHandle *handle = NULL;
    int result = 1;

    BoundarySnapshot installed = {0};
    BoundarySnapshot after_init = {0};
    BoundarySnapshot after_timeout = {0};
    BoundarySnapshot after_cancel = {0};
    BoundarySnapshot after_cpu_timeout = {0};
    BoundarySnapshot after_cpu_cancel = {0};
    BoundarySnapshot after_copy_input_timeout = {0};
    BoundarySnapshot after_copy_input_cancel = {0};
    BoundarySnapshot after_supervisor_sql = {0};
    BoundarySnapshot after_close = {0};

    QueryObservation input_validation_recovery = {0};
    QueryObservation timeout_query = {0};
    QueryObservation timeout_recovery = {0};
    QueryObservation cancel_recovery = {0};
    QueryObservation cpu_timeout_query = {0};
    QueryObservation cpu_timeout_recovery = {0};
    QueryObservation cpu_cancel_setup = {0};
    QueryObservation cpu_cancel_recovery = {0};
    QueryObservation copy_input_timeout_setup = {0};
    QueryObservation copy_input_timeout_recovery = {0};
    QueryObservation copy_input_cancel_setup = {0};
    QueryObservation copy_input_cancel_recovery = {0};
    QueryObservation reload_query = {0};
    QueryObservation rotate_query = {0};
    QueryObservation promote_query = {0};
    QueryObservation final_recovery = {0};
    CancelThreadState cancel_state = {0};
    int cancel_result = -1;
    int64_t cancel_call_duration_micros = -1;
    int64_t cancel_total_duration_micros = -1;
    bool cancel_thread_created = false;
    bool cancel_thread_joined = false;
    int64_t cpu_timeout_duration_micros = -1;
    CancelThreadState cpu_cancel_state = {0};
    int cpu_cancel_result = -1;
    int64_t cpu_cancel_call_duration_micros = -1;
    int64_t cpu_cancel_total_duration_micros = -1;
    bool cpu_cancel_thread_created = false;
    bool cpu_cancel_thread_joined = false;
    ProtocolStreamState copy_input_timeout_state = {0};
    bool copy_input_timeout_state_initialized = false;
    ProtocolStreamState copy_input_cancel_state = {0};
    bool copy_input_cancel_state_initialized = false;
    pthread_t copy_input_cancel_thread;
    bool copy_input_cancel_thread_created = false;
    bool copy_input_cancel_thread_joined = false;
    bool copy_input_observed_before_cancel = false;
    int copy_input_cancel_result = -1;
    int64_t copy_input_cancel_call_duration_micros = -1;
    int64_t copy_input_cancel_total_duration_micros = -1;
    int close_result = -1;
    int blocked_signal_routing_checks = 0;

    if (install_sentinels(
            original_actions,
            &installed_count,
            &original_timer,
            &original_mask) != 0) {
        goto cleanup;
    }
    sentinels_installed = true;
    if (capture_snapshot(&installed) != 0) {
        goto cleanup;
    }

    OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = argv[1],
        .runtime_dir = argv[2],
        .module_dir = argv[3],
        .username = "postgres",
        .database = "postgres",
        .flags = 0,
        .startup_args = NULL,
        .startup_arg_count = 0,
    };
    if (oliphaunt_init(&config, &handle) != 0 || handle == NULL) {
        fprintf(
            stderr,
            "signal boundary probe failed: oliphaunt_init: %s\n",
            last_error_message(handle));
        goto cleanup;
    }
    if (capture_snapshot(&after_init) != 0 ||
        verify_blocked_signal_routing("after init") != 0) {
        goto cleanup;
    }
    blocked_signal_routing_checks++;

    /*
     * These suffixes would leave COPY waiting after consuming respectively
     * part of the next message length and part of its declared body.  Native
     * must reject the whole concatenated batch before the preceding Query can
     * reach PostgreSQL.
     */
    static const uint8_t partial_copy_length[] = {'d', 0, 0};
    static const uint8_t partial_copy_body[] = {'d', 0, 0, 0, 8, '1'};
    if (expect_trailing_partial_copy_frame_rejected(
            handle,
            "COPY-data partial length",
            partial_copy_length,
            sizeof(partial_copy_length),
            "truncated message header") != 0 ||
        expect_trailing_partial_copy_frame_rejected(
            handle,
            "COPY-data partial body",
            partial_copy_body,
            sizeof(partial_copy_body),
            "truncated message body") != 0) {
        goto cleanup;
    }
    input_validation_recovery = execute_query(handle, "SELECT 0", NULL);
    if (!query_is_success(&input_validation_recovery)) {
        fprintf(stderr, "signal boundary probe failed: input validation recovery\n");
        goto cleanup;
    }

    timeout_query = execute_query(
        handle,
        "SET statement_timeout = '40ms'; SELECT pg_sleep(0.2)",
        "canceling statement due to statement timeout");
    if (timeout_query.abi_result != 0 || !timeout_query.has_error ||
        !timeout_query.has_ready || !timeout_query.diagnostic_matched) {
        fprintf(stderr, "signal boundary probe failed: statement_timeout contract\n");
        goto cleanup;
    }
    timeout_recovery = execute_query(
        handle,
        "SET statement_timeout = 0; SELECT 1",
        NULL);
    if (!query_is_success(&timeout_recovery) || capture_snapshot(&after_timeout) != 0 ||
        verify_blocked_signal_routing("after timeout recovery") != 0) {
        fprintf(stderr, "signal boundary probe failed: timeout recovery\n");
        goto cleanup;
    }
    blocked_signal_routing_checks++;

    cancel_state.handle = handle;
    cancel_state.sql = "SELECT pg_sleep(2)";
    cancel_state.expected_diagnostic = "canceling statement due to user request";
    pthread_t cancel_thread;
    const int64_t cancel_total_started_micros = monotonic_micros();
    if (pthread_create(&cancel_thread, NULL, cancel_query_main, &cancel_state) != 0) {
        fprintf(stderr, "signal boundary probe failed: create cancel query thread\n");
        goto cleanup;
    }
    cancel_thread_created = true;
    struct timespec cancel_delay = {.tv_sec = 0, .tv_nsec = 100000000};
    while (nanosleep(&cancel_delay, &cancel_delay) != 0 && errno == EINTR) {
    }
    const int64_t cancel_call_started_micros = monotonic_micros();
    cancel_result = oliphaunt_cancel(handle);
    const int64_t cancel_call_finished_micros = monotonic_micros();
    if (cancel_call_started_micros >= 0 &&
        cancel_call_finished_micros >= cancel_call_started_micros) {
        cancel_call_duration_micros =
            cancel_call_finished_micros - cancel_call_started_micros;
    }
    if (pthread_join(cancel_thread, NULL) != 0) {
        fprintf(stderr, "signal boundary probe failed: join cancel query thread\n");
        goto cleanup;
    }
    cancel_thread_joined = true;
    const int64_t cancel_total_finished_micros = monotonic_micros();
    if (cancel_total_started_micros >= 0 &&
        cancel_total_finished_micros >= cancel_total_started_micros) {
        cancel_total_duration_micros =
            cancel_total_finished_micros - cancel_total_started_micros;
    }
    if (cancel_result != 0 || cancel_state.query.abi_result != 0 ||
        !cancel_state.query.has_error || !cancel_state.query.has_ready ||
        !cancel_state.query.diagnostic_matched) {
        fprintf(stderr, "signal boundary probe failed: public ABI cancel contract\n");
        goto cleanup;
    }
    cancel_recovery = execute_query(handle, "SELECT 2", NULL);
    if (!query_is_success(&cancel_recovery) || capture_snapshot(&after_cancel) != 0 ||
        verify_blocked_signal_routing("after cancel recovery") != 0) {
        fprintf(stderr, "signal boundary probe failed: cancel recovery\n");
        goto cleanup;
    }
    blocked_signal_routing_checks++;

    const int64_t cpu_timeout_started_micros = monotonic_micros();
    cpu_timeout_query = execute_query(
        handle,
        "SET statement_timeout = '40ms'; " CPU_BOUND_SQL,
        "canceling statement due to statement timeout");
    const int64_t cpu_timeout_finished_micros = monotonic_micros();
    if (cpu_timeout_started_micros >= 0 &&
        cpu_timeout_finished_micros >= cpu_timeout_started_micros) {
        cpu_timeout_duration_micros =
            cpu_timeout_finished_micros - cpu_timeout_started_micros;
    }
    if (cpu_timeout_query.abi_result != 0 || !cpu_timeout_query.has_error ||
        !cpu_timeout_query.has_ready || !cpu_timeout_query.diagnostic_matched) {
        fprintf(stderr, "signal boundary probe failed: CPU-bound statement_timeout contract\n");
        goto cleanup;
    }
    cpu_timeout_recovery = execute_query(
        handle,
        "SET statement_timeout = 0; SELECT 11",
        NULL);
    if (!query_is_success(&cpu_timeout_recovery) ||
        capture_snapshot(&after_cpu_timeout) != 0) {
        fprintf(stderr, "signal boundary probe failed: CPU-bound timeout recovery\n");
        goto cleanup;
    }

    cpu_cancel_setup = execute_query(handle, "SET statement_timeout = '2s'", NULL);
    if (!query_is_success(&cpu_cancel_setup)) {
        fprintf(stderr, "signal boundary probe failed: CPU-bound cancel guard setup\n");
        goto cleanup;
    }
    cpu_cancel_state.handle = handle;
    cpu_cancel_state.sql = CPU_BOUND_SQL;
    cpu_cancel_state.expected_diagnostic = "canceling statement due to user request";
    pthread_t cpu_cancel_thread;
    const int64_t cpu_cancel_total_started_micros = monotonic_micros();
    if (pthread_create(
            &cpu_cancel_thread,
            NULL,
            cancel_query_main,
            &cpu_cancel_state) != 0) {
        fprintf(stderr, "signal boundary probe failed: create CPU-bound cancel query thread\n");
        goto cleanup;
    }
    cpu_cancel_thread_created = true;
    struct timespec cpu_cancel_delay = {.tv_sec = 0, .tv_nsec = 100000000};
    while (nanosleep(&cpu_cancel_delay, &cpu_cancel_delay) != 0 && errno == EINTR) {
    }
    const int64_t cpu_cancel_call_started_micros = monotonic_micros();
    cpu_cancel_result = oliphaunt_cancel(handle);
    const int64_t cpu_cancel_call_finished_micros = monotonic_micros();
    if (cpu_cancel_call_started_micros >= 0 &&
        cpu_cancel_call_finished_micros >= cpu_cancel_call_started_micros) {
        cpu_cancel_call_duration_micros =
            cpu_cancel_call_finished_micros - cpu_cancel_call_started_micros;
    }
    if (pthread_join(cpu_cancel_thread, NULL) != 0) {
        fprintf(stderr, "signal boundary probe failed: join CPU-bound cancel query thread\n");
        goto cleanup;
    }
    cpu_cancel_thread_joined = true;
    const int64_t cpu_cancel_total_finished_micros = monotonic_micros();
    if (cpu_cancel_total_started_micros >= 0 &&
        cpu_cancel_total_finished_micros >= cpu_cancel_total_started_micros) {
        cpu_cancel_total_duration_micros =
            cpu_cancel_total_finished_micros - cpu_cancel_total_started_micros;
    }
    if (cpu_cancel_result != 0 || cpu_cancel_state.query.abi_result != 0 ||
        !cpu_cancel_state.query.has_error || !cpu_cancel_state.query.has_ready ||
        !cpu_cancel_state.query.diagnostic_matched) {
        fprintf(stderr, "signal boundary probe failed: CPU-bound public ABI cancel contract\n");
        goto cleanup;
    }
    cpu_cancel_recovery = execute_query(
        handle,
        "SET statement_timeout = 0; SELECT 12",
        NULL);
    if (!query_is_success(&cpu_cancel_recovery) ||
        capture_snapshot(&after_cpu_cancel) != 0) {
        fprintf(stderr, "signal boundary probe failed: CPU-bound cancel recovery\n");
        goto cleanup;
    }

    copy_input_timeout_setup = execute_query(
        handle,
        "SET statement_timeout = '40ms'; "
        "CREATE TEMP TABLE oliphaunt_copy_input_timeout(value integer)",
        NULL);
    if (!query_is_success(&copy_input_timeout_setup)) {
        fprintf(stderr, "signal boundary probe failed: COPY-input timeout setup\n");
        goto cleanup;
    }
    if (initialize_protocol_stream_state(
            &copy_input_timeout_state,
            handle,
            "COPY oliphaunt_copy_input_timeout(value) FROM STDIN",
            "canceling statement due to statement timeout") != 0) {
        fprintf(stderr, "signal boundary probe failed: initialize COPY-input timeout state\n");
        goto cleanup;
    }
    copy_input_timeout_state_initialized = true;
    (void)protocol_stream_query_main(&copy_input_timeout_state);
    if (!copy_input_timeout_state.copy_input_seen ||
        copy_input_timeout_state.query.abi_result != 0 ||
        !copy_input_timeout_state.query.has_error ||
        !copy_input_timeout_state.query.has_ready ||
        !copy_input_timeout_state.query.diagnostic_matched) {
        fprintf(
            stderr,
            "signal boundary probe failed: COPY-input statement_timeout contract\n");
        goto cleanup;
    }
    copy_input_timeout_recovery = execute_query(
        handle,
        "SET statement_timeout = 0; SELECT 21",
        NULL);
    if (!query_is_success(&copy_input_timeout_recovery) ||
        capture_snapshot(&after_copy_input_timeout) != 0) {
        fprintf(stderr, "signal boundary probe failed: COPY-input timeout recovery\n");
        goto cleanup;
    }

    copy_input_cancel_setup = execute_query(
        handle,
        "SET statement_timeout = '2s'; "
        "CREATE TEMP TABLE oliphaunt_copy_input_cancel(value integer)",
        NULL);
    if (!query_is_success(&copy_input_cancel_setup)) {
        fprintf(stderr, "signal boundary probe failed: COPY-input cancel guard setup\n");
        goto cleanup;
    }
    if (initialize_protocol_stream_state(
            &copy_input_cancel_state,
            handle,
            "COPY oliphaunt_copy_input_cancel(value) FROM STDIN",
            "canceling statement due to user request") != 0) {
        fprintf(stderr, "signal boundary probe failed: initialize COPY-input cancel state\n");
        goto cleanup;
    }
    copy_input_cancel_state_initialized = true;
    const int64_t copy_input_cancel_total_started_micros = monotonic_micros();
    if (pthread_create(
            &copy_input_cancel_thread,
            NULL,
            protocol_stream_query_main,
            &copy_input_cancel_state) != 0) {
        fprintf(stderr, "signal boundary probe failed: create COPY-input cancel thread\n");
        goto cleanup;
    }
    copy_input_cancel_thread_created = true;
    copy_input_observed_before_cancel =
        wait_for_copy_input(&copy_input_cancel_state, COPY_INPUT_WAIT_MILLIS) == 0;
    const int64_t copy_input_cancel_call_started_micros = monotonic_micros();
    copy_input_cancel_result = oliphaunt_cancel(handle);
    const int64_t copy_input_cancel_call_finished_micros = monotonic_micros();
    if (copy_input_cancel_call_started_micros >= 0 &&
        copy_input_cancel_call_finished_micros >= copy_input_cancel_call_started_micros) {
        copy_input_cancel_call_duration_micros =
            copy_input_cancel_call_finished_micros - copy_input_cancel_call_started_micros;
    }
    if (pthread_join(copy_input_cancel_thread, NULL) != 0) {
        fprintf(stderr, "signal boundary probe failed: join COPY-input cancel thread\n");
        goto cleanup;
    }
    copy_input_cancel_thread_joined = true;
    const int64_t copy_input_cancel_total_finished_micros = monotonic_micros();
    if (copy_input_cancel_total_started_micros >= 0 &&
        copy_input_cancel_total_finished_micros >= copy_input_cancel_total_started_micros) {
        copy_input_cancel_total_duration_micros =
            copy_input_cancel_total_finished_micros -
            copy_input_cancel_total_started_micros;
    }
    if (!copy_input_observed_before_cancel || copy_input_cancel_result != 0 ||
        copy_input_cancel_state.query.abi_result != 0 ||
        !copy_input_cancel_state.query.has_error ||
        !copy_input_cancel_state.query.has_ready ||
        !copy_input_cancel_state.query.diagnostic_matched) {
        fprintf(stderr, "signal boundary probe failed: COPY-input cancel contract\n");
        goto cleanup;
    }
    copy_input_cancel_recovery = execute_query(
        handle,
        "SET statement_timeout = 0; SELECT 22",
        NULL);
    if (!query_is_success(&copy_input_cancel_recovery) ||
        capture_snapshot(&after_copy_input_cancel) != 0 ||
        verify_blocked_signal_routing("after COPY cancel recovery") != 0) {
        fprintf(stderr, "signal boundary probe failed: COPY-input cancel recovery\n");
        goto cleanup;
    }
    blocked_signal_routing_checks++;

    reload_query = execute_query(
        handle,
        "SELECT pg_reload_conf()",
        "configuration reload is not supported in a trusted embedded session");
    rotate_query = execute_query(
        handle,
        "SELECT pg_rotate_logfile()",
        "log rotation is not supported in a trusted embedded session");
    promote_query = execute_query(
        handle,
        "SELECT pg_promote(false, 1)",
        "standby promotion is not supported in a trusted embedded session");
    if (reload_query.abi_result != 0 || !reload_query.has_error ||
        !reload_query.has_ready || !reload_query.diagnostic_matched ||
        rotate_query.abi_result != 0 || rotate_query.has_error ||
        !rotate_query.has_notice || !rotate_query.has_ready ||
        !rotate_query.diagnostic_matched ||
        promote_query.abi_result != 0 || !promote_query.has_error ||
        !promote_query.has_ready || !promote_query.diagnostic_matched) {
        fprintf(stderr, "signal boundary probe failed: supervisor-only SQL contract\n");
        goto cleanup;
    }
    final_recovery = execute_query(handle, "SELECT 3", NULL);
    if (!query_is_success(&final_recovery) ||
        capture_snapshot(&after_supervisor_sql) != 0) {
        fprintf(stderr, "signal boundary probe failed: supervisor SQL recovery\n");
        goto cleanup;
    }

    close_result = oliphaunt_close(handle);
    handle = NULL;
    if (close_result != 0 || capture_snapshot(&after_close) != 0) {
        fprintf(stderr, "signal boundary probe failed: oliphaunt_close\n");
        goto cleanup;
    }
    result = 0;

cleanup:
    if (cancel_thread_created && !cancel_thread_joined) {
        (void)pthread_join(cancel_thread, NULL);
    }
    if (cpu_cancel_thread_created && !cpu_cancel_thread_joined) {
        (void)pthread_join(cpu_cancel_thread, NULL);
    }
    if (copy_input_cancel_thread_created && !copy_input_cancel_thread_joined) {
        (void)pthread_join(copy_input_cancel_thread, NULL);
    }
    if (handle != NULL) {
        (void)oliphaunt_close(handle);
    }
    int restoration_result = -1;
    if (sentinels_installed) {
        restoration_result = restore_host_state(
            original_actions,
            installed_count,
            &original_timer,
            &original_mask);
    }
    if (copy_input_timeout_state_initialized) {
        destroy_protocol_stream_state(&copy_input_timeout_state);
    }
    if (copy_input_cancel_state_initialized) {
        destroy_protocol_stream_state(&copy_input_cancel_state);
    }
    if (result != 0) {
        return result;
    }
    if (restoration_result != 0) {
        fprintf(stderr, "signal boundary probe failed: restore child host state\n");
        return 1;
    }

    printf(
        "{\"schema\":\"oliphaunt-native-signal-boundary-child-v1\","
        "\"privateProcessSession\":true,\"phases\":{");
    print_snapshot("installed", &installed, true);
    print_snapshot("afterInit", &after_init, true);
    print_snapshot("afterTimeout", &after_timeout, true);
    print_snapshot("afterCancel", &after_cancel, true);
    print_snapshot("afterCpuTimeout", &after_cpu_timeout, true);
    print_snapshot("afterCpuCancel", &after_cpu_cancel, true);
    print_snapshot("afterCopyInputTimeout", &after_copy_input_timeout, true);
    print_snapshot("afterCopyInputCancel", &after_copy_input_cancel, true);
    print_snapshot("afterSupervisorSql", &after_supervisor_sql, true);
    print_snapshot("afterClose", &after_close, false);
    printf(
        "},\"operations\":{\"inputValidation\":{"
        "\"partialCopyLengthRejectedBeforePublish\":true,"
        "\"partialCopyBodyRejectedBeforePublish\":true,\"recovery\":");
    print_query_observation(&input_validation_recovery);
    printf("},\"timeout\":{\"query\":");
    print_query_observation(&timeout_query);
    printf(",\"recovery\":");
    print_query_observation(&timeout_recovery);
    printf(
        "},\"cancel\":{\"cancelResult\":%d,\"queryDurationMicros\":%lld,"
        "\"cancelCallDurationMicros\":%lld,\"totalDurationMicros\":%lld,\"query\":",
        cancel_result,
        (long long)cancel_state.query_duration_micros,
        (long long)cancel_call_duration_micros,
        (long long)cancel_total_duration_micros);
    print_query_observation(&cancel_state.query);
    printf(",\"recovery\":");
    print_query_observation(&cancel_recovery);
    printf(
        "},\"cpuTimeout\":{\"queryDurationMicros\":%lld,\"query\":",
        (long long)cpu_timeout_duration_micros);
    print_query_observation(&cpu_timeout_query);
    printf(",\"recovery\":");
    print_query_observation(&cpu_timeout_recovery);
    printf(
        "},\"cpuCancel\":{\"cancelResult\":%d,\"queryDurationMicros\":%lld,"
        "\"cancelCallDurationMicros\":%lld,\"totalDurationMicros\":%lld,\"setup\":",
        cpu_cancel_result,
        (long long)cpu_cancel_state.query_duration_micros,
        (long long)cpu_cancel_call_duration_micros,
        (long long)cpu_cancel_total_duration_micros);
    print_query_observation(&cpu_cancel_setup);
    printf(",\"query\":");
    print_query_observation(&cpu_cancel_state.query);
    printf(",\"recovery\":");
    print_query_observation(&cpu_cancel_recovery);
    printf(
        "},\"copyInputTimeout\":{\"copyInObserved\":%s,"
        "\"queryDurationMicros\":%lld,\"setup\":",
        copy_input_timeout_state.copy_input_seen ? "true" : "false",
        (long long)copy_input_timeout_state.query_duration_micros);
    print_query_observation(&copy_input_timeout_setup);
    printf(",\"query\":");
    print_query_observation(&copy_input_timeout_state.query);
    printf(",\"recovery\":");
    print_query_observation(&copy_input_timeout_recovery);
    printf(
        "},\"copyInputCancel\":{\"copyInObservedBeforeCancel\":%s,"
        "\"cancelResult\":%d,\"queryDurationMicros\":%lld,"
        "\"cancelCallDurationMicros\":%lld,\"totalDurationMicros\":%lld,"
        "\"setup\":",
        copy_input_observed_before_cancel ? "true" : "false",
        copy_input_cancel_result,
        (long long)copy_input_cancel_state.query_duration_micros,
        (long long)copy_input_cancel_call_duration_micros,
        (long long)copy_input_cancel_total_duration_micros);
    print_query_observation(&copy_input_cancel_setup);
    printf(",\"query\":");
    print_query_observation(&copy_input_cancel_state.query);
    printf(",\"recovery\":");
    print_query_observation(&copy_input_cancel_recovery);
    printf("},\"supervisorSql\":{\"reload\":");
    print_query_observation(&reload_query);
    printf(",\"rotate\":");
    print_query_observation(&rotate_query);
    printf(",\"promote\":");
    print_query_observation(&promote_query);
    printf(",\"recovery\":");
    print_query_observation(&final_recovery);
    printf("}},\"sentinelDeliveries\":{");
    for (size_t index = 0; index < ARRAY_LENGTH(signal_specs); index++) {
        printf(
            "%s\"%s\":%d",
            index == 0 ? "" : ",",
            signal_specs[index].name,
            (int)sentinel_deliveries[signal_specs[index].number]);
    }
    printf(
        "},\"blockedSignalRoutingChecks\":%d,\"closeResult\":%d,"
        "\"childHostStateRestoredAfterObservation\":true}\n",
        blocked_signal_routing_checks,
        close_result);
    return 0;
}
