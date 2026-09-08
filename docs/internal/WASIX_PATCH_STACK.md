# WASIX PostgreSQL patch stack

The ordered patches live in
[`patches/series`](../../src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/series);
the PostgreSQL source pin lives in
[`versions/18/source.toml`](../../src/postgres/versions/18/source.toml).
Each patch header explains its change. The WASIX builder applies that series
before compiling the runtime.

Use the built runtime's protocol and extension tests for behavioral evidence.
Source fragments and generated review tables no longer gate qualification.
The concurrent Postmaster runtime has its own source, patches, and recovery tests.
