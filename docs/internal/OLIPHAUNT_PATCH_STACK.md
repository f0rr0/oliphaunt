# Native PostgreSQL patch stack

The ordered patches and source pin live in
[`source.toml`](../../src/runtimes/liboliphaunt/native/postgres18/source.toml).
Each patch header explains its change. Platform builders apply that series with
`git apply --whitespace=error-all` before compiling PostgreSQL.

Run the native runtime build and its C ABI, SQL, lifecycle, and extension tests
for behavioral evidence. Source fragments, author headers, and a generated
review table do not prove those behaviors and no longer gate qualification.
