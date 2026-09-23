#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

int
main(void)
{
	struct sockaddr_in addr;
	socklen_t addrlen = sizeof(addr);
	struct epoll_event ev;
	struct epoll_event out;
	int listen_fd;
	int epfd;
	int client_fd;
	int pipefd[2];
	int one = 1;
	int n;
	char byte;

	if (pipe(pipefd) != 0)
	{
		perror("pipe");
		return 1;
	}

	listen_fd = socket(AF_INET, SOCK_STREAM, 0);
	if (listen_fd < 0)
	{
		perror("socket");
		return 2;
	}

	setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons(0);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	if (bind(listen_fd, (struct sockaddr *) &addr, sizeof(addr)) < 0)
	{
		perror("bind");
		return 3;
	}
	if (listen(listen_fd, 16) < 0)
	{
		perror("listen");
		return 4;
	}
	if (getsockname(listen_fd, (struct sockaddr *) &addr, &addrlen) < 0)
	{
		perror("getsockname");
		return 5;
	}

	epfd = epoll_create1(EPOLL_CLOEXEC);
	if (epfd < 0)
	{
		perror("epoll_create1");
		return 6;
	}

	memset(&ev, 0, sizeof(ev));
	ev.events = EPOLLIN;
	ev.data.fd = pipefd[0];
	if (epoll_ctl(epfd, EPOLL_CTL_ADD, pipefd[0], &ev) < 0)
	{
		perror("epoll_ctl pipe");
		return 7;
	}

	memset(&ev, 0, sizeof(ev));
	ev.events = EPOLLIN;
	ev.data.fd = listen_fd;
	if (epoll_ctl(epfd, EPOLL_CTL_ADD, listen_fd, &ev) < 0)
	{
		perror("epoll_ctl listen");
		return 8;
	}

	if (write(pipefd[1], "p", 1) != 1)
	{
		perror("write pipe");
		return 9;
	}

	n = epoll_wait(epfd, &out, 1, 10000);
	if (n != 1 || out.data.fd != pipefd[0] || (out.events & EPOLLIN) == 0)
	{
		fprintf(stderr, "pipe pre-event failed n=%d fd=%d events=0x%x errno=%d\n",
				n, n == 1 ? out.data.fd : -1, n == 1 ? out.events : 0, errno);
		return 10;
	}
	read(pipefd[0], &byte, 1);

	printf("epoll-listen-external-after-pipe port=%d\n", ntohs(addr.sin_port));
	fflush(stdout);

	n = epoll_wait(epfd, &out, 1, 10000);
	if (n < 0)
	{
		perror("epoll_wait listener");
		return 11;
	}
	if (n == 0)
	{
		fprintf(stderr, "epoll_wait timed out for external connector after pipe event\n");
		return 12;
	}
	if (out.data.fd != listen_fd || (out.events & EPOLLIN) == 0)
	{
		fprintf(stderr, "unexpected listener event fd=%d events=0x%x\n",
				out.data.fd, out.events);
		return 13;
	}

	client_fd = accept(listen_fd, NULL, NULL);
	if (client_fd < 0)
	{
		perror("accept");
		return 14;
	}
	read(client_fd, &byte, 1);
	close(client_fd);
	close(epfd);
	close(listen_fd);
	close(pipefd[0]);
	close(pipefd[1]);
	printf("epoll-listen-external-after-pipe ok port=%d\n", ntohs(addr.sin_port));
	return 0;
}
