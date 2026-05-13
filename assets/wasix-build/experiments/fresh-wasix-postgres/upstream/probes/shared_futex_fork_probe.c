#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wasi/libc.h>

struct shared_futex_state {
	int parent_ready;
	int child_done;
	int payload;
};

static int wait_changed(int *addr, int expected, const char *label)
{
	int ret;

	for (;;)
	{
		if (__atomic_load_n(addr, __ATOMIC_ACQUIRE) != expected)
			return 0;
		ret = __wasilibc_futex_wait_wasix(addr, 0, expected, 5000000000LL);
		if (ret == 0 || ret == -EWOULDBLOCK)
			continue;
		fprintf(stderr, "%s wait failed ret=%d\n", label, ret);
		return ret;
	}
}

int main(void)
{
	const char *name = "/wasix-upstream-shared-futex-fork-probe";
	struct shared_futex_state *shared;
	int status = 0;
	pid_t pid;
	int fd;

	shm_unlink(name);
	fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
	if (fd < 0)
	{
		perror("shm_open");
		return 1;
	}
	if (ftruncate(fd, 4096) < 0)
	{
		perror("ftruncate");
		return 2;
	}

	shared = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (shared == MAP_FAILED)
	{
		perror("mmap");
		return 3;
	}
	__atomic_store_n(&shared->parent_ready, 0, __ATOMIC_RELEASE);
	__atomic_store_n(&shared->child_done, 0, __ATOMIC_RELEASE);
	__atomic_store_n(&shared->payload, 0, __ATOMIC_RELEASE);

	pid = fork();
	if (pid < 0)
	{
		perror("fork");
		return 4;
	}
	if (pid == 0)
	{
		if (wait_changed(&shared->parent_ready, 0, "child parent_ready") != 0)
			_exit(10);

		usleep(100000);
		__atomic_store_n(&shared->payload, 42, __ATOMIC_RELEASE);
		__atomic_store_n(&shared->child_done, 1, __ATOMIC_RELEASE);
		if (__wasilibc_futex_wake_wasix(&shared->child_done, 1) != 0)
			_exit(11);
		_exit(0);
	}

	__atomic_store_n(&shared->parent_ready, 1, __ATOMIC_RELEASE);
	if (__wasilibc_futex_wake_wasix(&shared->parent_ready, 1) != 0)
	{
		fprintf(stderr, "parent_ready wake failed\n");
		return 5;
	}

	if (wait_changed(&shared->child_done, 0, "parent child_done") != 0)
		return 6;
	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 7;
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
	{
		fprintf(stderr, "child status=%d exited=%d exitstatus=%d\n",
			status, WIFEXITED(status),
			WIFEXITED(status) ? WEXITSTATUS(status) : -1);
		return 8;
	}
	if (__atomic_load_n(&shared->payload, __ATOMIC_ACQUIRE) != 42)
	{
		fprintf(stderr, "payload=%d expected=42\n", shared->payload);
		return 9;
	}

	puts("shared-futex-fork: ok");
	return 0;
}
