/* Exercise the real queue with a write larger than its entire capacity. */
#include "../src/liboliphaunt_protocol.c"
#include <assert.h>

enum { QUEUE_LIMIT = 65536, INPUT_SIZE = QUEUE_LIMIT * 9 + 17 };

static unsigned char input[INPUT_SIZE];

/* This queue-only fixture has no PostgreSQL backend or armed deadline. */
void RequestTrustedEmbeddedTimeoutCheck(void) {
    assert(!"an unarmed queue fixture must not notify PostgreSQL of a timeout");
}

void RequestTrustedEmbeddedQueryCancel(void) {
    assert(!"a queue fixture has no backend to cancel");
}

bool TrustedEmbeddedInterruptPending(void) {
    return false;
}

static void verify_protocol_completion(OliphauntHandle *handle) {
    const unsigned char query[] = {'Q', 0, 0, 0, 5, 0};
    const unsigned char ready[] = {'Z', 0, 0, 0, 5, 'T'};
    unsigned char received[sizeof(query)];

    begin_protocol_operation_locked(handle, false);
    assert(oliphaunt_set_input_locked(handle, query, sizeof(query)) == 0);
    assert(!scan_stream_ready_locked(handle, ready, sizeof(ready)));
    oliphaunt_embedded_protocol_checkpoint(handle, true, 0);
    assert(!handle->output_ready);
    assert(oliphaunt_embedded_read(handle, received, sizeof(received), -1) == (ssize_t)sizeof(query));
    assert(memcmp(received, query, sizeof(query)) == 0);
    check_protocol_completion_locked(handle);
    assert(!handle->output_ready); /* Reading invalidates the preceding checkpoint. */
    oliphaunt_embedded_protocol_checkpoint(handle, true, 0);
    assert(handle->output_ready && handle->transaction_status == 'T');

    begin_protocol_operation_locked(handle, false);
    assert(!scan_stream_ready_locked(handle, ready, sizeof(ready)));
    oliphaunt_embedded_protocol_checkpoint(handle, true, sizeof(query));
    assert(!handle->output_ready); /* libpq still owns a prefetched command. */
    oliphaunt_embedded_protocol_checkpoint(handle, true, 0);
    assert(handle->output_ready);

    begin_protocol_operation_locked(handle, false);
    handle->stream_input_closed = false;
    assert(!scan_stream_ready_locked(handle, ready, sizeof(ready)));
    oliphaunt_embedded_protocol_checkpoint(handle, true, 0);
    assert(!handle->output_ready);
    handle->stream_input_closed = true;
    check_protocol_completion_locked(handle);
    assert(handle->output_ready); /* End may arrive after PostgreSQL is waiting. */

    begin_protocol_operation_locked(handle, true);
    handle->stream_fragmented = true;
    assert(!scan_stream_ready_locked(handle, ready, sizeof(ready)));
    oliphaunt_embedded_copy_input(handle, true);
    assert(handle->stream_copy_input && handle->stream_copy_extended);
    check_protocol_completion_locked(handle);
    assert(!handle->output_ready);
    oliphaunt_embedded_protocol_checkpoint(handle, false, 0);
    assert(!handle->stream_copy_input && !handle->output_ready);
    assert(!scan_stream_ready_locked(handle, ready, sizeof(ready)));
    assert(!handle->output_ready); /* Ready bytes precede the owning checkpoint. */
    oliphaunt_embedded_protocol_checkpoint(handle, true, 0);
    assert(handle->output_ready);

    begin_protocol_operation_locked(handle, false);
    oliphaunt_embedded_protocol_checkpoint(handle, true, 0);
    assert(!handle->output_ready); /* An idle checkpoint from before Ready is insufficient. */
    handle->output = (unsigned char *)ready;
    handle->output_len = sizeof(ready);
    handle->output_scan_off = 0;
    assert(!scan_ready_for_query_locked(handle));
    assert(!handle->output_ready);
    oliphaunt_embedded_protocol_checkpoint(handle, true, 0);
    assert(handle->output_ready);
    handle->output = NULL;
    handle->output_len = 0;

    /* A callback can admit final Sync before the preceding Flush reaches its
     * checkpoint. That checkpoint must not reopen the already sealed input. */
    const unsigned char sync[] = {'S', 0, 0, 0, 4};
    begin_protocol_operation_locked(handle, false);
    assert(oliphaunt_set_input_locked(handle, sync, sizeof(sync)) == 0);
    oliphaunt_embedded_protocol_checkpoint(handle, false, 0);
    assert(handle->stream_input_closed);
    assert(oliphaunt_embedded_read(handle, received, sizeof(sync), -1) == (ssize_t)sizeof(sync));
    oliphaunt_embedded_protocol_checkpoint(handle, false, sizeof(sync));
    /* A prefetched final Sync is equally authoritative for input admission. */
    handle->stream_input_closed = true;
    oliphaunt_embedded_protocol_checkpoint(handle, false, sizeof(sync));
    assert(handle->stream_input_closed);
    assert(!scan_stream_ready_locked(handle, ready, sizeof(ready)));
    oliphaunt_embedded_protocol_checkpoint(handle, true, 0);
    assert(handle->output_ready);

    for (int copy = 0; copy <= 1; copy++) {
        handle->closing = false; /* Each iteration models a fresh native owner. */
        begin_protocol_operation_locked(handle, true);
        handle->stream_fragmented = true;
        if (copy) oliphaunt_embedded_copy_input(handle, true);
        else oliphaunt_embedded_protocol_checkpoint(handle, false, 0);
        assert(oliphaunt_embedded_read(handle, received, 1, 0) == 0);
        assert(handle->stream_failed && !handle->output_ready);
    }
}

static void *produce(void *context) {
    OliphauntHandle *handle = context;
    pthread_mutex_lock(&handle->mutex);
    assert(enqueue_stream_output_locked(handle, input, sizeof(input)) == 0);
    pthread_mutex_unlock(&handle->mutex);
    return NULL;
}

int main(void) {
    assert(oliphaunt_resource_size("17", 1, SIZE_MAX, 8) == 17);
    assert(oliphaunt_resource_size("0", 1, SIZE_MAX, 8) == 8);
    assert(oliphaunt_resource_size("17suffix", 1, SIZE_MAX, 8) == 8);
    assert(oliphaunt_resource_size("-1", 1, SIZE_MAX, 8) == 8);
    assert(oliphaunt_resource_size("+17", 1, SIZE_MAX, 8) == 8);
    assert(oliphaunt_resource_size("9999999999999999999999999999999999999999", 1, SIZE_MAX, 8) == 8);
    assert(oliphaunt_resource_size("2147483648", 1, INT_MAX, 8) == 8);

    OliphauntHandle handle = {0};
    assert(pthread_mutex_init(&handle.mutex, NULL) == 0);
    assert(pthread_cond_init(&handle.output_cond, NULL) == 0);
    assert(pthread_cond_init(&handle.input_cond, NULL) == 0);
    handle.streaming = true;
    handle.stream_queue_max_bytes = QUEUE_LIMIT;
    for (size_t i = 0; i < sizeof(input); i++) input[i] = (unsigned char)i;

    pthread_t producer;
    assert(pthread_create(&producer, NULL, produce, &handle) == 0);
    size_t received = 0;
    while (received < sizeof(input)) {
        pthread_mutex_lock(&handle.mutex);
        while (handle.stream_head == NULL) {
            struct timespec deadline;
            assert(clock_gettime(CLOCK_REALTIME, &deadline) == 0);
            deadline.tv_sec += 5;
            assert(pthread_cond_timedwait(&handle.output_cond, &handle.mutex, &deadline) == 0);
        }
        assert(handle.stream_bytes_queued <= QUEUE_LIMIT);
        OliphauntOutputChunk *chunk = pop_stream_chunk_locked(&handle);
        assert(chunk != NULL && chunk->len <= QUEUE_LIMIT);
        assert(received + chunk->len <= sizeof(input));
        assert(memcmp(chunk->data, input + received, chunk->len) == 0);
        received += chunk->len;
        free(chunk->data);
        free(chunk);
        pthread_cond_broadcast(&handle.output_cond);
        pthread_mutex_unlock(&handle.mutex);
        struct timespec delay = {.tv_nsec = 1000000};
        nanosleep(&delay, NULL);
    }
    assert(pthread_join(producer, NULL) == 0);
    assert(handle.stream_head == NULL && handle.stream_bytes_queued == 0);
    assert(!stream_queue_has_room_locked(&handle, QUEUE_LIMIT + 1, QUEUE_LIMIT));
    verify_protocol_completion(&handle);
    free(handle.input);
    pthread_cond_destroy(&handle.input_cond);
    pthread_cond_destroy(&handle.output_cond);
    pthread_mutex_destroy(&handle.mutex);
    return 0;
}
