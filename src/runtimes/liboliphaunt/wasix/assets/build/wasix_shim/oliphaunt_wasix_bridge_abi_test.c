#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pwd.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/shm.h>

#define CHECK(condition)                                                                 \
	do                                                                                   \
	{                                                                                    \
		if (!(condition))                                                                \
		{                                                                                \
			fprintf(stderr, "bridge ABI check failed at %s:%d: %s\n", __FILE__, __LINE__, \
					#condition);                                                        \
			return 1;                                                                    \
		}                                                                                \
	} while (0)

FILE *oliphaunt_wasix_popen(const char *command, const char *mode);
int oliphaunt_wasix_system(const char *command);
int oliphaunt_wasix_set_force_host_error_recovery(int new_value);
int oliphaunt_wasix_set_active(int new_value);
int oliphaunt_wasix_atexit(void (*function)(void));
void oliphaunt_wasix_run_atexit_funcs(void);
uid_t oliphaunt_wasix_geteuid(void);
uid_t oliphaunt_wasix_getuid(void);
gid_t oliphaunt_wasix_getegid(void);
gid_t oliphaunt_wasix_getgid(void);
struct passwd *oliphaunt_wasix_getpwuid(uid_t uid);
int oliphaunt_wasix_getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen,
				   struct passwd **result);
int oliphaunt_wasix_input_reset(void);
int oliphaunt_wasix_input_write(const void *buffer, size_t length);
size_t oliphaunt_wasix_input_available(void);
int oliphaunt_wasix_output_reset(void);
size_t oliphaunt_wasix_output_len(void);
size_t oliphaunt_wasix_output_read(void *buffer, size_t max_length);
int oliphaunt_wasix_fcntl(int fd, int cmd, ...);
int oliphaunt_wasix_setsockopt(int fd, int level, int optname, const void *optval, socklen_t optlen);
int oliphaunt_wasix_getsockopt(int fd, int level, int optname, void *optval, socklen_t *optlen);
int oliphaunt_wasix_getsockname(int fd, struct sockaddr *addr, socklen_t *len);
int oliphaunt_wasix_set_protocol_stdio(int enabled);
int oliphaunt_wasix_set_protocol_transport(int mode);
int oliphaunt_wasix_protocol_stream_active(void);
void oliphaunt_wasix_protocol_report_copy_response(int state);
int oliphaunt_wasix_protocol_copy_state(void);
ssize_t oliphaunt_wasix_recv(int fd, void *buf, size_t n, int flags);
ssize_t oliphaunt_wasix_send(int fd, const void *buf, size_t n, int flags);
int oliphaunt_wasix_connect(int socket, const struct sockaddr *address, socklen_t address_len);
int oliphaunt_wasix_poll(struct pollfd fds[], nfds_t nfds, int timeout);
int oliphaunt_wasix_munmap(void *addr, size_t length);
int oliphaunt_wasix_shmget(key_t key, size_t size, int shmflg);
void *oliphaunt_wasix_shmat(int shmid, const void *shmaddr, int shmflg);
int oliphaunt_wasix_shmdt(const void *shmaddr);
int oliphaunt_wasix_shmctl(int shmid, int cmd, struct shmid_ds *buf);

int
pg_char_to_encoding_private(const char *name)
{
	return strcmp(name, "UTF8") == 0 ? 6 : -1;
}

const char *
pg_encoding_to_char_private(int encoding)
{
	return encoding == 6 ? "UTF8" : "";
}

static int atexit_counter;

static void
increment_atexit_counter(void)
{
	atexit_counter++;
}

static int
check_locale_pipe(void)
{
	char temp_template[] = "/tmp/oliphaunt-bridge-abi-XXXXXX";
	char *dir = mkdtemp(temp_template);
	CHECK(dir != NULL);
	CHECK(setenv("PGSYSCONFDIR", dir, 1) == 0);
	CHECK(setenv("PGCLIENTENCODING", "UTF8", 1) == 0);

	errno = 0;
	CHECK(oliphaunt_wasix_popen("uname -a", "r") == NULL);
	CHECK(errno == ENOSYS);
	errno = 0;
	CHECK(oliphaunt_wasix_popen("locale -a", "w") == NULL);
	CHECK(errno == ENOSYS);

	FILE *file = oliphaunt_wasix_popen("locale -a", "r");
	CHECK(file != NULL);
	char contents[128] = {0};
	size_t read_len = fread(contents, 1, sizeof(contents) - 1, file);
	CHECK(fclose(file) == 0);
	CHECK(read_len > 0);
	CHECK(strstr(contents, "C\n") != NULL);
	CHECK(strstr(contents, "C.UTF8\n") != NULL);
	CHECK(strstr(contents, "POSIX\n") != NULL);
	CHECK(unsetenv("PGSYSCONFDIR") == 0);
	errno = 0;
	CHECK(oliphaunt_wasix_popen("locale -a", "r") == NULL);
	CHECK(errno == ENOENT);
	return 0;
}

static int
check_identity_and_fail_closed_calls(void)
{
	CHECK(oliphaunt_wasix_geteuid() == 123);
	CHECK(oliphaunt_wasix_getuid() == 123);
	CHECK(oliphaunt_wasix_getegid() == 123);
	CHECK(oliphaunt_wasix_getgid() == 123);
	struct passwd *pw = oliphaunt_wasix_getpwuid(123);
	CHECK(pw != NULL);
	CHECK(strcmp(pw->pw_name, "postgres") == 0);
	CHECK(pw->pw_uid == 123);
	CHECK(pw->pw_gid == 123);

	struct passwd pwbuf;
	struct passwd *result = NULL;
	char buf[128];
	CHECK(oliphaunt_wasix_getpwuid_r(123, &pwbuf, buf, sizeof(buf), &result) == 0);
	CHECK(result == &pwbuf);
	CHECK(strcmp(result->pw_name, "postgres") == 0);
	CHECK(result->pw_uid == 123);
	CHECK(result->pw_gid == 123);
	result = &pwbuf;
	CHECK(oliphaunt_wasix_getpwuid_r(999, &pwbuf, buf, sizeof(buf), &result) == 0);
	CHECK(result == NULL);
	errno = 0;
	CHECK(oliphaunt_wasix_getpwuid_r(123, &pwbuf, buf, 4, &result) == ERANGE);
	CHECK(errno == ERANGE);

	errno = 0;
	CHECK(oliphaunt_wasix_getpwuid(999) == NULL);
	CHECK(errno == ENOENT);

	errno = 0;
	CHECK(oliphaunt_wasix_system("echo unsafe") == -1);
	CHECK(errno == ENOSYS);

	CHECK(oliphaunt_wasix_set_force_host_error_recovery(1) == 0);
	CHECK(oliphaunt_wasix_set_force_host_error_recovery(0) == 1);
	CHECK(oliphaunt_wasix_set_active(1) == 0);
	CHECK(oliphaunt_wasix_set_active(0) == 1);
	CHECK(oliphaunt_wasix_atexit(increment_atexit_counter) == 0);
	CHECK(oliphaunt_wasix_atexit(increment_atexit_counter) == 0);
	oliphaunt_wasix_run_atexit_funcs();
	CHECK(atexit_counter == 2);
	oliphaunt_wasix_run_atexit_funcs();
	CHECK(atexit_counter == 2);

	errno = 0;
	CHECK(oliphaunt_wasix_connect(1, NULL, 0) == -1);
	CHECK(errno == ENOSYS);
	errno = 0;
	CHECK(oliphaunt_wasix_connect(-1, NULL, 0) == -1);
	CHECK(errno == EBADF);
	return 0;
}

static int
check_protocol_socket(void)
{
	char buf[8] = {0};
	const char input[] = "abc";
	const char output[] = "xyz";

	CHECK(oliphaunt_wasix_input_reset() == 0);
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_recv(1, buf, sizeof(buf), 0) == 0);
	CHECK(oliphaunt_wasix_input_write(input, sizeof(input) - 1) == (int) (sizeof(input) - 1));
	CHECK(oliphaunt_wasix_input_available() == sizeof(input) - 1);
	CHECK(oliphaunt_wasix_recv(1, buf, 2, 0) == 2);
	CHECK(memcmp(buf, "ab", 2) == 0);
	CHECK(oliphaunt_wasix_input_available() == 1);

	CHECK(oliphaunt_wasix_send(1, output, sizeof(output) - 1, 0) == (ssize_t) (sizeof(output) - 1));
	CHECK(oliphaunt_wasix_output_len() == sizeof(output) - 1);
	memset(buf, 0, sizeof(buf));
	CHECK(oliphaunt_wasix_output_read(buf, sizeof(buf)) == sizeof(output) - 1);
	CHECK(memcmp(buf, output, sizeof(output) - 1) == 0);

	CHECK(oliphaunt_wasix_set_protocol_stdio(0) == 0);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);
	CHECK(oliphaunt_wasix_set_protocol_stdio(1) == 0);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 1);
	CHECK(oliphaunt_wasix_set_protocol_stdio(0) == 1);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(2) == 0);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);
	CHECK(oliphaunt_wasix_protocol_copy_state() == 0);
	oliphaunt_wasix_protocol_report_copy_response(1);
	CHECK(oliphaunt_wasix_protocol_copy_state() == 1);
	CHECK(oliphaunt_wasix_send(1, output, sizeof(output) - 1, 0) == (ssize_t) (sizeof(output) - 1));
	CHECK(oliphaunt_wasix_protocol_stream_active() == 1);
	CHECK(oliphaunt_wasix_set_protocol_transport(0) == 2);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);
	CHECK(oliphaunt_wasix_protocol_copy_state() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(2) == 0);
	oliphaunt_wasix_protocol_report_copy_response(0);
	CHECK(oliphaunt_wasix_protocol_copy_state() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(0) == 2);
	errno = 0;
	CHECK(oliphaunt_wasix_set_protocol_transport(99) == -1);
	CHECK(errno == EINVAL);

#ifdef ENOTSOCK
	errno = 0;
	CHECK(oliphaunt_wasix_recv(2, buf, sizeof(buf), 0) == -1);
	CHECK(errno == ENOTSOCK);
	errno = 0;
	CHECK(oliphaunt_wasix_send(2, output, sizeof(output) - 1, 0) == -1);
	CHECK(errno == ENOTSOCK);
#endif

	CHECK(oliphaunt_wasix_fcntl(1, F_GETFL) == 0);
	CHECK(oliphaunt_wasix_fcntl(1, F_SETFL, O_NONBLOCK) == 0);
#ifdef O_APPEND
	errno = 0;
	CHECK(oliphaunt_wasix_fcntl(1, F_SETFL, O_APPEND) == -1);
	CHECK(errno == EINVAL);
#endif

	int opt = 1;
	CHECK(oliphaunt_wasix_setsockopt(1, SOL_SOCKET, SO_KEEPALIVE, &opt, sizeof(opt)) == 0);
#ifdef TCP_NODELAY
	CHECK(oliphaunt_wasix_setsockopt(1, IPPROTO_TCP, TCP_NODELAY, &opt, sizeof(opt)) == 0);
#endif
	errno = 0;
	CHECK(oliphaunt_wasix_setsockopt(1, SOL_SOCKET, 0x7ffffffe, &opt, sizeof(opt)) == -1);
	CHECK(errno == ENOPROTOOPT);

	opt = 0;
	socklen_t optlen = sizeof(opt);
	CHECK(oliphaunt_wasix_getsockopt(1, SOL_SOCKET, SO_TYPE, &opt, &optlen) == 0);
	CHECK(opt == SOCK_STREAM);
	CHECK(optlen == (socklen_t) sizeof(opt));
	errno = 0;
	optlen = sizeof(opt);
	CHECK(oliphaunt_wasix_getsockopt(1, SOL_SOCKET, 0x7ffffffd, &opt, &optlen) == -1);
	CHECK(errno == ENOPROTOOPT);

	struct sockaddr_storage addr;
	socklen_t addrlen = sizeof(addr);
	CHECK(oliphaunt_wasix_getsockname(1, (struct sockaddr *) &addr, &addrlen) == 0);
	CHECK(addr.ss_family == AF_UNIX);

	CHECK(oliphaunt_wasix_input_reset() == 0);
	struct pollfd fds[1] = {{.fd = 1, .events = POLLIN, .revents = 0}};
	CHECK(oliphaunt_wasix_poll(fds, 1, 0) == 0);
	CHECK(fds[0].revents == 0);
	CHECK(oliphaunt_wasix_input_write("q", 1) == 1);
	CHECK(oliphaunt_wasix_poll(fds, 1, 0) == 1);
	CHECK((fds[0].revents & POLLIN) != 0);

	struct pollfd ignored[1] = {{.fd = -1, .events = POLLIN, .revents = 0}};
	CHECK(oliphaunt_wasix_poll(ignored, 1, 0) == 0);
	struct pollfd mixed[2] = {
		{.fd = 1, .events = POLLOUT, .revents = 0},
		{.fd = 99, .events = POLLIN, .revents = 0},
	};
	CHECK(oliphaunt_wasix_poll(mixed, 2, 0) == 2);
	CHECK((mixed[0].revents & POLLOUT) != 0);
#ifdef POLLNVAL
	CHECK((mixed[1].revents & POLLNVAL) != 0);
#endif
	return 0;
}

static int
check_memory_and_shared_memory(void)
{
	errno = 0;
	CHECK(oliphaunt_wasix_munmap(NULL, 0) == -1);
	CHECK(errno == EINVAL);

#if defined(MAP_ANON)
	int anon_flag = MAP_ANON;
#elif defined(MAP_ANONYMOUS)
	int anon_flag = MAP_ANONYMOUS;
#else
	int anon_flag = 0;
#endif
	if (anon_flag != 0)
	{
		void *mapping = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | anon_flag, -1, 0);
		CHECK(mapping != MAP_FAILED);
		CHECK(oliphaunt_wasix_munmap(mapping, 4096) == 0);
	}

	key_t key = 4242;
	int shmid = oliphaunt_wasix_shmget(key, 64, IPC_CREAT | IPC_EXCL);
	CHECK(shmid > 0);
	errno = 0;
	CHECK(oliphaunt_wasix_shmget(key, 64, IPC_CREAT | IPC_EXCL) == -1);
	CHECK(errno == EEXIST);
	errno = 0;
	CHECK(oliphaunt_wasix_shmget(key + 1, 64, 0) == -1);
	CHECK(errno == ENOENT);

	void *addr = oliphaunt_wasix_shmat(shmid, NULL, 0);
	CHECK(addr != (void *) -1);
	memset(addr, 0x7b, 64);

	struct shmid_ds statbuf;
	CHECK(oliphaunt_wasix_shmctl(shmid, IPC_STAT, &statbuf) == 0);
	CHECK(statbuf.shm_segsz == 64);
	CHECK(statbuf.shm_nattch == 1);
	CHECK(oliphaunt_wasix_shmdt(addr) == 0);
	CHECK(oliphaunt_wasix_shmctl(shmid, IPC_RMID, NULL) == 0);
	errno = 0;
	CHECK(oliphaunt_wasix_shmat(shmid, NULL, 0) == (void *) -1);
	CHECK(errno == EINVAL);
	return 0;
}

int
main(void)
{
	CHECK(check_locale_pipe() == 0);
	CHECK(check_identity_and_fail_closed_calls() == 0);
	CHECK(check_protocol_socket() == 0);
	CHECK(check_memory_and_shared_memory() == 0);
	return 0;
}
