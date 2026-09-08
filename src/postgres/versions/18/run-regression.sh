#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:-native}"
[ "$#" -le 1 ] || {
  echo "usage: $0 [native|embedded]" >&2
  exit 2
}
case "$mode" in
  native | embedded) ;;
  *)
    echo "usage: $0 [native|embedded]" >&2
    exit 2
    ;;
esac
source "$script_dir/../../../runtimes/liboliphaunt/wasix-postmaster/lib/common.sh"
fresh_lock_postgres_baseline shared
trap fresh_unlock_postgres_baseline EXIT
fresh_require_postgres_baseline "$(fresh_postgres_baseline_fingerprint)" || {
  echo "missing or invalid pinned PostgreSQL source; run moon run postgres18:regression-tools" >&2
  exit 2
}

regress="$CLIENT_TOOLS_BUILD_DIR/src/test/regress"
input="$BASELINE_DIR/src/test/regress"
[ -x "$regress/pg_regress" ] && [ -x "$CLIENT_TOOLS_INSTALL_DIR/bin/psql" ] || {
  echo "missing PostgreSQL regression tools; run moon run postgres18:regression-tools" >&2
  exit 2
}
mkdir -p "$REPO_ROOT/target/postgres-regress"
output="$(mktemp -d "$REPO_ROOT/target/postgres-regress/$mode.XXXXXX")"
bindir="$CLIENT_TOOLS_INSTALL_DIR/bin"
if [ "$mode" = native ]; then
  source "$REPO_ROOT/src/runtimes/liboliphaunt/native/tools/runtime-preflight.sh"
  source "$REPO_ROOT/src/runtimes/liboliphaunt/native/bin/icu.sh"
  bindir="$(oliphaunt_runtime_native_host_install_dir)/bin"
  for tool in postgres initdb psql; do
    [ -x "$bindir/$tool" ] || {
      echo "missing native runtime: $bindir/$tool" >&2
      exit 2
    }
  done
  bindir="$(cd "$bindir" && pwd)"
  export ICU_DATA="${OLIPHAUNT_ICU_DATA_DIR:-$(oliphaunt_runtime_native_host_work_root)/icu/share/icu}"
  oliphaunt_icu_files_data_ready "$ICU_DATA" || {
    echo "missing native ICU data: $ICU_DATA" >&2
    exit 2
  }
  ICU_DATA="$(cd "$ICU_DATA" && pwd)"
  export LD_LIBRARY_PATH="$bindir/../lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  schedule="$input/parallel_schedule"
  connection=(--temp-instance="$output/instance" --no-locale --encoding=UTF8)
else
  : "${PGHOST:?embedded regression requires an isolated server PGHOST}"
  : "${PGPORT:?embedded regression requires an isolated server PGPORT}"
  : "${PGUSER:?embedded regression requires an isolated server PGUSER}"
  : "${PGDATABASE:?embedded regression requires an isolated server PGDATABASE}"
  schedule="$script_dir/embedded_schedule"
  connection=(--use-existing --host="$PGHOST" --port="$PGPORT" --user="$PGUSER" --dbname="$PGDATABASE")
fi
printf 'PostgreSQL %s %s regression: %s\n' "$POSTGRES_VERSION" "$mode" "$output"
# pg_regress owns psql, environment normalization, resultmap, and output diffs.
# Keep the upstream schedule order even when serializing its parallel groups.
cd "$output"
"$regress/pg_regress" \
  --bindir="$bindir" --inputdir="$input" --outputdir="$output" \
  --dlpath="$regress" --schedule="$schedule" --max-connections=1 \
  "${connection[@]}"
