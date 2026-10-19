/* Exercise the real queue with a write larger than its entire capacity. */
#include "../src/liboliphaunt_protocol.c"
#include <assert.h>

enum { QUEUE_LIMIT = 65536, INPUT_SIZE = QUEUE_LIMIT * 9 + 17 };

static unsigned char input[INPUT_SIZE];

/* This queue-only fixture has no PostgreSQL backend or armed deadline. */
void RequestTrustedEmbeddedTimeoutCheck(void) {
    assert(!"an unarmed queue fixture must not notify PostgreSQL of a timeout");
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
    const unsigned char queries[] = {'Q',0,0,0,6,'a',0,'Q',0,0,0,6,'b',0};
    const unsigned char ready[] = {'Z',0,0,0,5,'I','Z',0,0,0,5,'T'};
    bool extended_pending = false;
    assert(validate_frontend_protocol_frames(&handle, queries, sizeof(queries),
                                            true, &extended_pending, &handle.ready_remaining) == 0);
    assert(handle.ready_remaining == 2);
    assert(!scan_stream_ready_locked(&handle, ready, 6));
    assert(handle.ready_remaining == 1);
    assert(scan_stream_ready_locked(&handle, ready + 6, 6));
    assert(handle.transaction_status == 'T');
    handle.ready_remaining = 2;
    assert(scan_stream_ready_locked(&handle, ready, sizeof(ready)));
    assert(handle.transaction_status == 'T');
    handle.output = (unsigned char *)ready;
    handle.output_len = sizeof(ready);
    handle.output_scan_off = 0;
    handle.output_ready = false;
    handle.ready_remaining = 2;
    assert(scan_ready_for_query_locked(&handle));
    assert(handle.output_scan_off == sizeof(ready));
    assert(handle.transaction_status == 'T');
    const unsigned char parse_flush[] = {'P',0,0,0,4,'H',0,0,0,4};
    const unsigned char sync[] = {'S',0,0,0,4};
    size_t boundaries = 0;
    assert(validate_frontend_protocol_frames(&handle, parse_flush, sizeof(parse_flush),
                                            true, &extended_pending, &boundaries) == -1);
    assert(validate_frontend_protocol_frames(&handle, parse_flush, sizeof(parse_flush),
                                            false, &extended_pending, &boundaries) == 0);
    assert(extended_pending && boundaries == 0);
    assert(validate_frontend_protocol_frames(&handle, queries, sizeof(queries),
                                            false, &extended_pending, &boundaries) == -1);
    assert(extended_pending);
    assert(validate_frontend_protocol_frames(&handle, sync, sizeof(sync),
                                            false, &extended_pending, &boundaries) == 0);
    assert(!extended_pending && boundaries == 1);
    const unsigned char sync_query[] = {'S',0,0,0,4,'Q',0,0,0,5,0};
    handle.ready_remaining = 2;
    handle.output_ready = false;
    handle.stream_copy_ignored_sync = 0;
    oliphaunt_embedded_ignore_sync(&handle);
    assert(handle.ready_remaining == 1 && !handle.output_ready);
    assert(handle.stream_copy_ignored_sync == 1);
    assert(stream_copy_is_extended(&handle, sync_query, sizeof(sync_query), 2));
    handle.ready_remaining = 1;
    handle.stream_copy_ignored_sync = 0;
    assert(!stream_copy_is_extended(&handle, sync_query, sizeof(sync_query), 2));
    handle.stream_ready_implicit = true;
    oliphaunt_embedded_ignore_sync(&handle);
    assert(handle.ready_remaining == 1 && !handle.output_ready);
    pthread_cond_destroy(&handle.output_cond);
    pthread_mutex_destroy(&handle.mutex);
    return 0;
}
