#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

typedef int (*probe_value_fn) (int);
typedef const char *(*probe_name_fn) (void);

int
main(void)
{
	void	   *handle;
	probe_name_fn name_fn;
	probe_value_fn value_fn;
	const char *name;
	int			value;

	dlerror();
	handle = dlopen("libwasix_dynamic_probe_side.so", RTLD_NOW | RTLD_LOCAL);
	if (handle == NULL)
	{
		fprintf(stderr, "dlopen side module failed: %s\n", dlerror());
		return 1;
	}

	name_fn = (probe_name_fn) dlsym(handle, "wasix_dynamic_probe_name");
	if (name_fn == NULL)
	{
		fprintf(stderr, "dlsym name failed: %s\n", dlerror());
		return 2;
	}
	value_fn = (probe_value_fn) dlsym(handle, "wasix_dynamic_probe_value");
	if (value_fn == NULL)
	{
		fprintf(stderr, "dlsym value failed: %s\n", dlerror());
		return 3;
	}

	name = name_fn();
	if (strcmp(name, "wasix-dynamic-probe-side") != 0)
	{
		fprintf(stderr, "unexpected side module name: %s\n", name);
		return 4;
	}

	value = value_fn(7);
	if (value != 42)
	{
		fprintf(stderr, "unexpected side module value: %d\n", value);
		return 5;
	}

	printf("dynamic-dlopen name=%s value=%d\n", name, value);
	return 0;
}
