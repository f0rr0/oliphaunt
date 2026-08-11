#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUMMARIZER="$PROJECT_ROOT/bin/summarize-libpq-latency.sh"
PROBE_SOURCE="$PROJECT_ROOT/probes/libpq_latency_probe.c"
CC_BIN="${CC:-cc}"

command -v "$CC_BIN" >/dev/null 2>&1 || {
  printf 'missing C compiler for libpq latency probe warnings test: %s\n' "$CC_BIN" >&2
  exit 127
}

test_root="$(mktemp -d)"
cleanup() {
  rm -rf -- "$test_root"
}
trap cleanup EXIT HUP INT TERM

cat >"$test_root/libpq-fe.h" <<'HEADER'
#ifndef FAKE_LIBPQ_FE_H
#define FAKE_LIBPQ_FE_H

typedef struct pg_conn PGconn;
typedef struct pg_result PGresult;

typedef enum
{
  CONNECTION_OK,
  CONNECTION_BAD
} ConnStatusType;

typedef enum
{
  PGRES_EMPTY_QUERY,
  PGRES_COMMAND_OK,
  PGRES_TUPLES_OK
} ExecStatusType;

PGconn *PQconnectdb(const char *conninfo);
ConnStatusType PQstatus(const PGconn *connection);
void PQfinish(PGconn *connection);
PGresult *PQexec(PGconn *connection, const char *query);
ExecStatusType PQresultStatus(const PGresult *result);
int PQntuples(const PGresult *result);
int PQnfields(const PGresult *result);
int PQgetisnull(const PGresult *result, int row, int column);
char *PQgetvalue(const PGresult *result, int row, int column);
void PQclear(PGresult *result);

#endif
HEADER

cat >"$test_root/fake-libpq.c" <<'SOURCE'
#define _POSIX_C_SOURCE 200809L

#include <libpq-fe.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct pg_conn
{
  int connected;
};

struct pg_result
{
  int valid;
};

static void
fake_delay(void)
{
  struct timespec duration = {0, 100000L};

  (void) nanosleep(&duration, NULL);
}

PGconn *
PQconnectdb(const char *conninfo)
{
  PGconn *connection;

  (void) conninfo;
  fake_delay();
  connection = malloc(sizeof(*connection));
  if (connection != NULL)
    connection->connected = getenv("FAKE_LIBPQ_FAIL_CONNECT") == NULL;
  return connection;
}

ConnStatusType
PQstatus(const PGconn *connection)
{
  return connection != NULL && connection->connected ? CONNECTION_OK : CONNECTION_BAD;
}

void
PQfinish(PGconn *connection)
{
  fake_delay();
  free(connection);
}

PGresult *
PQexec(PGconn *connection, const char *query)
{
  PGresult *result;

  (void) connection;
  fake_delay();
  if (getenv("FAKE_LIBPQ_FAIL_QUERY") != NULL || strcmp(query, "SELECT 1") != 0)
    return NULL;
  result = malloc(sizeof(*result));
  if (result != NULL)
    result->valid = 1;
  return result;
}

ExecStatusType
PQresultStatus(const PGresult *result)
{
  return result != NULL && result->valid ? PGRES_TUPLES_OK : PGRES_EMPTY_QUERY;
}

int
PQntuples(const PGresult *result)
{
  return result != NULL && result->valid ? 1 : 0;
}

int
PQnfields(const PGresult *result)
{
  return result != NULL && result->valid ? 1 : 0;
}

int
PQgetisnull(const PGresult *result, int row, int column)
{
  return result == NULL || !result->valid || row != 0 || column != 0;
}

char *
PQgetvalue(const PGresult *result, int row, int column)
{
  static char value[] = "1";

  if (result == NULL || !result->valid || row != 0 || column != 0)
    return NULL;
  return value;
}

void
PQclear(PGresult *result)
{
  free(result);
}
SOURCE

"$CC_BIN" -std=c11 -O2 -Wall -Wextra -Werror -Wpedantic -Wconversion -Wshadow \
  -I"$test_root" "$PROBE_SOURCE" "$test_root/fake-libpq.c" \
  -o "$test_root/libpq-latency-probe"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}
printf 'fake exact libpq shared object\n' >"$test_root/libpq.so.5.18"
fake_libpq_path="$test_root/libpq.so.5.18"
fake_libpq_sha256="$(hash_file "$fake_libpq_path")"
fake_probe_sha256="$(hash_file "$test_root/libpq-latency-probe")"

for mode in persistent reconnect; do
  raw="$test_root/$mode.raw.tsv"
  summary="$test_root/$mode.summary.tsv"
  "$test_root/libpq-latency-probe" \
    --conninfo postgresql://fake/postgres \
    --mode "$mode" \
    --warmup 2 \
    --samples 5 \
    --output "$raw"
  "$SUMMARIZER" \
    --raw "$raw" \
    --output "$summary" \
    --target fake \
    --mode "$mode" \
    --warmup 2 \
    --samples 5 \
    --libpq-path "$fake_libpq_path" \
    --libpq-sha256 "$fake_libpq_sha256" \
    --probe-sha256 "$fake_probe_sha256"
  awk -F '\t' -v mode="$mode" '
    NR == 1 {
      if ($0 != "schema_version\tmode\tphase\tsample_index\tduration_ns\tstatus") exit 1
      next
    }
    $2 != mode || $6 != "ok" { exit 1 }
    $3 == "warmup" { warmup++ }
    $3 == "measure" { measure++ }
    END { if (NR != 8 || warmup != 2 || measure != 5) exit 1 }
  ' "$raw"
  awk -F '\t' -v mode="$mode" '
    NR == 1 { next }
    $1 != "1" || $2 != "fake" || $3 != mode || $4 != "ok" ||
      $5 != "CLOCK_MONOTONIC" || $6 != 2 || $7 != 5 ||
      $8 !~ /^[1-9][0-9]*$/ || $9 !~ /^[1-9][0-9]*$/ ||
      $10 !~ /^[1-9][0-9]*$/ { exit 1 }
    END { if (NR != 2) exit 1 }
  ' "$summary"
done

# A destination created after validation but before admission must win without
# being replaced. Use a helper shim to inject that exact commit-time race.
race_root="$test_root/race-project"
mkdir -p "$race_root/bin" "$race_root/lib"
cp "$SUMMARIZER" "$race_root/bin/summarize-libpq-latency.sh"
race_summarizer="$race_root/bin/summarize-libpq-latency.sh"
cp "$PROJECT_ROOT/lib/durable_publication.py" \
  "$race_root/lib/durable_publication.real.py"
cat >"$race_root/lib/durable_publication.py" <<'PY'
#!/usr/bin/env python3
import os
import sys
from pathlib import Path

if len(sys.argv) == 8 and sys.argv[1] == "publish-identified":
    destination = Path(sys.argv[3])
    with destination.open("xb") as stream:
        stream.write(b"concurrent owner\n")
os.execv(
    sys.executable,
    [
        sys.executable,
        str(Path(__file__).with_name("durable_publication.real.py")),
        *sys.argv[1:],
    ],
)
PY
race_output="$test_root/raced.summary.tsv"
if "$race_summarizer" \
  --raw "$test_root/persistent.raw.tsv" \
  --output "$race_output" \
  --target native \
  --mode persistent \
  --warmup 2 \
  --samples 5 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1; then
  echo "summarizer accepted a commit-time destination race" >&2
  exit 1
fi
[ "$(cat "$race_output")" = 'concurrent owner' ]

cat >"$test_root/known.raw.tsv" <<'TSV'
schema_version	mode	phase	sample_index	duration_ns	status
1	persistent	warmup	1	7	ok
1	persistent	warmup	2	8	ok
1	persistent	measure	1	50	ok
1	persistent	measure	2	10	ok
1	persistent	measure	3	40	ok
1	persistent	measure	4	20	ok
1	persistent	measure	5	30	ok
TSV
"$SUMMARIZER" \
  --raw "$test_root/known.raw.tsv" \
  --output "$test_root/known.summary.tsv" \
  --target native \
  --mode persistent \
  --warmup 2 \
  --samples 5 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256"
awk -F '\t' 'NR == 2 { if ($8 != 30 || $9 != 50 || $10 != 50) exit 1; found = 1 } END { exit !found }' \
  "$test_root/known.summary.tsv"

cat >"$test_root/decimal-boundary.raw.tsv" <<'TSV'
schema_version	mode	phase	sample_index	duration_ns	status
1	persistent	measure	1	999999999999999	ok
1	persistent	measure	2	1000000000000000	ok
TSV
"$SUMMARIZER" \
  --raw "$test_root/decimal-boundary.raw.tsv" \
  --output "$test_root/decimal-boundary.summary.tsv" \
  --target native \
  --mode persistent \
  --warmup 0 \
  --samples 2 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256"
awk -F '\t' 'NR == 2 {
  if ($8 != "999999999999999" || $9 != "1000000000000000" ||
      $10 != "1000000000000000" || $11 != "999999999.999999" ||
      $12 != "1000000000.000000" || $13 != "1000000000.000000") exit 1
  found = 1
} END { exit !found }' "$test_root/decimal-boundary.summary.tsv"

cat >"$test_root/overflow.raw.tsv" <<'TSV'
schema_version	mode	phase	sample_index	duration_ns	status
1	persistent	measure	1	1000000000000001	ok
TSV
if "$SUMMARIZER" \
  --raw "$test_root/overflow.raw.tsv" \
  --output "$test_root/overflow.summary.tsv" \
  --target native \
  --mode persistent \
  --warmup 0 \
  --samples 1 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1
then
  echo "summarizer accepted duration_ns above the bounded contract" >&2
  exit 1
fi
[ ! -e "$test_root/overflow.summary.tsv" ]

sed 's/\t50\tok$/\t050\tok/' "$test_root/known.raw.tsv" \
  >"$test_root/noncanonical-duration.raw.tsv"
if "$SUMMARIZER" \
  --raw "$test_root/noncanonical-duration.raw.tsv" \
  --output "$test_root/noncanonical-duration.summary.tsv" \
  --target native \
  --mode persistent \
  --warmup 2 \
  --samples 5 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1
then
  echo "summarizer accepted noncanonical duration_ns" >&2
  exit 1
fi
[ ! -e "$test_root/noncanonical-duration.summary.tsv" ]

python3 - "$test_root/oversized-line.raw.tsv" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).write_text(
    "schema_version\tmode\tphase\tsample_index\tduration_ns\tstatus\n"
    + "1\tpersistent\tmeasure\t1\t1\tok"
    + "x" * 128
    + "\n",
    encoding="ascii",
)
PY
if "$SUMMARIZER" \
  --raw "$test_root/oversized-line.raw.tsv" \
  --output "$test_root/oversized-line.summary.tsv" \
  --target native \
  --mode persistent \
  --warmup 0 \
  --samples 1 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1
then
  echo "summarizer accepted an unbounded raw record" >&2
  exit 1
fi
[ ! -e "$test_root/oversized-line.summary.tsv" ]

stable_race_hooks="$test_root/stable-race-hooks"
mkdir "$stable_race_hooks"
cat >"$stable_race_hooks/sitecustomize.py" <<'PY'
import os
from pathlib import Path

race_path = os.environ.get("OLIPHAUNT_TEST_STABLE_RACE_PATH")
real_open = os.open
injected = False


def mutate_then_open(path, *args, **kwargs):
    global injected
    if (
        not injected
        and race_path is not None
        and Path(os.path.abspath(path)) == Path(os.path.abspath(race_path))
    ):
        injected = True
        target = Path(race_path)
        before = target.stat()
        data = target.read_bytes()
        replacement = data.replace(b"\t50\tok\n", b"\t51\tok\n", 1)
        if replacement == data:
            raise RuntimeError("stable-read race fixture did not find its target")
        target.write_bytes(replacement)
        os.utime(
            target,
            ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000_000),
        )
    return real_open(path, *args, **kwargs)


os.open = mutate_then_open
PY
cp "$test_root/known.raw.tsv" "$test_root/stable-race.raw.tsv"
if PYTHONPATH="$stable_race_hooks" \
  OLIPHAUNT_TEST_STABLE_RACE_PATH="$test_root/stable-race.raw.tsv" \
  "$SUMMARIZER" \
  --raw "$test_root/stable-race.raw.tsv" \
  --output "$test_root/stable-race.summary.tsv" \
  --target native \
  --mode persistent \
  --warmup 2 \
  --samples 5 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1
then
  echo "summarizer accepted raw evidence mutated between stat and open" >&2
  exit 1
fi
[ ! -e "$test_root/stable-race.summary.tsv" ]
grep -Fq $'\t51\tok' "$test_root/stable-race.raw.tsv"

cat >"$test_root/failed.raw.tsv" <<'TSV'
schema_version	mode	phase	sample_index	duration_ns	status
1	persistent	warmup	1	7	ok
1	persistent	warmup	2	8	ok
1	persistent	measure	1	50	ok
1	persistent	measure	2	10	query_error
TSV
if "$SUMMARIZER" \
  --raw "$test_root/failed.raw.tsv" \
  --output "$test_root/failed.summary.tsv" \
  --target native \
  --mode persistent \
  --warmup 2 \
  --samples 2 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1
then
  echo "summarizer accepted a failed raw sample" >&2
  exit 1
fi
[ ! -e "$test_root/failed.summary.tsv" ] || {
  echo "summarizer left derived metrics for failed evidence" >&2
  exit 1
}

cat >"$test_root/missing.raw.tsv" <<'TSV'
schema_version	mode	phase	sample_index	duration_ns	status
1	reconnect	warmup	1	7	ok
1	reconnect	measure	1	50	ok
TSV
if "$SUMMARIZER" \
  --raw "$test_root/missing.raw.tsv" \
  --output "$test_root/missing.summary.tsv" \
  --target wasix \
  --mode reconnect \
  --warmup 1 \
  --samples 2 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1
then
  echo "summarizer accepted a missing measured sample" >&2
  exit 1
fi
[ ! -e "$test_root/missing.summary.tsv" ] || {
  echo "summarizer left derived metrics for incomplete evidence" >&2
  exit 1
}

cat >"$test_root/interleaved.raw.tsv" <<'TSV'
schema_version	mode	phase	sample_index	duration_ns	status
1	persistent	measure	1	50	ok
1	persistent	warmup	1	7	ok
1	persistent	measure	2	60	ok
TSV
if "$SUMMARIZER" \
  --raw "$test_root/interleaved.raw.tsv" \
  --output "$test_root/interleaved.summary.tsv" \
  --target native \
  --mode persistent \
  --warmup 1 \
  --samples 2 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1
then
  echo "summarizer accepted a warmup row after measurement began" >&2
  exit 1
fi
[ ! -e "$test_root/interleaved.summary.tsv" ] || {
  echo "summarizer left derived metrics for interleaved phases" >&2
  exit 1
}

if "$SUMMARIZER" \
  --raw "$test_root/known.raw.tsv" \
  --output "$test_root/wrong-libpq.summary.tsv" \
  --target native \
  --mode persistent \
  --warmup 2 \
  --samples 5 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 0000000000000000000000000000000000000000000000000000000000000000 \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1
then
  echo "summarizer accepted a mismatched libpq provenance hash" >&2
  exit 1
fi
[ ! -e "$test_root/wrong-libpq.summary.tsv" ] || {
  echo "summarizer left derived metrics for mismatched libpq provenance" >&2
  exit 1
}

if FAKE_LIBPQ_FAIL_QUERY=1 "$test_root/libpq-latency-probe" \
  --conninfo postgresql://fake/postgres \
  --mode reconnect \
  --warmup 1 \
  --samples 1 \
  --output "$test_root/probe-failed.raw.tsv" >/dev/null 2>&1
then
  echo "probe accepted a failed query" >&2
  exit 1
fi
grep -Fq $'\tquery_error' "$test_root/probe-failed.raw.tsv" || {
  echo "probe did not preserve explicit failed-sample status" >&2
  exit 1
}
if "$SUMMARIZER" \
  --raw "$test_root/probe-failed.raw.tsv" \
  --output "$test_root/probe-failed.summary.tsv" \
  --target fake \
  --mode reconnect \
  --warmup 1 \
  --samples 1 \
  --libpq-path "$fake_libpq_path" \
  --libpq-sha256 "$fake_libpq_sha256" \
  --probe-sha256 "$fake_probe_sha256" >/dev/null 2>&1
then
  echo "summarizer accepted failed probe output" >&2
  exit 1
fi

printf 'libpq latency probe and summary tests passed\n'
