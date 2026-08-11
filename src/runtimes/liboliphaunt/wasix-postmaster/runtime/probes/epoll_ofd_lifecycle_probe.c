#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <unistd.h>

#define PAYLOAD_OLD_FD UINT64_C(0x4f4c4401)
#define PAYLOAD_OLD_ALIAS UINT64_C(0x4f4c4402)
#define PAYLOAD_REUSED_FD UINT64_C(0x4e455701)

static int
add_read_watch(int epfd, int fd, uint64_t payload)
{
	struct epoll_event event;

	memset(&event, 0, sizeof(event));
	event.events = EPOLLIN;
	event.data.u64 = payload;
	return epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &event);
}

static int
require_initial_payloads(int epfd)
{
	struct epoll_event events[8];
	unsigned int seen = 0;
	int n;
	int i;

	n = epoll_wait(epfd, events, 8, 1000);
	if (n < 0)
	{
		perror("epoll_wait initial payloads");
		return -1;
	}
	if (n != 3)
	{
		fprintf(stderr, "expected three initial events, got %d errno=%d\n", n, errno);
		return -1;
	}

	for (i = 0; i < n; i++)
	{
		unsigned int bit;

		if ((events[i].events & EPOLLIN) == 0)
		{
			fprintf(stderr,
					"initial payload 0x%llx lacked EPOLLIN: events=0x%x\n",
					(unsigned long long) events[i].data.u64,
					events[i].events);
			return -1;
		}

		switch (events[i].data.u64)
		{
			case PAYLOAD_OLD_FD:
				bit = 1U << 0;
				break;
			case PAYLOAD_OLD_ALIAS:
				bit = 1U << 1;
				break;
			case PAYLOAD_REUSED_FD:
				bit = 1U << 2;
				break;
			default:
				fprintf(stderr, "unexpected initial payload: 0x%llx\n",
						(unsigned long long) events[i].data.u64);
				return -1;
		}

		if ((seen & bit) != 0)
		{
			fprintf(stderr, "duplicate initial payload: 0x%llx\n",
					(unsigned long long) events[i].data.u64);
			return -1;
		}
		seen |= bit;
	}

	if (seen != 0x7U)
	{
		fprintf(stderr, "initial payload set incomplete: mask=0x%x\n", seen);
		return -1;
	}
	return 0;
}

static int
require_quiet(int epfd)
{
	struct epoll_event events[8];
	int n;

	n = epoll_wait(epfd, events, 8, 100);
	if (n < 0)
	{
		perror("epoll_wait stale registrations");
		return -1;
	}
	if (n != 0)
	{
		fprintf(stderr,
				"stale event survived final old-OFD close: count=%d payload=0x%llx events=0x%x\n",
				n, (unsigned long long) events[0].data.u64, events[0].events);
		return -1;
	}
	return 0;
}

static int
require_reused_watch(int epfd)
{
	struct epoll_event events[8];
	int n;

	n = epoll_wait(epfd, events, 8, 1000);
	if (n < 0)
	{
		perror("epoll_wait reused fd");
		return -1;
	}
	if (n != 1 || events[0].data.u64 != PAYLOAD_REUSED_FD ||
		(events[0].events & EPOLLIN) == 0)
	{
		fprintf(stderr,
				"reused-fd watch failed: count=%d payload=0x%llx events=0x%x\n",
				n,
				(unsigned long long) (n > 0 ? events[0].data.u64 : 0),
				n > 0 ? events[0].events : 0);
		return -1;
	}
	return 0;
}

static int
read_one(int fd, const char *label)
{
	char byte;
	ssize_t n;

	n = read(fd, &byte, 1);
	if (n != 1)
	{
		fprintf(stderr, "%s read failed: result=%lld errno=%d\n",
				label, (long long) n, errno);
		return -1;
	}
	return 0;
}

int
main(int argc, char **argv)
{
	int old_pipe[2];
	int new_pipe[2];
	int old_read_fd;
	int old_write_fd;
	int old_alias;
	int reused_read_fd;
	int epfd;
	int ctl_status;

	if (argc != 1)
	{
		fprintf(stderr, "usage: %s\n", argv[0]);
		return 64;
	}

	if (pipe(old_pipe) != 0)
	{
		perror("pipe old");
		return 1;
	}
	old_read_fd = old_pipe[0];
	old_write_fd = old_pipe[1];

	epfd = epoll_create1(EPOLL_CLOEXEC);
	if (epfd < 0)
	{
		perror("epoll_create1");
		return 2;
	}
	ctl_status = add_read_watch(epfd, old_read_fd, PAYLOAD_OLD_FD);
	if (ctl_status != 0)
	{
		fprintf(stderr, "epoll_ctl old fd failed: result=%d errno=%d\n",
				ctl_status, errno);
		return 3;
	}

	old_alias = dup(old_read_fd);
	if (old_alias < 0)
	{
		perror("dup old read fd");
		return 4;
	}
	ctl_status = add_read_watch(epfd, old_alias, PAYLOAD_OLD_ALIAS);
	if (ctl_status != 0)
	{
		fprintf(stderr, "epoll_ctl old alias failed: result=%d errno=%d\n",
				ctl_status, errno);
		return 5;
	}

	if (close(old_read_fd) != 0)
	{
		perror("close old numeric fd");
		return 6;
	}
	if (pipe(new_pipe) != 0)
	{
		perror("pipe new");
		return 7;
	}
	reused_read_fd = new_pipe[0];
	if (reused_read_fd != old_read_fd)
	{
		fprintf(stderr, "old numeric fd was not reused: old=%d new=%d\n",
				old_read_fd, reused_read_fd);
		return 8;
	}
	ctl_status = add_read_watch(epfd, reused_read_fd, PAYLOAD_REUSED_FD);
	if (ctl_status != 0)
	{
		fprintf(stderr, "epoll_ctl reused fd failed: result=%d errno=%d\n",
				ctl_status, errno);
		return 9;
	}

	if (write(old_write_fd, "o", 1) != 1)
	{
		perror("write old pipe");
		return 10;
	}
	if (write(new_pipe[1], "n", 1) != 1)
	{
		perror("write new pipe");
		return 11;
	}
	if (require_initial_payloads(epfd) != 0)
		return 12;
	if (read_one(old_alias, "old alias") != 0)
		return 13;
	if (read_one(reused_read_fd, "reused fd") != 0)
		return 14;

	/*
	 * The first close retained the old registrations because old_alias still
	 * referenced that open file description.  This close is the final guest
	 * handle for it, so both old registrations must now be removed.  Closing
	 * the writer would make the retained read end report HUP if either stale
	 * registration still held it alive.
	 */
	if (close(old_alias) != 0)
	{
		perror("close final old alias");
		return 15;
	}
	if (close(old_write_fd) != 0)
	{
		perror("close old writer");
		return 16;
	}
	if (require_quiet(epfd) != 0)
		return 17;

	if (write(new_pipe[1], "r", 1) != 1)
	{
		perror("write reused-fd pipe");
		return 18;
	}
	if (require_reused_watch(epfd) != 0)
		return 19;
	if (read_one(reused_read_fd, "reused fd after old close") != 0)
		return 20;
	if (require_quiet(epfd) != 0)
		return 21;

	close(new_pipe[1]);
	close(reused_read_fd);
	close(epfd);
	printf("epoll-ofd-lifecycle ok reused-fd=%d\n", reused_read_fd);
	return 0;
}
