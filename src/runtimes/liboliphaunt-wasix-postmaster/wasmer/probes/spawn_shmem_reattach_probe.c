#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int
child_main(const char *path, const char *addr_text)
{
	void *early_alloc;
	volatile int *reattached;
	uintptr_t addr;
	char *end = NULL;
	int fd;

	errno = 0;
	addr = (uintptr_t) strtoull(addr_text, &end, 0);
	if (errno != 0 || end == addr_text || *end != '\0' || addr == 0)
	{
		fprintf(stderr, "bad child address: %s\n", addr_text);
		return 20;
	}

	early_alloc = malloc(64);
	if (early_alloc == NULL)
	{
		perror("child early malloc");
		return 26;
	}
	memset(early_alloc, 0x7a, 64);

	fd = open(path, O_RDWR);
	if (fd < 0)
	{
		perror("child open");
		return 21;
	}

	reattached = mmap((void *) addr, 4096, PROT_READ | PROT_WRITE,
					  MAP_SHARED | MAP_FIXED, fd, 0);
	if (reattached == MAP_FAILED)
	{
		perror("child mmap MAP_FIXED");
		close(fd);
		return 22;
	}
	if ((uintptr_t) reattached != addr)
	{
		fprintf(stderr, "reattach address mismatch got=%p expected=%p\n",
				(void *) reattached, (void *) addr);
		close(fd);
		return 23;
	}
	if (*reattached != 7)
	{
		fprintf(stderr, "reattach content mismatch got=%d\n", *reattached);
		close(fd);
		return 24;
	}

	*reattached = 42;
	if (msync((void *) reattached, 4096, MS_SYNC) != 0)
	{
		perror("child msync");
		close(fd);
		return 25;
	}
	for (int i = 0; i < 160; i++)
	{
		void *scratch = malloc(65536);

		if (scratch == NULL)
		{
			perror("child malloc stress");
			close(fd);
			return 27;
		}
		memset(scratch, 0xa5, 65536);
		if (*reattached != 42)
		{
			fprintf(stderr, "mapping overlapped malloc allocation at step=%d value=%d\n",
					i, *reattached);
			close(fd);
			return 28;
		}
	}
	close(fd);
	return 0;
}

int
main(int argc, char **argv)
{
	const char *path = "/dev/shm/wasix-upstream-spawn-shmem-reattach-probe.dat";
	volatile int *slot;
	char addr_text[32];
	char *child_argv[5];
	int status = 0;
	pid_t pid;
	int fd;
	int rc;

	if (argc == 4 && strcmp(argv[1], "--child") == 0)
		return child_main(argv[2], argv[3]);

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

	snprintf(addr_text, sizeof(addr_text), "%p", (void *) slot);
	child_argv[0] = argv[0];
	child_argv[1] = "--child";
	child_argv[2] = (char *) path;
	child_argv[3] = addr_text;
	child_argv[4] = NULL;

	rc = posix_spawn(&pid, argv[0], NULL, NULL, child_argv, environ);
	if (rc != 0)
	{
		errno = rc;
		fprintf(stderr, "posix_spawn failed: %s (%d)\n", strerror(errno), rc);
		return 5;
	}

	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 6;
	}

	printf("after_wait slot=%d status=%d exited=%d exitstatus=%d addr=%p\n",
		   *slot, status, WIFEXITED(status),
		   WIFEXITED(status) ? WEXITSTATUS(status) : -1,
		   (void *) slot);

	if (!WIFEXITED(status))
		return 7;
	if (WEXITSTATUS(status) != 0)
		return WEXITSTATUS(status);
	return *slot == 42 ? 0 : 8;
}
