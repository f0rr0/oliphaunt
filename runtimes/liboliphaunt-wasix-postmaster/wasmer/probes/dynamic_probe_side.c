#include <stdint.h>

__attribute__((visibility("default"))) int
wasix_dynamic_probe_value(int input)
{
	return input + 35;
}

__attribute__((visibility("default"))) const char *
wasix_dynamic_probe_name(void)
{
	return "wasix-dynamic-probe-side";
}
