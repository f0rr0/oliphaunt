# Native PostgreSQL patch stack

The ordered native recipe lives in
[`postgres/series`](../../native/runtime/postgres/series),
and the shared source pin lives in
[`source.toml`](../../third-party/postgres/source.toml).
Each patch header explains its change. Platform builders apply that series with
`git apply --whitespace=error-all` before compiling PostgreSQL.

Run the native runtime build and its C ABI, SQL, lifecycle, and extension tests
for behavioral evidence. Source fragments, author headers, and a generated
review table do not prove those behaviors and no longer gate qualification.

## Correctness consolidation

Patch 0021 models trusted embedded sessions: catalog identity, normal admission
and wraparound protections without pretending an absent postmaster exists.
Patch 0022 keeps cancellation, timers, wakeups, signal masks and COPY deadlines
inside the embedding boundary. Its narrower changes supersede the former
0021 wake-epoll-self-pipe patch; they are not an optional performance switch.

The native bridge no longer injects `-F`. PostgreSQL's default `fsync=on` is
preserved unless the caller explicitly chooses otherwise. This can increase
directory-write latency; reopening a database is not crash-durability proof.
Startup/cleanup, configured identity and host working-directory restoration
must be checked through the real C ABI, not inferred from patch formatting.

The [September consolidation record](PATCH_CONSOLIDATION_20260907.md) preserves
the prior results and unresolved platform limitations. Its checks and timings
do not qualify the current refreshed tree. The shared collation patch now comes
from `src/third-party/postgres/patches/common/`; keep main's shared source layout.
