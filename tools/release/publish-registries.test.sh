#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source_root="$PWD"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/tools/release" "$scratch/tools/dev" "$scratch/bin"
cp tools/release/publish-registries.sh "$scratch/tools/release/"
printf '#!/usr/bin/env bash\nshift\nexec "$@"\n' > "$scratch/tools/release/with-source.sh"
bun tools/release/publish-registries.test.mts prepare "$scratch"
cat > "$scratch/tools/dev/bun.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
phase="$2"; state="$3"; index="${4:-}"
event() { echo "$*" >> "$REGISTRY_FIXTURE_LOG"; }
case "$phase" in
  registry-prepare) cp "$REGISTRY_FIXTURE_ROOT/plan.json" "$state/context.json" ;;
  registry-cargo)
    if [[ "$index" == 0 ]]; then echo '[]' > "$state/operation-0.json"; event cargo-0; else
      [[ -f "$state/operation-1.json" ]]
      event cargo-start; : > "$state/cargo-start"
      until [[ -f "$state/maven-start" ]]; do sleep 0.05; done
      sleep 0.15
      echo '[]' > "$state/operation-2.json"; event cargo-drained
    fi ;;
  registry-npm-before)
    event "npm-before-$index"
    jq -n '{tarball:"frozen.tgz",registry:"https://registry.npmjs.org",timeout:2000}' > "$state/npm-$index.json" ;;
  registry-npm-after) event "npm-reconciled-$index"; echo '[]' > "$state/operation-$index.json" ;;
  registry-maven)
    [[ -f "$state/operation-1.json" ]]
    until [[ -f "$state/cargo-start" ]]; do sleep 0.05; done
    event maven-start; : > "$state/maven-start"
    [[ "$REGISTRY_FIXTURE_FAIL" != true ]] || exit 9
    echo '[]' > "$state/operation-3.json" ;;
  registry-finish) event finish ;;
  *) exit 20 ;;
esac
SH
cat > "$scratch/bin/npm" <<'SH'
#!/usr/bin/env bash
[[ "$*" == 'publish frozen.tgz --access public --provenance --registry https://registry.npmjs.org' ]] || exit 21
[[ "$NPM_CONFIG_FETCH_RETRIES" == 0 ]] || exit 22
echo npm-push >> "$REGISTRY_FIXTURE_LOG"
exit 7
SH
chmod +x "$scratch/bin/npm"
deadline="$(command -v gtimeout || command -v timeout)"
for scenario in success failure; do
  fail=false
  [[ "$scenario" != failure ]] || fail=true
  status=0
  PATH="$scratch/bin:$PATH" REGISTRY_FIXTURE_ROOT="$scratch" REGISTRY_FIXTURE_LOG="$scratch/events-$scenario" REGISTRY_FIXTURE_FAIL="$fail" \
    "$deadline" 10 bash "$scratch/tools/release/publish-registries.sh" --products-json '["fixture"]' > "$scratch/result" 2>&1 || status=$?
  if [[ "$scenario" == success ]]; then [[ "$status" == 0 ]] || { cat "$scratch/result" >&2; exit 1; };
  else [[ "$status" != 0 && "$status" != 124 ]]; fi
  bun "$source_root/tools/release/publish-registries.test.mts" assert "$scratch" "$scenario"
done
echo 'Registry lanes: dependency ordering, one npm attempt, reconciliation and peer draining passed'
