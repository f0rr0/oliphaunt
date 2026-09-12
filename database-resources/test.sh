#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun test ./database-resources/seeds/package-mobile-carriers.test.mts
bash database-resources/icu/tools/data.test.sh
bash database-resources/icu/tools/package-liboliphaunt-icu-data.test.sh
bash database-resources/icu/tools/icu-npm-carrier-contract.test.sh
