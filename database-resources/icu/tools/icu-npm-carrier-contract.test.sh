#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
root="$PWD"
scratch="$(mktemp -d)"
scratch="$(cd "$scratch" && pwd -P)"
trap 'rm -rf "$scratch"' EXIT
test_file=database-resources/icu/tools/icu-npm-carrier-contract.test.mts
bun "$test_file" prepare "$scratch"
(cd "$scratch/stage" && bun pm pack --filename "$scratch/packed/package.tgz")
bun "$test_file" extract-config "$scratch"
node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' \
  "$scratch/consumer/react-native.config.js" > "$scratch/config.json"
OLIPHAUNT_ICU_NPM_TEST_ROOT="$scratch" bun test "$root/$test_file"
