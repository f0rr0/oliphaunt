#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

int
main(int argc, char **argv)
{
	struct sockaddr_in addr;
	socklen_t addrlen = sizeof(addr);
	struct epoll_event ev;
	struct epoll_event out;
	int listen_fd;
	int epfd;
	int client_fd;
	int one = 1;
	int n;
	char byte;

	if (argc != 1)
	{
		fprintf(stderr, "usage: %s\n", argv[0]);
		return 64;
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
	ev.data.fd = listen_fd;
	if (epoll_ctl(epfd, EPOLL_CTL_ADD, listen_fd, &ev) < 0)
	{
		perror("epoll_ctl");
		return 6;
	}

	printf("epoll-listen-external port=%d\n", ntohs(addr.sin_port));
	fflush(stdout);

	n = epoll_wait(epfd, &out, 1, 10000);
	if (n < 0)
	{
		perror("epoll_wait");
		return 7;
	}
	if (n == 0)
	{
		fprintf(stderr, "epoll_wait timed out for external connector\n");
		return 8;
	}
	if (out.data.fd != listen_fd || (out.events & EPOLLIN) == 0)
	{
		fprintf(stderr, "unexpected epoll event fd=%d events=0x%x\n",
				out.data.fd, out.events);
		return 9;
	}

	client_fd = accept(listen_fd, NULL, NULL);
	if (client_fd < 0)
	{
		perror("accept");
		return 10;
	}
	read(client_fd, &byte, 1);
	close(client_fd);
	close(epfd);
	close(listen_fd);
	printf("epoll-listen-external ok port=%d\n", ntohs(addr.sin_port));
	return 0;
}
