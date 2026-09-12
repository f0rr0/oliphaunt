# Performance measurements

Benchmarks are optional measurements, not release qualification gates. The native
runner executes fixed workloads against direct, broker, and server modes,
ordinary PostgreSQL, and SQLite. Its JSON includes timings, sample counts,
percentiles, and the selected durability and memory settings.

Build the runtime you intend to measure, then use an explicit library and matching
PostgreSQL tools. From the repository root:

```sh
export LIBOLIPHAUNT_PATH=/absolute/path/to/liboliphaunt.so
export OLIPHAUNT_POSTGRES=/absolute/path/to/postgres
export OLIPHAUNT_INITDB=/absolute/path/to/initdb
benchmarks/perf/run-native.sh target/perf/direct-rtt native-liboliphaunt --engine direct --suite rtt --iterations 100
benchmarks/perf/run-native.sh target/perf/postgres-rtt native-postgres --suite rtt --iterations 100
benchmarks/perf/run-native.sh target/perf/sqlite-speed sqlite --suite speed
```

Use the platform's actual library filename. Native modes are `direct`, `broker`,
and `server`; suites are `rtt`, `speed`, `streaming`, `prepared-updates`, and
`backup-restore`. Native direct mode opens once per process, so run separate
commands for separate suites. The runner rejects unsupported mode/suite pairs.
SQLite supports `speed` and `backup-restore`. Narrow speed-case diagnostics remain
available through the `diagnose-speed-cases` subcommand.

Each output directory is exclusive. It records the command, source and workload
hashes, runner and explicitly supplied runtime binary hashes, compiler/host
context, raw JSON, and diagnostics. A failed run leaves its JSON marked partial.
Source and recorded binary hashes must still match when a run completes. Preserve
any additional runtime assets and configuration used by the run alongside these
records. Use the environment variables above for runtime paths so they are hashed.

Repeat the exact command in fresh output directories when comparing changes.
Keep hardware, engine, client transport, SQL, durability, dataset, and cache state
consistent. Report sample counts and variation; a quick plumbing run does not
establish a performance claim. Review the raw JSON rather than treating an
automatically generated parity verdict as evidence.

WASIX Node and browser measurements retain their own specs and runners:

```sh
moon run perf-tools:wasix-node-measure
moon run perf-tools:wasix-browser-measure
bun run --cwd benchmarks/perf/wasix-node bench:streaming
```

The browser runner uses an installed browser and the same isolated host headers
as the product smoke test. Committed historical baselines and reports under
`benchmarks/` remain historical evidence; they do not qualify current builds.
