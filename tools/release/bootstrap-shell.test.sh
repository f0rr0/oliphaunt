#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source_root="$PWD"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/.github/scripts" "$scratch/tools/dev" "$scratch/tools/release" "$scratch/bin"
cp .github/scripts/bootstrap-registry-identities.sh "$scratch/.github/scripts/"
printf '#!/usr/bin/env bash\nshift\nexec "$@"\n' > "$scratch/tools/release/with-source.sh"
bun tools/release/bootstrap-shell.test.mts prepare "$scratch"
cat > "$scratch/tools/dev/bun.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
phase="$2"; state="$3"; index="${4:-}"
event() { echo "$*" >> "$BOOT_FIXTURE_LOG"; }
case "$phase" in
  --prepare) cp "$BOOT_FIXTURE_ROOT/plan.json" "$state/context.json" ;;
  --checkpoint)
    shopt -s nullglob; files=("$state"/operation-*.json); count="${#files[@]}"
    event "checkpoint-$count"
    if [[ "$BOOT_FIXTURE_MODE" == checkpoint-failure && ! -f "$state/tried" ]]; then : > "$state/tried"; exit 9; fi
    echo "$count" > "$state/checkpoint-count" ;;
  --finish)
    if [[ -f "$state/status-1" && "$(cat "$state/status-1")" != 0 ]]; then
      [[ "$(cat "$state/status-1")" == 75 ]] || exit 9
      event deferred
    fi
    [[ ! -f "$state/checkpoint-failed" ]] || exit 9
    event finish ;;
  bootstrap-cargo)
    [[ -z "${NPM_TOKEN:-}${NPM_CONFIG_USERCONFIG:-}${NODE_AUTH_TOKEN:-}" && "$CARGO_REGISTRY_TOKEN" == cargo-fixture ]]
    if [[ "$index" == 2 ]]; then
      event cargo-start; : > "$state/cargo-start"
      until [[ -f "$state/npm-start" ]]; do sleep 0.01; done
      sleep 0.15
      event cargo-drained
    fi
    echo '{}' > "$state/operation-$index.json"; event "cargo-$index" ;;
  bootstrap-npm-before)
    [[ -z "${CARGO_REGISTRY_TOKEN:-}${CRATES_IO_BOOTSTRAP_TOKEN:-}" && "$NPM_TOKEN" == npm-fixture ]]
    : > "$state/npm-start"
    if [[ "$index" == 1 && "$BOOT_FIXTURE_MODE" == deferral ]]; then
      until [[ -f "$state/cargo-start" ]]; do sleep 0.01; done
      event npm-deferred; exit 75
    fi
    jq -n '{tarball:"frozen.tgz",registry:"https://registry.npmjs.org",timeout:2000}' > "$state/npm-$index.json" ;;
  bootstrap-npm-after)
    if [[ "$index" == 1 ]]; then
      until [[ -f "$state/cargo-start" ]]; do sleep 0.01; done
      if [[ "$BOOT_FIXTURE_MODE" == mutation-failure ]]; then event npm-failed; exit 9; fi
    fi
    echo '{}' > "$state/operation-$index.json"; event "npm-$index" ;;
  *) exit 21 ;;
esac
SH
cat > "$scratch/bin/npm" <<'SH'
#!/usr/bin/env bash
[[ "$*" == 'publish frozen.tgz --access public --provenance --registry https://registry.npmjs.org' && "$NPM_CONFIG_FETCH_RETRIES" == 0 ]] || exit 22
echo npm-publish >> "$BOOT_FIXTURE_LOG"
exit 7
SH
chmod +x "$scratch/bin/npm"
deadline="$(command -v gtimeout || command -v timeout)"
for scenario in success mutation-failure deferral checkpoint-failure; do
  status=0
  PATH="$scratch/bin:$PATH" BOOT_FIXTURE_ROOT="$scratch" BOOT_FIXTURE_LOG="$scratch/$scenario.log" BOOT_FIXTURE_MODE="$scenario" \
    RELEASE_HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa PUBLICATION_LOCK_PATH=lock.json BOOTSTRAP_LEDGER_PATH=ledger \
    CARGO_REGISTRY_TOKEN=cargo-fixture CRATES_IO_BOOTSTRAP_TOKEN=cargo-fixture NPM_TOKEN=npm-fixture \
    NODE_AUTH_TOKEN=npm-fixture NPM_CONFIG_USERCONFIG=fixture-npmrc \
    "$deadline" 15 bash "$scratch/.github/scripts/bootstrap-registry-identities.sh" > "$scratch/result" 2>&1 || status=$?
  case "$scenario" in
    success|deferral) [[ "$status" == 0 ]] || { cat "$scratch/result" >&2; exit 1; } ;;
    *) [[ "$status" != 0 && "$status" != 124 ]] ;;
  esac
  bun "$source_root/tools/release/bootstrap-shell.test.mts" assert "$scratch" "$scenario"
done
echo 'Bootstrap lanes: credential isolation, batch checkpoints, deferral and draining passed'
