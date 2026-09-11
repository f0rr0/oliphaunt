#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

enum
{
	MAPPING_SIZE = 4096,
	PROBE_ROUNDS = 512,
	CHILD_WAIT_TIMEOUT_MS = 2000,
	CONTROL_TIMEOUT_MS = 1000,
	STARTUP_TIMEOUT_MS = 5000
};

#define SHARED_MAGIC UINT32_C(0x4f4c4154)
#define memory_barrier() __atomic_thread_fence(__ATOMIC_SEQ_CST)

/* Keep the latch fields ordinary, as they are in PostgreSQL's Latch. */
typedef struct SharedLatch
{
	uint32_t magic;
	sig_atomic_t is_set;
	sig_atomic_t maybe_sleeping;
	int owner_pid;
	volatile sig_atomic_t handler_count;
	volatile uint32_t round;
} SharedLatch;

_Static_assert(sizeof(SharedLatch) <= MAPPING_SIZE,
			   "shared latch must fit in one mapped page");

static SharedLatch *signal_latch;
static volatile sig_atomic_t child_waiting;
static int selfpipe_writefd = -1;

static void
latch_sigurg_handler(int signo)
{
	char byte = 0;
	int saved_errno = errno;

	(void) signo;
	if (signal_latch != NULL)
		signal_latch->handler_count++;
	if (child_waiting && selfpipe_writefd >= 0)
	{
		ssize_t rc;

		do
			rc = write(selfpipe_writefd, &byte, 1);
		while (rc < 0 && errno == EINTR);
	}
	errno = saved_errno;
}

static int
set_nonblocking(int fd)
{
	int flags = fcntl(fd, F_GETFL, 0);

	if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
		return -1;
	return 0;
}

static int
write_control(char byte)
{
	ssize_t rc;

	do
		rc = write(STDOUT_FILENO, &byte, 1);
	while (rc < 0 && errno == EINTR);
	return rc == 1 ? 0 : -1;
}

static int
read_control(int fd, char *byte, int timeout_ms)
{
	struct pollfd pollfd;
	int rc;

	memset(&pollfd, 0, sizeof(pollfd));
	pollfd.fd = fd;
	pollfd.events = POLLIN;
	do
		rc = poll(&pollfd, 1, timeout_ms);
	while (rc < 0 && errno == EINTR);
	if (rc <= 0)
		return rc;

	do
		rc = (int) read(fd, byte, 1);
	while (rc < 0 && errno == EINTR);
	return rc == 1 ? 1 : -1;
}

static int
drain_selfpipe(int fd)
{
	char buffer[64];

	for (;;)
	{
		ssize_t rc = read(fd, buffer, sizeof(buffer));

		if (rc > 0)
			continue;
		if (rc < 0 && errno == EINTR)
			continue;
		if (rc < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
			return 0;
		return rc == 0 ? 0 : -1;
	}
}

static int
child_main(const char *path, const char *address_text)
{
	struct epoll_event event;
	struct epoll_event occurred;
	struct sigaction action;
	SharedLatch *latch;
	uintptr_t address;
	char *end = NULL;
	int selfpipe[2];
	int epollfd;
	int fd;

	errno = 0;
	address = (uintptr_t) strtoull(address_text, &end, 0);
	if (errno != 0 || end == address_text || *end != '\0' || address == 0)
	{
		fprintf(stderr, "invalid shared mapping address: %s\n", address_text);
		return 20;
	}

	fd = open(path, O_RDWR);
	if (fd < 0)
	{
		perror("child open shared mapping");
		return 21;
	}
	latch = mmap((void *) address, MAPPING_SIZE, PROT_READ | PROT_WRITE,
				 MAP_SHARED | MAP_FIXED, fd, 0);
	close(fd);
	if (latch == MAP_FAILED)
	{
		perror("child mmap MAP_SHARED|MAP_FIXED");
		return 22;
	}
	if ((uintptr_t) latch != address || latch->magic != SHARED_MAGIC)
	{
		fprintf(stderr,
				"child shared mapping mismatch address=%p expected=%p magic=0x%08x\n",
				(void *) latch, (void *) address, (unsigned) latch->magic);
		return 23;
	}

	if (pipe(selfpipe) != 0 || set_nonblocking(selfpipe[0]) != 0 ||
		set_nonblocking(selfpipe[1]) != 0)
	{
		perror("child self-pipe");
		return 24;
	}
	epollfd = epoll_create1(EPOLL_CLOEXEC);
	if (epollfd < 0)
	{
		perror("child epoll_create1");
		return 25;
	}
	memset(&event, 0, sizeof(event));
	event.events = EPOLLIN;
	event.data.fd = selfpipe[0];
	if (epoll_ctl(epollfd, EPOLL_CTL_ADD, selfpipe[0], &event) != 0)
	{
		perror("child epoll_ctl self-pipe");
		return 26;
	}

	signal_latch = latch;
	selfpipe_writefd = selfpipe[1];
	memset(&action, 0, sizeof(action));
	action.sa_handler = latch_sigurg_handler;
	action.sa_flags = SA_RESTART;
	sigemptyset(&action.sa_mask);
	if (sigaction(SIGURG, &action, NULL) != 0)
	{
		perror("child sigaction SIGURG");
		return 27;
	}

	if (write_control('I') != 0)
	{
		perror("child write init control");
		return 28;
	}

	for (uint32_t round = 0; round < PROBE_ROUNDS; round++)
	{
		int ready_sent = 0;

		latch->is_set = 0;
		latch->maybe_sleeping = 0;
		latch->round = round;
		memory_barrier();
		child_waiting = 1;

		while (!latch->is_set)
		{
			int rc;

			latch->maybe_sleeping = 1;
			memory_barrier();
			if (latch->is_set)
				break;

			if (!ready_sent)
			{
				if (write_control('R') != 0)
				{
					perror("child write ready control");
					return 29;
				}
				ready_sent = 1;
			}

			rc = epoll_wait(epollfd, &occurred, 1, CHILD_WAIT_TIMEOUT_MS);
			if (rc == 0)
			{
				fprintf(stderr,
						"child latch wait timed out round=%u is_set=%d maybe_sleeping=%d handlers=%d\n",
						round, (int) latch->is_set,
						(int) latch->maybe_sleeping,
						(int) latch->handler_count);
				(void) write_control('F');
				return 30;
			}
			if (rc < 0)
			{
				if (errno == EINTR)
					continue;
				perror("child epoll_wait");
				(void) write_control('F');
				return 31;
			}
			if (occurred.data.fd != selfpipe[0] ||
				(occurred.events & EPOLLIN) == 0)
			{
				fprintf(stderr,
						"child unexpected epoll event round=%u fd=%d events=0x%x\n",
						round, occurred.data.fd, occurred.events);
				(void) write_control('F');
				return 32;
			}
			if (drain_selfpipe(selfpipe[0]) != 0)
			{
				perror("child drain self-pipe");
				(void) write_control('F');
				return 33;
			}
		}

		latch->maybe_sleeping = 0;
		child_waiting = 0;
		if (!ready_sent || !latch->is_set)
		{
			fprintf(stderr,
					"child invalid latch completion round=%u ready=%d is_set=%d\n",
					round, ready_sent, (int) latch->is_set);
			(void) write_control('F');
			return 34;
		}
		if (write_control('A') != 0)
		{
			perror("child write ack control");
			return 35;
		}
	}

	close(epollfd);
	close(selfpipe[0]);
	close(selfpipe[1]);
	return 0;
}

static void
set_latch(SharedLatch *latch, pid_t child_pid, uint32_t round, int *failure)
{
	int kill_rc;

	memory_barrier();
	if (latch->is_set)
	{
		fprintf(stderr, "parent observed pre-set latch round=%u\n", round);
		*failure = 1;
		return;
	}
	latch->is_set = 1;
	memory_barrier();
	if (!latch->maybe_sleeping)
	{
		fprintf(stderr,
				"parent missed maybe_sleeping round=%u is_set=%d handlers=%d\n",
				round, (int) latch->is_set, (int) latch->handler_count);
		*failure = 1;
		return;
	}

	kill_rc = kill(child_pid, SIGURG);
	if (kill_rc != 0)
	{
		fprintf(stderr, "parent kill(SIGURG) failed round=%u rc=%d errno=%d\n",
				round, kill_rc, errno);
		*failure = 1;
	}
}

int
main(int argc, char **argv)
{
	const char *path_prefix = "/dev/shm/oliphaunt-exec-shared-latch-sigurg";
	posix_spawn_file_actions_t actions;
	SharedLatch *latch;
	char address_text[32];
	char path[160];
	char *child_argv[5];
	char control;
	int control_pipe[2];
	int status = 0;
	int failure = 0;
	int fd;
	int rc;
	pid_t child_pid;

	/* POSIX signal zero probes liveness without delivering a signal. */
	errno = 0;
	if (kill(getpid(), 0) != 0)
	{
		fprintf(stderr, "parent kill(self, 0) failed errno=%d\n", errno);
		return 1;
	}

	if (argc == 4 && strcmp(argv[1], "--child") == 0)
		return child_main(argv[2], argv[3]);

	snprintf(path, sizeof(path), "%s-%ld.dat", path_prefix, (long) getpid());
	unlink(path);
	fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
	if (fd < 0 || ftruncate(fd, MAPPING_SIZE) != 0)
	{
		perror("parent create shared mapping");
		return 1;
	}
	latch = mmap(NULL, MAPPING_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	close(fd);
	if (latch == MAP_FAILED)
	{
		perror("parent mmap MAP_SHARED");
		unlink(path);
		return 2;
	}
	memset(latch, 0, MAPPING_SIZE);
	latch->magic = SHARED_MAGIC;
	memory_barrier();

	if (pipe(control_pipe) != 0)
	{
		perror("parent control pipe");
		unlink(path);
		return 3;
	}
	rc = posix_spawn_file_actions_init(&actions);
	if (rc == 0)
		rc = posix_spawn_file_actions_adddup2(&actions, control_pipe[1],
										 STDOUT_FILENO);
	if (rc == 0)
		rc = posix_spawn_file_actions_addclose(&actions, control_pipe[0]);
	if (rc == 0)
		rc = posix_spawn_file_actions_addclose(&actions, control_pipe[1]);
	if (rc != 0)
	{
		errno = rc;
		perror("parent posix_spawn file actions");
		unlink(path);
		return 4;
	}

	snprintf(address_text, sizeof(address_text), "%p", (void *) latch);
	child_argv[0] = argv[0];
	child_argv[1] = "--child";
	child_argv[2] = path;
	child_argv[3] = address_text;
	child_argv[4] = NULL;
	rc = posix_spawn(&child_pid, argv[0], &actions, NULL, child_argv, environ);
	posix_spawn_file_actions_destroy(&actions);
	close(control_pipe[1]);
	if (rc != 0)
	{
		errno = rc;
		fprintf(stderr, "parent posix_spawn failed: %s (%d)\n",
				strerror(errno), rc);
		unlink(path);
		return 5;
	}
	latch->owner_pid = child_pid;

	rc = read_control(control_pipe[0], &control, STARTUP_TIMEOUT_MS);
	if (rc != 1 || control != 'I')
	{
		fprintf(stderr,
				"parent child initialization failed rc=%d control=%d round=%u is_set=%d maybe_sleeping=%d handlers=%d\n",
				rc, rc == 1 ? (int) control : -1, (unsigned) latch->round,
				(int) latch->is_set, (int) latch->maybe_sleeping,
				(int) latch->handler_count);
		failure = 1;
		goto cleanup_child;
	}

	for (uint32_t round = 0; round < PROBE_ROUNDS; round++)
	{
		rc = read_control(control_pipe[0], &control, CONTROL_TIMEOUT_MS);
		if (rc != 1 || control != 'R')
		{
			fprintf(stderr,
					"parent ready timeout/failure expected_round=%u rc=%d control=%d shared_round=%u is_set=%d maybe_sleeping=%d handlers=%d\n",
					round, rc, rc == 1 ? (int) control : -1,
					(unsigned) latch->round, (int) latch->is_set,
					(int) latch->maybe_sleeping,
					(int) latch->handler_count);
			failure = 1;
			break;
		}
		if (latch->round != round || !latch->maybe_sleeping)
		{
			fprintf(stderr,
					"parent shared-state visibility failure expected_round=%u shared_round=%u is_set=%d maybe_sleeping=%d handlers=%d\n",
					round, (unsigned) latch->round, (int) latch->is_set,
					(int) latch->maybe_sleeping,
					(int) latch->handler_count);
			failure = 1;
		}

		/* Odd rounds exercise an already-parked epoll waiter. */
		if ((round & 1U) != 0)
			usleep(2000);
		set_latch(latch, child_pid, round, &failure);

		rc = read_control(control_pipe[0], &control, CONTROL_TIMEOUT_MS);
		if (rc != 1 || control != 'A')
		{
			fprintf(stderr,
					"parent latch ack timeout/failure round=%u rc=%d control=%d is_set=%d maybe_sleeping=%d handlers=%d\n",
					round, rc, rc == 1 ? (int) control : -1,
					(int) latch->is_set, (int) latch->maybe_sleeping,
					(int) latch->handler_count);
			failure = 1;
			break;
		}
		if (latch->handler_count != (sig_atomic_t) (round + 1))
		{
			fprintf(stderr,
					"parent signal handler count mismatch round=%u handlers=%d\n",
					round, (int) latch->handler_count);
			failure = 1;
			break;
		}
	}

cleanup_child:
	if (failure)
		(void) kill(child_pid, SIGKILL);
	if (waitpid(child_pid, &status, 0) < 0)
	{
		perror("parent waitpid");
		failure = 1;
	}
	errno = 0;
	rc = kill(child_pid, 0);
	if (rc != -1 || errno != ESRCH)
	{
		fprintf(stderr,
				"parent kill(reaped-child, 0) did not report ESRCH rc/errno=%d/%d\n",
				rc, errno);
		failure = 1;
	}
	close(control_pipe[0]);
	munmap(latch, MAPPING_SIZE);
	unlink(path);

	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
	{
		fprintf(stderr, "parent child exit failure status=%d exited=%d exitstatus=%d\n",
				status, WIFEXITED(status),
				WIFEXITED(status) ? WEXITSTATUS(status) : -1);
		failure = 1;
	}
	if (failure)
		return 6;

	printf("exec-shared-latch-sigurg ok rounds=%d handlers=%d\n",
		   PROBE_ROUNDS, (int) PROBE_ROUNDS);
	return 0;
}
