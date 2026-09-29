#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export TEST_SOURCE_ROOT="$PWD" TEST_BUN="$(command -v bun)"
bun -e '
  const fs = require("node:fs");
  const assert = require("node:assert/strict");
  const workflow = Bun.YAML.parse(fs.readFileSync(".github/workflows/release.yml", "utf8"));
  const step = Object.values(workflow.jobs).flatMap(job => job.steps ?? [])
    .find(step => step.name === "Freeze canonical Apple extension carrier input");
  assert.equal(step.env.PRODUCTS_JSON,
    "${{ fromJSON(needs.plan-candidate.outputs.release_plan).products_json }}");
  fs.writeFileSync(process.argv[1] + "/freeze.sh", step.run);
' "$scratch"
mkdir -p "$scratch/tools/dev"
cat > "$scratch/tools/dev/bun.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == tools/release/query.mts ]]; then
  exec "$TEST_BUN" "$TEST_SOURCE_ROOT/$1" "${@:2}"
fi
[[ "$1" == src/native/sdks/swift/tools/ios-carrier-manifest.mts ]]
printf '%s\n' "$@" >> calls
SH
chmod +x "$scratch/tools/dev/bun.sh"
cd "$scratch"
native=target/extension-artifacts/liboliphaunt-native/oliphaunt-extension-contrib-pg18
wasix=target/extension-artifacts/liboliphaunt-wasix/oliphaunt-extension-contrib-pg18
vector=target/extension-artifacts/oliphaunt-extension-vector
for root in "$native" "$wasix" "$vector"; do
  mkdir -p "$root/release-assets"
  printf '{}\n' > "$root/extension-artifacts.json"
  printf '{}\n' > "$root/release-assets/fixture-swift-extension-carrier.json"
done
source_carrier=target/sdk-artifacts/oliphaunt-react-native/ios-carriers/oliphaunt-react-native-ios-carriers.json
mkdir -p "$(dirname "$source_carrier")"
printf 'frozen base carrier\n' > "$source_carrier"
export includes_swift=false includes_react_native=true
export PRODUCTS_JSON='["liboliphaunt-native","liboliphaunt-wasix","oliphaunt-extension-vector","oliphaunt-react-native"]'
bash -eo pipefail freeze.sh
rg -q -F "$native/extension-artifacts.json" calls
rg -q -F "$vector/extension-artifacts.json" calls
[[ "$(rg -c '^--extension-manifest$' calls)" == 2 ]]
! rg -q -F "$wasix" calls

# No native extensions selected: preserve the qualified base, even with unrelated artifacts present.
rm calls
PRODUCTS_JSON='["oliphaunt-react-native","liboliphaunt-wasix"]' bash -eo pipefail freeze.sh
cmp "$source_carrier" target/release/ios-carriers/oliphaunt-react-native-ios-carriers.json
[[ ! -e calls ]]
for selection in '' malformed '["unknown-product"]'; do
  if PRODUCTS_JSON="$selection" bash -eo pipefail freeze.sh > failure 2>&1; then
    echo 'invalid Apple carrier selection was accepted' >&2; exit 1
  fi
  [[ ! -e calls ]]
done
rm "$native/extension-artifacts.json"
if bash -eo pipefail freeze.sh > failure 2>&1; then
  echo 'missing selected manifest was accepted' >&2; exit 1
fi
rg -q 'Selected extension product .* is missing' failure
[[ ! -e calls ]]
echo 'Apple carrier selection: native-only inputs, empty selection and query failures passed'
