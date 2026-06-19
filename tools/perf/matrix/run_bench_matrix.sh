#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"

cat >&2 <<'MSG'
tools/perf/matrix/run_bench_matrix.sh is a retired compatibility entrypoint.
Use tools/perf/matrix/run_native_oliphaunt_matrix.sh for native direct,
broker, server, PostgreSQL, SQLite, and WASIX comparison plans.
MSG

exec "$script_dir/run_native_oliphaunt_matrix.sh" "$@"
