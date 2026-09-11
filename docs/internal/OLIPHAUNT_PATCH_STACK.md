# Native PostgreSQL patch stack

The ordered native recipe lives in
[`postgres/series`](../../src/runtimes/liboliphaunt/native/postgres/series),
and the shared source pin lives in
[`source.toml`](../../src/postgres/versions/18/source.toml).
Each patch header explains its change. Platform builders apply that series with
`git apply --whitespace=error-all` before compiling PostgreSQL.

Run the native runtime build and its C ABI, SQL, lifecycle, and extension tests
for behavioral evidence. Source fragments, author headers, and a generated
review table do not prove those behaviors and no longer gate qualification.
