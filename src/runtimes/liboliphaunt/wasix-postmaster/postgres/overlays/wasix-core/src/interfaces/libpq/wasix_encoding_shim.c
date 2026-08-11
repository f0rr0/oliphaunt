/*-------------------------------------------------------------------------
 *
 * wasix_encoding_shim.c
 *	  Static libpq encoding exports for the fresh WASIX core lane.
 *
 * PostgreSQL deliberately gives static libpgcommon.a private names for the
 * encoding helpers that libpq exports publicly.  A normal shared libpq link
 * gets the public symbols from libpgcommon_shlib.a.  The initial WASIX core
 * lane links libpq statically into frontend programs, so provide only the two
 * public libpq wrappers needed by those links instead of pulling in the whole
 * shlib common archive and duplicating unrelated symbols.
 *
 *-------------------------------------------------------------------------
 */

#define USE_PRIVATE_ENCODING_FUNCS

#include "postgres_fe.h"
#include "mb/pg_wchar.h"

#undef pg_char_to_encoding
#undef pg_encoding_to_char
#undef pg_valid_server_encoding_id

extern int pg_char_to_encoding(const char *name);
extern const char *pg_encoding_to_char(int encoding);
extern int pg_valid_server_encoding_id(int encoding);
extern int pg_char_to_encoding_private(const char *name);
extern const char *pg_encoding_to_char_private(int encoding);
extern int pg_valid_server_encoding_id_private(int encoding);

int
pg_char_to_encoding(const char *name)
{
	return pg_char_to_encoding_private(name);
}

const char *
pg_encoding_to_char(int encoding)
{
	return pg_encoding_to_char_private(encoding);
}

int
pg_valid_server_encoding_id(int encoding)
{
	return pg_valid_server_encoding_id_private(encoding);
}
