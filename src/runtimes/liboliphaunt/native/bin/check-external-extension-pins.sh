#!/usr/bin/env sh
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
. "$script_dir/common.sh"
root="$(oliphaunt_resolve_repo_root "$script_dir")"
manifest="$root/src/runtimes/liboliphaunt/native/postgres18/external-extensions.toml"
online=0

case "${1:-}" in
  "")
    ;;
  --online)
    online=1
    ;;
  *)
    echo "usage: src/runtimes/liboliphaunt/native/bin/check-external-extension-pins.sh [--online]" >&2
    exit 2
    ;;
esac

require_line() {
  line="$1"
  if ! grep -Fxq "$line" "$manifest"; then
    echo "external extension source manifest is missing: $line" >&2
    exit 1
  fi
}

check_checkout_if_present() {
  name="$1"
  relative_checkout="$2"
  expected_commit="$3"
  checkout="$root/$relative_checkout"

  if [ ! -d "$checkout/.git" ]; then
    echo "external extension checkout not present for $name: $relative_checkout"
    return 0
  fi

  actual_commit="$(git -C "$checkout" rev-parse HEAD)"
  if [ "$actual_commit" != "$expected_commit" ]; then
    cat >&2 <<MSG
external extension checkout for $name is not at the pinned commit.

Expected: $expected_commit
Actual:   $actual_commit
Path:     $relative_checkout
MSG
    exit 1
  fi
  echo "external extension checkout pin verified for $name: $expected_commit"
}

check_remote_if_requested() {
  name="$1"
  repo="$2"
  ref="$3"
  expected_commit="$4"

  if [ "$online" -eq 0 ]; then
    return 0
  fi

  actual_commit="$(git ls-remote "$repo" "$ref" | awk '{print $1}')"
  if [ "$actual_commit" != "$expected_commit" ]; then
    cat >&2 <<MSG
external extension remote pin for $name no longer resolves as expected.

Repository: $repo
Ref:        $ref
Expected:   $expected_commit
Actual:     ${actual_commit:-<missing>}
MSG
    exit 1
  fi
  echo "external extension remote pin verified for $name: $ref -> $expected_commit"
}

[ -f "$manifest" ] || {
  echo "missing external extension source manifest: $manifest" >&2
  exit 1
}

require_line 'schema = "liboliphaunt-external-extensions-v2"'
require_line 'pg_major = 18'

if grep -Eq '^[[:space:]]*pack[[:space:]]*=' "$manifest"; then
  echo "external extension manifest must not declare extension selection aliases; select exact extensions only" >&2
  exit 1
fi

require_line 'id = "pggraph"'
require_line 'sql_name = "graph"'
require_line 'module_stem = "graph"'
require_line 'upstream = "https://github.com/evokoa/pggraph.git"'
require_line 'source_ref = "main"'
require_line 'commit = "4ea3c3206811deda03de136b4f465a2cf9bc8e72"'
require_line 'checkout = "target/oliphaunt-sources/checkouts/pggraph"'
require_line 'source_subdir = "graph"'
require_line 'license = "Apache-2.0"'
require_line 'redistribution = "allowed"'
require_line 'pgrx_version = "0.18.0"'
require_line 'pg_feature = "pg18"'

require_line 'id = "paradedb-pg-search"'
require_line 'sql_name = "pg_search"'
require_line 'module_stem = "pg_search"'
require_line 'upstream = "https://github.com/paradedb/paradedb.git"'
require_line 'source_ref = "v0.23.4"'
require_line 'commit = "c07921a78f3d24cbb0251b31a1150a7db600af5a"'
require_line 'checkout = "target/oliphaunt-sources/checkouts/paradedb"'
require_line 'source_subdir = "pg_search"'
require_line 'license = "AGPL-3.0"'
require_line 'redistribution = "requires-commercial-license"'
require_line 'pgrx_version = "0.18.0"'
require_line 'pg_feature = "pg18"'
require_line 'requires_shared_preload = true'

check_checkout_if_present \
  pggraph \
  target/oliphaunt-sources/checkouts/pggraph \
  4ea3c3206811deda03de136b4f465a2cf9bc8e72

check_checkout_if_present \
  paradedb-pg-search \
  target/oliphaunt-sources/checkouts/paradedb \
  c07921a78f3d24cbb0251b31a1150a7db600af5a

check_remote_if_requested \
  pggraph \
  https://github.com/evokoa/pggraph.git \
  HEAD \
  4ea3c3206811deda03de136b4f465a2cf9bc8e72

check_remote_if_requested \
  paradedb-pg-search \
  https://github.com/paradedb/paradedb.git \
  refs/tags/v0.23.4 \
  c07921a78f3d24cbb0251b31a1150a7db600af5a

echo "external extension source pins passed"
