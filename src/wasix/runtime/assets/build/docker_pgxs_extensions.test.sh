#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
export OLIPHAUNT_PGXS_TEST_ROOT="$fixture"
build_scripts="$fixture/src/wasix/runtime/assets/build"
mkdir -p "$build_scripts" "$fixture/bin" "$fixture/build/src/backend" "$fixture/postgres/src/makefiles"
touch "$fixture/build/config.status" "$fixture/build/src/backend/oliphaunt"
printf 'test\n' > "$fixture/build/.oliphaunt-wasix-build-profile"
sha256sum "$fixture/build/config.status" > "$fixture/build/.oliphaunt-wasix-bridge-sha256"
cat > "$build_scripts/profile_flags.sh" <<'SH'
oliphaunt_wasix_apply_wasix_profile() { :; }
oliphaunt_wasix_wasix_profile_signature() { echo test; }
SH
cat > "$build_scripts/source_lane.sh" <<'SH'
oliphaunt_wasix_check_source_markers() { :; }
oliphaunt_wasix_verify_side_module_sjlj() { :; }
SH
touch "$build_scripts/docker_wasix_env.sh"
printf '#!/usr/bin/env bash\necho\n' > "$build_scripts/pg_config_wasix.sh"
chmod +x "$build_scripts/pg_config_wasix.sh"

# Run the actual Docker payload locally with harmless source/build fixtures.
# Only the container mount path and prerequisite toolchain are substituted.
cat > "$fixture/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == image ]]; then exit 0; fi
while [[ "$1" != bash ]]; do
  if [[ "$1" == -e ]]; then export "$2"; shift; fi
  shift
done
payload="${3//\/work\//$OLIPHAUNT_PGXS_TEST_ROOT/}"
cd "$OLIPHAUNT_PGXS_TEST_ROOT"
exec bash -c "$payload"
SH
chmod +x "$fixture/bin/docker"

# Use the generated SQL-only row, plus a compiled extension with one make arg.
awk -F '\t' '$1 == "pg_partman"' "$repo_root/src/extensions/generated/pgxs-build.tsv" > "$fixture/plan.tsv"
test -s "$fixture/plan.tsv"
printf 'age\tage\tfixture-age\tage.so\textensions/age.tar.zst\tSIZEOF_DATUM=4\n' >> "$fixture/plan.tsv"
partman_source="$(cut -f3 "$fixture/plan.tsv" | head -1)"
mkdir -p "$fixture/$partman_source" "$fixture/fixture-age"
cat > "$fixture/$partman_source/Makefile" <<'MAKE'
SCRIPTS = unwanted-tools
DOCS = unwanted-docs
all:
	@test "$(NO_BGW)" = 1
	@test -z "$(SCRIPTS)"
	@test -z "$(DOCS)"
	@touch flags-verified
clean:
	@true
MAKE
cat > "$fixture/fixture-age/Makefile" <<'MAKE'
all:
	@test "$(SIZEOF_DATUM)" = 4
	@touch age.so flags-verified
clean:
	@true
MAKE

DOCKER="$fixture/bin/docker" \
  JOBS=2 OLIPHAUNT_WASM_SKIP_IMAGE_BUILD=1 \
  CONTAINER_PGSRC="$fixture/postgres" \
  CONTAINER_BUILD_DIR="$fixture/build" \
  CONTAINER_ROOT="$build_scripts" \
  CONTAINER_PLAN="$fixture/plan.tsv" \
  bash "$script_dir/docker_pgxs_extensions.sh"
test -f "$fixture/build/pgxs/pg_partman/flags-verified"
test -f "$fixture/build/pgxs/age/flags-verified"
echo 'WASIX PGXS generated plan passes each make argument to the actual build'
