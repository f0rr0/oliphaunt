#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

scope="${1:-all}"

check_postgres18() {
  test -f src/postgres/versions/18/source.toml
  grep -Fq 'version = "18.4"' src/postgres/versions/18/source.toml
  grep -Fq 'postgresql-18.4.tar.bz2' src/postgres/versions/18/source.toml
  grep -Fq 'sha256 = "' src/postgres/versions/18/source.toml
}

check_third_party() {
  check_third_party_shared
  check_third_party_native
  check_third_party_wasix
}

check_third_party_shared() {
  for source_pin in \
    src/sources/third-party/shared/icu.toml \
    src/sources/third-party/shared/openssl.toml; do
    test -f "$source_pin"
    grep -Fq 'name = "' "$source_pin"
    grep -Fq 'commit = "' "$source_pin"
  done
}

check_third_party_native() {
  test -f src/sources/third-party/native/README.md
}

check_third_party_wasix() {
  test -f src/sources/third-party/wasix/README.md
}

check_toolchains() {
  test -f src/sources/toolchains/wasix.toml
  grep -Fq '[toolchain]' src/sources/toolchains/wasix.toml
  grep -Fq '[build]' src/sources/toolchains/wasix.toml
  test -f src/sources/toolchains/maestro.toml
  grep -Fq '[toolchain]' src/sources/toolchains/maestro.toml
  grep -Fq 'cloud_required = false' src/sources/toolchains/maestro.toml
  test -f src/sources/toolchains/android-emulator-runner.toml
  grep -Fq 'repository = "ReactiveCircus/android-emulator-runner"' src/sources/toolchains/android-emulator-runner.toml
  grep -Fq 'sha = "70f4dee990796918b78d040e3278474bdbd348a7"' src/sources/toolchains/android-emulator-runner.toml
  grep -Fq 'cloud_required = false' src/sources/toolchains/android-emulator-runner.toml
}

check_extensions() {
  test -f src/extensions/catalog/extensions.promoted.toml
  test -f src/extensions/catalog/extensions.smoke.toml
  test -f src/extensions/contrib/postgres18.toml
  test -f src/extensions/external/README.md
  test -f src/extensions/external/vector/source.toml
  test -f src/extensions/external/postgis/source.toml
  test -f src/extensions/external/postgis/dependencies/geos/source.toml
  test -f src/extensions/external/postgis/dependencies/proj/source.toml
  test -f src/extensions/external/postgis/dependencies/sqlite/source.toml
  test -f src/extensions/external/postgis/dependencies/libxml2/source.toml
  test -f src/extensions/external/postgis/dependencies/json-c/source.toml
  test -f src/extensions/external/postgis/dependencies/libiconv/source.toml
  test -f src/extensions/schemas/recipe.schema.json
  test -f src/extensions/schemas/support-table.schema.json
  test -f src/extensions/evidence/matrix.toml
  test -f src/extensions/evidence/schemas/matrix.schema.json
  test -f src/extensions/evidence/schemas/run.schema.json
  test -f src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json
  test -f src/extensions/generated/extensions.catalog.json
  test -f src/extensions/generated/extensions.build-plan.json
  test -f src/extensions/generated/contrib-build.tsv
  test -f src/extensions/generated/pgxs-build.tsv
  test -f src/extensions/generated/docs/extensions.json
  test -f src/extensions/generated/docs/extension-evidence.json
  test -f src/extensions/generated/sdk/rust.json
  test -f src/extensions/generated/sdk/swift.json
  test -f src/extensions/generated/sdk/kotlin.json
  test -f src/extensions/generated/sdk/js.json
  test -f src/extensions/generated/sdk/react-native.json
  test -f src/sdks/rust/src/generated/extensions.rs
  test -f src/extensions/generated/mobile/static-registry.json
  test -f src/extensions/generated/mobile/static-extensions.tsv
  test -f src/extensions/generated/wasix/extensions.json
  test -f src/extensions/tools/check-extension-model.py
  python3 src/extensions/tools/check-extension-model.py --check
}

check_repo_policy() {
  if tracked="$(git ls-files assets)" && [ -n "$tracked" ]; then
    printf 'root assets/ must not contain tracked files:\n%s\n' "$tracked" >&2
    exit 1
  fi
  if tracked="$(git ls-files src/third-party)" && [ -n "$tracked" ]; then
    printf 'src/third-party must not contain tracked files:\n%s\n' "$tracked" >&2
    exit 1
  fi
  removed_name="pg""lite"
  if git grep -I -i -n \
    -e "@electric-sql/${removed_name}" \
    -e "@electric-sql/${removed_name}-socket" \
    -e "electric-sql/${removed_name}" \
    -e "postgres-${removed_name}" \
    -e "${removed_name}-build" \
    -e "${removed_name}-bindings" \
    -e "REL_17_5-${removed_name}" \
    -e "pgl_startPG""lite" \
    -e "PG""Lite" \
    -e "${removed_name}" \
    -- ':!target/**' ':!node_modules/**'; then
    echo "removed upstream identifiers remain in tracked source" >&2
    exit 1
  fi
}

case "$scope" in
  postgres18)
    check_postgres18
    ;;
  third-party)
    check_third_party
    ;;
  third-party-shared)
    check_third_party_shared
    ;;
  third-party-native)
    check_third_party_native
    ;;
  third-party-wasix)
    check_third_party_wasix
    ;;
  toolchains)
    check_toolchains
    ;;
  extensions)
    check_postgres18
    check_third_party
    check_extensions
    ;;
  all)
    check_postgres18
    check_third_party
    check_toolchains
    check_extensions
    check_repo_policy
    ;;
  *)
    echo "usage: $0 [postgres18|third-party|third-party-shared|third-party-native|third-party-wasix|toolchains|extensions|all]" >&2
    exit 2
    ;;
esac
