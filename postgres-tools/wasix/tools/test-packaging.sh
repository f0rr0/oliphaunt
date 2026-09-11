#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
export OLIPHAUNT_WASIX_TOOLS_TEST_ROOT
OLIPHAUNT_WASIX_TOOLS_TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$OLIPHAUNT_WASIX_TOOLS_TEST_ROOT"' EXIT
bun test --timeout=30000 ./postgres-tools/wasix/tools
node postgres-tools/wasix/tools/wasix-tools-npm.test-consumer.mts
