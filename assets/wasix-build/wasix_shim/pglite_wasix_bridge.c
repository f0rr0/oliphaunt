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
#include <getopt.h>
#include <poll.h>
#include <pwd.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/ipc.h>
#include <sys/shm.h>

#ifndef EMSCRIPTEN_KEEPALIVE
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
#endif

#define PGLITE_UID 123
#define PGLITE_PROTOCOL_FD 1
#define POSTGRES_MAIN_LONGJMP 100
#define MAX_ATEXIT_FUNCS 32
#ifdef PGLITE_WASIX_BACKEND_TIMING
#define PGL_BACKEND_TIMING_MAX 64
#endif

volatile int is_pglite_active = 0;
volatile int force_host_error_recovery = 0;
volatile int pglite_wasix_startup_error_capture_active = 0;
volatile sigjmp_buf postgresmain_sigjmp_buf;
volatile bool ignore_till_sync = false;
volatile bool send_ready_for_query = false;

extern int pg_char_to_encoding_private(const char *name);
extern const char *pg_encoding_to_char_private(int encoding);

/*
 * PGlite's libpq sources intentionally use private encoding symbols in the
 * embedded backend build so libpq does not leak a second copy of the encoding
 * table into the main module. A standalone WASIX pg_dump links the same static
 * libpq archive, whose connection path still expects libpq's public aliases.
 * Provide only those aliases here so pg_dump can use the normal static
 * libpgcommon archive without also pulling in libpgcommon_shlib.
 */
int __attribute__((weak)) EMSCRIPTEN_KEEPALIVE
pg_char_to_encoding(const char *name)
{
	return pg_char_to_encoding_private(name);
}

const char __attribute__((weak)) *EMSCRIPTEN_KEEPALIVE
pg_encoding_to_char(int encoding)
{
	return pg_encoding_to_char_private(encoding);
}

static unsigned char *pgl_wasix_input_buf;
static size_t pgl_wasix_input_len;
static size_t pgl_wasix_input_off;

static unsigned char *pgl_wasix_output_buf;
static size_t pgl_wasix_output_len_value;
static size_t pgl_wasix_output_cap;
enum
{
	PGL_WASIX_PROTOCOL_BUFFERED = 0,
	PGL_WASIX_PROTOCOL_STREAM = 1,
	PGL_WASIX_PROTOCOL_HYBRID = 2,
};
enum
{
	PGL_WASIX_PROTOCOL_COPY_NONE = 0,
	PGL_WASIX_PROTOCOL_COPY_IN = 1,
	PGL_WASIX_PROTOCOL_COPY_OUT = 2,
	PGL_WASIX_PROTOCOL_COPY_BOTH = 3,
};

static int pgl_wasix_protocol_transport;
static int pgl_wasix_protocol_copy_state;
static bool pgl_wasix_protocol_stream_requested;
static bool pgl_wasix_protocol_stream_active;
static void (*atexit_funcs[MAX_ATEXIT_FUNCS])(void);
static int atexit_func_count;

int pgl_set_protocol_transport(int mode);

int EMSCRIPTEN_KEEPALIVE
pgl_set_protocol_stdio(int enabled)
{
	return pgl_set_protocol_transport(enabled ? PGL_WASIX_PROTOCOL_STREAM
											  : PGL_WASIX_PROTOCOL_BUFFERED);
}

int EMSCRIPTEN_KEEPALIVE
pgl_set_protocol_transport(int mode)
{
	if (mode < PGL_WASIX_PROTOCOL_BUFFERED || mode > PGL_WASIX_PROTOCOL_HYBRID)
	{
		errno = EINVAL;
		return -1;
	}

	int previous = pgl_wasix_protocol_transport;
	pgl_wasix_protocol_transport = mode;
	pgl_wasix_protocol_stream_active = mode == PGL_WASIX_PROTOCOL_STREAM;
	if (mode != PGL_WASIX_PROTOCOL_HYBRID)
	{
		pgl_wasix_protocol_copy_state = PGL_WASIX_PROTOCOL_COPY_NONE;
		pgl_wasix_protocol_stream_requested = false;
	}
	return previous;
}

int EMSCRIPTEN_KEEPALIVE
pgl_protocol_stream_active(void)
{
	return pgl_wasix_protocol_stream_active ? 1 : 0;
}

void EMSCRIPTEN_KEEPALIVE
pgl_protocol_report_copy_response(int state)
{
	if (state < PGL_WASIX_PROTOCOL_COPY_NONE ||
		state > PGL_WASIX_PROTOCOL_COPY_BOTH)
	{
		errno = EINVAL;
		return;
	}
	pgl_wasix_protocol_copy_state = state;
	pgl_wasix_protocol_stream_requested =
		pgl_wasix_protocol_transport == PGL_WASIX_PROTOCOL_HYBRID &&
		state != PGL_WASIX_PROTOCOL_COPY_NONE;
}

int EMSCRIPTEN_KEEPALIVE
pgl_protocol_copy_state(void)
{
	return pgl_wasix_protocol_copy_state;
}

int EMSCRIPTEN_KEEPALIVE
pgl_set_force_host_error_recovery(int new_value)
{
	int current = force_host_error_recovery;
	force_host_error_recovery = new_value != 0;
	return current;
}

int EMSCRIPTEN_KEEPALIVE
pgl_setPGliteActive(int new_value)
{
	int current = is_pglite_active;
	is_pglite_active = new_value;
	if (new_value == 0)
	{
		struct itimerval zero = {{0, 0}, {0, 0}};
		(void) setitimer(ITIMER_REAL, &zero, NULL);
	}
	return current;
}

void EMSCRIPTEN_KEEPALIVE
pgl_longjmp(jmp_buf env, int val)
{
	/*
	 * Some hosts can run nested WebAssembly exception unwinds and can preserve
	 * PostgreSQL's normal PG_TRY/PG_CATCH behavior. Hosts without that support
	 * must route every PostgreSQL ERROR longjmp through the existing
	 * single-user process-exit boundary; Rust then invokes PostgresMainLongJmp()
	 * to perform the same top-level cleanup and emit the backend ErrorResponse.
	 */
	if (is_pglite_active &&
		(force_host_error_recovery ||
		 memcmp(env, (void *) postgresmain_sigjmp_buf, sizeof(jmp_buf)) == 0))
	{
		exit(POSTGRES_MAIN_LONGJMP);
	}
	longjmp(env, val);
}

void EMSCRIPTEN_KEEPALIVE
pgl_siglongjmp(sigjmp_buf env, int val)
{
	pgl_longjmp(env, val);
}

#ifdef PGLITE_WASIX_BACKEND_TIMING
static uint64_t pgl_backend_timing_started_us[PGL_BACKEND_TIMING_MAX];
static uint64_t pgl_backend_timing_elapsed_us_value[PGL_BACKEND_TIMING_MAX];
static bool pgl_backend_timing_seen[PGL_BACKEND_TIMING_MAX];

static uint64_t
pgl_monotonic_us(void)
{
	struct timespec ts;
	if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
		return 0;
	return ((uint64_t) ts.tv_sec * 1000000ULL) + ((uint64_t) ts.tv_nsec / 1000ULL);
}

void EMSCRIPTEN_KEEPALIVE
pgl_backend_timing_reset(void)
{
	memset(pgl_backend_timing_started_us, 0, sizeof(pgl_backend_timing_started_us));
	memset(pgl_backend_timing_elapsed_us_value, 0, sizeof(pgl_backend_timing_elapsed_us_value));
	memset(pgl_backend_timing_seen, 0, sizeof(pgl_backend_timing_seen));
}

void EMSCRIPTEN_KEEPALIVE
pgl_backend_timing_start(int id)
{
	if (id <= 0 || id >= PGL_BACKEND_TIMING_MAX)
		return;
	pgl_backend_timing_started_us[id] = pgl_monotonic_us();
}

void EMSCRIPTEN_KEEPALIVE
pgl_backend_timing_end(int id)
{
	if (id <= 0 || id >= PGL_BACKEND_TIMING_MAX)
		return;

	uint64_t started = pgl_backend_timing_started_us[id];
	uint64_t ended = pgl_monotonic_us();
	if (started == 0 || ended < started)
		return;

	pgl_backend_timing_elapsed_us_value[id] += ended - started;
	pgl_backend_timing_seen[id] = true;
	pgl_backend_timing_started_us[id] = 0;
}

int64_t EMSCRIPTEN_KEEPALIVE
pgl_backend_timing_elapsed_us(int id)
{
	if (id <= 0 || id >= PGL_BACKEND_TIMING_MAX || !pgl_backend_timing_seen[id])
		return -1;
	return (int64_t) pgl_backend_timing_elapsed_us_value[id];
}
#endif

int EMSCRIPTEN_KEEPALIVE
pgl_wasix_input_reset(void)
{
	pgl_wasix_input_len = 0;
	pgl_wasix_input_off = 0;
	return 0;
}

int EMSCRIPTEN_KEEPALIVE
pgl_wasix_input_write(const void *buffer, size_t length)
{
	if (length == 0)
		return 0;
	if (buffer == NULL)
	{
		errno = EINVAL;
		return -1;
	}

	if (pgl_wasix_input_off == pgl_wasix_input_len)
	{
		pgl_wasix_input_len = 0;
		pgl_wasix_input_off = 0;
	}

	size_t new_len = pgl_wasix_input_len + length;
	unsigned char *new_buf = realloc(pgl_wasix_input_buf, new_len);
	if (new_buf == NULL)
	{
		errno = ENOMEM;
		return -1;
	}

	pgl_wasix_input_buf = new_buf;
	memcpy(pgl_wasix_input_buf + pgl_wasix_input_len, buffer, length);
	pgl_wasix_input_len = new_len;
	return (int) length;
}

size_t EMSCRIPTEN_KEEPALIVE
pgl_wasix_input_available(void)
{
	if (pgl_wasix_input_off >= pgl_wasix_input_len)
		return 0;
	return pgl_wasix_input_len - pgl_wasix_input_off;
}

int EMSCRIPTEN_KEEPALIVE
pgl_wasix_input_peek(void)
{
	if (pgl_wasix_input_off >= pgl_wasix_input_len)
		return -1;
	return (int) pgl_wasix_input_buf[pgl_wasix_input_off];
}

static ssize_t
pgl_wasix_buffer_read(void *buffer, size_t max_length)
{
	if (buffer == NULL || max_length == 0)
		return 0;
	if (pgl_wasix_input_off >= pgl_wasix_input_len)
		return 0;

	size_t available = pgl_wasix_input_len - pgl_wasix_input_off;
	size_t to_copy = available < max_length ? available : max_length;
	memcpy(buffer, pgl_wasix_input_buf + pgl_wasix_input_off, to_copy);
	pgl_wasix_input_off += to_copy;
	return (ssize_t) to_copy;
}

static int
pgl_wasix_flush_output_to_stdio(void)
{
	size_t off = 0;
	while (off < pgl_wasix_output_len_value)
	{
		ssize_t written = write(STDOUT_FILENO,
								pgl_wasix_output_buf + off,
								pgl_wasix_output_len_value - off);
		if (written < 0)
			return -1;
		if (written == 0)
		{
			errno = EIO;
			return -1;
		}
		off += (size_t) written;
	}
	pgl_wasix_output_len_value = 0;
	return 0;
}

int EMSCRIPTEN_KEEPALIVE
pgl_wasix_output_reset(void)
{
	pgl_wasix_output_len_value = 0;
	pgl_wasix_protocol_copy_state = PGL_WASIX_PROTOCOL_COPY_NONE;
	pgl_wasix_protocol_stream_requested = false;
	return 0;
}

size_t EMSCRIPTEN_KEEPALIVE
pgl_wasix_output_len(void)
{
	return pgl_wasix_output_len_value;
}

size_t EMSCRIPTEN_KEEPALIVE
pgl_wasix_output_read(void *buffer, size_t max_length)
{
	if (buffer == NULL || max_length == 0 || pgl_wasix_output_len_value == 0)
		return 0;

	size_t to_copy = pgl_wasix_output_len_value < max_length
		? pgl_wasix_output_len_value
		: max_length;
	memcpy(buffer, pgl_wasix_output_buf, to_copy);
	return to_copy;
}

static ssize_t
pgl_wasix_buffer_write(const void *buffer, size_t length)
{
	if (length == 0)
		return 0;
	if (buffer == NULL)
	{
		errno = EINVAL;
		return -1;
	}

	size_t required = pgl_wasix_output_len_value + length;
	if (required > pgl_wasix_output_cap)
	{
		size_t next_cap = pgl_wasix_output_cap ? pgl_wasix_output_cap : 8192;
		while (next_cap < required)
			next_cap *= 2;
		unsigned char *new_buf = realloc(pgl_wasix_output_buf, next_cap);
		if (new_buf == NULL)
		{
			errno = ENOMEM;
			return -1;
		}
		pgl_wasix_output_buf = new_buf;
		pgl_wasix_output_cap = next_cap;
	}

	memcpy(pgl_wasix_output_buf + pgl_wasix_output_len_value, buffer, length);
	pgl_wasix_output_len_value += length;
	if (pgl_wasix_protocol_transport == PGL_WASIX_PROTOCOL_HYBRID &&
		pgl_wasix_protocol_stream_requested)
	{
		if (pgl_wasix_flush_output_to_stdio() != 0)
			return -1;
		pgl_wasix_protocol_stream_active = true;
		pgl_wasix_protocol_stream_requested = false;
	}
	return (ssize_t) length;
}

int EMSCRIPTEN_KEEPALIVE
pgl_system(const char *command)
{
	(void) command;
	errno = ENOSYS;
	return -1;
}

__attribute__((weak)) void EMSCRIPTEN_KEEPALIVE
pg_free(void *ptr)
{
	free(ptr);
}

static char *
pgl_locale_file_path(void)
{
	const char *sysconfdir = getenv("PGSYSCONFDIR");
	if (sysconfdir == NULL || sysconfdir[0] == '\0')
	{
		errno = ENOENT;
		return NULL;
	}
	if (access(sysconfdir, F_OK) != 0)
		return NULL;

	const char *name = "/locale";
	size_t len = strlen(sysconfdir) + strlen(name) + 1;
	char *path = malloc(len);
	if (path == NULL)
		return NULL;

	snprintf(path, len, "%s%s", sysconfdir, name);
	return path;
}

static FILE *
pgl_open_locale_pipe(const char *command, const char *mode)
{
	if (command == NULL || mode == NULL || strcmp(command, "locale -a") != 0 ||
		strcmp(mode, "r") != 0)
	{
		errno = ENOSYS;
		return NULL;
	}

	char *path = pgl_locale_file_path();
	if (path == NULL)
	{
		if (errno == 0)
			errno = ENOMEM;
		return NULL;
	}

	if (access(path, F_OK) != 0)
	{
		FILE *file = fopen(path, "w");
		if (file != NULL)
		{
			const char *encoding = getenv("PGCLIENTENCODING");
			if (encoding == NULL || encoding[0] == '\0')
				encoding = "UTF8";
			fprintf(file, "C\nC.%s\nPOSIX\n%s\n", encoding, encoding);
			fclose(file);
		}
	}

	FILE *file = fopen(path, mode);
	free(path);
	return file;
}

__attribute__((weak)) FILE *EMSCRIPTEN_KEEPALIVE
pgl_popen(const char *command, const char *mode)
{
	return pgl_open_locale_pipe(command, mode);
}

__attribute__((weak)) int EMSCRIPTEN_KEEPALIVE
pgl_pclose(FILE *file)
{
	if (file == NULL)
	{
		errno = EINVAL;
		return -1;
	}
	return fclose(file);
}

uid_t EMSCRIPTEN_KEEPALIVE
pgl_geteuid(void)
{
	return PGLITE_UID;
}

uid_t EMSCRIPTEN_KEEPALIVE
pgl_getuid(void)
{
	return PGLITE_UID;
}

struct passwd *EMSCRIPTEN_KEEPALIVE
pgl_getpwuid(uid_t uid)
{
	if (uid != PGLITE_UID)
	{
		errno = ENOENT;
		return NULL;
	}

	static struct passwd pw;
	static char name[] = "postgres";
	static char passwd[] = "x";
	static char gecos[] = "Static User";
	static char dir[] = "/home/postgres";
	static char shell[] = "/bin/sh";

	pw.pw_name = name;
	pw.pw_passwd = passwd;
	pw.pw_uid = uid;
	pw.pw_gid = uid;
	pw.pw_gecos = gecos;
	pw.pw_dir = dir;
	pw.pw_shell = shell;

	return &pw;
}

int EMSCRIPTEN_KEEPALIVE
pgl_atexit(void (*function)(void))
{
	if (atexit_func_count >= MAX_ATEXIT_FUNCS)
		return -1;
	atexit_funcs[atexit_func_count++] = function;
	return 0;
}

void EMSCRIPTEN_KEEPALIVE
pgl_run_atexit_funcs(void)
{
	for (int i = atexit_func_count - 1; i >= 0; i--)
	{
		if (atexit_funcs[i])
			atexit_funcs[i]();
	}
	atexit_func_count = 0;
}

static void
pgl_clear_interval_timer(void)
{
	struct itimerval zero = {{0, 0}, {0, 0}};
	(void) setitimer(ITIMER_REAL, &zero, NULL);
}

void EMSCRIPTEN_KEEPALIVE
pgl_exit(int status)
{
	pgl_clear_interval_timer();
	optind = 1;
	if (pglite_wasix_startup_error_capture_active && status != 0)
	{
		pglite_wasix_startup_error_capture_active = 0;
		__builtin_trap();
	}
	exit(status);
}

int EMSCRIPTEN_KEEPALIVE
pgl_munmap(void *addr, size_t length)
{
	if (addr == NULL || length == 0)
	{
		errno = EINVAL;
		return -1;
	}
	return munmap(addr, length);
}

int EMSCRIPTEN_KEEPALIVE
pgl_fcntl(int fd, int cmd, ...)
{
	va_list args;
	long arg = 0;

	switch (cmd)
	{
#ifdef F_GETFL
		case F_GETFL:
			if (fd == PGLITE_PROTOCOL_FD)
				return 0;
			return fcntl(fd, cmd);
#endif
#ifdef F_GETFD
		case F_GETFD:
			if (fd == PGLITE_PROTOCOL_FD)
				return 0;
			return fcntl(fd, cmd);
#endif
#ifdef F_SETFL
		case F_SETFL:
			va_start(args, cmd);
			arg = va_arg(args, long);
			va_end(args);
			if (fd == PGLITE_PROTOCOL_FD)
			{
#ifdef O_NONBLOCK
				if ((arg & ~((long) O_NONBLOCK)) == 0)
					return 0;
#else
				if (arg == 0)
					return 0;
#endif
				errno = EINVAL;
				return -1;
			}
			return fcntl(fd, cmd, (int) arg);
#endif
#ifdef F_SETFD
		case F_SETFD:
			va_start(args, cmd);
			arg = va_arg(args, long);
			va_end(args);
			if (fd == PGLITE_PROTOCOL_FD)
			{
#ifdef FD_CLOEXEC
				if ((arg & ~((long) FD_CLOEXEC)) == 0)
					return 0;
#else
				if (arg == 0)
					return 0;
#endif
				errno = EINVAL;
				return -1;
			}
			return fcntl(fd, cmd, (int) arg);
#endif
		default:
			errno = EINVAL;
			return -1;
	}
}

static int
pgl_write_int_sockopt(void *optval, socklen_t *optlen, int value)
{
	if (optval == NULL || optlen == NULL || *optlen < (socklen_t) sizeof(int))
	{
		errno = EINVAL;
		return -1;
	}
	memcpy(optval, &value, sizeof(value));
	*optlen = (socklen_t) sizeof(value);
	return 0;
}

int EMSCRIPTEN_KEEPALIVE
pgl_setsockopt(int fd, int level, int optname, const void *optval, socklen_t optlen)
{
	if (fd != PGLITE_PROTOCOL_FD)
		return setsockopt(fd, level, optname, optval, optlen);

	if (optval == NULL && optlen != 0)
	{
		errno = EINVAL;
		return -1;
	}

	if (level == SOL_SOCKET)
	{
		switch (optname)
		{
#ifdef SO_KEEPALIVE
			case SO_KEEPALIVE:
#endif
#ifdef SO_REUSEADDR
			case SO_REUSEADDR:
#endif
#ifdef SO_SNDBUF
			case SO_SNDBUF:
#endif
#ifdef SO_RCVBUF
			case SO_RCVBUF:
#endif
#ifdef SO_NOSIGPIPE
			case SO_NOSIGPIPE:
#endif
				return 0;
			default:
				break;
		}
	}

	if (level == IPPROTO_TCP)
	{
		switch (optname)
		{
#ifdef TCP_NODELAY
			case TCP_NODELAY:
#endif
#ifdef TCP_KEEPIDLE
			case TCP_KEEPIDLE:
#endif
#ifdef TCP_KEEPINTVL
			case TCP_KEEPINTVL:
#endif
#ifdef TCP_KEEPCNT
			case TCP_KEEPCNT:
#endif
#ifdef TCP_USER_TIMEOUT
			case TCP_USER_TIMEOUT:
#endif
				return 0;
			default:
				break;
		}
	}

	errno = ENOPROTOOPT;
	return -1;
}

int EMSCRIPTEN_KEEPALIVE
pgl_getsockopt(int fd, int level, int optname, void *optval, socklen_t *optlen)
{
	if (fd != PGLITE_PROTOCOL_FD)
		return getsockopt(fd, level, optname, optval, optlen);

	if (level == SOL_SOCKET)
	{
		switch (optname)
		{
#ifdef SO_ERROR
			case SO_ERROR:
				return pgl_write_int_sockopt(optval, optlen, 0);
#endif
#ifdef SO_TYPE
			case SO_TYPE:
				return pgl_write_int_sockopt(optval, optlen, SOCK_STREAM);
#endif
#ifdef SO_SNDBUF
			case SO_SNDBUF:
				return pgl_write_int_sockopt(optval, optlen, 32768);
#endif
#ifdef SO_RCVBUF
			case SO_RCVBUF:
				return pgl_write_int_sockopt(optval, optlen, 32768);
#endif
			default:
				break;
		}
	}

	if (level == IPPROTO_TCP)
	{
		switch (optname)
		{
#ifdef TCP_KEEPIDLE
			case TCP_KEEPIDLE:
#endif
#ifdef TCP_KEEPINTVL
			case TCP_KEEPINTVL:
#endif
#ifdef TCP_KEEPCNT
			case TCP_KEEPCNT:
#endif
#ifdef TCP_USER_TIMEOUT
			case TCP_USER_TIMEOUT:
#endif
				return pgl_write_int_sockopt(optval, optlen, 0);
			default:
				break;
		}
	}

	errno = ENOPROTOOPT;
	return -1;
}

int EMSCRIPTEN_KEEPALIVE
pgl_getsockname(int fd, struct sockaddr *addr, socklen_t *len)
{
	if (fd != PGLITE_PROTOCOL_FD)
		return getsockname(fd, addr, len);

	if (addr == NULL || len == NULL || *len < (socklen_t) sizeof(sa_family_t))
	{
		errno = EINVAL;
		return -1;
	}

	memset(addr, 0, *len);
	addr->sa_family = AF_UNIX;
	*len = (socklen_t) sizeof(sa_family_t);
	return 0;
}

ssize_t EMSCRIPTEN_KEEPALIVE
pgl_recv(int fd, void *buf, size_t n, int flags)
{
	if (fd != PGLITE_PROTOCOL_FD)
		return recv(fd, buf, n, flags);
	if (pgl_wasix_protocol_transport == PGL_WASIX_PROTOCOL_STREAM ||
		pgl_wasix_protocol_stream_active)
	{
		(void) flags;
		return read(STDIN_FILENO, buf, n);
	}
	return pgl_wasix_buffer_read(buf, n);
}

ssize_t EMSCRIPTEN_KEEPALIVE
pgl_send(int fd, const void *buf, size_t n, int flags)
{
	if (fd != PGLITE_PROTOCOL_FD)
		return send(fd, buf, n, flags);
	if (pgl_wasix_protocol_transport == PGL_WASIX_PROTOCOL_STREAM ||
		pgl_wasix_protocol_stream_active)
	{
		(void) flags;
		return write(STDOUT_FILENO, buf, n);
	}
	return pgl_wasix_buffer_write(buf, n);
}

int EMSCRIPTEN_KEEPALIVE
pgl_connect(int socket, const struct sockaddr *address, socklen_t address_len)
{
	if (socket != PGLITE_PROTOCOL_FD)
		return connect(socket, address, address_len);
	errno = ENOSYS;
	return -1;
}

int EMSCRIPTEN_KEEPALIVE
pgl_poll(struct pollfd fds[], nfds_t nfds, int timeout)
{
	bool has_protocol_fd = false;
	int ready = 0;

	for (nfds_t i = 0; i < nfds; i++)
	{
		if (fds[i].fd == PGLITE_PROTOCOL_FD)
		{
			has_protocol_fd = true;
			break;
		}
	}

	if (!has_protocol_fd)
		return poll(fds, nfds, timeout);

	for (nfds_t i = 0; i < nfds; i++)
	{
		fds[i].revents = 0;
		if (fds[i].fd != PGLITE_PROTOCOL_FD)
		{
			struct pollfd one = fds[i];
			int rc = poll(&one, 1, 0);
			if (rc < 0)
				return rc;
			fds[i].revents = one.revents;
			if (rc > 0)
				ready++;
			continue;
		}
		if (pgl_wasix_protocol_transport == PGL_WASIX_PROTOCOL_STREAM ||
			pgl_wasix_protocol_stream_active)
		{
			struct pollfd one;
			int rc;

			one.fd = STDIN_FILENO;
			one.events = fds[i].events;
			one.revents = 0;
			rc = poll(&one, 1, 0);
			if (rc < 0)
				return rc;
			fds[i].revents = one.revents;
			if (rc > 0)
				ready++;
			continue;
		}
#ifdef POLLIN
		if ((fds[i].events & POLLIN) &&
			pgl_wasix_input_available() > 0)
			fds[i].revents |= POLLIN;
#endif
#ifdef POLLOUT
		if (fds[i].events & POLLOUT)
			fds[i].revents |= POLLOUT;
#endif
		if (fds[i].revents)
			ready++;
	}
	return ready;
}

typedef struct WasixShmSegment
{
	int shmid;
	key_t key;
	size_t size;
	void *addr;
	unsigned long nattch;
	struct WasixShmSegment *next;
} WasixShmSegment;

static WasixShmSegment *wasix_shm_list;
static int wasix_next_shmid = 1;

static WasixShmSegment *
find_by_key(key_t key)
{
	for (WasixShmSegment *seg = wasix_shm_list; seg; seg = seg->next)
	{
		if (seg->key == key)
			return seg;
	}
	return NULL;
}

static WasixShmSegment *
find_by_id(int shmid)
{
	for (WasixShmSegment *seg = wasix_shm_list; seg; seg = seg->next)
	{
		if (seg->shmid == shmid)
			return seg;
	}
	return NULL;
}

int EMSCRIPTEN_KEEPALIVE
pgl_shmget(key_t key, size_t size, int shmflg)
{
	WasixShmSegment *existing = find_by_key(key);

	if (existing)
	{
		if ((shmflg & IPC_CREAT) && (shmflg & IPC_EXCL))
		{
			errno = EEXIST;
			return -1;
		}
		return existing->shmid;
	}

	if ((shmflg & IPC_CREAT) == 0)
	{
		errno = ENOENT;
		return -1;
	}

	size_t alloc_size = size ? size : 1;
	long pagesize = sysconf(_SC_PAGESIZE);
	if (pagesize > 0)
	{
		size_t page = (size_t) pagesize;
		alloc_size = ((alloc_size + page - 1) / page) * page;
	}

	void *addr = calloc(1, alloc_size);
	if (!addr)
	{
		errno = ENOMEM;
		return -1;
	}

	WasixShmSegment *seg = calloc(1, sizeof(*seg));
	if (!seg)
	{
		free(addr);
		errno = ENOMEM;
		return -1;
	}

	seg->shmid = wasix_next_shmid++;
	seg->key = key;
	seg->size = size;
	seg->addr = addr;
	seg->next = wasix_shm_list;
	wasix_shm_list = seg;

	return seg->shmid;
}

void *EMSCRIPTEN_KEEPALIVE
pgl_shmat(int shmid, const void *shmaddr, int shmflg)
{
	(void) shmaddr;
	(void) shmflg;

	WasixShmSegment *seg = find_by_id(shmid);
	if (!seg)
	{
		errno = EINVAL;
		return (void *) -1;
	}

	seg->nattch++;
	return seg->addr;
}

int EMSCRIPTEN_KEEPALIVE
pgl_shmdt(const void *shmaddr)
{
	for (WasixShmSegment *seg = wasix_shm_list; seg; seg = seg->next)
	{
		if (seg->addr == shmaddr)
		{
			if (seg->nattch > 0)
				seg->nattch--;
			return 0;
		}
	}

	errno = EINVAL;
	return -1;
}

int EMSCRIPTEN_KEEPALIVE
pgl_shmctl(int shmid, int cmd, struct shmid_ds *buf)
{
	WasixShmSegment *prev = NULL;
	WasixShmSegment *seg = wasix_shm_list;

	while (seg && seg->shmid != shmid)
	{
		prev = seg;
		seg = seg->next;
	}

	if (!seg)
	{
		errno = EINVAL;
		return -1;
	}

	switch (cmd)
	{
		case IPC_RMID:
			if (prev)
				prev->next = seg->next;
			else
				wasix_shm_list = seg->next;
			free(seg->addr);
			free(seg);
			return 0;

		case IPC_STAT:
			if (!buf)
			{
				errno = EINVAL;
				return -1;
			}
			memset(buf, 0, sizeof(*buf));
#if defined(__APPLE__)
			buf->shm_perm._key = seg->key;
#else
			buf->shm_perm.__key = seg->key;
#endif
			buf->shm_segsz = seg->size;
			buf->shm_nattch = seg->nattch;
			buf->shm_atime = buf->shm_dtime = buf->shm_ctime = time(NULL);
			return 0;

		case IPC_SET:
			if (!buf)
			{
				errno = EINVAL;
				return -1;
			}
			seg->size = buf->shm_segsz;
			return 0;

		default:
			errno = EINVAL;
			return -1;
	}
}
