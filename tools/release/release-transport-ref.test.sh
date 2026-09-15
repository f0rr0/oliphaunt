#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/release-transport-ref.test.mts
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/fetch.mts" <<'TS'
globalThis.fetch = async () => Response.json(JSON.parse(process.env.TEST_REF!));
TS
sha=84d90b9853530ab72e48a1aa6fb616aaed7a0dc6
# Derive the current transport ref shape through its public helper.
bun -e 'import {releaseTransportFullRef} from "./.github/scripts/release-transport-ref.mts"; const sha=process.argv[1]; console.log(JSON.stringify({ref:releaseTransportFullRef(sha),object:{sha,type:"commit"}}))' "$sha" > "$scratch/ref"
run_cli() {
  env -i PATH="$PATH" HOME="$HOME" GH_REPO=f0rr0/oliphaunt GH_TOKEN=test-token \
    TEST_REF="$1" bun --preload "$scratch/fetch.mts" \
    .github/scripts/release-transport-ref.mts verify "$sha" > "$scratch/result" 2>&1
}
run_cli "$(cat "$scratch/ref")"
rg -q 'verified refs/tags' "$scratch/result"
if run_cli '{}'; then echo 'Invalid remote ref was accepted' >&2; exit 1; fi
rg -q 'does not point directly' "$scratch/result"
if rg -q 'TypeError|Unhandled' "$scratch/result"; then cat "$scratch/result" >&2; exit 1; fi
echo 'Release transport CLI: exact remote ref and rejected read passed'
