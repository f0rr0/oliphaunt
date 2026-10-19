#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

typedef struct
{
	int port;
	int rc;
} connector_arg;

static void *
connector_main(void *argp)
{
	connector_arg *arg = argp;
	struct sockaddr_in addr;
	int fd;

	usleep(100000);

	fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0)
	{
		arg->rc = errno;
		return NULL;
	}

	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons(arg->port);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

	if (connect(fd, (struct sockaddr *) &addr, sizeof(addr)) < 0)
	{
		arg->rc = errno;
		close(fd);
		return NULL;
	}

	write(fd, "x", 1);
	close(fd);
	arg->rc = 0;
	return NULL;
}

int
main(int argc, char **argv)
{
	struct sockaddr_in addr;
	socklen_t addrlen = sizeof(addr);
	struct epoll_event ev;
	struct epoll_event out;
	connector_arg arg;
	pthread_t thread;
	char *child_argv[4];
	int listen_fd;
	int epfd;
	int client_fd;
	int one = 1;
	int status;
	int n;
	pid_t pid;

	if (argc == 2 && strcmp(argv[1], "--child") == 0)
		return 0;
	if (argc == 3 && strcmp(argv[1], "--child-check-epoll") == 0)
	{
		int inherited_epfd = atoi(argv[2]);

		if (fcntl(inherited_epfd, F_GETFD) >= 0 || errno != EBADF)
		{
			fprintf(stderr, "epoll fd %d leaked across exec errno=%d\n",
					inherited_epfd, errno);
			return 1;
		}
		return 0;
	}

	listen_fd = socket(AF_INET, SOCK_STREAM, 0);
	if (listen_fd < 0)
	{
		perror("socket");
		return 1;
	}

	setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons(0);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	if (bind(listen_fd, (struct sockaddr *) &addr, sizeof(addr)) < 0)
	{
		perror("bind");
		return 2;
	}
	if (listen(listen_fd, 16) < 0)
	{
		perror("listen");
		return 3;
	}
	if (getsockname(listen_fd, (struct sockaddr *) &addr, &addrlen) < 0)
	{
		perror("getsockname");
		return 4;
	}

	epfd = epoll_create1(EPOLL_CLOEXEC);
	if (epfd < 0)
	{
		perror("epoll_create1");
		return 5;
	}

	memset(&ev, 0, sizeof(ev));
	ev.events = EPOLLIN;
	ev.data.ptr = &ev;
	if (epoll_ctl(epfd, EPOLL_CTL_ADD, listen_fd, &ev) < 0)
	{
		perror("epoll_ctl");
		return 6;
	}

	char epfd_buf[32];

	snprintf(epfd_buf, sizeof(epfd_buf), "%d", epfd);
	child_argv[0] = argv[0];
	child_argv[1] = "--child-check-epoll";
	child_argv[2] = epfd_buf;
	child_argv[3] = NULL;

	pid = vfork();
	if (pid < 0)
	{
		perror("vfork");
		return 7;
	}
	if (pid == 0)
	{
		execve(argv[0], child_argv, environ);
		perror("execve");
		_exit(127);
	}
	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 8;
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
	{
		fprintf(stderr, "child exited unexpectedly status=%d\n", status);
		return 9;
	}

	arg.port = ntohs(addr.sin_port);
	arg.rc = -1;
	if (pthread_create(&thread, NULL, connector_main, &arg) != 0)
	{
		perror("pthread_create");
		return 10;
	}

	do
	{
		n = epoll_wait(epfd, &out, 1, 5000);
	} while (n < 0 && errno == EINTR);
	if (n < 0)
	{
		perror("epoll_wait");
		return 11;
	}
	if (n == 0)
	{
		fprintf(stderr, "epoll_wait timed out after vfork+exec child\n");
		return 12;
	}
	if (out.data.ptr != &ev || (out.events & EPOLLIN) == 0)
	{
		fprintf(stderr, "unexpected epoll event ptr=%p events=0x%x\n",
				out.data.ptr, out.events);
		return 13;
	}

	client_fd = accept(listen_fd, NULL, NULL);
	if (client_fd < 0)
	{
		perror("accept");
		return 14;
	}
	close(client_fd);

	pthread_join(thread, NULL);
	if (arg.rc != 0)
	{
		errno = arg.rc;
		perror("connector");
		return 15;
	}

	close(epfd);
	close(listen_fd);
	printf("epoll-listen-after-vfork-exec ok port=%d\n", arg.port);
	return 0;
}
