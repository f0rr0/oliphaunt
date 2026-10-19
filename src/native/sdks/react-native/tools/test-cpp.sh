#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rn-cpp-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
"${CXX:-c++}" -std=c++17 -pthread -Wall -Wextra -Werror cpp/Lifecycle.test.cpp -o "$scratch/lifecycle"
"$scratch/lifecycle"
