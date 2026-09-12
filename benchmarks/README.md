# Benchmarks

Fixed SQL workloads, benchmark specs, baselines, and promoted reports live here.
The native runner compares direct, broker, and server modes with PostgreSQL and
SQLite. WASIX Node/browser and mobile workloads retain their own runners.

Use `benchmarks/perf/run-native.sh OUTPUT_DIRECTORY COMMAND [OPTIONS...]` for one
native measurement with source/build identity and raw JSON. See
[measurement instructions](../docs/maintainers/performance-evidence.md) for commands
and comparison requirements. Optional matrices, generated verdicts, and report
verification gates have been retired.

- `native/sql/`: fixed native SQL workloads.
- `native/baselines/`: historical native baselines.
- `wasix/`: WASIX specs and baselines.
- `mobile/`: mobile specs and baselines.
- `reports/`: retained published measurements.
- `perf/`: executable benchmark runners.
