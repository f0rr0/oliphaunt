#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static long
elapsed_ms(const struct timeval *start, const struct timeval *end)
{
	return (end->tv_sec - start->tv_sec) * 1000L +
		(end->tv_usec - start->tv_usec) / 1000L;
}

int
main(int argc, char **argv)
{
	struct sockaddr_in addr;
	socklen_t addrlen = sizeof(addr);
	struct pollfd pfd;
	struct timeval tv;
	struct timeval before;
	struct timeval after;
	pid_t child;
	int listen_fd;
	int client_fd;
	int accepted_fd;
	int flags;
	int one = 1;
	int rc;
	char byte;
	char listen_fd_arg[32];
	char *child_argv[4];
	int spawn_rc;

	if (argc == 3 && strcmp(argv[1], "--child") == 0)
	{
		listen_fd = atoi(argv[2]);
		accepted_fd = accept(listen_fd, NULL, NULL);
		if (accepted_fd < 0)
		{
			perror("accept child");
			return 20;
		}
		usleep(700000);
		close(accepted_fd);
		return 0;
	}

	listen_fd = socket(AF_INET, SOCK_STREAM, 0);
	if (listen_fd < 0)
	{
		perror("socket listen");
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
	if (listen(listen_fd, 1) < 0)
	{
		perror("listen");
		return 3;
	}
	if (getsockname(listen_fd, (struct sockaddr *) &addr, &addrlen) < 0)
	{
		perror("getsockname");
		return 4;
	}

	snprintf(listen_fd_arg, sizeof(listen_fd_arg), "%d", listen_fd);
	child_argv[0] = argv[0];
	child_argv[1] = "--child";
	child_argv[2] = listen_fd_arg;
	child_argv[3] = NULL;
	spawn_rc = posix_spawn(&child, argv[0], NULL, NULL, child_argv, environ);
	if (spawn_rc != 0)
	{
		errno = spawn_rc;
		perror("posix_spawn");
		return 5;
	}

	client_fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (client_fd < 0)
	{
		perror("socket client");
		return 6;
	}

	flags = fcntl(client_fd, F_GETFL);
	if (flags < 0)
	{
		perror("fcntl F_GETFL");
		return 7;
	}
	if ((flags & O_NONBLOCK) == 0)
	{
		fprintf(stderr, "SOCK_NONBLOCK was not reflected in F_GETFL flags=0x%x\n",
				flags);
		return 8;
	}

	flags = fcntl(client_fd, F_GETFD);
	if (flags < 0)
	{
		perror("fcntl F_GETFD");
		return 9;
	}
	if ((flags & FD_CLOEXEC) == 0)
	{
		fprintf(stderr, "SOCK_CLOEXEC was not reflected in F_GETFD flags=0x%x\n",
				flags);
		return 10;
	}

	memset(&tv, 0, sizeof(tv));
	tv.tv_sec = 1;
	setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

	rc = connect(client_fd, (struct sockaddr *) &addr, sizeof(addr));
	if (rc < 0 && errno != EINPROGRESS && errno != EWOULDBLOCK && errno != EALREADY)
	{
		perror("connect");
		return 11;
	}

	memset(&pfd, 0, sizeof(pfd));
	pfd.fd = client_fd;
	pfd.events = POLLOUT;
	rc = poll(&pfd, 1, 5000);
	if (rc <= 0)
	{
		fprintf(stderr, "poll for connect returned %d errno=%d\n", rc, errno);
		return 12;
	}

	gettimeofday(&before, NULL);
	rc = recv(client_fd, &byte, 1, 0);
	gettimeofday(&after, NULL);
	if (rc >= 0)
	{
		fprintf(stderr, "recv returned %d, expected EAGAIN/EWOULDBLOCK\n", rc);
		return 13;
	}
	if (errno != EAGAIN && errno != EWOULDBLOCK)
	{
		fprintf(stderr, "recv errno=%d, expected EAGAIN/EWOULDBLOCK\n", errno);
		return 14;
	}
	if (elapsed_ms(&before, &after) > 200)
	{
		fprintf(stderr, "nonblocking recv took %ldms\n",
				elapsed_ms(&before, &after));
		return 15;
	}

	close(client_fd);
	close(listen_fd);
	if (waitpid(child, &rc, 0) != child)
	{
		perror("waitpid");
		return 16;
	}
	if (!WIFEXITED(rc) || WEXITSTATUS(rc) != 0)
	{
		fprintf(stderr, "child status=%d\n", rc);
		return 17;
	}

	printf("socket-nonblock ok port=%d\n", ntohs(addr.sin_port));
	return 0;
}
