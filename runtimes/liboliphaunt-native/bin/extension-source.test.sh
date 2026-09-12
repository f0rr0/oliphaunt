#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-extension-source.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/extensions/generated"
printf 'name\tmodule\tsource\nfixture_sql\tfixture_module\ttarget/oliphaunt-sources/checkouts/fixture_upstream\n' > "$fixture/extensions/generated/pgxs-build.tsv"
# Both SQL identity and upstream alias locate the same checkout from another cwd.
cd "$fixture"
sql="$(oliphaunt_native_external_extension_source_rel "$fixture" fixture_sql)"
alias="$(oliphaunt_native_external_extension_source_rel "$fixture" fixture_upstream)"
test -n "$sql"
test "$sql" = "$alias"
if oliphaunt_native_external_extension_source_rel "$fixture" missing > "$fixture/result"; then exit 1; fi
test ! -s "$fixture/result"
printf 'Extension source lookup checks passed\n'
