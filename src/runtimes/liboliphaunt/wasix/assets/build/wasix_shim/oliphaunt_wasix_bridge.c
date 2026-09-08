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
#include <limits.h>
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

#include "oliphaunt_wasix_protocol_contract.generated.h"

#ifndef EMSCRIPTEN_KEEPALIVE
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
#endif

#define OLIPHAUNT_UID 123
#define OLIPHAUNT_PROTOCOL_FD 1
#define MAX_ATEXIT_FUNCS 32
#define OLIPHAUNT_WASIX_STARTUP_REJECTED_EXIT 98
#define OLIPHAUNT_WASIX_STARTUP_OUTCOME_MAX_PROTOCOL_BYTES (1024U * 1024U)
_Static_assert(OLIPHAUNT_WASIX_BUFFERED_PROTOCOL_OUTPUT_LIMIT > 0,
			   "buffered protocol output limit must be positive");
_Static_assert((size_t) OLIPHAUNT_WASIX_BUFFERED_PROTOCOL_OUTPUT_LIMIT <=
				   (size_t) SSIZE_MAX,
			   "buffered protocol output limit must fit in ssize_t");

enum
{
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_ABI_VERSION = 1,
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_BYTE_SIZE = 32,
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_PENDING = 0,
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_REJECTED = 1,
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_VERSION_OFFSET = 0,
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_SIZE_OFFSET = 4,
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_KIND_OFFSET = 8,
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_RESERVED_OFFSET = 12,
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_PROTOCOL_PTR_OFFSET = 16,
	OLIPHAUNT_WASIX_STARTUP_OUTCOME_PROTOCOL_LEN_OFFSET = 24,
};

_Static_assert(CHAR_BIT == 8, "startup outcome ABI requires 8-bit bytes");
_Static_assert(sizeof(uintptr_t) <= sizeof(uint64_t),
			   "startup outcome ABI cannot encode this pointer width");
_Static_assert(sizeof(size_t) <= sizeof(uint64_t),
			   "startup outcome ABI cannot encode this length width");

volatile int is_oliphaunt_active = 0;
volatile int oliphaunt_wasix_startup_error_capture_active = 0;
sigjmp_buf postgresmain_sigjmp_buf;
volatile bool ignore_till_sync = false;
volatile bool send_ready_for_query = false;

extern int pg_char_to_encoding_private(const char *name);
extern const char *pg_encoding_to_char_private(int encoding);

/*
 * Oliphaunt's libpq sources intentionally use private encoding symbols in the
 * embedded backend build so libpq does not leak a second copy of the encoding
 * table into the main module. The standalone WASIX frontend tools link the
 * same static libpq archive, whose connection path still expects libpq's
 * public aliases. Provide only those aliases here so the tools can use the
 * normal static libpgcommon archive without also pulling in
 * libpgcommon_shlib.
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

static unsigned char *oliphaunt_wasix_input_buf;
static size_t oliphaunt_wasix_input_len;
static size_t oliphaunt_wasix_input_off;
static size_t oliphaunt_wasix_input_cap;
static size_t oliphaunt_wasix_input_reserved;

static unsigned char *oliphaunt_wasix_output_buf;
static size_t oliphaunt_wasix_output_len_value;
static size_t oliphaunt_wasix_output_cap;
static size_t oliphaunt_wasix_output_scan_off;
static bool oliphaunt_wasix_output_contains_error_value;
static int oliphaunt_wasix_output_failure_status;
/*
 * This descriptor is a wire ABI, not a native C struct: keeping its storage as
 * bytes makes the 32-byte little-endian layout independent of host alignment.
 * The address is stable for the lifetime of the module.  Rejected protocol
 * bytes live in a separate bridge-owned allocation and remain immutable until
 * the next startup attempt resets the descriptor.
 */
static volatile unsigned char
	oliphaunt_wasix_startup_outcome_descriptor[OLIPHAUNT_WASIX_STARTUP_OUTCOME_BYTE_SIZE] = {
		1, 0, 0, 0,
		32, 0, 0, 0,
	};
static unsigned char *oliphaunt_wasix_startup_outcome_protocol;
static size_t oliphaunt_wasix_startup_outcome_protocol_len;
static size_t oliphaunt_wasix_startup_outcome_protocol_cap;
static int oliphaunt_wasix_protocol_transport;
static int oliphaunt_wasix_protocol_fd = OLIPHAUNT_PROTOCOL_FD;
static int oliphaunt_wasix_protocol_status_flags;
static bool oliphaunt_wasix_direct_tool_active;
static bool oliphaunt_wasix_direct_tool_read_permitted;
static int oliphaunt_wasix_protocol_copy_state_value;
static bool oliphaunt_wasix_protocol_stream_requested;
static bool oliphaunt_wasix_protocol_stream_active_value;
static void (*atexit_funcs[MAX_ATEXIT_FUNCS])(void);
static int atexit_func_count;

int oliphaunt_wasix_socket(int domain, int type, int protocol);
ssize_t oliphaunt_wasix_recv(int fd, void *buf, size_t n, int flags);
ssize_t oliphaunt_wasix_send(int fd, const void *buf, size_t n, int flags);

static void
oliphaunt_wasix_startup_outcome_store_u32(size_t offset, uint32_t value)
{
	for (size_t i = 0; i < sizeof(value); i++)
		oliphaunt_wasix_startup_outcome_descriptor[offset + i] =
			(unsigned char) (value >> (i * CHAR_BIT));
}

static void
oliphaunt_wasix_startup_outcome_store_u64(size_t offset, uint64_t value)
{
	for (size_t i = 0; i < sizeof(value); i++)
		oliphaunt_wasix_startup_outcome_descriptor[offset + i] =
			(unsigned char) (value >> (i * CHAR_BIT));
}

static uint32_t
oliphaunt_wasix_startup_outcome_load_u32(size_t offset)
{
	uint32_t value = 0;
	for (size_t i = 0; i < sizeof(value); i++)
		value |= (uint32_t) oliphaunt_wasix_startup_outcome_descriptor[offset + i]
			<< (i * CHAR_BIT);
	return value;
}

static uint64_t
oliphaunt_wasix_startup_outcome_load_u64(size_t offset)
{
	uint64_t value = 0;
	for (size_t i = 0; i < sizeof(value); i++)
		value |= (uint64_t) oliphaunt_wasix_startup_outcome_descriptor[offset + i]
			<< (i * CHAR_BIT);
	return value;
}

const void *EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_startup_outcome_v1(void)
{
	return (const void *) (uintptr_t) oliphaunt_wasix_startup_outcome_descriptor;
}

void
oliphaunt_wasix_startup_outcome_reset(void)
{
	/* Invalidate a prior result before clearing or replacing its payload. */
	oliphaunt_wasix_startup_outcome_store_u32(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_KIND_OFFSET,
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_PENDING);
	oliphaunt_wasix_startup_outcome_store_u32(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_VERSION_OFFSET,
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_ABI_VERSION);
	oliphaunt_wasix_startup_outcome_store_u32(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_SIZE_OFFSET,
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_BYTE_SIZE);
	oliphaunt_wasix_startup_outcome_store_u32(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_RESERVED_OFFSET, 0);
	oliphaunt_wasix_startup_outcome_store_u64(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_PROTOCOL_PTR_OFFSET, 0);
	oliphaunt_wasix_startup_outcome_store_u64(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_PROTOCOL_LEN_OFFSET, 0);
	oliphaunt_wasix_startup_outcome_protocol_len = 0;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_set_protocol_transport(int mode)
{
	if (mode < OLIPHAUNT_WASIX_PROTOCOL_BUFFERED ||
		mode > OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT)
	{
		errno = EINVAL;
		return -1;
	}

	int previous = oliphaunt_wasix_protocol_transport;
	oliphaunt_wasix_protocol_transport = mode;
	oliphaunt_wasix_protocol_stream_active_value = mode == OLIPHAUNT_WASIX_PROTOCOL_STREAM;
	if (mode != OLIPHAUNT_WASIX_PROTOCOL_HYBRID)
	{
		oliphaunt_wasix_protocol_copy_state_value = OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE;
		oliphaunt_wasix_protocol_stream_requested = false;
	}
	return previous;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_protocol_stream_active(void)
{
	return oliphaunt_wasix_protocol_stream_active_value ? 1 : 0;
}

void EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_protocol_report_copy_response(int state)
{
	if (state < OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE ||
		state > OLIPHAUNT_WASIX_PROTOCOL_COPY_BOTH)
	{
		errno = EINVAL;
		return;
	}
	oliphaunt_wasix_protocol_copy_state_value = state;
	oliphaunt_wasix_protocol_stream_requested =
		oliphaunt_wasix_protocol_transport == OLIPHAUNT_WASIX_PROTOCOL_HYBRID &&
		state != OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_protocol_copy_state(void)
{
	return oliphaunt_wasix_protocol_copy_state_value;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_set_active(int new_value)
{
	int current = is_oliphaunt_active;
	is_oliphaunt_active = new_value;
	if (new_value == 0)
	{
		struct itimerval zero = {{0, 0}, {0, 0}};
		(void) setitimer(ITIMER_REAL, &zero, NULL);
	}
	return current;
}

void EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_longjmp(jmp_buf env, int val)
{
	/*
	 * PostgreSQL owns every nested and top-level error boundary.  With
	 * sigsetjmp expanded at each WebAssembly call site, the jump must remain
	 * inside the guest so PG_CATCH cleanup cannot be skipped by the host.
	 */
	longjmp(env, val);
}

void EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_siglongjmp(sigjmp_buf env, int val)
{
	oliphaunt_wasix_longjmp(env, val);
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_input_reset(void)
{
	oliphaunt_wasix_input_len = 0;
	oliphaunt_wasix_input_off = 0;
	oliphaunt_wasix_input_reserved = 0;
	return 0;
}

void *EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_input_reserve(size_t length)
{
	if (length == 0 || oliphaunt_wasix_input_reserved != 0)
	{
		errno = EINVAL;
		return NULL;
	}
	if (length > INT_MAX || oliphaunt_wasix_input_len > (size_t) INT_MAX - length)
	{
		errno = EOVERFLOW;
		return NULL;
	}

	if (oliphaunt_wasix_input_off == oliphaunt_wasix_input_len)
	{
		oliphaunt_wasix_input_len = 0;
		oliphaunt_wasix_input_off = 0;
	}

	if (length > SIZE_MAX - oliphaunt_wasix_input_len)
	{
		errno = EOVERFLOW;
		return NULL;
	}
	size_t new_len = oliphaunt_wasix_input_len + length;
	if (new_len > oliphaunt_wasix_input_cap)
	{
		size_t next_cap = oliphaunt_wasix_input_cap ? oliphaunt_wasix_input_cap : 8192;
		while (next_cap < new_len)
		{
			if (next_cap > SIZE_MAX / 2)
			{
				next_cap = new_len;
				break;
			}
			next_cap *= 2;
		}
		unsigned char *new_buf = realloc(oliphaunt_wasix_input_buf, next_cap);
		if (new_buf == NULL)
		{
			errno = ENOMEM;
			return NULL;
		}
		oliphaunt_wasix_input_buf = new_buf;
		oliphaunt_wasix_input_cap = next_cap;
	}

	oliphaunt_wasix_input_reserved = length;
	return oliphaunt_wasix_input_buf + oliphaunt_wasix_input_len;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_input_commit(size_t length)
{
	if (length == 0 || length != oliphaunt_wasix_input_reserved)
	{
		errno = EINVAL;
		return -1;
	}
	oliphaunt_wasix_input_len += length;
	oliphaunt_wasix_input_reserved = 0;
	return (int) length;
}

size_t EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_input_available(void)
{
	if (oliphaunt_wasix_input_off >= oliphaunt_wasix_input_len)
		return 0;
	return oliphaunt_wasix_input_len - oliphaunt_wasix_input_off;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_input_peek(void)
{
	if (oliphaunt_wasix_input_off >= oliphaunt_wasix_input_len)
		return -1;
	return (int) oliphaunt_wasix_input_buf[oliphaunt_wasix_input_off];
}

static ssize_t
oliphaunt_wasix_buffer_read(void *buffer, size_t max_length)
{
	if (buffer == NULL || max_length == 0)
		return 0;
	if (oliphaunt_wasix_input_off >= oliphaunt_wasix_input_len)
		return 0;

	size_t available = oliphaunt_wasix_input_len - oliphaunt_wasix_input_off;
	size_t to_copy = available < max_length ? available : max_length;
	memcpy(buffer, oliphaunt_wasix_input_buf + oliphaunt_wasix_input_off, to_copy);
	oliphaunt_wasix_input_off += to_copy;
	return (ssize_t) to_copy;
}

static int
oliphaunt_wasix_record_output_failure(int status)
{
	if (status <= 0)
		status = EIO;
	if (oliphaunt_wasix_output_failure_status == 0)
		oliphaunt_wasix_output_failure_status = status;
	errno = oliphaunt_wasix_output_failure_status;
	return -1;
}

static ssize_t
oliphaunt_wasix_stream_write(int fd, const void *buffer, size_t length)
{
	if (length == 0)
		return 0;
	if (buffer == NULL)
		return oliphaunt_wasix_record_output_failure(EINVAL);

	ssize_t written = write(fd, buffer, length);
	if (written < 0)
		return oliphaunt_wasix_record_output_failure(errno);
	if (written == 0)
		return oliphaunt_wasix_record_output_failure(EIO);
	return written;
}

int
oliphaunt_wasix_output_status(void)
{
	return oliphaunt_wasix_output_failure_status;
}

static int
oliphaunt_wasix_flush_output_to_stdio(void)
{
	size_t off = 0;
	while (off < oliphaunt_wasix_output_len_value)
	{
		ssize_t written = write(STDOUT_FILENO,
								oliphaunt_wasix_output_buf + off,
								oliphaunt_wasix_output_len_value - off);
		if (written < 0)
			return oliphaunt_wasix_record_output_failure(errno);
		if (written == 0)
			return oliphaunt_wasix_record_output_failure(EIO);
		off += (size_t) written;
	}
	oliphaunt_wasix_output_len_value = 0;
	return 0;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_output_reset(void)
{
	oliphaunt_wasix_output_len_value = 0;
	oliphaunt_wasix_output_scan_off = 0;
	oliphaunt_wasix_output_contains_error_value = false;
	oliphaunt_wasix_output_failure_status = 0;
	oliphaunt_wasix_protocol_copy_state_value = OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE;
	oliphaunt_wasix_protocol_stream_requested = false;
	return 0;
}

size_t EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_output_len(void)
{
	return oliphaunt_wasix_output_len_value;
}

const void *EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_output_data(void)
{
	return oliphaunt_wasix_output_buf;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_output_contains_error(void)
{
	return oliphaunt_wasix_output_contains_error_value ? 1 : 0;
}

static void
oliphaunt_wasix_scan_buffered_output(void)
{
	while (oliphaunt_wasix_output_scan_off + 5 <= oliphaunt_wasix_output_len_value)
	{
		const unsigned char *message =
			oliphaunt_wasix_output_buf + oliphaunt_wasix_output_scan_off;
		size_t body_len = ((size_t) message[1] << 24) |
			((size_t) message[2] << 16) |
			((size_t) message[3] << 8) |
			(size_t) message[4];
		if (body_len < 4 || body_len > SIZE_MAX - 1)
			return;
		size_t message_len = body_len + 1;
		if (message_len > oliphaunt_wasix_output_len_value - oliphaunt_wasix_output_scan_off)
			return;
		if (message[0] == 'E')
			oliphaunt_wasix_output_contains_error_value = true;
		oliphaunt_wasix_output_scan_off += message_len;
	}
}

static bool
oliphaunt_wasix_error_response_has_valid_sqlstate(const unsigned char *fields, size_t length)
{
	size_t offset = 0;
	bool contains_sqlstate = false;

	if (fields == NULL || length == 0 || fields[length - 1] != 0)
		return false;
	while (offset < length - 1)
	{
		unsigned char field_type = fields[offset++];
		const unsigned char *terminator;
		size_t value_len;

		if (field_type == 0)
			return false;
		terminator = memchr(fields + offset, 0, length - offset);
		if (terminator == NULL)
			return false;
		value_len = (size_t) (terminator - (fields + offset));
		if (field_type == 'C')
		{
			if (value_len != 5)
				return false;
			contains_sqlstate = true;
		}
		offset += value_len + 1;
	}
	return offset == length - 1 && contains_sqlstate;
}

static bool
oliphaunt_wasix_protocol_is_complete_with_error(const unsigned char *buffer, size_t length)
{
	size_t offset = 0;
	bool contains_error = false;

	if (buffer == NULL || length == 0)
		return false;
	while (offset + 5 <= length)
	{
		const unsigned char *message = buffer + offset;
		size_t body_len = ((size_t) message[1] << 24) |
			((size_t) message[2] << 16) |
			((size_t) message[3] << 8) |
			(size_t) message[4];
		if (body_len < 4 || body_len > SIZE_MAX - 1)
			return false;
		size_t message_len = body_len + 1;
		if (message_len > length - offset)
			return false;
		if (message[0] == 'E')
		{
			if (!oliphaunt_wasix_error_response_has_valid_sqlstate(
					message + 5, body_len - 4))
				return false;
			contains_error = true;
		}
		offset += message_len;
	}
	return offset == length && contains_error;
}

int
oliphaunt_wasix_startup_outcome_publish_rejected(void)
{
	if (!oliphaunt_wasix_startup_error_capture_active)
	{
		errno = EPERM;
		return -1;
	}
	if (oliphaunt_wasix_startup_outcome_load_u32(
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_VERSION_OFFSET) !=
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_ABI_VERSION ||
		oliphaunt_wasix_startup_outcome_load_u32(
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_SIZE_OFFSET) !=
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_BYTE_SIZE ||
		oliphaunt_wasix_startup_outcome_load_u32(
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_RESERVED_OFFSET) != 0)
	{
		errno = EPROTO;
		return -1;
	}
	if (oliphaunt_wasix_startup_outcome_load_u32(
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_KIND_OFFSET) !=
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_PENDING)
	{
		errno = EALREADY;
		return -1;
	}
	if (oliphaunt_wasix_output_len_value == 0 ||
		oliphaunt_wasix_output_scan_off != oliphaunt_wasix_output_len_value ||
		!oliphaunt_wasix_output_contains_error_value ||
		!oliphaunt_wasix_protocol_is_complete_with_error(
			oliphaunt_wasix_output_buf, oliphaunt_wasix_output_len_value))
	{
		errno = EPROTO;
		return -1;
	}
	if (oliphaunt_wasix_output_len_value >
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_MAX_PROTOCOL_BYTES)
	{
		errno = EOVERFLOW;
		return -1;
	}

	if (oliphaunt_wasix_output_len_value > oliphaunt_wasix_startup_outcome_protocol_cap)
	{
		unsigned char *protocol = realloc(oliphaunt_wasix_startup_outcome_protocol,
										  oliphaunt_wasix_output_len_value);
		if (protocol == NULL)
			return -1;
		oliphaunt_wasix_startup_outcome_protocol = protocol;
		oliphaunt_wasix_startup_outcome_protocol_cap = oliphaunt_wasix_output_len_value;
	}
	memcpy(oliphaunt_wasix_startup_outcome_protocol,
		   oliphaunt_wasix_output_buf,
		   oliphaunt_wasix_output_len_value);
	oliphaunt_wasix_startup_outcome_protocol_len = oliphaunt_wasix_output_len_value;

	/* Publish owned payload metadata before making the result observable. */
	oliphaunt_wasix_startup_outcome_store_u64(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_PROTOCOL_PTR_OFFSET,
		(uint64_t) (uintptr_t) oliphaunt_wasix_startup_outcome_protocol);
	oliphaunt_wasix_startup_outcome_store_u64(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_PROTOCOL_LEN_OFFSET,
		(uint64_t) oliphaunt_wasix_startup_outcome_protocol_len);
	__atomic_signal_fence(__ATOMIC_RELEASE);
	oliphaunt_wasix_startup_outcome_store_u32(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_KIND_OFFSET,
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_REJECTED);
	return 0;
}

static bool
oliphaunt_wasix_startup_outcome_is_valid_rejection(void)
{
	uint64_t protocol_ptr = oliphaunt_wasix_startup_outcome_load_u64(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_PROTOCOL_PTR_OFFSET);
	uint64_t protocol_len = oliphaunt_wasix_startup_outcome_load_u64(
		OLIPHAUNT_WASIX_STARTUP_OUTCOME_PROTOCOL_LEN_OFFSET);

	return oliphaunt_wasix_startup_outcome_load_u32(
			   OLIPHAUNT_WASIX_STARTUP_OUTCOME_VERSION_OFFSET) ==
			   OLIPHAUNT_WASIX_STARTUP_OUTCOME_ABI_VERSION &&
		oliphaunt_wasix_startup_outcome_load_u32(
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_SIZE_OFFSET) ==
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_BYTE_SIZE &&
		oliphaunt_wasix_startup_outcome_load_u32(
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_KIND_OFFSET) ==
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_REJECTED &&
		oliphaunt_wasix_startup_outcome_load_u32(
			OLIPHAUNT_WASIX_STARTUP_OUTCOME_RESERVED_OFFSET) == 0 &&
		protocol_ptr == (uint64_t) (uintptr_t) oliphaunt_wasix_startup_outcome_protocol &&
		protocol_len == (uint64_t) oliphaunt_wasix_startup_outcome_protocol_len &&
		oliphaunt_wasix_protocol_is_complete_with_error(
			oliphaunt_wasix_startup_outcome_protocol,
			oliphaunt_wasix_startup_outcome_protocol_len);
}

static ssize_t
oliphaunt_wasix_buffer_write(const void *buffer, size_t length)
{
	if (oliphaunt_wasix_output_failure_status != 0)
		return oliphaunt_wasix_record_output_failure(
			oliphaunt_wasix_output_failure_status);
	if (length == 0)
		return 0;
	if (buffer == NULL)
		return oliphaunt_wasix_record_output_failure(EINVAL);

	const size_t output_limit =
		(size_t) OLIPHAUNT_WASIX_BUFFERED_PROTOCOL_OUTPUT_LIMIT;
	if (oliphaunt_wasix_output_len_value > output_limit ||
		length > output_limit - oliphaunt_wasix_output_len_value)
		return oliphaunt_wasix_record_output_failure(EFBIG);

	size_t required = oliphaunt_wasix_output_len_value + length;
	if (required > oliphaunt_wasix_output_cap)
	{
		size_t next_cap = oliphaunt_wasix_output_cap ? oliphaunt_wasix_output_cap : 8192;
		if (next_cap > output_limit)
			next_cap = output_limit;
		while (next_cap < required)
		{
			if (next_cap > output_limit / 2)
			{
				next_cap = output_limit;
				break;
			}
			next_cap *= 2;
		}
		unsigned char *new_buf = realloc(oliphaunt_wasix_output_buf, next_cap);
		if (new_buf == NULL)
			return oliphaunt_wasix_record_output_failure(ENOMEM);
		oliphaunt_wasix_output_buf = new_buf;
		oliphaunt_wasix_output_cap = next_cap;
	}

	memcpy(oliphaunt_wasix_output_buf + oliphaunt_wasix_output_len_value, buffer, length);
	oliphaunt_wasix_output_len_value += length;
	oliphaunt_wasix_scan_buffered_output();
	if (oliphaunt_wasix_protocol_transport == OLIPHAUNT_WASIX_PROTOCOL_HYBRID &&
		oliphaunt_wasix_protocol_stream_requested)
	{
		if (oliphaunt_wasix_flush_output_to_stdio() != 0)
			return -1;
		oliphaunt_wasix_protocol_stream_active_value = true;
		oliphaunt_wasix_protocol_stream_requested = false;
	}
	return (ssize_t) length;
}

ssize_t
oliphaunt_wasix_host_read(void *context, void *buffer, size_t max_length)
{
	(void) context;
	return oliphaunt_wasix_recv(oliphaunt_wasix_protocol_fd, buffer, max_length, 0);
}

ssize_t
oliphaunt_wasix_host_write(void *context, const void *buffer, size_t length)
{
	(void) context;
	return oliphaunt_wasix_send(oliphaunt_wasix_protocol_fd, buffer, length, 0);
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_system(const char *command)
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
oliphaunt_wasix_locale_file_path(void)
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
oliphaunt_wasix_open_locale_pipe(const char *command, const char *mode)
{
	if (command == NULL || mode == NULL || strcmp(command, "locale -a") != 0 ||
		strcmp(mode, "r") != 0)
	{
		errno = ENOSYS;
		return NULL;
	}

	char *path = oliphaunt_wasix_locale_file_path();
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
oliphaunt_wasix_popen(const char *command, const char *mode)
{
	return oliphaunt_wasix_open_locale_pipe(command, mode);
}

__attribute__((weak)) int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_pclose(FILE *file)
{
	if (file == NULL)
	{
		errno = EINVAL;
		return -1;
	}
	return fclose(file);
}

uid_t EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_geteuid(void)
{
	return OLIPHAUNT_UID;
}

uid_t EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_getuid(void)
{
	return OLIPHAUNT_UID;
}

gid_t EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_getegid(void)
{
	return OLIPHAUNT_UID;
}

gid_t EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_getgid(void)
{
	return OLIPHAUNT_UID;
}

struct passwd *EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_getpwuid(uid_t uid)
{
	if (uid != OLIPHAUNT_UID)
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
oliphaunt_wasix_getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen,
			   struct passwd **result)
{
	const char *name = "postgres";
	const char *passwd = "x";
	const char *gecos = "Static User";
	const char *dir = "/home/postgres";
	const char *shell = "/bin/sh";
	char *cursor = buf;
	size_t remaining = buflen;

	if (pwd == NULL || buf == NULL || result == NULL)
	{
		errno = EINVAL;
		return EINVAL;
	}

	*result = NULL;
	if (uid != OLIPHAUNT_UID)
		return 0;

#define COPY_PASSWD_FIELD(field, value) \
	do { \
		size_t needed = strlen(value) + 1; \
		if (needed > remaining) \
		{ \
			errno = ERANGE; \
			return ERANGE; \
		} \
		memcpy(cursor, value, needed); \
		pwd->field = cursor; \
		cursor += needed; \
		remaining -= needed; \
	} while (0)

	COPY_PASSWD_FIELD(pw_name, name);
	COPY_PASSWD_FIELD(pw_passwd, passwd);
	COPY_PASSWD_FIELD(pw_gecos, gecos);
	COPY_PASSWD_FIELD(pw_dir, dir);
	COPY_PASSWD_FIELD(pw_shell, shell);

#undef COPY_PASSWD_FIELD

	pwd->pw_uid = uid;
	pwd->pw_gid = uid;
	*result = pwd;
	return 0;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_atexit(void (*function)(void))
{
	if (atexit_func_count >= MAX_ATEXIT_FUNCS)
		return -1;
	atexit_funcs[atexit_func_count++] = function;
	return 0;
}

void EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_run_atexit_funcs(void)
{
	for (int i = atexit_func_count - 1; i >= 0; i--)
	{
		if (atexit_funcs[i])
			atexit_funcs[i]();
	}
	atexit_func_count = 0;
}

static void
oliphaunt_wasix_clear_interval_timer(void)
{
	struct itimerval zero = {{0, 0}, {0, 0}};
	(void) setitimer(ITIMER_REAL, &zero, NULL);
}

void EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_exit(int status)
{
	oliphaunt_wasix_clear_interval_timer();
	optind = 1;
	if (oliphaunt_wasix_startup_error_capture_active && status != 0)
	{
		oliphaunt_wasix_startup_error_capture_active = 0;
		if (oliphaunt_wasix_startup_outcome_is_valid_rejection())
			exit(OLIPHAUNT_WASIX_STARTUP_REJECTED_EXIT);
		__builtin_trap();
	}
	exit(status);
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_munmap(void *addr, size_t length)
{
	if (addr == NULL || length == 0)
	{
		errno = EINVAL;
		return -1;
	}
	return munmap(addr, length);
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_fcntl(int fd, int cmd, ...)
{
	va_list args;
	long arg = 0;

	switch (cmd)
	{
#ifdef F_GETFL
		case F_GETFL:
			if (fd == oliphaunt_wasix_protocol_fd)
				return oliphaunt_wasix_protocol_status_flags;
			return fcntl(fd, cmd);
#endif
#ifdef F_GETFD
		case F_GETFD:
			if (fd == oliphaunt_wasix_protocol_fd)
				return 0;
			return fcntl(fd, cmd);
#endif
#ifdef F_SETFL
		case F_SETFL:
			va_start(args, cmd);
			arg = va_arg(args, long);
			va_end(args);
			if (fd == oliphaunt_wasix_protocol_fd)
			{
#ifdef O_NONBLOCK
				if ((arg & ~((long) O_NONBLOCK)) == 0)
				{
					oliphaunt_wasix_protocol_status_flags = (int) arg;
					return 0;
				}
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
			if (fd == oliphaunt_wasix_protocol_fd)
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
oliphaunt_wasix_write_int_sockopt(void *optval, socklen_t *optlen, int value)
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
oliphaunt_wasix_setsockopt(int fd, int level, int optname, const void *optval, socklen_t optlen)
{
	if (fd != oliphaunt_wasix_protocol_fd)
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
oliphaunt_wasix_getsockopt(int fd, int level, int optname, void *optval, socklen_t *optlen)
{
	if (fd != oliphaunt_wasix_protocol_fd)
		return getsockopt(fd, level, optname, optval, optlen);

	if (level == SOL_SOCKET)
	{
		switch (optname)
		{
#ifdef SO_ERROR
			case SO_ERROR:
				return oliphaunt_wasix_write_int_sockopt(optval, optlen, 0);
#endif
#ifdef SO_TYPE
			case SO_TYPE:
				return oliphaunt_wasix_write_int_sockopt(optval, optlen, SOCK_STREAM);
#endif
#ifdef SO_SNDBUF
			case SO_SNDBUF:
				return oliphaunt_wasix_write_int_sockopt(optval, optlen, 32768);
#endif
#ifdef SO_RCVBUF
			case SO_RCVBUF:
				return oliphaunt_wasix_write_int_sockopt(optval, optlen, 32768);
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
				return oliphaunt_wasix_write_int_sockopt(optval, optlen, 0);
			default:
				break;
		}
	}

	errno = ENOPROTOOPT;
	return -1;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_getsockname(int fd, struct sockaddr *addr, socklen_t *len)
{
	if (fd != oliphaunt_wasix_protocol_fd)
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
oliphaunt_wasix_recv(int fd, void *buf, size_t n, int flags)
{
	if (fd != oliphaunt_wasix_protocol_fd)
		return recv(fd, buf, n, flags);
	if (oliphaunt_wasix_protocol_transport == OLIPHAUNT_WASIX_PROTOCOL_STREAM ||
		oliphaunt_wasix_protocol_stream_active_value)
	{
		(void) flags;
		if (oliphaunt_wasix_direct_tool_active &&
			!oliphaunt_wasix_direct_tool_read_permitted)
		{
			errno = EAGAIN;
			return -1;
		}
		oliphaunt_wasix_direct_tool_read_permitted = false;
		return read(oliphaunt_wasix_direct_tool_active ? fd : STDIN_FILENO, buf, n);
	}
	return oliphaunt_wasix_buffer_read(buf, n);
}

ssize_t EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_send(int fd, const void *buf, size_t n, int flags)
{
	if (fd != oliphaunt_wasix_protocol_fd)
		return send(fd, buf, n, flags);
	if (oliphaunt_wasix_output_failure_status != 0)
		return oliphaunt_wasix_record_output_failure(
			oliphaunt_wasix_output_failure_status);
	if (oliphaunt_wasix_protocol_transport ==
		OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT)
	{
		(void) flags;
		return oliphaunt_wasix_stream_write(STDOUT_FILENO, buf, n);
	}
	if (oliphaunt_wasix_protocol_transport == OLIPHAUNT_WASIX_PROTOCOL_STREAM ||
		oliphaunt_wasix_protocol_stream_active_value)
	{
		(void) flags;
		return oliphaunt_wasix_stream_write(
			oliphaunt_wasix_direct_tool_active ? fd : STDOUT_FILENO, buf, n);
	}
	return oliphaunt_wasix_buffer_write(buf, n);
}

static const char *
oliphaunt_wasix_direct_tool_path(void)
{
	const char *value = getenv("OLIPHAUNT_DIRECT_PGWIRE");
	return value != NULL && value[0] != '\0' ? value : NULL;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_socket(int domain, int type, int protocol)
{
	const char *path = oliphaunt_wasix_direct_tool_path();
	if (path == NULL)
		return socket(domain, type, protocol);

	/*
	 * Direct tools use a private full-duplex virtual file. Claim the descriptor
	 * here, before libpq configures it with fcntl and socket options, while
	 * leaving the tool's standard streams available for normal PostgreSQL I/O.
	 */
	int fd = open(path, O_RDWR);
	if (fd < 0)
		return -1;

	oliphaunt_wasix_protocol_fd = fd;
	oliphaunt_wasix_protocol_status_flags = 0;
	oliphaunt_wasix_direct_tool_active = true;
	oliphaunt_wasix_direct_tool_read_permitted = false;
	return fd;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_connect(int socket, const struct sockaddr *address, socklen_t address_len)
{
	if (oliphaunt_wasix_direct_tool_path() != NULL)
	{
		oliphaunt_wasix_protocol_fd = socket;
		oliphaunt_wasix_protocol_status_flags = 0;
		oliphaunt_wasix_direct_tool_active = true;
		oliphaunt_wasix_direct_tool_read_permitted = false;
		oliphaunt_wasix_protocol_transport = OLIPHAUNT_WASIX_PROTOCOL_STREAM;
		oliphaunt_wasix_protocol_stream_active_value = true;
		return 0;
	}
	if (socket != oliphaunt_wasix_protocol_fd)
		return connect(socket, address, address_len);
	errno = ENOSYS;
	return -1;
}

int EMSCRIPTEN_KEEPALIVE
oliphaunt_wasix_poll(struct pollfd fds[], nfds_t nfds, int timeout)
{
	bool has_protocol_fd = false;
	int ready = 0;

	for (nfds_t i = 0; i < nfds; i++)
	{
		if (fds[i].fd == oliphaunt_wasix_protocol_fd)
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
		if (fds[i].fd != oliphaunt_wasix_protocol_fd)
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
		if (oliphaunt_wasix_protocol_transport == OLIPHAUNT_WASIX_PROTOCOL_STREAM ||
			oliphaunt_wasix_protocol_stream_active_value)
		{
			if (oliphaunt_wasix_direct_tool_active)
			{
				/*
				 * The synthetic socket writes to stdout immediately. The generic
				 * Wasmer stdio pipe does not reliably wake poll(2), so a blocking
				 * libpq read wait is made readable and the following recv(2) blocks
				 * on stdin itself. Zero-timeout readiness probes must remain false:
				 * claiming those are readable makes libpq perform an opportunistic
				 * recv with no protocol response pending and deadlocks the tool.
				 */
				fds[i].revents = fds[i].events & POLLOUT;
				if ((fds[i].events & POLLIN) && timeout != 0)
				{
					fds[i].revents |= POLLIN;
					oliphaunt_wasix_direct_tool_read_permitted = true;
				}
				if (fds[i].revents)
					ready++;
				continue;
			}
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
			oliphaunt_wasix_input_available() > 0)
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
oliphaunt_wasix_shmget(key_t key, size_t size, int shmflg)
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
oliphaunt_wasix_shmat(int shmid, const void *shmaddr, int shmflg)
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
oliphaunt_wasix_shmdt(const void *shmaddr)
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
oliphaunt_wasix_shmctl(int shmid, int cmd, struct shmid_ds *buf)
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
