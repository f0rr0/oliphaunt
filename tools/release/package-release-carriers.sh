#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [[ $# != 2 || "$1" != --products-json ]]; then
  echo 'usage: package-release-carriers.sh --products-json JSON' >&2
  exit 2
fi
has_broker="$(jq -r 'index("oliphaunt-broker") != null' <<<"$2")"
tools/dev/bun.sh tools/release/package-release-carriers.mts "$@"
if [[ "$has_broker" == true ]]; then
  bash src/runtimes/broker/tools/package-broker-cargo-artifacts.sh
fi
