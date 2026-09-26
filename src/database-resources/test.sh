#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bash tools/dev/bun.sh test ./src/database-resources/seeds/package-mobile-carriers.test.mts
bash src/database-resources/icu/tools/data.test.sh
bash src/database-resources/icu/tools/package-liboliphaunt-icu-data.test.sh
bash src/database-resources/icu/tools/icu-npm-carrier-contract.test.sh
