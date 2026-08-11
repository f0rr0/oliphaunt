#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t alarm_count;
static int selfpipe_writefd = -1;

static void
alarm_handler(int signo)
{
	char byte = 0;
	int saved_errno = errno;

	(void) signo;
	alarm_count++;
	if (selfpipe_writefd >= 0)
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

static long long
elapsed_milliseconds(const struct timespec *start, const struct timespec *end)
{
	long long seconds = (long long) end->tv_sec - (long long) start->tv_sec;
	long long nanoseconds = (long long) end->tv_nsec - (long long) start->tv_nsec;

	return seconds * 1000 + nanoseconds / 1000000;
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

int
main(void)
{
	struct epoll_event event;
	struct epoll_event occurred;
	struct itimerval timer;
	struct sigaction action;
	struct timespec start;
	struct timespec end;
	long long elapsed_ms;
	int selfpipe[2];
	int epollfd;
	int wait_errno;
	int rc;

	if (pipe(selfpipe) != 0 || set_nonblocking(selfpipe[0]) != 0 ||
		set_nonblocking(selfpipe[1]) != 0)
	{
		perror("self-pipe");
		return 1;
	}
	selfpipe_writefd = selfpipe[1];

	epollfd = epoll_create1(EPOLL_CLOEXEC);
	if (epollfd < 0)
	{
		perror("epoll_create1");
		return 2;
	}
	memset(&event, 0, sizeof(event));
	event.events = EPOLLIN;
	event.data.fd = selfpipe[0];
	if (epoll_ctl(epollfd, EPOLL_CTL_ADD, selfpipe[0], &event) != 0)
	{
		perror("epoll_ctl self-pipe");
		return 3;
	}

	memset(&action, 0, sizeof(action));
	action.sa_handler = alarm_handler;
	action.sa_flags = SA_RESTART;
	sigemptyset(&action.sa_mask);
	if (sigaction(SIGALRM, &action, NULL) != 0)
	{
		perror("sigaction SIGALRM");
		return 4;
	}

	memset(&timer, 0, sizeof(timer));
	timer.it_value.tv_usec = 100000;
	if (clock_gettime(CLOCK_MONOTONIC, &start) != 0)
	{
		perror("clock_gettime start");
		return 5;
	}
	if (setitimer(ITIMER_REAL, &timer, NULL) != 0)
	{
		perror("setitimer one-shot");
		return 6;
	}

	errno = 0;
	rc = epoll_wait(epollfd, &occurred, 1, 2000);
	wait_errno = errno;
	if (clock_gettime(CLOCK_MONOTONIC, &end) != 0)
	{
		perror("clock_gettime end");
		return 7;
	}
	elapsed_ms = elapsed_milliseconds(&start, &end);
	if (rc == 0)
	{
		fprintf(stderr,
				"one-shot timer did not wake epoll elapsed_ms=%lld alarms=%d\n",
				elapsed_ms, (int) alarm_count);
		return 8;
	}
	if (rc < 0 && wait_errno != EINTR)
	{
		errno = wait_errno;
		perror("first epoll_wait");
		return 9;
	}
	if (rc > 0 && (occurred.data.fd != selfpipe[0] ||
					(occurred.events & EPOLLIN) == 0))
	{
		fprintf(stderr, "unexpected first epoll event fd=%d events=0x%x\n",
				occurred.data.fd, occurred.events);
		return 10;
	}
	if (alarm_count != 1 || elapsed_ms < 25 || elapsed_ms > 1000)
	{
		fprintf(stderr,
				"one-shot timer delivery mismatch elapsed_ms=%lld alarms=%d epoll_rc=%d\n",
				elapsed_ms, (int) alarm_count, rc);
		return 11;
	}
	if (drain_selfpipe(selfpipe[0]) != 0)
	{
		perror("drain first timer self-pipe event");
		return 12;
	}

	errno = 0;
	rc = epoll_wait(epollfd, &occurred, 1, 300);
	wait_errno = errno;
	if (rc != 0 || alarm_count != 1)
	{
		fprintf(stderr,
				"one-shot timer repeated epoll_rc=%d errno=%d alarms=%d\n",
				rc, wait_errno, (int) alarm_count);
		return 13;
	}

	memset(&timer, 0, sizeof(timer));
	if (setitimer(ITIMER_REAL, &timer, NULL) != 0)
	{
		perror("setitimer cancel");
		return 14;
	}

	close(epollfd);
	close(selfpipe[0]);
	close(selfpipe[1]);
	printf("setitimer-epoll-one-shot ok elapsed_ms=%lld alarms=%d\n",
		   elapsed_ms, (int) alarm_count);
	return 0;
}
