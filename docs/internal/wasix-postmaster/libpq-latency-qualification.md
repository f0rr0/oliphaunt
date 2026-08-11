# True-libpq latency qualification

This lane answers a narrower question than the concurrent workload harness:
can one embedded WASIX postmaster serve a persistent libpq request and create,
serve, and reap a reconnecting backend within declared latency ceilings without
leaking host descriptors or changing the measured runtime, native oracle, or
PostgreSQL configuration?

The probe uses `CLOCK_MONOTONIC`. `persistent` measures `PQexec("SELECT 1")` on
an already-open connection. `reconnect` measures the complete `PQconnectdb`,
`SELECT 1`, result cleanup, and `PQfinish` interval. The latter includes guest
backend creation and teardown; neither metric is interchangeable with the
bulk-client wall time or `psql` `\timing` emitted by other lanes.

## Balanced fresh-server design

Run:

```sh
project=src/runtimes/liboliphaunt/wasix-postmaster
"$project/bin/qualify-wasix-libpq-latency.sh" \
  --sealed-carrier \
    target/oliphaunt-wasix-postmaster/carriers/headless-research \
  --blocks 10 \
  --warmup 100 \
  --samples 1000 \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --cgroup-memory-max 256M \
  --cgroup-memory-high 224M \
  --cgroup-swap-max 0 \
  --label embedded-true-libpq-v1
```

The block count must be even. An odd block is native, WASIX, WASIX, native (`ABBA`). An even block is WASIX,
native, native, WASIX (`BAAB`). Every position is a separate invocation of the
concurrent harness and therefore a fresh server and fresh cluster. Adjacent
positions form two native/WASIX pairs per block. Ten blocks produce 20 server
runs per target, 20 same-neighborhood ratios per mode, and equal representation
of native-first and WASIX-first order.

The latency-qualification floor is 10 blocks, 100 warmups, and 1000 measured
calls for each mode on each server. A passing full matrix is classified
`latency-qualified-non-release`; smaller matrices are
`latency-diagnostic-non-release`. Neither classification composes lifecycle
or memory evidence. The lane always uses the controlled checkpoint policy,
zero host-FD growth allowance, `--resource-detail off`, and
`WASIX_PERF_STATS=0`. PSS, cgroup, and PSI evidence belongs in the separate
resource lane; sampler and verbose instrumentation overhead must not enter this
latency distribution. A configured cgroup triple is still enforced: all three
limits are required together, frozen in the pre-run plan and machine result,
and passed explicitly to every fresh-server harness invocation after the
ambient `WASIX_CGROUP_*` variables are removed. This prevents an unrecorded
ambient limit from changing the latency population, but it does not turn the
timed lane into memory evidence. The runner also removes all ten legacy/current wait-dump
environment names—including both perf-prefixed names and
the request/ACK pair `WASIX_WAIT_DUMP_FENCE_REQUEST_FILE` and
`WASIX_WAIT_DUMP_FENCE_ACK_FILE`—before it invokes the harness. Their exact
list is part of the pre-run plan receipt.

## Statistical decision

For each server and mode, the comparator re-opens the raw sample TSV and
independently calculates nearest-rank p50, p95, and p99. For every adjacent
native/WASIX pair it calculates:

```text
WASIX server p95 / native server p95
WASIX server p99 / native server p99
```

It then gates the nearest-rank p95 across the 20 server-pair ratios. Separately,
it gates the nearest-rank p95 across the 20 WASIX server p95 values and across
the 20 WASIX server p99 values. The paired gate controls same-host drift; the
absolute gate prevents an anomalously slow native denominator from concealing
unviable WASIX latency. Server repetitions remain the experimental units—raw
calls from different servers are not pooled and presented as thousands of
independent server observations.

The initial declared defaults are:

| Mode | Max paired p95-ratio distribution p95 | Max paired p99-ratio distribution p95 | Max WASIX server-p95 distribution p95 | Max WASIX server-p99 distribution p95 |
| --- | ---: | ---: | ---: | ---: |
| Persistent | 2.0x | 2.5x | 0.25 ms | 0.40 ms |
| Reconnect | 3.5x | 4.5x | 20 ms | 30 ms |

These are initial viability/regression ceilings, not a claim of native parity.
They were chosen before a qualifying rerun from the retained
`true-libpq-safe-o2-c1-n1000-192m-v1` evidence. That run observed:

| Mode/target | Samples | p95 | p99 | WASIX/native p95 | WASIX/native p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Persistent/native | 1000 | 0.108599 ms | 0.123791 ms | — | — |
| Persistent/WASIX | 1000 | 0.139250 ms | 0.193360 ms | 1.282x | 1.562x |
| Reconnect/native | 1000 | 5.137682 ms | 5.608269 ms | — | — |
| Reconnect/WASIX | 879 | 13.495785 ms | 17.407965 ms | 2.627x | 3.104x |

The retained run is explicitly non-qualifying: the WASIX reconnect stream
ended at 879 of 1000 samples with `connect_error`. Its successful prefix is
used only to set conservative pre-run ceilings and cannot establish that the
product passes them. The new qualifier requires every declared sample from
every server and rejects any failed, missing, duplicated, or reordered row.

## Frozen identities and receipts

Before the first server starts, the runner writes and hashes
`qualification-plan.tsv`. The receipt fixes the matrix size, ordering,
PostgreSQL profiles, finite cgroup binding (or its explicit absence),
instrumentation policy, and all eight gates. It also:

- verifies the sealed carrier twice and freezes the manifest, build receipt,
  payload inventory, and headless binary as one closure identity;
- inventories native `postgres`, `initdb`, `psql`, every regular libpq
  artifact, and libpq symlink topology twice to freeze the native oracle;
- freezes the libpq probe source and requires the rebuilt probe binary to be
  byte-identical in every server run;
- requires the linked libpq path and hash to be one exact regular artifact in
  the frozen native oracle and identical across all native and WASIX runs;
- freezes the named PostgreSQL profile resolution, compares each adjacent
  pair's effective settings, and requires each benchmark's profile receipts
  to match the qualification copies byte-for-byte; and
- re-verifies the plan, probe source, profile sources, carrier closure, and
  native oracle before and after every fresh-server sample.

Input mutation is an authority failure and stops the run. A structurally bad
sample causes the comparator to fail closed without publishing aggregate
receipts. A valid matrix that exceeds a gate still publishes the exact sample
and pair receipts with `failed` gate rows, so the regression remains
diagnosable.

The durable outputs below
`reports/libpq-latency-qualification/<label>/` are:

- `qualification-plan.tsv`: pre-run settings and gate receipt;
- `runs.tsv` and `profile-comparisons.tsv`: fresh-server matrix and pair
  configuration evidence;
- `samples.tsv`: independently validated raw-stream hashes, percentile values,
  lifecycle/FD/instrumentation-policy hashes, and all frozen identities;
- `paired-samples.tsv`: every adjacent pair and its p95/p99 ratios;
- `paired-summary.tsv`: server-level distribution values and gate decisions;
- `sample-identity.tsv`: the single exact carrier/native/probe/libpq/profile
  closure used by all samples; and
- `qualification-result.tsv`: final status and a latency-scoped,
  non-release classification.

Do not weaken the default gates after seeing a candidate's results. A revised
budget needs a new label, written rationale, and prior evidence; keep the old
receipt for comparison.
