# Performance

`pglite-oxide` is built to stay close to native Postgres while keeping the
database embedded in the Rust process.

This page tracks the repo benchmark matrix. The main comparison uses SQLx on
each wire-protocol path:

- native Postgres with SQLx;
- `pglite-oxide + SQLx`;
- vanilla `@electric-sql/pglite` persisted with NodeFS and reached through
  `@electric-sql/pglite-socket`, then measured with SQLx.

## Snapshot

Snapshot run: `20260507T113000Z`

Environment:

- OS: `macOS 26.4.1 (Darwin 25.4.0 arm64)`
- CPU: `Apple M1 Pro`
- RAM: `16 GB`
- Logical cores: `10`
- Node: `v24.13.0`
- Node packages: `@electric-sql/pglite@0.4.5`,
  `@electric-sql/pglite-socket@0.1.5`
- Native Postgres: `18.3 (Homebrew)`
- Oxide Wasmer: `7.2.0-alpha.2`
- Oxide Wasmer WASIX: `0.702.0-alpha.2`
- RTT iterations: `100`
- Speed source: exact upstream SQL from
  `assets/checkouts/pglite/packages/benchmark/src`

Every mode was run serially.

## Representative Operations

Lower is better.

| Operation | native pg + SQLx | pglite-oxide + SQLx | vanilla PGlite + SQLx |
|---|---:|---:|---:|
| 25,000 INSERTs in one transaction | 132.36 ms | 149.54 ms | 257.02 ms |
| 25,000 INSERTs in one statement | 46.14 ms | 59.39 ms | 117.19 ms |
| 25,000 INSERTs into an indexed table | 188.72 ms | 253.38 ms | 352.64 ms |
| 5,000 indexed SELECTs | 81.39 ms | 125.31 ms | 203.05 ms |
| 25,000 indexed UPDATEs | 351.05 ms | 578.96 ms | 720.63 ms |

## Full Operation Table

| ID | Test | native pg + SQLx | pglite-oxide + SQLx | vanilla PGlite + SQLx |
|---|---|---:|---:|---:|
| 1 | Test 1: 1000 INSERTs | 9.13 ms | 19.76 ms | 15.66 ms |
| 2 | Test 2: 25000 INSERTs in a transaction | 132.36 ms | 149.54 ms | 257.02 ms |
| 2.1 | Test 2.1: 25000 INSERTs in single statement | 46.14 ms | 59.39 ms | 117.19 ms |
| 3 | Test 3: 25000 INSERTs into an indexed table | 188.72 ms | 253.38 ms | 352.64 ms |
| 3.1 | Test 3.1: 25000 INSERTs into an indexed table in single statement | 66.41 ms | 95.12 ms | 93.88 ms |
| 4 | Test 4: 100 SELECTs without an index | 107.63 ms | 162.89 ms | 242.03 ms |
| 5 | Test 5: 100 SELECTs on a string comparison | 305.38 ms | 338.01 ms | 434.63 ms |
| 6 | Test 6: Creating indexes | 9.94 ms | 13.08 ms | 17.12 ms |
| 7 | Test 7: 5000 SELECTs with an index | 81.39 ms | 125.31 ms | 203.05 ms |
| 8 | Test 8: 1000 UPDATEs without an index | 47.91 ms | 74.42 ms | 103.66 ms |
| 9 | Test 9: 25000 UPDATEs with an index | 351.05 ms | 578.96 ms | 720.63 ms |
| 10 | Test 10: 25000 text UPDATEs with an index | 471.74 ms | 712.38 ms | 858.95 ms |
| 11 | Test 11: INSERTs from a SELECT | 65.64 ms | 97.43 ms | 112.87 ms |
| 12 | Test 12: DELETE without an index | 7.54 ms | 9.74 ms | 11.69 ms |
| 13 | Test 13: DELETE with an index | 9.31 ms | 26.58 ms | 27.7 ms |
| 14 | Test 14: A big INSERT after a big DELETE | 53 ms | 71.6 ms | 87.72 ms |
| 15 | Test 15: A big DELETE followed by 12000 small INSERTs | 58.98 ms | 74.49 ms | 112.18 ms |
| 16 | Test 16: DROP TABLE | 3.43 ms | 10.17 ms | 6.74 ms |

## Reproduce

Run the serial matrix:

```sh
scripts/perf/run_bench_matrix.sh
```

That command runs:

1. `pglite-oxide + SQLx` RTT + speed benchmarks
2. native Postgres + SQLx RTT + speed benchmarks
3. vanilla PGlite + SQLx RTT + speed benchmarks
4. a markdown comparison report

Outputs land under `target/perf/`:

- `bench-oxide-<run-id>.json`
- `bench-native-postgres-sqlx-<run-id>.json`
- `bench-pglite-nodefs-sqlx-<run-id>.json`
- `bench-pglite-nodefs-sqlx-ready-<run-id>.json`
- `bench-comparison-<run-id>.md`

Override the native Postgres binaries when needed:

```sh
PGLITE_OXIDE_NATIVE_POSTGRES=/path/to/postgres \
PGLITE_OXIDE_NATIVE_INITDB=/path/to/initdb \
scripts/perf/run_bench_matrix.sh
```

## Reading The Matrix

- `pglite-oxide + SQLx` is the product-style path for apps that connect through
  standard Postgres clients.
- `vanilla PGlite + SQLx` keeps upstream PGlite on NodeFS, but uses the same Rust
  SQLx client path as the other wire-protocol rows.
- These are machine-local numbers. Re-run the matrix before quoting them in a
  release note or public comparison.
