#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

int
main(void)
{
	const char *name = "/wasix-upstream-postgres-shmem-reattach-probe";
	volatile int *slot;
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

	slot = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (slot == MAP_FAILED)
	{
		perror("mmap parent");
		return 3;
	}
	*slot = 7;

	pid = fork();
	if (pid < 0)
	{
		perror("fork");
		return 4;
	}
	if (pid == 0)
	{
		volatile int *reattached;

		reattached = mmap((void *) slot, 4096, PROT_READ | PROT_WRITE,
						  MAP_SHARED | MAP_FIXED, fd, 0);
		if (reattached == MAP_FAILED)
		{
			perror("mmap child MAP_FIXED");
			_exit(10);
		}
		if (reattached != slot)
		{
			printf("reattach address mismatch got=%p expected=%p\n",
				   (void *) reattached, (void *) slot);
			_exit(11);
		}
		if (*reattached != 7)
		{
			printf("reattach content mismatch got=%d\n", *reattached);
			_exit(12);
		}
		*reattached = 42;
		_exit(0);
	}

	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 5;
	}

	printf("after_wait slot=%d status=%d exited=%d exitstatus=%d\n",
		   *slot, status, WIFEXITED(status),
		   WIFEXITED(status) ? WEXITSTATUS(status) : -1);

	if (!WIFEXITED(status))
		return 6;
	if (WEXITSTATUS(status) != 0)
		return WEXITSTATUS(status);
	return *slot == 42 ? 0 : 13;
}
