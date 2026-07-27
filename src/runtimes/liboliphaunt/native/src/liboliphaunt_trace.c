#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "liboliphaunt_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static pthread_once_t trace_once = PTHREAD_ONCE_INIT;
static bool trace_protocol_enabled = false;

static void init_trace_protocol_flag(void) {
    const char *value = getenv("OLIPHAUNT_TRACE_PROTOCOL");
    if (value == NULL || value[0] == '\0') {
        value = getenv("OLIPHAUNT_TRACE");
    }
    trace_protocol_enabled =
        value != NULL &&
        value[0] != '\0' &&
        strcmp(value, "0") != 0 &&
        strcmp(value, "false") != 0 &&
        strcmp(value, "FALSE") != 0;
}

bool oliphaunt_trace_enabled(void) {
    pthread_once(&trace_once, init_trace_protocol_flag);
    return trace_protocol_enabled;
}

uint64_t oliphaunt_monotonic_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

uint64_t oliphaunt_elapsed_ns(uint64_t started_ns) {
    return oliphaunt_monotonic_ns() - started_ns;
}

static uint64_t ns_to_us(uint64_t value) {
    return value / 1000ULL;
}

void oliphaunt_reset_trace_locked(OliphauntHandle *handle, size_t request_len) {
    handle->trace_request_bytes = request_len;
    handle->trace_response_bytes = 0;
    handle->trace_lock_ns = 0;
    handle->trace_input_copy_ns = 0;
    handle->trace_wait_ns = 0;
    handle->trace_response_copy_ns = 0;
    handle->trace_read_calls = 0;
    handle->trace_read_bytes = 0;
    handle->trace_read_copy_ns = 0;
    handle->trace_write_calls = 0;
    handle->trace_write_bytes = 0;
    handle->trace_write_append_ns = 0;
    handle->trace_ready_scan_calls = 0;
    handle->trace_ready_scan_ns = 0;
    handle->trace_output_grows = 0;
}

void oliphaunt_print_trace_locked(OliphauntHandle *handle, uint64_t total_ns) {
    uint64_t seq = ++handle->trace_seq;
    fprintf(
        stderr,
        "oliphaunt_native_trace seq=%llu request_bytes=%llu response_bytes=%llu "
        "total_us=%llu lock_us=%llu input_copy_us=%llu wait_us=%llu "
        "ready_scan_calls=%llu ready_scan_us=%llu read_calls=%llu read_bytes=%llu "
        "read_copy_us=%llu write_calls=%llu write_bytes=%llu write_append_us=%llu "
        "output_grows=%llu output_cap=%llu response_copy_us=%llu\n",
        (unsigned long long)seq,
        (unsigned long long)handle->trace_request_bytes,
        (unsigned long long)handle->trace_response_bytes,
        (unsigned long long)ns_to_us(total_ns),
        (unsigned long long)ns_to_us(handle->trace_lock_ns),
        (unsigned long long)ns_to_us(handle->trace_input_copy_ns),
        (unsigned long long)ns_to_us(handle->trace_wait_ns),
        (unsigned long long)handle->trace_ready_scan_calls,
        (unsigned long long)ns_to_us(handle->trace_ready_scan_ns),
        (unsigned long long)handle->trace_read_calls,
        (unsigned long long)handle->trace_read_bytes,
        (unsigned long long)ns_to_us(handle->trace_read_copy_ns),
        (unsigned long long)handle->trace_write_calls,
        (unsigned long long)handle->trace_write_bytes,
        (unsigned long long)ns_to_us(handle->trace_write_append_ns),
        (unsigned long long)handle->trace_output_grows,
        (unsigned long long)handle->output_cap,
        (unsigned long long)ns_to_us(handle->trace_response_copy_ns));
}
