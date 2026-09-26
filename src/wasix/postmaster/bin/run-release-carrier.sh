#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: oliphaunt-wasix-postmaster <init|start|uri> --data-dir DIR [options]

Run the sealed liboliphaunt WASIX postmaster carrier shipped in this release.

Options:
  --data-dir DIR       PostgreSQL data directory. Required.
  --host HOST          Listen host. Default: 127.0.0.1.
  --port PORT          Listen port. Default: 5432.
  --username NAME      Bootstrap superuser. Default: postgres.
  --database NAME      Database used by the printed URI. Default: postgres.
  --guc NAME=VALUE     PostgreSQL startup setting. May repeat with start.
  --allow-remote       Permit a non-loopback listen host.
  -h, --help           Show this help.

`start` initializes an empty data directory, prints the connection URI, and
then runs PostgreSQL in the foreground. Send SIGTERM to stop it cleanly.
USAGE
}

fail() {
  printf 'oliphaunt-wasix-postmaster: %s\n' "$*" >&2
  exit 2
}

[ "$#" -gt 0 ] || { usage >&2; exit 2; }
command="$1"
shift
case "$command" in
  init|start|uri) ;;
  -h|--help) usage; exit 0 ;;
  *) fail "unknown command: $command" ;;
esac

data_dir=""
host="127.0.0.1"
port="5432"
username="postgres"
database="postgres"
allow_remote=0
gucs=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --data-dir|--host|--port|--username|--database|--guc)
      option="$1"
      shift
      [ "$#" -gt 0 ] || fail "$option requires a value"
      case "$option" in
        --data-dir) [ -z "$data_dir" ] || fail '--data-dir may only be specified once'; data_dir="$1" ;;
        --host) host="$1" ;;
        --port) port="$1" ;;
        --username) username="$1" ;;
        --database) database="$1" ;;
        --guc) gucs+=("$1") ;;
      esac
      ;;
    --allow-remote) allow_remote=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

[ -n "$data_dir" ] || fail '--data-dir is required'
case "$port" in ''|*[!0-9]*) fail '--port must be an integer from 1 through 65535' ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail '--port must be an integer from 1 through 65535'
[[ "$username" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail '--username must be a simple PostgreSQL identifier'
[[ "$database" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail '--database must be a simple PostgreSQL identifier'
[ -n "$host" ] || fail '--host must not be empty'
if [ "$allow_remote" -ne 1 ]; then
  case "$host" in
    127.0.0.1|localhost|::1) ;;
    *) fail 'non-loopback --host requires --allow-remote' ;;
  esac
fi
if [ "$command" != start ] && [ "${#gucs[@]}" -gt 0 ]; then
  fail '--guc is only valid with start'
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
package_root="$(cd "$script_dir/.." && pwd -P)"
carrier_root="${OLIPHAUNT_WASIX_POSTMASTER_CARRIER_DIR:-$package_root/carrier}"
[ -d "$carrier_root" ] && [ ! -L "$carrier_root" ] || fail "missing regular carrier directory: $carrier_root"
carrier_root="$(cd "$carrier_root" && pwd -P)"
for required in bin/wasmer-headless bin/initdb bin/postgres manifest.json; do
  [ -f "$carrier_root/$required" ] && [ ! -L "$carrier_root/$required" ] || {
    fail "carrier is missing regular payload: $required"
  }
done
[ -x "$carrier_root/bin/wasmer-headless" ] || fail 'carrier executor is not executable'
for required in lib share; do
  [ -d "$carrier_root/$required" ] && [ ! -L "$carrier_root/$required" ] || {
    fail "carrier is missing regular payload directory: $required"
  }
done

if [ -e "$data_dir" ]; then
  [ -d "$data_dir" ] && [ ! -L "$data_dir" ] || fail "data path is not a regular directory: $data_dir"
else
  mkdir -p "$data_dir"
fi
data_dir="$(cd "$data_dir" && pwd -P)"
state_dir="${OLIPHAUNT_WASIX_POSTMASTER_STATE_DIR:-$data_dir.oliphaunt-runtime}"
if [ -e "$state_dir" ]; then
  [ -d "$state_dir" ] && [ ! -L "$state_dir" ] || fail "runtime state path is not a regular directory: $state_dir"
else
  mkdir -p "$state_dir"
fi
state_dir="$(cd "$state_dir" && pwd -P)"
if [ -e "$state_dir/dev-shm" ]; then
  [ -d "$state_dir/dev-shm" ] && [ ! -L "$state_dir/dev-shm" ] || fail 'runtime shared-memory path is not a regular directory'
else
  mkdir "$state_dir/dev-shm"
fi
for mount_path in "$carrier_root" "$data_dir" "$state_dir"; do
  case "$mount_path" in
    *:*) fail "mounted paths must not contain a colon: $mount_path" ;;
    *$'\n'*|*$'\r'*) fail 'mounted paths must not contain newline characters' ;;
  esac
done

executor_args=(
  run
  --quiet
  --disable-cache
  --sealed-module-manifest "$carrier_root/manifest.json"
  --stack-size "${OLIPHAUNT_WASIX_POSTMASTER_STACK_SIZE:-33554432}"
  --enable-exceptions
  --enable-threads
  --net
  --volume "$carrier_root:$carrier_root"
  --volume "$carrier_root/share:/share"
  --volume "$carrier_root/lib:/lib"
  --volume "$data_dir:/pgdata"
  --volume "$state_dir/dev-shm:/dev/shm"
)

connection_uri="postgresql://$username@$host:$port/$database"

initialize() {
  if [ -e "$data_dir/PG_VERSION" ]; then
    [ -f "$data_dir/PG_VERSION" ] && [ ! -L "$data_dir/PG_VERSION" ] || fail 'PG_VERSION is not a regular file'
    [ -f "$data_dir/global/pg_control" ] && [ ! -L "$data_dir/global/pg_control" ] || {
      fail 'data directory contains an incomplete PostgreSQL cluster'
    }
    return 0
  fi
  [ -z "$(find "$data_dir" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
    fail 'refusing to initialize a non-empty data directory without PG_VERSION'
  }
  "$carrier_root/bin/wasmer-headless" "${executor_args[@]}" \
    "$carrier_root/bin/initdb" -- \
      -D /pgdata \
      -A trust \
      --username "$username" \
      --no-locale \
      --encoding=UTF8 \
      --no-instructions
}

case "$command" in
  uri)
    printf '%s\n' "$connection_uri"
    ;;
  init)
    initialize
    ;;
  start)
    initialize
    postgres_args=(
      -D /pgdata
      -h "$host"
      -p "$port"
      -c unix_socket_directories=
    )
    for guc in "${gucs[@]}"; do
      [[ "$guc" == *=* ]] || fail '--guc requires NAME=VALUE'
      postgres_args+=(-c "$guc")
    done
    printf 'Oliphaunt WASIX postmaster: %s\n' "$connection_uri" >&2
    exec "$carrier_root/bin/wasmer-headless" "${executor_args[@]}" \
      "$carrier_root/bin/postgres" -- "${postgres_args[@]}"
    ;;
esac
