#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#if defined(_WIN32)
#include <windows.h>
#else
#include <unistd.h>
#endif

int main(void) {
    assert(sizeof(void *) == 8);
    uint64_t *number = malloc(sizeof(*number));
    assert(number != NULL);
    *number = UINT64_C(0x1234567890abcdef);
    assert(*number == UINT64_C(0x1234567890abcdef));
    free(number);
#if defined(_WIN32)
    assert(GetCurrentProcessId() != 0);
#else
    assert(getpid() > 0);
#endif
    puts("native SDK compile, link and execution passed");
    return 0;
}
