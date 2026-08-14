# WASIX Node Bulk/DDL Performance Review (2026-08-14)

## Scope

- Re-ran WASIX asset release build with perf probe settings on core-only lane
- Ran Node benchmark plan `benchmarks/wasix/node-pglite-memory-v1.json`
- Captured a paired candidate-vs-PGlite report in:
  - `target/perf/wasix-node-run-20260814/report.json`
  - `target/perf/wasix-node-run-20260814/report.md`

## Commands executed

```bash
OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1 cargo run -p xtask --features template-runner -- assets release-build --profile release --target-triple x86_64-unknown-linux-gnu --skip-aot --skip-package-size --fetch
node tools/perf/wasix-node/benchmark.mjs --run --config benchmarks/wasix/node-pglite-memory-v1.json --output target/perf/wasix-node-run-20260814
```

## Result summary

- Gate: **PASS**
- Worker geomean ratio: **0.7612** (required <= 0.80)
- Direct geomean ratio: **0.6940** (required <= 0.80)
- Candidate startup is still significantly faster than PGlite
  - Worker cold-to-first-result median ratio: `0.400`
  - Direct cold-to-first-result median ratio: `0.383`

### Bulk/DDL findings

The remaining problematic area is still bulk insert / table-creation path:

- Worker placement:
  - `bulk/insert-series/elapsed`: `1.175` (median paired ratio)
  - `bulk/create-index/elapsed`: `1.029`
  - `bulk/indexed-update/elapsed`: `0.584`
- Direct placement:
  - `bulk/insert-series/elapsed`: `1.466`
  - `bulk/create-index/elapsed`: `1.020`
  - `bulk/indexed-update/elapsed`: `0.572`

`bulk/create-index` is mostly parity-level but not yet beating PGlite; `bulk/insert-series` remains clearly slower, especially in direct mode.

## Practical conclusions

1. **Startup profile is healthy** and above the gate; this should not block release-readiness for warm-path latency.
2. **Insertion throughput is still the hot gap** in both worker and direct placements; this is likely protocol-path or planner/tuple-formation overhead, not index DDL overhead.
3. The direct path has larger regression than worker on insert (`1.466` vs `1.175`) even though direct rtt/lookup/update is faster elsewhere, suggesting direct-mode payload setup or result-shape processing is the differentiator there.

## Next targeted checks

- Inspect `bulk/insert-series` pipeline for per-batch protocol/message reuse opportunities in the Node direct backend.
- Validate whether a small-batch variant of `bulk/insert-series` can reuse prepared statement or extended protocol in a way that is not already covered by current `execProtocolRaw` path.
- Compare direct-node protocol traces for insert-only against worker-node to separate host-transport vs protocol-core effects.
