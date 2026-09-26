#include "postgres.h"
#include "port.h"

#include <stdint.h>
#include <string.h>
#include <sys/time.h>

#include <uuid/uuid.h>

static void
oliphaunt_uuid_random_bytes(unsigned char *out, size_t len)
{
	if (!pg_strong_random(out, len))
		elog(ERROR, "could not generate UUID randomness");
}

void
uuid_generate_random(uuid_t out)
{
	oliphaunt_uuid_random_bytes(out, 16);
	out[6] = (unsigned char) ((out[6] & 0x0f) | 0x40);
	out[8] = (unsigned char) ((out[8] & 0x3f) | 0x80);
}

void
uuid_generate_time(uuid_t out)
{
	struct timeval tv;
	uint64_t	timestamp;
	uint16_t	clock_seq;
	unsigned char random_tail[8];

	if (gettimeofday(&tv, NULL) != 0)
		elog(ERROR, "could not read system time for UUID generation");

	timestamp = ((uint64_t) tv.tv_sec * UINT64CONST(10000000)) +
		((uint64_t) tv.tv_usec * UINT64CONST(10)) +
		UINT64CONST(0x01B21DD213814000);
	oliphaunt_uuid_random_bytes(random_tail, sizeof(random_tail));
	clock_seq = ((uint16_t) random_tail[0] << 8) | random_tail[1];
	clock_seq &= 0x3fff;

	out[0] = (unsigned char) (timestamp >> 24);
	out[1] = (unsigned char) (timestamp >> 16);
	out[2] = (unsigned char) (timestamp >> 8);
	out[3] = (unsigned char) timestamp;
	out[4] = (unsigned char) (timestamp >> 40);
	out[5] = (unsigned char) (timestamp >> 32);
	out[6] = (unsigned char) (((timestamp >> 56) & 0x0f) | 0x10);
	out[7] = (unsigned char) (timestamp >> 48);
	out[8] = (unsigned char) ((clock_seq >> 8) | 0x80);
	out[9] = (unsigned char) clock_seq;
	memcpy(out + 10, random_tail + 2, 6);
	out[10] |= 0x01;
}

void
uuid_unparse(const uuid_t uu, char *out)
{
	static const char hex[] = "0123456789abcdef";
	static const int positions[16] = {
		0, 2, 4, 6, 9, 11, 14, 16, 19, 21, 24, 26, 28, 30, 32, 34
	};
	static const int hyphens[4] = {8, 13, 18, 23};

	memset(out, '0', 36);
	for (int i = 0; i < 4; i++)
		out[hyphens[i]] = '-';
	for (int i = 0; i < 16; i++)
	{
		int			pos = positions[i];

		out[pos] = hex[uu[i] >> 4];
		out[pos + 1] = hex[uu[i] & 0x0f];
	}
	out[36] = '\0';
}
