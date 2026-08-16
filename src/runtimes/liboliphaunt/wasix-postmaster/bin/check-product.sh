#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(git -C "$project_root" rev-parse --show-toplevel)"
mode="${1:---static}"

fail() {
  printf 'wasix-postmaster product check: %s\n' "$*" >&2
  exit 2
}

run_static() {
  python3 "$project_root/runtime/bin/verify-source-lock.py" \
    --project-root "$project_root" --repo-root "$repo_root"

  python3 - "$project_root" <<'PY'
import json
import pathlib
import sys
import tomllib

root = pathlib.Path(sys.argv[1])
assert (root / "VERSION").read_text(encoding="utf-8").strip() == "0.0.0"
with (root / "release.toml").open("rb") as stream:
    release = tomllib.load(stream)
assert release == {
    "id": "liboliphaunt-wasix-postmaster",
    "owner": "@oliphaunt/wasix",
    "kind": "wasm-runtime",
    "publish_targets": ["github-release-assets"],
    "registry_packages": [],
    "release_artifacts": ["sealed-postmaster-carrier"],
}
assert (root / "CHANGELOG.md").read_bytes() == b""

with (root / "postgres/product-patch-provenance.toml").open("rb") as stream:
    patch_provenance = tomllib.load(stream)
series_paths = {
    f"postgres/patches/{line}"
    for line in (root / "postgres/patches/series").read_text(encoding="utf-8").splitlines()
    if line and not line.startswith("#")
}
provenance_paths = {record["path"] for record in patch_provenance["patch"]}
assert provenance_paths == series_paths, (provenance_paths, series_paths)

policy = root / "runtime/policies/sealed-side-modules.v1.tsv"
rows = []
occupied = set()
for number, line in enumerate(policy.read_text(encoding="utf-8").splitlines(), 1):
    if not line or line.startswith("#"):
        continue
    fields = line.split("\t")
    assert len(fields) == 3, (number, fields)
    relative, raw_aliases, abi = fields
    aliases = [] if raw_aliases == "-" else raw_aliases.split(",")
    assert relative.startswith("lib/") and relative.endswith((".so", ".so.5.18"))
    assert abi
    for candidate in (relative, *aliases):
        assert candidate.startswith("lib/") and candidate not in occupied, candidate
        occupied.add(candidate)
    rows.append(relative)
assert len(rows) == 27, rows

manifest = json.loads((root.parents[3] / ".release-please-manifest.json").read_text())
assert manifest["src/runtimes/liboliphaunt/wasix-postmaster"] == "0.0.0"
PY

  while IFS= read -r script; do
    bash -n "$script"
  done < <(find "$project_root" -type f -name '*.sh' -print | LC_ALL=C sort)

  while IFS= read -r script; do
    python3 - "$script" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
compile(path.read_bytes(), str(path), "exec")
PY
  done < <(find "$project_root" -type f -name '*.py' -print | LC_ALL=C sort)

  if rg -n --glob '!testdata/**' --glob '!**/check-product.sh' \
    'research-only|non-release project|no current-source carrier|historical five-module|prototype carrier' \
    "$project_root"; then
    fail 'active product source still contains a retired research contract'
  fi
}

run_tests() {
  python_tests=(
    lib/durable_publication.test.py
    lib/durable_publication_crash.test.py
    lib/guest_build_provenance.test.py
    lib/immutable-carrier.test.py
    lib/linear_memory_transaction.test.py
    lib/sealed_export_chain.test.py
    lib/signal-owned-pid.test.py
    lib/verify-sealed-carrier.test.py
    runtime/bin/verify-postmaster-concurrency-contract.test.py
    runtime/bin/verify-postmaster-wasm-import.test.py
    runtime/bin/verify-runtime-execution-ownership.test.py
    runtime/bin/verify-runtime-state-ownership.test.py
    runtime/bin/verify-source-lock.test.py
    bin/validate-sealed-loader-audit.test.py
    postgres/patches/0008-wasix-packed-atomic-latch-state.test.py
  )
  shell_tests=(
    lib/common.test.sh
    lib/postgres-profiles.test.sh
    lib/process-supervision.test.sh
    lib/server-lifecycle.test.sh
    bin/build-wasix-core.backend.test.sh
    bin/qualify-wasix-immediate-recovery.test.sh
    bin/regress-suite-name.test.sh
    bin/run-release-carrier.test.sh
    bin/seal-wasix-core-exports.test.sh
    bin/seal-wasix-core-exports.transaction.test.sh
    bin/smoke-wasix-concurrent-options.test.sh
    bin/build-sealed-headless-carrier.test.sh
  )
  for test_file in "${python_tests[@]}"; do
    python3 "$project_root/$test_file"
  done
  for test_file in "${shell_tests[@]}"; do
    bash "$project_root/$test_file"
  done
}

case "$mode" in
  --static) run_static ;;
  --tests) run_tests ;;
  --all)
    run_static
    run_tests
    ;;
  *) fail 'usage: check-product.sh [--static|--tests|--all]' ;;
esac

printf 'wasix-postmaster product %s checks passed\n' "${mode#--}"
