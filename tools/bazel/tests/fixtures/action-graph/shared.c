#include "shared.h"
#include "config.h"
int shared_value(void) { return SHARED_VALUE + CONFIG_VALUE; }
