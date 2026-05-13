#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wasi/api_wasix.h>

typedef __wasi_errno_t (*fork_fn) (__wasi_pid_t *);

static __wasi_errno_t
fork_through_pointer_target(__wasi_pid_t *child_pid)
{
	return __wasi_proc_fork(1, child_pid);
}

static int
call_indirect_fork(fork_fn fn, volatile int *slot)
{
	__wasi_pid_t child_pid = 0;
	__wasi_errno_t fork_errno;
	int			status = 0;

	/*
	 * Keep live stack values across the indirect call so the continuation
	 * frame has to restore real operands, not just an empty stack.
	 */
	*slot += 3;
	fork_errno = fn(&child_pid);
	if (fork_errno != 0)
	{
		pid_t		waited;

		errno = 0;
		waited = waitpid(-1, &status, WNOHANG);
		if (waited != -1 || errno != ECHILD)
		{
			fprintf(stderr,
					"indirect proc_fork failure left child state: waited=%d errno=%d status=%d\n",
					(int) waited, errno, status);
			return 20;
		}
		fprintf(stderr, "indirect proc_fork failed: %u\n",
				(unsigned int) fork_errno);
		return 21;
	}

	if (child_pid == 0)
	{
		if (*slot != 10)
			_exit(22);
		*slot = 77;
		if (msync((void *) slot, 4096, MS_SYNC) != 0)
			_exit(23);
		_exit(0);
	}

	if (waitpid((pid_t) child_pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 24;
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
	{
		fprintf(stderr, "child status=0x%x\n", status);
		return 25;
	}
	if (*slot != 77)
	{
		fprintf(stderr, "shared slot after indirect fork=%d\n", *slot);
		return 26;
	}

	printf("dynamic-fork-indirect child=%d status=%d slot=%d\n",
		   (int) child_pid, status, *slot);
	return 0;
}

int
main(void)
{
	const char *path = "/dev/shm/wasix-upstream-dynamic-fork-indirect-probe.dat";
	volatile int *slot;
	int			fd;
	fork_fn		fn = fork_through_pointer_target;

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
		perror("mmap");
		return 3;
	}
	*slot = 7;
	if (msync((void *) slot, 4096, MS_SYNC) != 0)
	{
		perror("msync");
		return 4;
	}

	return call_indirect_fork(fn, slot);
}
