# React Native Oliphaunt Expo Example

This is a real Expo development-build app for validating
`@oliphaunt/react-native` against the Kotlin Android SDK and the New
Architecture JSI `ArrayBuffer` transport.

The first screen is a small field-ops task board rather than a static smoke
screen. On launch it opens one direct database, creates a
project/task/event schema, seeds 240 tasks in a transaction, updates work items
in a second transaction, runs parameterized aggregate/search queries, and logs
latency percentiles through `OLIPHAUNT_EXPO_SMOKE_PASS`.

The installed-app smoke activates the generated mobile extension set and runs
the extension-specific runtime proofs, including the pgvector HNSW query.

Fast Android smoke:

```sh
pnpm run smoke
pnpm run smoke:android
```

`pnpm run smoke` is the default installed-app harness: it runs the Android and
iOS Expo development-client smokes through the repository validation script.
Use `smoke:android` or `smoke:ios` when only one simulator/device stack is
available.

The default local dev command is the Expo development-client harness with local
Expo MCP capabilities enabled, not Expo Go:

```sh
pnpm start
pnpm run android:start
pnpm run ios:start
```

The automated smoke, benchmark, and crash scripts start their own
development-client Metro server with local MCP enabled by default so the native
runner receives the same env on every machine. If port 8081 is busy, they choose
a free port in 8082-8099 unless `OLIPHAUNT_EXPO_*_METRO_PORT` is set explicitly.
Set `OLIPHAUNT_EXPO_*_REUSE_METRO=1` only when manually attaching to a Metro
process that already has the desired `EXPO_PUBLIC_OLIPHAUNT_*` env.

Device benchmark runs use the same native build/package path but launch the app
with the benchmark runner. They emit `OLIPHAUNT_EXPO_BENCH_PASS` and write the
parsed JSON report under `target/oliphaunt-expo-<platform>-benchmark/reports/`.
The report includes typed and parameterized RTT, set-based insert throughput,
JS timer liveness, effective PostgreSQL settings, and checkpoint latency. The
platform harness records process memory and built artifact sizes separately. A
same-device Expo SQLite WAL baseline uses its own explicit SQLite durability
profile so comparisons do not invent an Oliphaunt durability mode:

```sh
pnpm run bench:android
pnpm run bench:ios
```

Process-death recovery runs use the same dev-client build but launch a
two-phase crash harness. The write phase opens persistent app-private storage,
writes committed data, and leaves the database open. The platform script then
force-stops/terminates the app process and relaunches the verify phase against
the same storage with a fresh phase-specific dev-client bundle, expecting
PostgreSQL recovery to make the committed row visible. Before writing, the app
verifies the effective PostgreSQL `fsync`, `full_page_writes`, and
`synchronous_commit` settings are all `on`:

```sh
pnpm run crash:android
pnpm run crash:ios
```

The runners choose isolated persistent storage by default. Set
`OLIPHAUNT_EXPO_ANDROID_CRASH_STORAGE` or
`OLIPHAUNT_EXPO_IOS_CRASH_STORAGE` to override it; the iOS runner accepts an
`app-data:<name>` selector for the public `applicationData` storage case.

The smoke script:

- packs the current React Native SDK when sources changed;
- installs the packed SDK into this Expo app when needed;
- runs Expo prebuild for Android when the ignored generated `android/` project
  is missing;
- builds clean Android `liboliphaunt` runtime resources with runtime files,
  a standard cluster seed, package-size evidence, and `liboliphaunt.so`;
- builds and installs the dev-client APK;
- launches through Expo dev-client and waits for
  `OLIPHAUNT_EXPO_SMOKE_PASS` from logcat.

Useful overrides:

```sh
OLIPHAUNT_EXPO_MOBILE_STARTUP_GUCS=shared_buffers=8MB,wal_buffers=-1 pnpm run bench:android
OLIPHAUNT_EXPO_MOBILE_BENCHMARK_PRESET=quick pnpm run bench:android
OLIPHAUNT_EXPO_ANDROID_SKIP_BUILD=1 pnpm run smoke:android
OLIPHAUNT_EXPO_ANDROID_KEEP_METRO=1 pnpm run smoke:android
OLIPHAUNT_EXPO_ANDROID_REPACKAGE_ASSETS=1 pnpm run smoke:android
OLIPHAUNT_EXPO_ANDROID_GRADLE_CONFIGURATION_CACHE=1 pnpm run smoke:android
OLIPHAUNT_EXPO_ANDROID_RUNTIME_DIR=/path/to/runtime pnpm run smoke:android
OLIPHAUNT_EXPO_ANDROID_SEED_CLOSURE_DIR=/path/to/android-datum64-runtime-closure pnpm run smoke:android
OLIPHAUNT_EXPO_ANDROID_OLIPHAUNT_SO=/path/to/liboliphaunt.so pnpm run smoke:android
```

Expo smoke and benchmark tuning uses explicit PostgreSQL startup GUCs through
`OLIPHAUNT_EXPO_MOBILE_STARTUP_GUCS`.
`tools/perf/matrix/run_mobile_footprint_matrix.sh`
prints or runs the full Android/iOS device matrix, stores each case in its own
scratch directory, and writes `summary.json` plus `summary.md` under
`target/perf/mobile-footprint-<run-id>/`. Matrix cases run the benchmark and,
by default, process-death recovery lanes under the same explicit GUCs and
PostgreSQL safe defaults.
Pass `--quick` to the matrix wrapper, or set
`OLIPHAUNT_EXPO_MOBILE_BENCHMARK_PRESET=quick` directly, when validating harness
changes; leave the default full preset for reportable performance numbers.
Use the matrix axis filters for iterative tuning slices, for example:

```sh
../../../../../tools/perf/matrix/run_mobile_footprint_matrix.sh --quick --platform android \
  --shared-buffers 8MB,32MB,128MB \
  --wal-buffers -1 \
  --min-wal-size 32MB \
  --max-wal-size 64MB \
  --crash-recovery off
```

The harness defaults to `--no-configuration-cache` for the Expo app because the
generated Expo Gradle files currently resolve React Native/Expo paths through
Node during configuration. Keep configuration cache opt-in until that upstream
behavior changes.

Fast iOS build/smoke harness:

```sh
OLIPHAUNT_EXPO_IOS_OLIPHAUNT_XCFRAMEWORK=/path/to/liboliphaunt.xcframework \
OLIPHAUNT_EXPO_IOS_RUNTIME_DIR=/path/to/postgres-runtime \
OLIPHAUNT_EXPO_IOS_SEED_CLOSURE_DIR=/path/to/ios-datum64-runtime-closure \
pnpm run smoke:ios
```

Use `OLIPHAUNT_EXPO_IOS_BUILD_ONLY=1` when you only want the generated Expo iOS
project, CocoaPods integration, bundled resources, and Xcode build checked. The
script rejects macOS `liboliphaunt.dylib` artifacts; iOS validation needs an iOS
simulator/device build of `liboliphaunt`. For an unsigned generic iPhoneOS
compile/package check, set `OLIPHAUNT_EXPO_IOS_SDK=iphoneos`,
`OLIPHAUNT_EXPO_IOS_BUILD_ONLY=1`, and
`OLIPHAUNT_EXPO_IOS_CODE_SIGNING_ALLOWED=NO`; install/launch benchmarks still
require a runnable paired phone and valid signing.

Physical iOS runs use Xcode's `devicectl` path:

```sh
OLIPHAUNT_EXPO_IOS_SDK=iphoneos \
OLIPHAUNT_EXPO_IOS_OLIPHAUNT_XCFRAMEWORK=/path/to/liboliphaunt.xcframework \
OLIPHAUNT_EXPO_IOS_RUNTIME_DIR=/path/to/postgres-runtime \
OLIPHAUNT_EXPO_IOS_SEED_CLOSURE_DIR=/path/to/ios-datum64-runtime-closure \
pnpm run bench:ios
```

Set `OLIPHAUNT_EXPO_IOS_DEVICE_ID` to pick a specific paired device, and
`OLIPHAUNT_EXPO_IOS_METRO_URL` if the device cannot reach the host address that
the harness auto-detects. Device crash-recovery runs default to the public
`{ kind: 'applicationData', name }` storage case, which the platform SDK
resolves inside the app sandbox and which survives process death.

Physical-device runs require a working Apple Development signing setup. The
harness first checks that the paired phone has Developer Mode and Developer Disk
Image services available through `devicectl`, then uses
`OLIPHAUNT_EXPO_IOS_DEVELOPMENT_TEAM` when set, otherwise it uses the single
team configured in Xcode. If Xcode has multiple teams configured, set
`OLIPHAUNT_EXPO_IOS_DEVELOPMENT_TEAM` explicitly. If no local signing identity
is installed the harness fails before doing the expensive Expo/CocoaPods work; set
`OLIPHAUNT_EXPO_IOS_ALLOW_PROVISIONING_UPDATES=1` to explicitly allow
`xcodebuild -allowProvisioningUpdates` and device registration when the Xcode
account session is valid. Override with `OLIPHAUNT_EXPO_IOS_CODE_SIGN_IDENTITY`,
`OLIPHAUNT_EXPO_IOS_PROVISIONING_PROFILE_SPECIFIER`, or
`OLIPHAUNT_EXPO_IOS_ALLOW_PROVISIONING_UPDATES=0` for locked-down local/CI
signing.

The iPhone must be unlocked and awake when `devicectl` launches the development
client. If a physical run already built and installed the app but launch failed
because the device was locked, retry without rebuilding:

```sh
OLIPHAUNT_EXPO_IOS_REUSE_INSTALLED_APP=1 \
OLIPHAUNT_EXPO_IOS_SDK=iphoneos \
OLIPHAUNT_EXPO_IOS_DEVICE_ID=<device-udid> \
pnpm run crash:ios
```

The physical iOS smoke harness exercises background/foreground automatically:
after the app reaches `lifecycle:ready`, it opens Safari, waits
`OLIPHAUNT_EXPO_IOS_BACKGROUND_SECONDS` seconds, then foregrounds the same
installed app and verifies SQL still works on the resumed database.

Expo local MCP capabilities are installed through `expo-mcp`:

```sh
pnpm run mcp:version
pnpm run mcp:start
```

`mcp:start` is an alias for the default `pnpm start` dev-client/MCP harness,
which is the local tool path for screenshots, app logs, DevTools, and automation
from MCP-capable agents. Expo's remote MCP server requires Expo OAuth/EAS
access, so the repo keeps local CLI/dev-client validation as the default
reproducible path.

EAS CLI is intentionally used through `npx eas-cli@latest` for build-service
operations so the example does not pin a stale global CLI:

```sh
npx eas-cli@latest --version
```

Baseline local checks:

```sh
pnpm run typecheck
pnpm run lint -- --max-warnings=0
npx expo-doctor
```
