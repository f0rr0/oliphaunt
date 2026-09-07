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
#include <limits.h>
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

#include "oliphaunt_wasix_protocol_contract.generated.h"

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
int oliphaunt_wasix_output_contains_error(void);
const void *oliphaunt_wasix_startup_outcome_v1(void);
void oliphaunt_wasix_startup_outcome_reset(void);
int oliphaunt_wasix_startup_outcome_publish_rejected(void);
extern volatile int oliphaunt_wasix_startup_error_capture_active;
int oliphaunt_wasix_fcntl(int fd, int cmd, ...);
int oliphaunt_wasix_setsockopt(int fd, int level, int optname, const void *optval, socklen_t optlen);
int oliphaunt_wasix_getsockopt(int fd, int level, int optname, void *optval, socklen_t *optlen);
int oliphaunt_wasix_getsockname(int fd, struct sockaddr *addr, socklen_t *len);
ssize_t oliphaunt_wasix_recv(int fd, void *buf, size_t n, int flags);
ssize_t oliphaunt_wasix_send(int fd, const void *buf, size_t n, int flags);
int oliphaunt_wasix_socket(int domain, int type, int protocol);
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

typedef struct OliphauntWasixStartupOutcomeV1
{
	uint32_t abi_version;
	uint32_t byte_size;
	uint32_t kind;
	uint32_t reserved;
	uint64_t protocol_ptr;
	uint64_t protocol_len;
} OliphauntWasixStartupOutcomeV1;

_Static_assert(sizeof(OliphauntWasixStartupOutcomeV1) == 32,
			   "startup outcome ABI must remain 32 bytes");
_Static_assert(offsetof(OliphauntWasixStartupOutcomeV1, abi_version) == 0,
			   "startup outcome ABI version offset changed");
_Static_assert(offsetof(OliphauntWasixStartupOutcomeV1, byte_size) == 4,
			   "startup outcome ABI size offset changed");
_Static_assert(offsetof(OliphauntWasixStartupOutcomeV1, kind) == 8,
			   "startup outcome ABI kind offset changed");
_Static_assert(offsetof(OliphauntWasixStartupOutcomeV1, reserved) == 12,
			   "startup outcome ABI reserved offset changed");
_Static_assert(offsetof(OliphauntWasixStartupOutcomeV1, protocol_ptr) == 16,
			   "startup outcome ABI protocol pointer offset changed");
_Static_assert(offsetof(OliphauntWasixStartupOutcomeV1, protocol_len) == 24,
			   "startup outcome ABI protocol length offset changed");

static uint32_t
load_le32(const unsigned char *bytes)
{
	return (uint32_t) bytes[0] |
		((uint32_t) bytes[1] << 8) |
		((uint32_t) bytes[2] << 16) |
		((uint32_t) bytes[3] << 24);
}

static uint64_t
load_le64(const unsigned char *bytes)
{
	uint64_t value = 0;
	for (size_t i = 0; i < sizeof(value); i++)
		value |= (uint64_t) bytes[i] << (i * 8);
	return value;
}

static void
increment_atexit_counter(void)
{
	atexit_counter++;
}

static int
check_send_reaches_stdout(const void *sent_bytes, size_t sent_len,
						  const void *expected, size_t expected_len)
{
	int capture_fds[2] = {-1, -1};
	int saved_stdout = -1;
	unsigned char actual[64];
	size_t actual_len = 0;
	ssize_t sent = -1;
	int result = 1;

	if (expected_len > sizeof(actual) || pipe(capture_fds) != 0)
		goto cleanup;
	saved_stdout = dup(STDOUT_FILENO);
	if (saved_stdout < 0 || dup2(capture_fds[1], STDOUT_FILENO) < 0)
		goto cleanup;
	if (close(capture_fds[1]) != 0)
		goto cleanup;
	capture_fds[1] = -1;

	sent = oliphaunt_wasix_send(1, sent_bytes, sent_len, 0);
	if (dup2(saved_stdout, STDOUT_FILENO) < 0)
		goto cleanup;
	if (close(saved_stdout) != 0)
		goto cleanup;
	saved_stdout = -1;

	while (actual_len < expected_len)
	{
		ssize_t count = read(capture_fds[0], actual + actual_len,
						 expected_len - actual_len);
		if (count <= 0)
			goto cleanup;
		actual_len += (size_t) count;
	}
	unsigned char trailing;
	ssize_t trailing_len = read(capture_fds[0], &trailing, 1);
	result = sent == (ssize_t) sent_len &&
		actual_len == expected_len &&
		trailing_len == 0 &&
		memcmp(actual, expected, expected_len) == 0 ? 0 : 1;

cleanup:
	if (saved_stdout >= 0)
	{
		(void) dup2(saved_stdout, STDOUT_FILENO);
		(void) close(saved_stdout);
	}
	if (capture_fds[0] >= 0)
		(void) close(capture_fds[0]);
	if (capture_fds[1] >= 0)
		(void) close(capture_fds[1]);
	return result;
}

static int
check_send_rejected_without_stdout(const void *sent_bytes, size_t sent_len,
								   int expected_errno)
{
	int capture_fds[2] = {-1, -1};
	int saved_stdout = -1;
	ssize_t sent = -1;
	int send_errno = 0;
	unsigned char unexpected;
	ssize_t captured_len = -1;
	int result = 1;

	if (pipe(capture_fds) != 0)
		goto cleanup;
	saved_stdout = dup(STDOUT_FILENO);
	if (saved_stdout < 0 || dup2(capture_fds[1], STDOUT_FILENO) < 0)
		goto cleanup;
	if (close(capture_fds[1]) != 0)
		goto cleanup;
	capture_fds[1] = -1;

	errno = 0;
	sent = oliphaunt_wasix_send(1, sent_bytes, sent_len, 0);
	send_errno = errno;
	if (dup2(saved_stdout, STDOUT_FILENO) < 0)
		goto cleanup;
	if (close(saved_stdout) != 0)
		goto cleanup;
	saved_stdout = -1;
	captured_len = read(capture_fds[0], &unexpected, 1);
	result = sent == -1 && send_errno == expected_errno && captured_len == 0 ? 0 : 1;

cleanup:
	if (saved_stdout >= 0)
	{
		(void) dup2(saved_stdout, STDOUT_FILENO);
		(void) close(saved_stdout);
	}
	if (capture_fds[0] >= 0)
		(void) close(capture_fds[0]);
	if (capture_fds[1] >= 0)
		(void) close(capture_fds[1]);
	return result;
}

static int
check_stream_write_failure_is_sticky(int mode)
{
	int saved_stdout = -1;
	ssize_t failed_send = -1;
	int failed_errno = 0;

	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(mode) >= 0);
	saved_stdout = dup(STDOUT_FILENO);
	CHECK(saved_stdout >= 0);
	CHECK(close(STDOUT_FILENO) == 0);
	errno = 0;
	failed_send = oliphaunt_wasix_send(1, "x", 1, 0);
	failed_errno = errno;
	CHECK(dup2(saved_stdout, STDOUT_FILENO) == STDOUT_FILENO);
	CHECK(close(saved_stdout) == 0);

	CHECK(failed_send == -1);
	CHECK(failed_errno == EBADF);
	CHECK(oliphaunt_wasix_output_status() == EBADF);
	CHECK(check_send_rejected_without_stdout("y", 1, EBADF) == 0);
	CHECK(oliphaunt_wasix_output_status() == EBADF);

	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_output_status() == 0);
	CHECK(check_send_reaches_stdout("z", 1, "z", 1) == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED) == mode);
	return 0;
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
	CHECK(oliphaunt_wasix_output_status() == 0);
	CHECK(oliphaunt_wasix_recv(1, buf, sizeof(buf), 0) == 0);
	void *input_buffer = oliphaunt_wasix_input_reserve(sizeof(input) - 1);
	CHECK(input_buffer != NULL);
	memcpy(input_buffer, input, sizeof(input) - 1);
	CHECK(oliphaunt_wasix_input_commit(sizeof(input) - 1) == (int) (sizeof(input) - 1));
	CHECK(oliphaunt_wasix_input_available() == sizeof(input) - 1);
	CHECK(oliphaunt_wasix_recv(1, buf, 2, 0) == 2);
	CHECK(memcmp(buf, "ab", 2) == 0);
	CHECK(oliphaunt_wasix_input_available() == 1);
	CHECK(oliphaunt_wasix_recv(1, buf, 1, 0) == 1);
	CHECK(oliphaunt_wasix_input_reset() == 0);
	void *reused_input_buffer = oliphaunt_wasix_input_reserve(sizeof(input) - 1);
	CHECK(reused_input_buffer == input_buffer);
	memcpy(reused_input_buffer, input, sizeof(input) - 1);
	CHECK(oliphaunt_wasix_input_commit(sizeof(input) - 1) == (int) (sizeof(input) - 1));
	CHECK(oliphaunt_wasix_input_reset() == 0);

	CHECK(oliphaunt_wasix_send(1, output, sizeof(output) - 1, 0) == (ssize_t) (sizeof(output) - 1));
	CHECK(oliphaunt_wasix_output_len() == sizeof(output) - 1);
	const void *output_buffer = oliphaunt_wasix_output_data();
	memset(buf, 0, sizeof(buf));
	memcpy(buf, output_buffer, oliphaunt_wasix_output_len());
	CHECK(memcmp(buf, output, sizeof(output) - 1) == 0);
	CHECK(oliphaunt_wasix_output_contains_error() == 0);

	CHECK(oliphaunt_wasix_output_reset() == 0);
	const unsigned char error_header[] = {'E', 0, 0, 0, 4};
	CHECK(oliphaunt_wasix_send(1, error_header, 2, 0) == 2);
	CHECK(oliphaunt_wasix_output_contains_error() == 0);
	CHECK(oliphaunt_wasix_send(1, error_header + 2, sizeof(error_header) - 2, 0) ==
		  (ssize_t) (sizeof(error_header) - 2));
	CHECK(oliphaunt_wasix_output_data() == output_buffer);
	CHECK(oliphaunt_wasix_output_contains_error() == 1);
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_output_contains_error() == 0);
	errno = 0;
	CHECK(oliphaunt_wasix_input_reserve((size_t) INT_MAX + 1) == NULL);
	CHECK(errno == EOVERFLOW);
	errno = 0;
	CHECK(oliphaunt_wasix_send(1, output, (size_t) INT_MAX + 1, 0) == -1);
	CHECK(errno == EFBIG);
	CHECK(oliphaunt_wasix_output_len() == 0);
	CHECK(oliphaunt_wasix_output_status() == EFBIG);
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_output_status() == 0);

	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED) == OLIPHAUNT_WASIX_PROTOCOL_BUFFERED);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_STREAM) == OLIPHAUNT_WASIX_PROTOCOL_BUFFERED);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 1);
	CHECK(check_send_reaches_stdout(output, sizeof(output) - 1,
								 output, sizeof(output) - 1) == 0);
	CHECK(oliphaunt_wasix_output_len() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED) == OLIPHAUNT_WASIX_PROTOCOL_STREAM);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);

	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_HYBRID) == OLIPHAUNT_WASIX_PROTOCOL_BUFFERED);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);
	CHECK(oliphaunt_wasix_protocol_copy_state() == OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE);
	CHECK(oliphaunt_wasix_send(1, "a", 1, 0) == 1);
	CHECK(oliphaunt_wasix_output_len() == 1);
	oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_IN);
	CHECK(oliphaunt_wasix_protocol_copy_state() == OLIPHAUNT_WASIX_PROTOCOL_COPY_IN);
	const char hybrid_transition_output[] = "axyz";
	CHECK(check_send_reaches_stdout(output, sizeof(output) - 1,
								 hybrid_transition_output,
								 sizeof(hybrid_transition_output) - 1) == 0);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 1);
	CHECK(oliphaunt_wasix_output_len() == 0);
	CHECK(check_send_reaches_stdout(output, sizeof(output) - 1,
								 output, sizeof(output) - 1) == 0);
	CHECK(oliphaunt_wasix_output_len() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED) == OLIPHAUNT_WASIX_PROTOCOL_HYBRID);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);
	CHECK(oliphaunt_wasix_protocol_copy_state() == OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_HYBRID) == OLIPHAUNT_WASIX_PROTOCOL_BUFFERED);
	oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE);
	CHECK(oliphaunt_wasix_protocol_copy_state() == OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED) == OLIPHAUNT_WASIX_PROTOCOL_HYBRID);

	/* A failed hybrid buffer-to-stdio transition is sticky and preserves bytes. */
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_HYBRID) == OLIPHAUNT_WASIX_PROTOCOL_BUFFERED);
	CHECK(oliphaunt_wasix_send(1, "a", 1, 0) == 1);
	oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_IN);
	int saved_stdout = dup(STDOUT_FILENO);
	CHECK(saved_stdout >= 0);
	CHECK(close(STDOUT_FILENO) == 0);
	errno = 0;
	ssize_t hybrid_failed_send = oliphaunt_wasix_send(1, "b", 1, 0);
	int hybrid_failure_errno = errno;
	int restore_stdout_result = dup2(saved_stdout, STDOUT_FILENO);
	int close_saved_stdout_result = close(saved_stdout);
	CHECK(restore_stdout_result == STDOUT_FILENO);
	CHECK(close_saved_stdout_result == 0);
	CHECK(hybrid_failed_send == -1);
	CHECK(hybrid_failure_errno == EBADF);
	CHECK(oliphaunt_wasix_output_status() == EBADF);
	CHECK(oliphaunt_wasix_output_len() == 2);
	CHECK(memcmp(oliphaunt_wasix_output_data(), "ab", 2) == 0);
	errno = 0;
	CHECK(oliphaunt_wasix_send(1, "c", 1, 0) == -1);
	CHECK(errno == EBADF);
	CHECK(oliphaunt_wasix_output_len() == 2);
	CHECK(memcmp(oliphaunt_wasix_output_data(), "ab", 2) == 0);
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_output_status() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED) == OLIPHAUNT_WASIX_PROTOCOL_HYBRID);

	/* Mode 3 keeps request input buffered while streaming every response byte. */
	CHECK(oliphaunt_wasix_input_reset() == 0);
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT) ==
		  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);
	input_buffer = oliphaunt_wasix_input_reserve(1);
	CHECK(input_buffer != NULL);
	memcpy(input_buffer, "q", 1);
	CHECK(oliphaunt_wasix_input_commit(1) == 1);
	struct pollfd mode3_poll = {
		.fd = 1,
		.events = POLLIN | POLLOUT,
		.revents = 0,
	};
	CHECK(oliphaunt_wasix_poll(&mode3_poll, 1, 0) == 1);
	CHECK((mode3_poll.revents & POLLIN) != 0);
	CHECK((mode3_poll.revents & POLLOUT) != 0);
	memset(buf, 0, sizeof(buf));
	CHECK(oliphaunt_wasix_recv(1, buf, 1, 0) == 1);
	CHECK(buf[0] == 'q');
	CHECK(check_send_reaches_stdout(output, sizeof(output) - 1,
								 output, sizeof(output) - 1) == 0);
	CHECK(oliphaunt_wasix_output_len() == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED) ==
		  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 0);
	CHECK(check_stream_write_failure_is_sticky(
			  OLIPHAUNT_WASIX_PROTOCOL_STREAM) == 0);
	CHECK(check_stream_write_failure_is_sticky(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT) == 0);

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
	CHECK(oliphaunt_wasix_fcntl(1, F_GETFL) == O_NONBLOCK);
	CHECK(oliphaunt_wasix_fcntl(1, F_SETFL, 0) == 0);
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
	input_buffer = oliphaunt_wasix_input_reserve(1);
	CHECK(input_buffer != NULL);
	memcpy(input_buffer, "q", 1);
	CHECK(oliphaunt_wasix_input_commit(1) == 1);
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
check_startup_outcome(void)
{
	const unsigned char notice_then_error[] = {
		'N', 0, 0, 0, 5, 0,
		'E', 0, 0, 0, 12, 'C', '3', 'D', '0', '0', '0', 0, 0,
	};
	const unsigned char ready[] = {'Z', 0, 0, 0, 5, 'I'};
	const unsigned char malformed_error[] = {'E', 0, 0, 0, 5, 0};
	const unsigned char incomplete_error[] = {
		'E', 0, 0, 0, 12, 'C', '3', 'D', '0', '0', '0', 0,
	};
	const unsigned char complete_error_with_incomplete_tail[] = {
		'E', 0, 0, 0, 12, 'C', '3', 'D', '0', '0', '0', 0, 0,
		'N', 0, 0, 0, 5,
	};

	const unsigned char *descriptor = oliphaunt_wasix_startup_outcome_v1();
	CHECK(descriptor != NULL);
	CHECK(oliphaunt_wasix_startup_outcome_v1() == descriptor);
	oliphaunt_wasix_startup_outcome_reset();
	CHECK(load_le32(descriptor + 0) == 1);
	CHECK(load_le32(descriptor + 4) == 32);
	CHECK(load_le32(descriptor + 8) == 0);
	CHECK(load_le32(descriptor + 12) == 0);
	CHECK(load_le64(descriptor + 16) == 0);
	CHECK(load_le64(descriptor + 24) == 0);

	/* Publication is impossible outside the narrow InitPostgres capture. */
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_send(1, notice_then_error, sizeof(notice_then_error), 0) ==
		  (ssize_t) sizeof(notice_then_error));
	errno = 0;
	CHECK(oliphaunt_wasix_startup_outcome_publish_rejected() == -1);
	CHECK(errno == EPERM);
	CHECK(load_le32(descriptor + 8) == 0);

	oliphaunt_wasix_startup_error_capture_active = 1;
	CHECK(oliphaunt_wasix_output_reset() == 0);
	errno = 0;
	CHECK(oliphaunt_wasix_startup_outcome_publish_rejected() == -1);
	CHECK(errno == EPROTO);

	CHECK(oliphaunt_wasix_send(1, ready, sizeof(ready), 0) == (ssize_t) sizeof(ready));
	errno = 0;
	CHECK(oliphaunt_wasix_startup_outcome_publish_rejected() == -1);
	CHECK(errno == EPROTO);

	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_send(1, malformed_error, sizeof(malformed_error), 0) ==
		  (ssize_t) sizeof(malformed_error));
	errno = 0;
	CHECK(oliphaunt_wasix_startup_outcome_publish_rejected() == -1);
	CHECK(errno == EPROTO);

	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_send(1, incomplete_error, sizeof(incomplete_error), 0) ==
		  (ssize_t) sizeof(incomplete_error));
	errno = 0;
	CHECK(oliphaunt_wasix_startup_outcome_publish_rejected() == -1);
	CHECK(errno == EPROTO);

	/* A complete ErrorResponse is insufficient when trailing output is partial. */
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_send(1,
							 complete_error_with_incomplete_tail,
							 sizeof(complete_error_with_incomplete_tail),
							 0) == (ssize_t) sizeof(complete_error_with_incomplete_tail));
	errno = 0;
	CHECK(oliphaunt_wasix_startup_outcome_publish_rejected() == -1);
	CHECK(errno == EPROTO);

	/* Complete preceding frames are retained with the ErrorResponse. */
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_send(1, notice_then_error, sizeof(notice_then_error), 0) ==
		  (ssize_t) sizeof(notice_then_error));
	const void *bridge_output = oliphaunt_wasix_output_data();
	CHECK(oliphaunt_wasix_startup_outcome_publish_rejected() == 0);
	CHECK(load_le32(descriptor + 0) == 1);
	CHECK(load_le32(descriptor + 4) == 32);
	CHECK(load_le32(descriptor + 8) == 1);
	CHECK(load_le32(descriptor + 12) == 0);
	CHECK(load_le64(descriptor + 24) == sizeof(notice_then_error));
	const unsigned char *owned_protocol =
		(const unsigned char *) (uintptr_t) load_le64(descriptor + 16);
	CHECK(owned_protocol != NULL);
	CHECK(owned_protocol != bridge_output);
	CHECK(memcmp(owned_protocol, notice_then_error, sizeof(notice_then_error)) == 0);

	/* Later bridge output mutations cannot invalidate the published snapshot. */
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_send(1, ready, sizeof(ready), 0) == (ssize_t) sizeof(ready));
	CHECK(memcmp(owned_protocol, notice_then_error, sizeof(notice_then_error)) == 0);
	errno = 0;
	CHECK(oliphaunt_wasix_startup_outcome_publish_rejected() == -1);
	CHECK(errno == EALREADY);

	oliphaunt_wasix_startup_outcome_reset();
	CHECK(oliphaunt_wasix_startup_outcome_v1() == descriptor);
	CHECK(load_le32(descriptor + 8) == 0);
	CHECK(load_le64(descriptor + 16) == 0);
	CHECK(load_le64(descriptor + 24) == 0);

	/* A corrupt or unexpectedly huge startup error cannot force a giant snapshot. */
	const size_t oversized_len = (1024U * 1024U) + 1U;
	if ((size_t) OLIPHAUNT_WASIX_BUFFERED_PROTOCOL_OUTPUT_LIMIT >= oversized_len)
	{
		unsigned char *oversized = malloc(oversized_len);
		CHECK(oversized != NULL);
		memset(oversized, 'x', oversized_len);
		oversized[0] = 'E';
		const uint32_t oversized_body_len = (uint32_t) (oversized_len - 1);
		oversized[1] = (unsigned char) (oversized_body_len >> 24);
		oversized[2] = (unsigned char) (oversized_body_len >> 16);
		oversized[3] = (unsigned char) (oversized_body_len >> 8);
		oversized[4] = (unsigned char) oversized_body_len;
		oversized[5] = 'C';
		memcpy(oversized + 6, "3D000", 5);
		oversized[11] = 0;
		oversized[12] = 'M';
		oversized[oversized_len - 2] = 0;
		oversized[oversized_len - 1] = 0;
		CHECK(oliphaunt_wasix_output_reset() == 0);
		CHECK(oliphaunt_wasix_send(1, oversized, oversized_len, 0) ==
			  (ssize_t) oversized_len);
		errno = 0;
		CHECK(oliphaunt_wasix_startup_outcome_publish_rejected() == -1);
		CHECK(errno == EOVERFLOW);
		CHECK(load_le32(descriptor + 8) == 0);
		free(oversized);
	}

	oliphaunt_wasix_startup_error_capture_active = 0;
	CHECK(oliphaunt_wasix_output_reset() == 0);
	return 0;
}

static int
check_buffered_protocol_output_limit(void)
{
	const size_t limit =
		(size_t) OLIPHAUNT_WASIX_BUFFERED_PROTOCOL_OUTPUT_LIMIT;
	unsigned char chunk[4096];
	size_t written = 0;

	memset(chunk, 'x', sizeof(chunk));
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED) == OLIPHAUNT_WASIX_PROTOCOL_BUFFERED);
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_output_status() == 0);
	errno = 0;
	CHECK(oliphaunt_wasix_send(1, NULL, 1, 0) == -1);
	CHECK(errno == EINVAL);
	CHECK(oliphaunt_wasix_output_status() == EINVAL);
	CHECK(oliphaunt_wasix_output_len() == 0);
	errno = 0;
	CHECK(oliphaunt_wasix_send(1, "x", 1, 0) == -1);
	CHECK(errno == EINVAL);
	CHECK(oliphaunt_wasix_output_len() == 0);
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_output_status() == 0);
	CHECK(oliphaunt_wasix_send(1, "x", 1, 0) == 1);
	const unsigned char *single_byte_output = oliphaunt_wasix_output_data();
	errno = 0;
	CHECK(oliphaunt_wasix_send(1, "y", SIZE_MAX, 0) == -1);
	CHECK(errno == EFBIG);
	CHECK(oliphaunt_wasix_output_status() == EFBIG);
	CHECK(oliphaunt_wasix_output_len() == 1);
	CHECK(oliphaunt_wasix_output_data() == single_byte_output);
	CHECK(single_byte_output[0] == 'x');
	errno = 0;
	CHECK(oliphaunt_wasix_send(1, NULL, 1, 0) == -1);
	CHECK(errno == EFBIG);
	CHECK(oliphaunt_wasix_output_len() == 1);
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_output_status() == 0);

	while (written < limit)
	{
		size_t remaining = limit - written;
		size_t count = remaining < sizeof(chunk) ? remaining : sizeof(chunk);
		CHECK(oliphaunt_wasix_send(1, chunk, count, 0) == (ssize_t) count);
		written += count;
	}
	CHECK(oliphaunt_wasix_output_len() == limit);
	const unsigned char *output = oliphaunt_wasix_output_data();
	CHECK(output != NULL);
	CHECK(output[0] == 'x');
	CHECK(output[limit - 1] == 'x');

	errno = 0;
	CHECK(oliphaunt_wasix_send(1, "y", 1, 0) == -1);
	CHECK(errno == EFBIG);
	CHECK(oliphaunt_wasix_output_status() == EFBIG);
	CHECK(oliphaunt_wasix_output_len() == limit);
	CHECK(oliphaunt_wasix_output_data() == output);
	CHECK(output[0] == 'x');
	CHECK(output[limit - 1] == 'x');

	/* Sticky failure is terminal across modes; a reset restores true mode-3 streaming. */
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT) ==
		  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED);
	CHECK(check_send_rejected_without_stdout("z", 1, EFBIG) == 0);
	CHECK(oliphaunt_wasix_output_status() == EFBIG);
	CHECK(oliphaunt_wasix_output_len() == limit);
	CHECK(oliphaunt_wasix_output_reset() == 0);
	CHECK(oliphaunt_wasix_output_status() == 0);
	CHECK(check_send_reaches_stdout("z", 1, "z", 1) == 0);
	CHECK(oliphaunt_wasix_set_protocol_transport(
			  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED) ==
		  OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT);
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

static int
check_direct_tool_transport(void)
{
	char protocol_path[] = "/tmp/oliphaunt-pgwire-XXXXXX";
	int protocol_file = mkstemp(protocol_path);
	CHECK(protocol_file >= 0);
	CHECK(close(protocol_file) == 0);
	struct sockaddr_in target;
	memset(&target, 0, sizeof(target));
	target.sin_family = AF_INET;
	target.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	target.sin_port = htons(65432);
	CHECK(setenv("OLIPHAUNT_DIRECT_PGWIRE", protocol_path, 1) == 0);
	int direct_fd = oliphaunt_wasix_socket(AF_INET, SOCK_STREAM, 0);
	CHECK(direct_fd >= 0);
	CHECK(oliphaunt_wasix_fcntl(direct_fd, F_GETFL) == 0);
	CHECK(oliphaunt_wasix_connect(direct_fd, (const struct sockaddr *) &target, sizeof(target)) == 0);
	CHECK(unsetenv("OLIPHAUNT_DIRECT_PGWIRE") == 0);
	CHECK(oliphaunt_wasix_protocol_stream_active() == 1);
	CHECK(oliphaunt_wasix_fcntl(direct_fd, F_SETFL, O_NONBLOCK) == 0);
	CHECK(oliphaunt_wasix_fcntl(direct_fd, F_GETFL) == O_NONBLOCK);
	int opt = 0;
	socklen_t optlen = sizeof(opt);
	CHECK(oliphaunt_wasix_getsockopt(direct_fd, SOL_SOCKET, SO_TYPE, &opt, &optlen) == 0);
	CHECK(opt == SOCK_STREAM);
	struct pollfd socket_poll = {.fd = direct_fd, .events = POLLOUT, .revents = 0};
	CHECK(oliphaunt_wasix_poll(&socket_poll, 1, 0) == 1);
	CHECK(socket_poll.revents == POLLOUT);
	struct pollfd read_probe = {.fd = direct_fd, .events = POLLIN, .revents = 0};
	CHECK(oliphaunt_wasix_poll(&read_probe, 1, 0) == 0);
	CHECK(read_probe.revents == 0);
	struct pollfd blocking_read = {.fd = direct_fd, .events = POLLIN, .revents = 0};
	CHECK(oliphaunt_wasix_poll(&blocking_read, 1, -1) == 1);
	CHECK(blocking_read.revents == POLLIN);
	CHECK(close(direct_fd) == 0);
	CHECK(unlink(protocol_path) == 0);
	return 0;
}

int
main(void)
{
	CHECK(check_locale_pipe() == 0);
	CHECK(check_identity_and_fail_closed_calls() == 0);
	CHECK(check_protocol_socket() == 0);
	CHECK(check_buffered_protocol_output_limit() == 0);
	CHECK(check_startup_outcome() == 0);
	CHECK(check_memory_and_shared_memory() == 0);
	CHECK(check_direct_tool_transport() == 0);
	return 0;
}
