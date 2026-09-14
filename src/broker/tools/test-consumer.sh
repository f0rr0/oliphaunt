#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[[ "$(uname -s):$(uname -m)" == Linux:x86_64 ]] || {
  echo 'packed broker consumer uses Linux x64 archives; test-integration supports local source builds' >&2
  exit 2
}
native_archives=(target/liboliphaunt/desktop-release-assets/linux-x64-gnu/liboliphaunt-*-linux-x64-gnu.tar.gz)
broker_archives=(target/oliphaunt-broker/release-assets/oliphaunt-broker-*-linux-x64-gnu.tar.gz)
[[ ${#native_archives[@]} == 1 && -f "${native_archives[0]}" && ${#broker_archives[@]} == 1 && -f "${broker_archives[0]}" ]] || {
  echo 'expected one native runtime and one broker Linux archive from owner package tasks' >&2
  exit 1
}
consumer="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-broker-consumer.XXXXXX")"
trap 'rm -rf "$consumer"' EXIT HUP INT TERM
mkdir -p "$consumer/native" "$consumer/broker"
tar -xzf "${native_archives[0]}" -C "$consumer/native" --no-same-owner
tar -xzf "${broker_archives[0]}" -C "$consumer/broker" --no-same-owner
export LIBOLIPHAUNT_PATH="$consumer/native/lib/liboliphaunt.so"
export OLIPHAUNT_INSTALL_DIR="$consumer/native/runtime"
export OLIPHAUNT_EMBEDDED_MODULE_DIR="$consumer/native/lib/modules"
export OLIPHAUNT_BROKER="$consumer/broker/bin/oliphaunt-broker"
cargo test -p oliphaunt-broker --locked --test postgres_client -- --ignored
