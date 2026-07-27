# Oliphaunt Internal README

> Archived product-copy draft; non-normative. The repository root `README.md`,
> `docs/maintainers/README.md`, and executable product metadata describe the
> current product and release contract.

This draft is retained only as implementation history. It predates the current
Oliphaunt root README and must not be used to infer release status, package
identity, or supported targets.

Native-first embedded PostgreSQL for application developers who want PostgreSQL
semantics without running a separate database service.

The long-term product is a small family of native SDKs over the same engine:

- direct embedded mode for the lowest-latency in-process Tauri and Rust desktop
  apps;
- broker mode for robust desktop apps that need crash isolation today. The
  durable multi-root daemon is the longer-term broker shape and is not
  advertised as available until it exists;
- server mode for real PostgreSQL client compatibility with `psql`, `pg_dump`,
  ORMs, and connection pools.

This repository now has two product lanes:

- `liboliphaunt`: the C ABI boundary over embedded PostgreSQL 18.
- `oliphaunt`: the Rust SDK built on that native boundary.

The existing `oliphaunt-wasix` WASIX release lane is preserved in
`src/bindings/wasix-rust/crates/oliphaunt-wasix` while native parity is built out. It remains separate from
the native SDK so we can keep the legacy release path stable without shaping the
new architecture around it. Native Rust APIs are not routed through
`oliphaunt-wasix`; they live in `oliphaunt`.

SDK ownership is explicit. Rust is the SDK for Tauri and Rust desktop apps,
Swift is the SDK for iOS and macOS apps, Kotlin is the SDK for Android apps,
and React Native is the TypeScript/TurboModule SDK over the Swift and Kotlin
SDKs. TypeScript is the SDK for Node.js, Bun, and Deno. Tauri apps currently
keep Oliphaunt in Rust state behind narrow app-owned commands; a direct
JavaScript/webview adapter is planned, not part of the first release.
SDK features should have parity where the platform can support them honestly;
platform support is summarized in the
[`Capability Matrix`](../../src/docs/content/reference/capabilities.mdx),
with the maintainer contract in
[`SDK Parity`](../maintainers/sdk-parity-policy.md).

## Layout

- `src/runtimes/liboliphaunt/native/`: C ABI, PostgreSQL 18 source pin, patch stack, native build and
  smoke harnesses.
- `src/sdks/rust/`: native Rust SDK surface.
- `src/bindings/wasix-rust/crates/oliphaunt-wasix/`: existing WASIX-based Rust package.
- `src/runtimes/liboliphaunt/wasix/crates/assets/` and `src/runtimes/liboliphaunt/wasix/crates/aot/`: packaged WASIX release assets.
- `src/sdks/swift/`, `src/sdks/kotlin/`, `src/sdks/react-native/`,
  and `src/sdks/js/`: platform and runtime SDKs.
- `tools/policy/sdk-manifest.toml`: SDK ownership registry used by parity checks.
- `tools/`: repo automation, including `xtask` and validation scripts.
- `benchmarks/`: benchmark plans and future cross-engine harnesses.
- `src/docs/`: public Fumadocs/Next docs product, generated matrices,
  tested snippets, API-reference stubs, and LLM docs.
- Public SDK docs live under `src/docs/content/sdk/`; product roots
  keep only package README/CHANGELOG files and source-adjacent API comments.
- `docs/`: architecture, release, development, maintainer, and internal source
  material.
- `docs/internal/`: maintainer-only progress notes and generated patch-stack
  audits.

See [repo-structure.md](../maintainers/repo-structure.md) for the repository policy and the evidence behind
the layout.

## Current Native Status

The native track is usable as an active development lane, not yet a default
release replacement:

- macOS arm64 native `liboliphaunt` builds against PostgreSQL 18.4;
- the C smoke opens, executes raw protocol queries, recovers after SQL errors,
  streams a large protocol response, closes, and reopens the same PGDATA from a
  new process;
- the Rust SDK for Tauri and Rust desktop apps exposes `NativeDirect`,
  `NativeBroker`, and `NativeServer`;
- broker mode uses Unix-domain sockets on Unix platforms, with explicit TCP
  fallback for portability and debugging, and enforces the selected bootstrap
  policy inside the helper;
- direct and broker expose same-version physical backup/restore, while server
  mode also exposes logical SQL backup through packaged `pg_dump`;
- the gated native extension matrix creates or loads release-ready PostgreSQL 18
  extensions by exact SQL name, then verifies restart and physical restore
  through broker/direct-C-ABI and server paths;
- Rust, Swift, Kotlin, React Native, and TypeScript SDK lanes track the same product
  concepts where platform constraints allow it, with platform status summarized
  in `src/docs/content/reference/capabilities.mdx`;
- the benchmark matrix measures native direct, broker, server, native
  PostgreSQL controls, and SQLite comparison data without entering the legacy
  WASIX release lane.

Maintainers track release-claim evidence and open blocker audits in
[OLIPHAUNT_TRACK_REVIEW.md](OLIPHAUNT_TRACK_REVIEW.md).

## Common Commands

```sh
moon query projects
moon query tasks
moon run repo:check
moon run :check
moon run :test
moon run :package
moon run :coverage
moon run liboliphaunt-native:host-smoke
moon run oliphaunt-react-native:smoke-mobile
moon run oliphaunt-js:check
```

Moon is the contributor command surface. `.prototools` pins Moon, Node, pnpm,
Bun, and Deno. Use pnpm to install JavaScript workspace dependencies when
working on JavaScript-family projects; do not use it as a repo-wide task
router. Bun is required for the
TypeScript SDK check because Bun installs `@oliphaunt/ts` from npm; Deno is
used by strict JSR consumer-release gates.

React Native installed-app validation uses the Expo development-client example
as the default harness because the package always exercises custom Swift/Kotlin
native code. `moon run oliphaunt-react-native:smoke-android`,
`moon run oliphaunt-react-native:smoke-ios`, and
`moon run oliphaunt-react-native:smoke-mobile` run the installed app lanes.
`moon run oliphaunt-react-native:check` is the package-only TypeScript,
Codegen, and native-source lane. `moon run
oliphaunt-js:check` validates the desktop JavaScript SDK, including npm and JSR
package shape.

For liboliphaunt work, use the product Moon tasks above. Product inner loops
should use `moon run <product>:check` and `moon run <product>:test`; CI lanes
use `moon ci` through `.github/scripts/run-moon-ci.sh`.

## Native Performance Matrix

After building `liboliphaunt`, run:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh
```

For fast local plumbing checks:

```sh
cargo build -p oliphaunt-perf
target/debug/oliphaunt-perf native-liboliphaunt --engine direct --suite rtt --iterations 10
target/debug/oliphaunt-perf native-liboliphaunt --engine broker --suite rtt --iterations 10
target/debug/oliphaunt-perf native-liboliphaunt --engine server --suite rtt --iterations 10
```

The native matrix opts in to `perf-runner support explicitly, so ordinary
asset/release automation does not compile legacy WASIX or benchmark-only code.
Use `--quick` for a one-repeat plumbing run and `--plan-only` to inspect the
native-only command plan without checking artifacts or building anything.
Focused diagnostic runs can select one engine or suite without changing the
release default:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh \
  --quick --engines broker --suites streaming
```

Selector runs are for local evidence and debugging. Release evidence uses the
default all-engine/all-suite matrix.
