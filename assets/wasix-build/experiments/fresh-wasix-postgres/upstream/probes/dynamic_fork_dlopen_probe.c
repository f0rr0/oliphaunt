#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wasi/api_wasix.h>

typedef int (*probe_value_fn) (int);
typedef const char *(*probe_name_fn) (void);

static int
load_side_module_and_update_slot(volatile int *slot)
{
	void	   *handle;
	probe_name_fn name_fn;
	probe_value_fn value_fn;
	const char *name;
	int			next_value;

	dlerror();
	handle = dlopen("libwasix_dynamic_probe_side.so", RTLD_NOW | RTLD_LOCAL);
	if (handle == NULL)
	{
		fprintf(stderr, "dlopen side module failed: %s\n", dlerror());
		return 40;
	}

	name_fn = (probe_name_fn) dlsym(handle, "wasix_dynamic_probe_name");
	if (name_fn == NULL)
	{
		fprintf(stderr, "dlsym name failed: %s\n", dlerror());
		return 41;
	}
	value_fn = (probe_value_fn) dlsym(handle, "wasix_dynamic_probe_value");
	if (value_fn == NULL)
	{
		fprintf(stderr, "dlsym value failed: %s\n", dlerror());
		return 42;
	}

	name = name_fn();
	if (strcmp(name, "wasix-dynamic-probe-side") != 0)
	{
		fprintf(stderr, "unexpected side module name: %s\n", name);
		return 43;
	}

	next_value = value_fn(*slot);
	if (next_value != 42)
	{
		fprintf(stderr, "unexpected side module value: %d\n", next_value);
		return 44;
	}

	*slot = next_value;
	if (msync((void *) slot, 4096, MS_SYNC) != 0)
	{
		perror("child msync");
		return 45;
	}

	return 0;
}

int
main(void)
{
	const char *path = "/dev/shm/wasix-upstream-dynamic-fork-dlopen-probe.dat";
	volatile int *slot;
	__wasi_pid_t child_pid = 0;
	__wasi_errno_t fork_errno;
	int			status = 0;
	int			fd;
	int			child_rc;

	unlink(path);
	fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
	if (fd < 0)
	{
		perror("open");
		return 1;
	}
	if (ftruncate(fd, 4096) < 0)
	{
		perror("ftruncate");
		return 2;
	}

	slot = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (slot == MAP_FAILED)
	{
		perror("parent mmap");
		return 3;
	}
	*slot = 7;
	if (msync((void *) slot, 4096, MS_SYNC) != 0)
	{
		perror("parent msync");
		return 4;
	}

	/*
	 * First exercise the dynamic loader before the fork boundary. The strict
	 * dynamic-dlopen probe covers extension loading; this probe composes it
	 * with copied proc_fork and shared mmap replay.
	 */
	child_rc = load_side_module_and_update_slot(slot);
	if (child_rc != 0)
		return child_rc;
	*slot = 7;
	if (msync((void *) slot, 4096, MS_SYNC) != 0)
	{
		perror("parent reset msync");
		return 5;
	}

	fork_errno = __wasi_proc_fork(1, &child_pid);
	if (fork_errno != 0)
	{
		pid_t		waited;

		errno = 0;
		waited = waitpid(-1, &status, WNOHANG);
		if (waited != -1 || errno != ECHILD)
		{
			fprintf(stderr,
					"proc_fork failure left observable child state: waited=%d errno=%d status=%d\n",
					(int) waited, errno, status);
			return 35;
		}
		fprintf(stderr, "proc_fork failed in dynamic-main module: %u\n",
				(unsigned int) fork_errno);
		return 30;
	}

	if (child_pid == 0)
	{
		if (*slot != 7)
		{
			fprintf(stderr, "child saw unexpected shared slot value: %d\n", *slot);
			_exit(31);
		}
		child_rc = load_side_module_and_update_slot(slot);
		_exit(child_rc);
	}

	if (waitpid((pid_t) child_pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 32;
	}

	printf("dynamic-fork-dlopen child=%d status=%d exited=%d exitstatus=%d slot=%d addr=%p\n",
		   (int) child_pid,
		   status,
		   WIFEXITED(status),
		   WIFEXITED(status) ? WEXITSTATUS(status) : -1,
		   *slot,
		   (void *) slot);

	if (!WIFEXITED(status))
		return 33;
	if (WEXITSTATUS(status) != 0)
		return WEXITSTATUS(status);
	if (*slot != 42)
		return 34;

	return 0;
}
