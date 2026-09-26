#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
export OLIPHAUNT_WASIX_TOOLS_TEST_ROOT
OLIPHAUNT_WASIX_TOOLS_TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$OLIPHAUNT_WASIX_TOOLS_TEST_ROOT"' EXIT
bash tools/dev/bun.sh test ./src/wasix/postgres-tools/tools
node src/wasix/postgres-tools/tools/wasix-tools-npm.test-consumer.mts
