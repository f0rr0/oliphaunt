# WASIX Benchmarks

WASIX benchmark specs and baselines live here. Rust runner implementation and
runtime orchestration stay under `tools/perf` and the WASIX product source tree.

## Browser comparison

The TypeScript SDK includes a worker-for-worker comparison against PGlite:

```sh
pnpm --dir src/bindings/wasix-ts bench:browser
```

Build the portable WASIX runtime first with
`moon run liboliphaunt-wasix:runtime-portable`. The primary comparison runs
both engines with ephemeral memory storage in dedicated Web Workers. It also
records direct PGlite as an explicitly unequal-topology control, alternates
engine order between repetitions, and retains every raw sample. It covers cold
and warm open, DDL, a 10,000-row set insert, parameterized point reads, indexed 100-row
ranges, aggregates, a decoded 10,000-row scan, a 100-statement transaction,
updates, deletes, and close latency. Summary rows report Oliphaunt's percentage
advantage and whether it clears the 25% target.

For a harness smoke check without a full sample set, run:

```sh
pnpm --dir src/bindings/wasix-ts package:build
node src/bindings/wasix-ts/tools/smoke-browser.mjs --benchmark --quick
```
