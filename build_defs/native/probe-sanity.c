#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    void *allocation = malloc(sizeof(uint64_t));
    if (!allocation) return 1;
    puts("declared native compiler and standard-library link are usable");
    free(allocation);
    return 0;
}
