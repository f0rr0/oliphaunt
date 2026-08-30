# WASIX Benchmarks

WASIX benchmark specs and baselines live here. Runner implementations and
runtime orchestration stay under `tools/perf` and the WASIX product source tree.

## Browser comparison

`browser-pglite-memory-v2.json` defines two explicit comparisons against exact
PGlite 0.5.4. Oliphaunt's caller-owned root Promise API is measured against
PGlite's caller-realm API; Oliphaunt's explicit `/worker` entrypoint is measured
against PGlite's official Worker API. Both APIs in the direct pair return
promises, but Oliphaunt executes guest work in the calling realm while that
promise is pending. The plan and result record each surface's entry point,
calling contract, and execution owner separately, using the canonical `caller`
and `sdk-worker` ownership values, so Promise shape is not mistaken for
main-thread safety.

```sh
pnpm --dir src/bindings/wasix-ts bench:browser
# or: moon run oliphaunt-wasix-ts:bench-browser
```

Build the portable WASIX runtime first with
`moon run liboliphaunt-wasix:runtime-portable`. Each comparison uses ephemeral
memory, rotates engine order between repetitions, performs an untimed
representative warmup, and retains every raw sample. It covers cold and warm
open, DDL, a 10,000-row set insert, parameterized point reads, indexed 100-row
ranges, aggregates, a decoded 10,000-row scan, a 100-statement transaction,
updates, deletes, and close latency. Exact row-count/checksum assertions and
PostgreSQL durability/WAL checks prevent faster-but-different work. For each
execution comparison independently, the command computes the geometric mean of
the median same-run Oliphaunt/PGlite ratios and requires it to be at most `0.80`.
The direct result therefore cannot subsidize the Worker result, or vice
versa. First cold open remains
descriptive because the implementations use different compilation caches;
close is descriptive because the public APIs make different worker-reclamation
guarantees; insert decomposition remains diagnostic so it cannot overweight the
primary insert workload. Machine-readable JSON and a compact Markdown report
are written under `target/perf`. Benchmark runs require a clean worktree and
record the exact Git commit and tree, runtime and staged host build identities,
the built SDK tree, every harness source, and the installed PGlite closure.

For a harness smoke check without a full sample set, run:

```sh
pnpm --dir src/bindings/wasix-ts package:build
node src/bindings/wasix-ts/tools/smoke-browser.mjs --benchmark --quick
```

Quick mode still requires every workload assertion and durability/WAL parity,
but is explicitly ineligible for performance qualification.

The explicit `/worker` OPFS path has a separate advisory comparison against
PGlite's OPFS access-handle-pool Worker path:

```sh
node src/bindings/wasix-ts/tools/smoke-browser.mjs --diagnostic-opfs --quick
```

It uses durable PostgreSQL settings on both Worker engines and prints the raw
configuration and medians. It is deliberately not evaluated with the
memory-only plan or its gate; the caller-owned direct comparison remains in
memory while the Worker comparison uses OPFS.

## Node comparison

`node-pglite-memory-v2.json` is the deterministic Node comparison plan for the
public `@oliphaunt/wasix-ts` package and the exact PGlite control named in the
plan. The executable harness lives in `tools/perf/wasix-node`. It compares the
real `@oliphaunt/wasix-ts/worker` entrypoint with a harness-owned PGlite Worker,
and the blocking `@oliphaunt/wasix-ts/direct` entrypoint with PGlite's
caller-realm API. Both use memory storage. The harness
alternates which engine runs first across ten fresh-process pairs per
comparison and gates them independently, so a strong isolated result cannot
hide a weak direct result or vice versa. Both Worker candidates own real Worker
threads, while Oliphaunt's Worker loads its synchronous Node-API `/direct`
placement. The direct comparison has matched execution
ownership and Promise-shaped public APIs; the plan and report separately record
that Oliphaunt performs guest work in the caller realm while its promise is
pending.

Startup is one cold-to-first-result metric; public-open and
immediate-first-query components remain visible without receiving separate
gate weight. PGlite's published benchmark times `pg.exec()` inside a browser
worker. Its official worker library requires browser Worker and Web Locks APIs,
so this Node harness owns a deliberately small `worker_threads` RPC adapter and
times both public APIs end-to-end from the Node host, including exactly one
isolation RPC for each engine. PGlite's official benchmark methodology is
retained as provenance only: calls return public results without collecting or
serializing comparator-only internal timing. The caller-owned comparison times
both packages around their public Promise APIs and does not imply that either
implementation yields the caller realm while database work runs.

Bulk timing sends identical PostgreSQL Simple Query bytes through both public
`execProtocolRaw` APIs and, in the Worker comparison, transfers both raw responses
across the worker edge.
The untimed verifier decodes the timed response's command tags and result rows,
then validates the resulting database state. Gate eligibility also requires
all recorded PostgreSQL settings to match across every candidate/control run.
Generated SQL is bounded by the compact row counts in the plan; upstream
generated benchmark files are not vendored.

Validate the plan without runtime assets with
`moon run oliphaunt-wasix-ts:bench`. The uncached measurement deliberately does
not build its large native prerequisite. Stage the portable/AOT runtime, ICU,
and extension inputs, then build and smoke the optimized carrier for the
current host before running it:

```sh
bash src/runtimes/wasix-napi/tools/build-native.sh
moon run oliphaunt-wasix-ts:bench-run
```

Each run writes machine-readable JSON
and a compact Markdown table under `target/perf`; it passes only when canonical
timed-response/result hashes and PostgreSQL settings agree and the geometric
mean of median paired Oliphaunt/PGlite ratios is at most `0.80`. Reports pin the
comparator tarball integrity and installed tree hash, and record the complete
resolved installed closure of each engine. The candidate package fixture also
requires its native carrier binary to match its recorded artifact provenance and
its embedded runtime module to match the canonical asset manifest and build
outputs. Reports record the carrier target, binary digest, artifact source,
payload build inputs, native Cargo profile, and full guest build-profile
signature. The checked-in plan rejects anything other than a non-incremental
one-codegen-unit native `release` build with thin LTO and the qualified guest
`release` profile with `-O2 -g0 -flto=thin`.

For an advisory placement, raw-streaming, server, tool, event-loop, and RSS
comparison, build the staged SDK and runtime assets plus that optimized native
carrier, then run:

```sh
pnpm --dir tools/perf/wasix-node bench:streaming
# exhaustive 1 KiB / 1 MiB / 64 MiB and 1 / 4 / 16 database profile
node tools/perf/wasix-node/streaming-quick.mjs --full --json
```

Its v3 report measures the default Rust actor, blocking `/direct`, and real
`/worker` placements separately. It reports p50/p95/p99 latency, actor and
Worker overhead relative to direct, streaming throughput and backpressure, and
representative event-loop and RSS observations. It is descriptive rather than
a qualification gate. This is also the canonical actor-versus-direct overhead
measurement; the PGlite gate above deliberately compares execution placements
with matched caller/Worker ownership.
