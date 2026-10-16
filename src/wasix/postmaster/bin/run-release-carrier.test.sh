#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
launcher="$project_root/bin/run-release-carrier.sh"
test_root="$(mktemp -d)"
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT HUP INT TERM

carrier="$test_root/carrier"
data_dir="$test_root/data"
log="$test_root/executor.log"
mkdir -p "$carrier/bin" "$carrier/lib" "$carrier/share"
printf '{}\n' >"$carrier/manifest.json"
printf 'wasm\n' >"$carrier/bin/initdb"
printf 'wasm\n' >"$carrier/bin/postgres"
cat >"$carrier/bin/wasmer-headless" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$OLIPHAUNT_TEST_EXECUTOR_LOG"
printf '\n' >>"$OLIPHAUNT_TEST_EXECUTOR_LOG"
for arg in "$@"; do
  if [[ "$arg" == */bin/initdb ]]; then
    mkdir -p "$OLIPHAUNT_TEST_DATA_DIR/global"
    printf '18\n' >"$OLIPHAUNT_TEST_DATA_DIR/PG_VERSION"
    printf 'control\n' >"$OLIPHAUNT_TEST_DATA_DIR/global/pg_control"
    break
  fi
done
SH
chmod 0555 "$carrier/bin/wasmer-headless"

export OLIPHAUNT_WASIX_POSTMASTER_CARRIER_DIR="$carrier"
export OLIPHAUNT_TEST_EXECUTOR_LOG="$log"
export OLIPHAUNT_TEST_DATA_DIR="$data_dir"

uri="$(bash "$launcher" uri --data-dir "$data_dir" --port 55432)"
[ "$uri" = 'postgresql://postgres@127.0.0.1:55432/postgres' ]

bash "$launcher" init --data-dir "$data_dir" --username app
[ -f "$data_dir/PG_VERSION" ]
grep -Fq -- '--username app' "$log"

bash "$launcher" start --data-dir "$data_dir" --username app --port 55432 \
  --guc max_connections=16 2>"$test_root/start.stderr"
[ "$(wc -l <"$log" | tr -d '[:space:]')" = 2 ]
grep -Fq -- '-c max_connections=16' "$log"
grep -Fq 'postgresql://app@127.0.0.1:55432/postgres' "$test_root/start.stderr"

if bash "$launcher" start --data-dir "$data_dir" --host 0.0.0.0 \
  >"$test_root/remote.out" 2>"$test_root/remote.err"; then
  echo 'launcher accepted a remote listener without --allow-remote' >&2
  exit 1
fi
grep -Fq 'requires --allow-remote' "$test_root/remote.err"

incomplete="$test_root/incomplete"
mkdir -p "$incomplete"
printf 'user data\n' >"$incomplete/file"
if bash "$launcher" init --data-dir "$incomplete" \
  >"$test_root/incomplete.out" 2>"$test_root/incomplete.err"; then
  echo 'launcher initialized a non-empty unowned directory' >&2
  exit 1
fi
grep -Fq 'refusing to initialize a non-empty data directory' "$test_root/incomplete.err"

ipv6="$(bash "$launcher" uri --data-dir "$data_dir" --host ::1 --port 55432)"
[ "$ipv6" = 'postgresql://postgres@[::1]:55432/postgres' ]
bash "$launcher" start --data-dir "$data_dir" 2>"$test_root/default.stderr"
for setting in PORT=1234 listen-addresses=0.0.0.0 data_directory=/tmp/other unix_socket_directories=/tmp; do
  rejected_root="$test_root/rejected-${setting%%=*}"
  if bash "$launcher" start --data-dir "$rejected_root" --guc "$setting" \
    >"$test_root/guc.out" 2>"$test_root/guc.err"; then
    echo "launcher accepted controlled setting: $setting" >&2
    exit 1
  fi
  [ ! -e "$rejected_root" ]
  grep -Fq 'controlled by launcher options' "$test_root/guc.err"
done

echo 'release carrier launcher tests passed'
