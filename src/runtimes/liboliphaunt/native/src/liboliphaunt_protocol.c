#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "../include/oliphaunt.h"
#include "liboliphaunt_internal.h"

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifndef _WIN32
#include <unistd.h>
#endif

#define DEFAULT_STARTUP_TIMEOUT_MS 60000
#define DEFAULT_STREAM_QUEUE_MAX_BYTES (4 * 1024 * 1024)

extern void RequestTrustedEmbeddedTimeoutCheck(void);
extern bool TrustedEmbeddedInterruptPending(void);

static int wait_for_output_locked(
    OliphauntHandle *handle,
    const struct timespec *caller_deadline);

static int validate_frontend_protocol_frames(OliphauntHandle *handle, const uint8_t *request, size_t request_len) {
    if (request_len == 0) {
        set_error(handle, "malformed frontend protocol request: empty request");
        return -1;
    }
    size_t off = 0;
    while (off < request_len) {
        if (request_len - off < 5) {
            set_error(handle, "malformed frontend protocol request: truncated message header");
            return -1;
        }
        uint32_t msg_len = ((uint32_t)request[off + 1] << 24) |
                           ((uint32_t)request[off + 2] << 16) |
                           ((uint32_t)request[off + 3] << 8) |
                           (uint32_t)request[off + 4];
        if (msg_len < 4) {
            set_error(handle, "malformed frontend protocol request: message length is smaller than protocol header");
            return -1;
        }
        size_t total = (size_t)msg_len + 1;
        if (total > request_len - off) {
            set_error(handle, "malformed frontend protocol request: truncated message body");
            return -1;
        }
        off += total;
    }
    return 0;
}

static int append_output_locked(OliphauntHandle *handle, const void *buf, size_t len) {
    if (len == 0) {
        return 0;
    }
    size_t required = handle->output_len + len;
    if (required > handle->output_cap) {
        size_t next = handle->output_cap ? handle->output_cap : 8192;
        while (next < required) {
            next *= 2;
        }
        unsigned char *grown = (unsigned char *)realloc(handle->output, next);
        if (grown == NULL) {
            errno = ENOMEM;
            return -1;
        }
        handle->output = grown;
        handle->output_cap = next;
        if (handle->trace_protocol) {
            handle->trace_output_grows++;
        }
    }
    memcpy(handle->output + handle->output_len, buf, len);
    handle->output_len += len;
    return 0;
}

static uint32_t read_be32(const unsigned char *ptr) {
    return ((uint32_t)ptr[0] << 24) |
           ((uint32_t)ptr[1] << 16) |
           ((uint32_t)ptr[2] << 8) |
           (uint32_t)ptr[3];
}

static void reset_protocol_scanner(OliphauntProtocolScanner *scanner) {
    memset(scanner, 0, sizeof(*scanner));
}

static bool scan_stream_ready_locked(OliphauntHandle *handle, const unsigned char *buf, size_t len) {
    OliphauntProtocolScanner *scanner = &handle->stream_scanner;
    while (len > 0) {
        if (scanner->header_len < sizeof(scanner->header)) {
            size_t need = sizeof(scanner->header) - scanner->header_len;
            size_t take = len < need ? len : need;
            memcpy(scanner->header + scanner->header_len, buf, take);
            scanner->header_len += take;
            buf += take;
            len -= take;
            if (scanner->header_len < sizeof(scanner->header)) {
                continue;
            }

            scanner->tag = scanner->header[0];
            uint32_t msg_len = read_be32(scanner->header + 1);
            if (msg_len < 4) {
                handle->stream_failed = true;
                set_error(handle, "invalid backend protocol frame while streaming");
                return true;
            }
            scanner->payload_remaining = (size_t)msg_len - 4;
            if (scanner->payload_remaining == 0) {
                bool ready = scanner->tag == 'Z';
                if (ready) {
                    handle->transaction_status = 'I';
                }
                reset_protocol_scanner(scanner);
                if (ready) {
                    return true;
                }
            }
        }

        if (scanner->payload_remaining > 0) {
            size_t take = len < scanner->payload_remaining ? len : scanner->payload_remaining;
            if (scanner->tag == 'Z' && !scanner->ready_status_set && take > 0) {
                scanner->ready_status = buf[0];
                scanner->ready_status_set = true;
            }
            buf += take;
            len -= take;
            scanner->payload_remaining -= take;
            if (scanner->payload_remaining == 0) {
                bool ready = scanner->tag == 'Z';
                if (ready) {
                    handle->transaction_status = scanner->ready_status_set ? scanner->ready_status : 'I';
                }
                reset_protocol_scanner(scanner);
                if (ready) {
                    return true;
                }
            }
        }
    }
    return false;
}

static size_t stream_queue_max_bytes(void) {
    const char *value = getenv("OLIPHAUNT_STREAM_QUEUE_MAX_BYTES");
    if (value == NULL || value[0] == '\0') {
        return DEFAULT_STREAM_QUEUE_MAX_BYTES;
    }

    char *end = NULL;
    unsigned long long parsed = strtoull(value, &end, 10);
    if (end == value || parsed == 0) {
        return DEFAULT_STREAM_QUEUE_MAX_BYTES;
    }
    if (parsed > (unsigned long long)SIZE_MAX) {
        return SIZE_MAX;
    }
    return (size_t)parsed;
}

static bool stream_queue_has_room_locked(OliphauntHandle *handle, size_t len, size_t max_bytes) {
    if (len == 0) {
        return true;
    }
    if (len > max_bytes) {
        return handle->stream_bytes_queued == 0;
    }
    return handle->stream_bytes_queued <= max_bytes - len;
}

static int wait_for_stream_queue_room_locked(OliphauntHandle *handle, size_t len) {
    size_t max_bytes = handle->stream_queue_max_bytes > 0
                           ? handle->stream_queue_max_bytes
                           : DEFAULT_STREAM_QUEUE_MAX_BYTES;
    while (!stream_queue_has_room_locked(handle, len, max_bytes)) {
        if (!handle->streaming || handle->stream_failed || handle->backend_exited || handle->closing) {
            set_error(handle, "native liboliphaunt stream queue closed");
            errno = EPIPE;
            return -1;
        }
        int rc = wait_for_output_locked(handle, NULL);
        if (rc < 0) {
            return -1;
        }
    }
    return 0;
}

static int enqueue_stream_chunk_locked(OliphauntHandle *handle, const void *buf, size_t len) {
    if (len == 0) {
        return 0;
    }
    if (wait_for_stream_queue_room_locked(handle, len) != 0) {
        return -1;
    }
    OliphauntOutputChunk *chunk = (OliphauntOutputChunk *)calloc(1, sizeof(OliphauntOutputChunk));
    if (chunk == NULL) {
        set_error(handle, "out of memory enqueuing protocol stream response");
        errno = ENOMEM;
        return -1;
    }
    chunk->data = (unsigned char *)malloc(len);
    if (chunk->data == NULL) {
        free(chunk);
        set_error(handle, "out of memory enqueuing protocol stream response");
        errno = ENOMEM;
        return -1;
    }
    memcpy(chunk->data, buf, len);
    chunk->len = len;
    if (handle->stream_tail == NULL) {
        handle->stream_head = chunk;
        handle->stream_tail = chunk;
    } else {
        handle->stream_tail->next = chunk;
        handle->stream_tail = chunk;
    }
    handle->stream_bytes_queued += len;
    return 0;
}

static OliphauntOutputChunk *pop_stream_chunk_locked(OliphauntHandle *handle) {
    OliphauntOutputChunk *chunk = handle->stream_head;
    if (chunk == NULL) {
        return NULL;
    }
    handle->stream_head = chunk->next;
    if (handle->stream_head == NULL) {
        handle->stream_tail = NULL;
    }
    chunk->next = NULL;
    if (handle->stream_bytes_queued >= chunk->len) {
        handle->stream_bytes_queued -= chunk->len;
    } else {
        handle->stream_bytes_queued = 0;
    }
    pthread_cond_broadcast(&handle->output_cond);
    return chunk;
}

static void free_stream_chunk(OliphauntOutputChunk *chunk) {
    if (chunk == NULL) {
        return;
    }
    free(chunk->data);
    free(chunk);
}

void oliphaunt_clear_stream_chunks_locked(OliphauntHandle *handle) {
    OliphauntOutputChunk *chunk = handle->stream_head;
    handle->stream_head = NULL;
    handle->stream_tail = NULL;
    handle->stream_bytes_queued = 0;
    while (chunk != NULL) {
        OliphauntOutputChunk *next = chunk->next;
        free_stream_chunk(chunk);
        chunk = next;
    }
}

static bool scan_ready_for_query_locked(OliphauntHandle *handle) {
    bool trace = handle->trace_protocol;
    uint64_t scan_started = trace ? oliphaunt_monotonic_ns() : 0;
    size_t off = handle->output_scan_off;
    while (off + 5 <= handle->output_len) {
        unsigned char tag = handle->output[off];
        uint32_t msg_len = read_be32(handle->output + off + 1);
        if (msg_len < 4) {
            if (trace) {
                handle->trace_ready_scan_calls++;
                handle->trace_ready_scan_ns += oliphaunt_elapsed_ns(scan_started);
            }
            return false;
        }
        size_t frame_len = 1 + (size_t)msg_len;
        if (frame_len > handle->output_len - off) {
            if (trace) {
                handle->trace_ready_scan_calls++;
                handle->trace_ready_scan_ns += oliphaunt_elapsed_ns(scan_started);
            }
            return false;
        }
        if (tag == 'Z') {
            handle->transaction_status = msg_len >= 5 ? handle->output[off + 5] : 'I';
            handle->output_ready = true;
            off += frame_len;
            handle->output_scan_off = off;
            if (trace) {
                handle->trace_ready_scan_calls++;
                handle->trace_ready_scan_ns += oliphaunt_elapsed_ns(scan_started);
            }
            return true;
        }
        off += frame_len;
    }
    handle->output_scan_off = off;
    if (trace) {
        handle->trace_ready_scan_calls++;
        handle->trace_ready_scan_ns += oliphaunt_elapsed_ns(scan_started);
    }
    return handle->output_ready;
}

int oliphaunt_startup_timeout_ms(void) {
    const char *value = getenv("OLIPHAUNT_STARTUP_TIMEOUT_MS");
    if (value == NULL || value[0] == '\0') {
        return DEFAULT_STARTUP_TIMEOUT_MS;
    }
    int parsed = atoi(value);
    return parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
}

static void add_ms_to_timespec(struct timespec *ts, long ms) {
    ts->tv_sec += ms / 1000;
    ts->tv_nsec += (long)(ms % 1000) * 1000000L;
    if (ts->tv_nsec >= 1000000000L) {
        ts->tv_sec++;
        ts->tv_nsec -= 1000000000L;
    }
}

static int compare_timespec(const struct timespec *left, const struct timespec *right) {
    if (left->tv_sec < right->tv_sec) {
        return -1;
    }
    if (left->tv_sec > right->tv_sec) {
        return 1;
    }
    if (left->tv_nsec < right->tv_nsec) {
        return -1;
    }
    if (left->tv_nsec > right->tv_nsec) {
        return 1;
    }
    return 0;
}

static int realtime_now_locked(OliphauntHandle *handle, struct timespec *now) {
    if (clock_gettime(CLOCK_REALTIME, now) == 0) {
        return 0;
    }
    int saved_errno = errno;
    char message[OLIPHAUNT_ERROR_CAPACITY];
    snprintf(message, sizeof(message), "clock_gettime(CLOCK_REALTIME) failed: %d", saved_errno);
    set_error(handle, message);
    errno = saved_errno;
    return -1;
}

static int notify_embedded_timeout_locked(OliphauntHandle *handle) {
    if (!handle->embedded_timeout_armed ||
        handle->embedded_timeout_notified_generation == handle->embedded_timeout_generation) {
        return 0;
    }

    /* Publish the notification before waking the owning backend thread. */
    handle->embedded_timeout_notified_generation = handle->embedded_timeout_generation;
    RequestTrustedEmbeddedTimeoutCheck();
    return oliphaunt_wake_backend_locked(handle) == 0 ? 1 : -1;
}

static int notify_due_embedded_timeout_locked(
    OliphauntHandle *handle,
    const struct timespec *now) {
    if (!handle->embedded_timeout_armed ||
        compare_timespec(now, &handle->embedded_timeout_deadline) < 0) {
        return 0;
    }
    return notify_embedded_timeout_locked(handle);
}

static int check_embedded_timeout_deadline_locked(OliphauntHandle *handle) {
    if (!handle->embedded_timeout_armed ||
        handle->embedded_timeout_notified_generation == handle->embedded_timeout_generation) {
        return 0;
    }

    struct timespec now;
    if (realtime_now_locked(handle, &now) != 0) {
        return -1;
    }
    return notify_due_embedded_timeout_locked(handle, &now) < 0 ? -1 : 0;
}

/*
 * Wait for backend output while also relaying PostgreSQL's nearest cooperative
 * timeout. caller_deadline is an independent API-level deadline (currently
 * startup only); returning 1 means that deadline expired, not a PG timeout.
 */
static int wait_for_output_locked(
    OliphauntHandle *handle,
    const struct timespec *caller_deadline) {
    bool pg_deadline_pending =
        handle->embedded_timeout_armed &&
        handle->embedded_timeout_notified_generation != handle->embedded_timeout_generation;
    struct timespec now;

    if (caller_deadline != NULL || pg_deadline_pending) {
        if (realtime_now_locked(handle, &now) != 0) {
            return -1;
        }
        int pg_timeout_notification =
            pg_deadline_pending ? notify_due_embedded_timeout_locked(handle, &now) : 0;
        if (pg_timeout_notification < 0) {
            return -1;
        }
        if (caller_deadline != NULL && compare_timespec(&now, caller_deadline) >= 0) {
            return 1;
        }
        if (pg_timeout_notification > 0) {
            return 0;
        }
    }

    struct timespec wait_deadline_storage;
    const struct timespec *wait_deadline = caller_deadline;
    if (pg_deadline_pending &&
        (wait_deadline == NULL ||
         compare_timespec(&handle->embedded_timeout_deadline, wait_deadline) < 0)) {
        wait_deadline_storage = handle->embedded_timeout_deadline;
        wait_deadline = &wait_deadline_storage;
    }

    int rc = wait_deadline != NULL
                 ? pthread_cond_timedwait(&handle->output_cond, &handle->mutex, wait_deadline)
                 : pthread_cond_wait(&handle->output_cond, &handle->mutex);
    if (rc == 0) {
        return 0;
    }
    if (rc != ETIMEDOUT) {
        char message[OLIPHAUNT_ERROR_CAPACITY];
        snprintf(message, sizeof(message), "pthread wait failed: %d", rc);
        set_error(handle, message);
        errno = rc;
        return -1;
    }

    if (realtime_now_locked(handle, &now) != 0) {
        return -1;
    }
    if (notify_due_embedded_timeout_locked(handle, &now) < 0) {
        return -1;
    }
    if (caller_deadline != NULL && compare_timespec(&now, caller_deadline) >= 0) {
        return 1;
    }
    return 0;
}

int oliphaunt_wait_for_ready_locked(OliphauntHandle *handle, int timeout_ms) {
    bool has_timeout = timeout_ms > 0;
    struct timespec deadline;
    if (has_timeout) {
        if (realtime_now_locked(handle, &deadline) != 0) {
            return -1;
        }
        add_ms_to_timespec(&deadline, timeout_ms);
    }

    while (true) {
        bool ready = scan_ready_for_query_locked(handle);
        if (ready) {
            break;
        }
        if (handle->backend_exited) {
            char message[OLIPHAUNT_ERROR_CAPACITY];
            snprintf(
                message,
                sizeof(message),
                "embedded backend exited with status %d before ReadyForQuery",
                handle->backend_status);
            set_error(handle, message);
            return -1;
        }
        if (handle->closing) {
            set_error(handle, "native backend is closing before ReadyForQuery");
            return -1;
        }
        int rc = wait_for_output_locked(handle, has_timeout ? &deadline : NULL);
        if (rc > 0) {
            char message[OLIPHAUNT_ERROR_CAPACITY];
            snprintf(
                message,
                sizeof(message),
                "timed out after %dms waiting for embedded backend ReadyForQuery",
                timeout_ms);
            set_error(handle, message);
            return -1;
        }
        if (rc < 0) {
            return -1;
        }
    }
    return 0;
}

int oliphaunt_embedded_set_timeout(void *context, long timeout_ms) {
    OliphauntHandle *handle = (OliphauntHandle *)context;
    struct timespec deadline = {0, 0};

    if (timeout_ms >= 0) {
        if (clock_gettime(CLOCK_REALTIME, &deadline) != 0) {
            return -1;
        }
        add_ms_to_timespec(&deadline, timeout_ms);
    }

    pthread_mutex_lock(&handle->mutex);
    if (handle->interrupt_wakeup_kind == OLIPHAUNT_EMBEDDED_WAKE_NONE) {
        pthread_mutex_unlock(&handle->mutex);
        errno = ENODEV;
        return -1;
    }
    handle->embedded_timeout_generation++;
    if (handle->embedded_timeout_generation == 0) {
        handle->embedded_timeout_generation = 1;
    }
    handle->embedded_timeout_armed = timeout_ms >= 0;
    if (handle->embedded_timeout_armed) {
        /* A failed clock read leaves an immediately-due zero deadline. */
        handle->embedded_timeout_deadline = deadline;
    }
    pthread_cond_broadcast(&handle->output_cond);
    pthread_mutex_unlock(&handle->mutex);
    return 0;
}

int oliphaunt_embedded_set_interrupt_wakeup(void *context, uint32_t kind, uintptr_t token) {
    OliphauntHandle *handle = (OliphauntHandle *)context;

    if ((kind == OLIPHAUNT_EMBEDDED_WAKE_NONE && token != 0) ||
#ifdef _WIN32
        (kind != OLIPHAUNT_EMBEDDED_WAKE_NONE &&
         (kind != OLIPHAUNT_EMBEDDED_WAKE_WIN32_EVENT || token == 0))
#else
        (kind != OLIPHAUNT_EMBEDDED_WAKE_NONE &&
         (kind != OLIPHAUNT_EMBEDDED_WAKE_POSIX_FD || token > INT_MAX))
#endif
    ) {
        errno = EINVAL;
        return -1;
    }

    pthread_mutex_lock(&handle->mutex);
    if (kind != OLIPHAUNT_EMBEDDED_WAKE_NONE &&
        handle->interrupt_wakeup_kind != OLIPHAUNT_EMBEDDED_WAKE_NONE &&
        (handle->interrupt_wakeup_kind != kind ||
         handle->interrupt_wakeup_token != token)) {
        pthread_mutex_unlock(&handle->mutex);
        errno = EBUSY;
        return -1;
    }
    handle->interrupt_wakeup_kind = kind;
    handle->interrupt_wakeup_token = token;
    pthread_mutex_unlock(&handle->mutex);
    return 0;
}

int oliphaunt_wake_backend_locked(OliphauntHandle *handle) {
    int saved_errno = errno;

    if (handle->interrupt_wakeup_kind == OLIPHAUNT_EMBEDDED_WAKE_NONE) {
        set_error(handle, "trusted embedded wakeup endpoint is not published");
        errno = ENODEV;
        return -1;
    }
#ifdef _WIN32
    if (handle->interrupt_wakeup_kind != OLIPHAUNT_EMBEDDED_WAKE_WIN32_EVENT ||
        !SetEvent((HANDLE)handle->interrupt_wakeup_token)) {
        set_error(handle, "failed to signal trusted embedded Windows wakeup event");
        errno = EIO;
        return -1;
    }
#else
    if (handle->interrupt_wakeup_kind != OLIPHAUNT_EMBEDDED_WAKE_POSIX_FD) {
        set_error(handle, "trusted embedded wakeup endpoint has the wrong platform kind");
        errno = EINVAL;
        return -1;
    }
    char byte = 0;
    for (;;) {
        ssize_t rc = write((int)handle->interrupt_wakeup_token, &byte, 1);
        if (rc == 1) {
            break;
        }
        if (rc < 0 && errno == EINTR) {
            continue;
        }
        if (rc < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            break;
        }
        char message[OLIPHAUNT_ERROR_CAPACITY];
        snprintf(message, sizeof(message), "failed to signal trusted embedded wakeup pipe: %d", errno);
        set_error(handle, message);
        return -1;
    }
#endif
    errno = saved_errno;
    return 0;
}

ssize_t oliphaunt_embedded_read(void *context, void *ptr, size_t len, long timeout_ms) {
    OliphauntHandle *handle = (OliphauntHandle *)context;
    pthread_mutex_lock(&handle->mutex);
    if (handle->input_off >= handle->input_len && !handle->closing) {
        if (TrustedEmbeddedInterruptPending()) {
            pthread_mutex_unlock(&handle->mutex);
            errno = EINTR;
            return -1;
        }

        const bool has_timeout = timeout_ms >= 0;
        struct timespec deadline;

        if (has_timeout) {
            /* A spurious wake must not extend PostgreSQL's published delay. */
            if (clock_gettime(CLOCK_REALTIME, &deadline) != 0) {
                pthread_mutex_unlock(&handle->mutex);
                errno = EINTR;
                return -1;
            }
            add_ms_to_timespec(&deadline, timeout_ms);
        }

        while (handle->input_off >= handle->input_len &&
               !handle->closing &&
               !TrustedEmbeddedInterruptPending()) {
            int wait_rc = has_timeout
                ? pthread_cond_timedwait(
                    &handle->input_cond,
                    &handle->mutex,
                    &deadline)
                : pthread_cond_wait(&handle->input_cond, &handle->mutex);

            if (wait_rc == 0) {
                /* Recheck every predicate after a real or spurious wake. */
                continue;
            }
            if (wait_rc == ETIMEDOUT) {
                if (handle->embedded_timeout_armed) {
                    handle->embedded_timeout_notified_generation =
                        handle->embedded_timeout_generation;
                }
                /* The timed-read value itself is authoritative. */
                RequestTrustedEmbeddedTimeoutCheck();
                (void)oliphaunt_wake_backend_locked(handle);
            }
            pthread_mutex_unlock(&handle->mutex);
            errno = wait_rc == ETIMEDOUT ? EINTR : wait_rc;
            return -1;
        }

        if (handle->input_off >= handle->input_len &&
            !handle->closing &&
            TrustedEmbeddedInterruptPending()) {
            pthread_mutex_unlock(&handle->mutex);
            errno = EINTR;
            return -1;
        }
    }

    if (handle->input_off >= handle->input_len && handle->closing) {
        pthread_mutex_unlock(&handle->mutex);
        return 0;
    }

    size_t available = handle->input_len - handle->input_off;
    size_t take = available < len ? available : len;
    bool trace = handle->trace_protocol;
    uint64_t copy_started = trace ? oliphaunt_monotonic_ns() : 0;
    memcpy(ptr, handle->input + handle->input_off, take);
    if (trace) {
        handle->trace_read_calls++;
        handle->trace_read_bytes += take;
        handle->trace_read_copy_ns += oliphaunt_elapsed_ns(copy_started);
    }
    handle->input_off += take;

    if (handle->input_off >= handle->input_len) {
        handle->input_len = 0;
        handle->input_off = 0;
    }

    pthread_mutex_unlock(&handle->mutex);
    return (ssize_t)take;
}

ssize_t oliphaunt_embedded_write(void *context, const void *ptr, size_t len) {
    OliphauntHandle *handle = (OliphauntHandle *)context;
    pthread_mutex_lock(&handle->mutex);
    bool trace = handle->trace_protocol;
    uint64_t append_started = trace ? oliphaunt_monotonic_ns() : 0;
    int rc;
    bool ready = false;
    if (handle->streaming) {
        rc = enqueue_stream_chunk_locked(handle, ptr, len);
        if (rc == 0) {
            ready = scan_stream_ready_locked(handle, (const unsigned char *)ptr, len);
            if (ready) {
                handle->output_ready = true;
            }
        }
    } else {
        rc = append_output_locked(handle, ptr, len);
        if (rc == 0) {
            ready = scan_ready_for_query_locked(handle);
        }
    }
    if (trace && rc == 0) {
        handle->trace_write_calls++;
        handle->trace_write_bytes += len;
        handle->trace_write_append_ns += oliphaunt_elapsed_ns(append_started);
    }
    if (handle->streaming || ready) {
        pthread_cond_broadcast(&handle->output_cond);
    }
    pthread_mutex_unlock(&handle->mutex);
    return rc == 0 ? (ssize_t)len : -1;
}

int oliphaunt_set_input_locked(OliphauntHandle *handle, const void *buf, size_t len) {
    if (handle->input_len != 0) {
        set_error(handle, "native liboliphaunt input queue is busy");
        return -1;
    }
    bool trace = handle->trace_protocol;
    uint64_t copy_started = trace ? oliphaunt_monotonic_ns() : 0;
    if (len > handle->input_cap) {
        unsigned char *grown = (unsigned char *)realloc(handle->input, len);
        if (grown == NULL) {
            set_error(handle, "out of memory while copying protocol input");
            return -1;
        }
        handle->input = grown;
        handle->input_cap = len;
    }
    if (len > 0) {
        memcpy(handle->input, buf, len);
    }
    handle->input_len = len;
    handle->input_off = 0;
    if (trace) {
        handle->trace_input_copy_ns += oliphaunt_elapsed_ns(copy_started);
    }
    pthread_cond_broadcast(&handle->input_cond);
    return 0;
}

static int oliphaunt_set_simple_query_input_locked(OliphauntHandle *handle, const char *sql, size_t sql_len) {
    if (handle->input_len != 0) {
        set_error(handle, "native liboliphaunt input queue is busy");
        return -1;
    }
    if (sql_len > (size_t)UINT32_MAX - 5) {
        set_error(handle, "simple query is too large for the PostgreSQL protocol");
        return -1;
    }

    size_t total_len = sql_len + 6;
    bool trace = handle->trace_protocol;
    uint64_t copy_started = trace ? oliphaunt_monotonic_ns() : 0;
    if (total_len > handle->input_cap) {
        unsigned char *grown = (unsigned char *)realloc(handle->input, total_len);
        if (grown == NULL) {
            set_error(handle, "out of memory while copying simple-query input");
            return -1;
        }
        handle->input = grown;
        handle->input_cap = total_len;
    }

    uint32_t message_len = (uint32_t)(sql_len + 5);
    handle->input[0] = 'Q';
    handle->input[1] = (unsigned char)((message_len >> 24) & 0xff);
    handle->input[2] = (unsigned char)((message_len >> 16) & 0xff);
    handle->input[3] = (unsigned char)((message_len >> 8) & 0xff);
    handle->input[4] = (unsigned char)(message_len & 0xff);
    if (sql_len > 0) {
        memcpy(handle->input + 5, sql, sql_len);
    }
    handle->input[5 + sql_len] = '\0';
    handle->input_len = total_len;
    handle->input_off = 0;
    if (trace) {
        handle->trace_input_copy_ns += oliphaunt_elapsed_ns(copy_started);
    }
    pthread_cond_broadcast(&handle->input_cond);
    return 0;
}

static int oliphaunt_copy_response_locked(OliphauntHandle *handle, OliphauntResponse *out, bool trace) {
    if (handle->output_len == 0) {
        return 0;
    }

    uint64_t response_copy_started = trace ? oliphaunt_monotonic_ns() : 0;
    out->data = (uint8_t *)malloc(handle->output_len);
    if (out->data == NULL) {
        set_error(handle, "out of memory copying protocol response");
        return -1;
    }
    memcpy(out->data, handle->output, handle->output_len);
    out->len = handle->output_len;
    if (trace) {
        handle->trace_response_bytes = out->len;
        handle->trace_response_copy_ns = oliphaunt_elapsed_ns(response_copy_started);
    }
    handle->output_len = 0;
    return 0;
}

static int oliphaunt_wait_and_copy_response_locked(OliphauntHandle *handle, OliphauntResponse *out, bool trace) {
    uint64_t wait_started = trace ? oliphaunt_monotonic_ns() : 0;
    if (oliphaunt_wait_for_ready_locked(handle, -1) != 0) {
        return -1;
    }
    if (trace) {
        handle->trace_wait_ns = oliphaunt_elapsed_ns(wait_started);
    }
    return oliphaunt_copy_response_locked(handle, out, trace);
}

static int32_t oliphaunt_exec_protocol_impl(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out) {
    if (handle == NULL || out == NULL || (request_len > 0 && request == NULL)) {
        set_error(handle, "invalid oliphaunt_exec_protocol arguments");
        return -1;
    }
    out->data = NULL;
    out->len = 0;
    if (validate_frontend_protocol_frames(handle, request, request_len) != 0) {
        return -1;
    }

    bool trace = handle->trace_protocol;
    uint64_t total_started = trace ? oliphaunt_monotonic_ns() : 0;
    uint64_t lock_started = trace ? oliphaunt_monotonic_ns() : 0;
    pthread_mutex_lock(&handle->mutex);
    if (trace) {
        oliphaunt_reset_trace_locked(handle, request_len);
        handle->trace_lock_ns = oliphaunt_elapsed_ns(lock_started);
    }
    if (oliphaunt_reject_if_streaming_locked(handle) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (!handle->logical_active) {
        set_error(handle, "native liboliphaunt logical handle is closed");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (handle->backup_mode_exit_unconfirmed) {
        set_error(handle, "native liboliphaunt backup-mode exit is unconfirmed; close the database and restart the process before reopening it");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (handle->backend_exited) {
        set_error(handle, "native backend is not running");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    handle->output_len = 0;
    handle->output_scan_off = 0;
    handle->output_ready = false;
    if (oliphaunt_set_input_locked(handle, request, request_len) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (oliphaunt_wait_and_copy_response_locked(handle, out, trace) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (trace) {
        oliphaunt_print_trace_locked(handle, oliphaunt_elapsed_ns(total_started));
    }
    pthread_mutex_unlock(&handle->mutex);
    return 0;
}

static int32_t run_exec_protocol_operation(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out,
    OliphauntErrorCapture *capture,
    bool capture_required) {
    OliphauntErrorScope error_scope;
    oliphaunt_error_scope_begin(&error_scope, NULL, "oliphaunt_exec_protocol");
    int32_t rc = -1;
    bool leased = false;
    if (capture_required && capture == NULL) {
        set_error(NULL, "oliphaunt_exec_protocol error capture is null");
    } else if (handle == NULL) {
        rc = oliphaunt_exec_protocol_impl(handle, request, request_len, out);
    } else if (oliphaunt_begin_handle_call(handle) == 0) {
        leased = true;
        error_scope.fallback_handle = handle;
        rc = oliphaunt_exec_protocol_impl(handle, request, request_len, out);
    }
    oliphaunt_error_scope_end(&error_scope, rc != 0);
    oliphaunt_error_capture_current(capture, leased ? handle : NULL, rc != 0);
    if (leased) {
        oliphaunt_end_handle_call();
    }
    return rc;
}

int32_t oliphaunt_exec_protocol(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out) {
    return run_exec_protocol_operation(
        handle, request, request_len, out, NULL, false);
}

int32_t oliphaunt_exec_protocol_with_error(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out,
    OliphauntErrorCapture *error) {
    return run_exec_protocol_operation(
        handle, request, request_len, out, error, true);
}

static int32_t oliphaunt_exec_simple_query_impl(
    OliphauntHandle *handle,
    const char *sql,
    size_t sql_len,
    OliphauntResponse *out) {
    if (handle == NULL || out == NULL || sql == NULL) {
        set_error(handle, "invalid oliphaunt_exec_simple_query arguments");
        return -1;
    }
    out->data = NULL;
    out->len = 0;
    if (sql_len > 0 && memchr(sql, '\0', sql_len) != NULL) {
        set_error(handle, "simple query contains an interior NUL byte");
        return -1;
    }
    if (sql_len > (size_t)UINT32_MAX - 5) {
        set_error(handle, "simple query is too large for the PostgreSQL protocol");
        return -1;
    }

    size_t request_len = sql_len + 6;
    bool trace = handle->trace_protocol;
    uint64_t total_started = trace ? oliphaunt_monotonic_ns() : 0;
    uint64_t lock_started = trace ? oliphaunt_monotonic_ns() : 0;
    pthread_mutex_lock(&handle->mutex);
    if (trace) {
        oliphaunt_reset_trace_locked(handle, request_len);
        handle->trace_lock_ns = oliphaunt_elapsed_ns(lock_started);
    }
    if (oliphaunt_reject_if_streaming_locked(handle) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (!handle->logical_active) {
        set_error(handle, "native liboliphaunt logical handle is closed");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (handle->backup_mode_exit_unconfirmed) {
        set_error(handle, "native liboliphaunt backup-mode exit is unconfirmed; close the database and restart the process before reopening it");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (handle->backend_exited) {
        set_error(handle, "native backend is not running");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    handle->output_len = 0;
    handle->output_scan_off = 0;
    handle->output_ready = false;
    if (oliphaunt_set_simple_query_input_locked(handle, sql, sql_len) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (oliphaunt_wait_and_copy_response_locked(handle, out, trace) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (trace) {
        oliphaunt_print_trace_locked(handle, oliphaunt_elapsed_ns(total_started));
    }
    pthread_mutex_unlock(&handle->mutex);
    return 0;
}

static int32_t run_exec_simple_query_operation(
    OliphauntHandle *handle,
    const char *sql,
    size_t sql_len,
    OliphauntResponse *out,
    OliphauntErrorCapture *capture,
    bool capture_required) {
    OliphauntErrorScope error_scope;
    oliphaunt_error_scope_begin(&error_scope, NULL, "oliphaunt_exec_simple_query");
    int32_t rc = -1;
    bool leased = false;
    if (capture_required && capture == NULL) {
        set_error(NULL, "oliphaunt_exec_simple_query error capture is null");
    } else if (handle == NULL) {
        rc = oliphaunt_exec_simple_query_impl(handle, sql, sql_len, out);
    } else if (oliphaunt_begin_handle_call(handle) == 0) {
        leased = true;
        error_scope.fallback_handle = handle;
        rc = oliphaunt_exec_simple_query_impl(handle, sql, sql_len, out);
    }
    oliphaunt_error_scope_end(&error_scope, rc != 0);
    oliphaunt_error_capture_current(capture, leased ? handle : NULL, rc != 0);
    if (leased) {
        oliphaunt_end_handle_call();
    }
    return rc;
}

int32_t oliphaunt_exec_simple_query(
    OliphauntHandle *handle,
    const char *sql,
    size_t sql_len,
    OliphauntResponse *out) {
    return run_exec_simple_query_operation(
        handle, sql, sql_len, out, NULL, false);
}

int32_t oliphaunt_exec_simple_query_with_error(
    OliphauntHandle *handle,
    const char *sql,
    size_t sql_len,
    OliphauntResponse *out,
    OliphauntErrorCapture *error) {
    return run_exec_simple_query_operation(
        handle, sql, sql_len, out, error, true);
}

static int32_t oliphaunt_exec_protocol_raw_stream_impl(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context) {
    if (handle == NULL || callback == NULL || (request_len > 0 && request == NULL)) {
        set_error(handle, "invalid oliphaunt_exec_protocol_raw_stream arguments");
        return -1;
    }
    if (validate_frontend_protocol_frames(handle, request, request_len) != 0) {
        return -1;
    }

    pthread_mutex_lock(&handle->mutex);
    if (!handle->logical_active) {
        set_error(handle, "native liboliphaunt logical handle is closed");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (handle->backup_mode_exit_unconfirmed) {
        set_error(handle, "native liboliphaunt backup-mode exit is unconfirmed; close the database and restart the process before reopening it");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (handle->backend_exited) {
        set_error(handle, "native backend is not running");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (handle->streaming) {
        set_error(handle, "native liboliphaunt stream queue is busy");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }

    handle->output_len = 0;
    handle->output_scan_off = 0;
    handle->output_ready = false;
    handle->streaming = true;
    handle->stream_failed = false;
    handle->stream_queue_max_bytes = stream_queue_max_bytes();
    reset_protocol_scanner(&handle->stream_scanner);
    oliphaunt_clear_stream_chunks_locked(handle);

    if (oliphaunt_set_input_locked(handle, request, request_len) != 0) {
        handle->streaming = false;
        handle->stream_queue_max_bytes = 0;
        oliphaunt_clear_stream_chunks_locked(handle);
        pthread_cond_broadcast(&handle->output_cond);
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }

    int status = 0;
    bool callback_failed = false;
    while (status == 0) {
        OliphauntOutputChunk *chunk = NULL;
        while ((chunk = pop_stream_chunk_locked(handle)) != NULL) {
            if (check_embedded_timeout_deadline_locked(handle) != 0) {
                free_stream_chunk(chunk);
                status = -1;
                break;
            }
            /*
             * A user callback runs without the handle mutex and may block.
             * There is deliberately no watchdog thread, so check the PG
             * deadline immediately before and after this unbounded region.
             */
            pthread_mutex_unlock(&handle->mutex);
            if (!callback_failed) {
                int32_t callback_rc = callback(callback_context, chunk->data, chunk->len);
                if (callback_rc != 0) {
                    callback_failed = true;
                }
            }
            free_stream_chunk(chunk);
            pthread_mutex_lock(&handle->mutex);
            if (check_embedded_timeout_deadline_locked(handle) != 0) {
                status = -1;
                break;
            }
        }
        if (status != 0) {
            break;
        }

        if (handle->stream_failed) {
            /* Embedded writes report queue/scanner failures from PostgreSQL's
             * backend thread. Snapshot that shared error before releasing the
             * session mutex so a later caller cannot steal this operation's
             * attribution window. */
            oliphaunt_error_scope_capture_shared(handle);
            status = -1;
            break;
        }
        if (handle->output_ready) {
            break;
        }
        if (handle->backend_exited) {
            char message[OLIPHAUNT_ERROR_CAPACITY];
            snprintf(
                message,
                sizeof(message),
                "embedded backend exited with status %d before ReadyForQuery",
                handle->backend_status);
            set_error(handle, message);
            status = -1;
            break;
        }
        if (handle->closing) {
            set_error(handle, "native backend is closing before ReadyForQuery");
            status = -1;
            break;
        }

        int rc = wait_for_output_locked(handle, NULL);
        if (rc < 0) {
            status = -1;
            break;
        }
    }

    OliphauntOutputChunk *chunk = NULL;
    while ((chunk = pop_stream_chunk_locked(handle)) != NULL) {
        if (check_embedded_timeout_deadline_locked(handle) != 0) {
            free_stream_chunk(chunk);
            status = -1;
            break;
        }
        pthread_mutex_unlock(&handle->mutex);
        if (!callback_failed) {
            int32_t callback_rc = callback(callback_context, chunk->data, chunk->len);
            if (callback_rc != 0) {
                callback_failed = true;
            }
        }
        free_stream_chunk(chunk);
        pthread_mutex_lock(&handle->mutex);
        if (check_embedded_timeout_deadline_locked(handle) != 0) {
            status = -1;
            break;
        }
    }

    handle->streaming = false;
    handle->stream_queue_max_bytes = 0;
    reset_protocol_scanner(&handle->stream_scanner);
    oliphaunt_clear_stream_chunks_locked(handle);
    pthread_cond_broadcast(&handle->output_cond);
    if (status == 0 && callback_failed) {
        set_error(handle, "protocol stream callback failed");
        status = OLIPHAUNT_STREAM_CALLBACK_ABORTED;
    }
    pthread_mutex_unlock(&handle->mutex);
    return status;
}

static int32_t run_exec_protocol_raw_stream_operation(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context,
    OliphauntErrorCapture *capture,
    bool capture_required) {
    OliphauntErrorScope error_scope;
    oliphaunt_error_scope_begin(&error_scope, NULL, "oliphaunt_exec_protocol_raw_stream");
    int32_t rc = -1;
    bool leased = false;
    if (capture_required && capture == NULL) {
        set_error(NULL, "oliphaunt_exec_protocol_raw_stream error capture is null");
    } else if (handle == NULL) {
        rc = oliphaunt_exec_protocol_raw_stream_impl(
            handle, request, request_len, callback, callback_context);
    } else if (oliphaunt_begin_handle_call(handle) == 0) {
        leased = true;
        error_scope.fallback_handle = handle;
        rc = oliphaunt_exec_protocol_raw_stream_impl(
            handle, request, request_len, callback, callback_context);
    }
    oliphaunt_error_scope_end(&error_scope, rc != 0);
    oliphaunt_error_capture_current(capture, leased ? handle : NULL, rc != 0);
    if (leased) {
        oliphaunt_end_handle_call();
    }
    return rc;
}

int32_t oliphaunt_exec_protocol_raw_stream(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context) {
    return run_exec_protocol_raw_stream_operation(
        handle, request, request_len, callback, callback_context, NULL, false);
}

int32_t oliphaunt_exec_protocol_raw_stream_with_error(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context,
    OliphauntErrorCapture *error) {
    return run_exec_protocol_raw_stream_operation(
        handle, request, request_len, callback, callback_context, error, true);
}
