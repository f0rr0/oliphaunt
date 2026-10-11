#include <stdio.h>
#include "shared.h"
int main(void) { printf("%d\n", shared_value() + 1); return 0; }
