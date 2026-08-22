# WASIX Benchmarks

WASIX benchmark specs and baselines live here. Runner implementations and
runtime orchestration stay under `tools/perf` and the WASIX product source tree.

## Browser comparison

`browser-pglite-memory-v1.json` defines matched direct/direct and worker/worker
comparisons against exact PGlite 0.5.4:

```sh
pnpm --dir src/bindings/wasix-ts bench:browser
# or: moon run oliphaunt-wasix-ts:bench-browser
```

Build the portable WASIX runtime first with
`moon run liboliphaunt-wasix:runtime-portable`. Each topology uses ephemeral
memory, rotates engine order between repetitions, performs an untimed
representative warmup, and retains every raw sample. It covers cold and warm
open, DDL, a 10,000-row set insert, parameterized point reads, indexed 100-row
ranges, aggregates, a decoded 10,000-row scan, a 100-statement transaction,
updates, deletes, and close latency. Exact row-count/checksum assertions and
PostgreSQL durability/WAL checks prevent faster-but-different work. For each
topology independently, the command computes the geometric mean of the median
same-run Oliphaunt/PGlite ratios and requires it to be at most `0.80`. One
topology therefore cannot subsidize the other. First cold open remains
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

The direct OPFS path has a separate advisory comparison against PGlite's OPFS
access-handle-pool worker path:

```sh
node src/bindings/wasix-ts/tools/smoke-browser.mjs --diagnostic-opfs --quick
```

It uses durable PostgreSQL settings on both worker engines and prints the raw
configuration and medians. It is deliberately not evaluated with the
memory-only plan or its gate; direct/direct remains memory while worker/worker
uses OPFS.

## Node comparison

`node-pglite-memory-v1.json` is the deterministic Node comparison plan for the
public `@oliphaunt/wasix-ts` package and the exact PGlite control named in the
plan. The executable harness lives in `tools/perf/wasix-node`. It runs both
engines with memory storage in matched worker/worker and direct/direct
placements. It alternates which engine runs first across ten fresh-process
pairs per placement and gates each placement independently, so a strong worker
result cannot hide a weak direct result or vice versa.

Startup is one cold-to-first-result metric; public-open and
immediate-first-query components remain visible without receiving separate
gate weight. PGlite's published benchmark times `pg.exec()` inside a browser
worker. Its official worker library requires browser Worker and Web Locks APIs,
so this Node harness owns a deliberately small `worker_threads` RPC adapter and
times both public APIs end-to-end from the Node host, including exactly one
worker RPC for each engine. PGlite's official benchmark methodology is retained
as provenance only: calls return public results without collecting or
serializing comparator-only internal timing. Direct placement times both
packages around their caller-thread public APIs.

Bulk timing sends identical PostgreSQL Simple Query bytes through both public
`execProtocolRaw` APIs and, in worker placement, transfers both raw responses
across the worker edge.
The untimed verifier decodes the timed response's command tags and result rows,
then validates the resulting database state. Gate eligibility also requires
all recorded PostgreSQL settings to match across every candidate/control run.
Generated SQL is bounded by the compact row counts in the plan; upstream
generated benchmark files are not vendored.

Validate the plan without runtime assets with
`moon run oliphaunt-wasix-ts:bench`. After building the portable runtime, run
the uncached local measurement with
`moon run oliphaunt-wasix-ts:bench-run`. Each run writes machine-readable JSON
and a compact Markdown table under `target/perf`; it passes only when canonical
timed-response/result hashes and PostgreSQL settings agree and the geometric
mean of median paired Oliphaunt/PGlite ratios is at most `0.80`. Reports pin the
comparator tarball integrity and installed tree hash, and record the complete
resolved installed closure of each engine. The candidate package fixture also
requires its runtime module to match the canonical asset manifest and build
outputs, then records the full build-profile signature plus the exact outputs
digest. The checked-in plan rejects anything other than the qualified
`release` profile with `-O2 -g0 -flto=thin` and a ThinLTO final link.
