/* Exercise the real queue with a write larger than its entire capacity. */
#include "../src/liboliphaunt_protocol.c"
#include <assert.h>

enum { QUEUE_LIMIT = 65536, INPUT_SIZE = QUEUE_LIMIT * 9 + 17 };

static unsigned char input[INPUT_SIZE];

static void *produce(void *context) {
    OliphauntHandle *handle = context;
    pthread_mutex_lock(&handle->mutex);
    assert(enqueue_stream_output_locked(handle, input, sizeof(input)) == 0);
    pthread_mutex_unlock(&handle->mutex);
    return NULL;
}

int main(void) {
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
    pthread_cond_destroy(&handle.output_cond);
    pthread_mutex_destroy(&handle.mutex);
    return 0;
}
