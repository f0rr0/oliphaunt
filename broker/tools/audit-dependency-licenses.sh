#!/usr/bin/env bash
set -euo pipefail
[[ $# == 0 ]] || { echo 'usage: audit-dependency-licenses.sh' >&2; exit 2; }
exec bash "$(dirname "${BASH_SOURCE[0]}")/../../tools/packaging/audit-rust-dependency-licenses.sh" \
  broker/tools/broker-dependency-license-contract.mts oliphaunt-broker
