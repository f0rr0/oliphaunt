# WASIX Benchmarks

WASIX benchmark specs and baselines live here. Rust runner implementation and
runtime orchestration stay under `tools/perf` and the WASIX product source tree.

## Browser comparison

The TypeScript SDK includes matched direct/direct and worker/worker comparisons
against pinned PGlite:

```sh
pnpm --dir src/bindings/wasix-ts bench:browser
```

Build the portable WASIX runtime first with
`moon run liboliphaunt-wasix:runtime-portable`. Each topology uses ephemeral
memory, rotates engine order between repetitions, performs an untimed
representative warmup, and retains every raw sample. It covers cold and warm
open, DDL, a 10,000-row set insert, parameterized point reads, indexed 100-row
ranges, aggregates, a decoded 10,000-row scan, a 100-statement transaction,
updates, deletes, and close latency. Exact row-count/checksum assertions and
PostgreSQL durability/WAL checks prevent faster-but-different work. The command
fails unless the paired-sample lower quartile clears the 30% target for every
comparable metric in both topologies; first cold open remains descriptive
because the implementations use different compilation caches.

For a harness smoke check without a full sample set, run:

```sh
pnpm --dir src/bindings/wasix-ts package:build
node src/bindings/wasix-ts/tools/smoke-browser.mjs --benchmark --quick
```
