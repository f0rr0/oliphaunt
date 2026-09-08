# Published-package documentation verification

Checked on 2026-09-08 after the September releases, using fresh projects outside the workspace. No SDK source aliases or workspace dependencies were used in the executed consumer checks.

## Release and API alignment

| Surface | Published version | Evidence |
| --- | --- | --- |
| Native Rust | 0.2.0 | Installed from crates.io; API source matches `oliphaunt-rust-v0.2.0`. |
| Native TypeScript | 0.2.0 | Installed from npm; API source matches `oliphaunt-js-v0.2.0`. |
| Swift | 0.7.0 | SwiftPM tag `0.7.0` has the documented products, Swift 6/iOS 17/macOS 14 requirements, and a matching published XCFramework asset. API source matches the tag. |
| Kotlin | 0.2.0 | Maven Central serves both the Android package POM and Gradle plugin marker POM; API source matches `oliphaunt-kotlin-v0.2.0`. |
| React Native | 0.2.0 | npm metadata confirms React 19+, React Native 0.85+, and Expo 56+ peers. API source matches the release tag. |
| WASIX TypeScript | 0.1.0 | Installed from npm; API source matches the release tag. |
| WASIX Rust | 0.2.0 | Installed from crates.io; API source matches the release tag. |
| Optional WASIX tools / pgTAP | 0.1.0 / 0.2.0 | Installed from npm and executed. |
| Native runtime / vector | 0.2.0 / 0.2.0 | Native GitHub archive downloaded and used; vector npm version confirmed. |

All seven SDK API source trees are unchanged between this docs checkout and their published source tags. This preserves the earlier page-by-page API audit, but does not establish that packaging or every runtime integration works.

Primary package endpoints: [native npm SDK](https://registry.npmjs.org/@oliphaunt/ts/0.2.0), [WASIX npm SDK](https://registry.npmjs.org/@oliphaunt/wasix-ts/0.1.0), [React Native metadata](https://registry.npmjs.org/@oliphaunt/react-native/0.2.0), [Kotlin POM](https://repo.maven.apache.org/maven2/dev/oliphaunt/oliphaunt-android/0.2.0/oliphaunt-android-0.2.0.pom), [Kotlin plugin marker](https://repo.maven.apache.org/maven2/dev/oliphaunt/android/dev.oliphaunt.android.gradle.plugin/0.2.0/dev.oliphaunt.android.gradle.plugin-0.2.0.pom), [Swift manifest](https://github.com/f0rr0/oliphaunt/blob/0.7.0/Package.swift), [native release](https://github.com/f0rr0/oliphaunt/releases/tag/liboliphaunt-native-v0.2.0).

## Executed consumer checks

Host: Linux x64 GNU, Node.js 24.18.0, Bun 1.4.2. The workspace packages were not substituted for registry releases.

- **WASIX TypeScript:** the exact first-query example printed `42`. Additional checks passed parameter binding, transaction commit/rollback, persistent close/reopen, physical backup/restore, pgTAP loading, a Worker handle, and logical `pgDump`/`psql` round-trip restoration.
- **WASIX Rust:** the exact first-query example compiled from crates.io dependencies, ran, and printed `42`.
- **Native Rust:** the original first-query example compiled but failed without `LIBOLIPHAUNT_PATH`. With the complete GitHub runtime archive under `OLIPHAUNT_RESOURCES_DIR/native-runtime/liboliphaunt-native` and `LIBOLIPHAUNT_PATH` pointing to its library, the same example printed `42`. These prerequisites are now documented.
- **Native TypeScript:** a fresh npm install succeeded, but the exact first-query example failed in both Node and Bun with PostgreSQL's invalid data-directory permissions error. Changing the execution umask did not resolve it. This is now disclosed in the quickstart, SDK README, and upgrade reference.

## Release defects found

1. Native TypeScript copies the installed cluster seed with `fs.cp` and does not normalize the PGDATA root permissions. The installed seed root in this consumer was mode `0775`, while PostgreSQL accepts `0700` or `0750`. This prevents the default fresh database from reaching ReadyForQuery. No SDK patch or replacement package was published during this docs task.
2. Native Rust's `register_build_resources!()` macro expands to the private `Error::InvalidConfig` associated function and fails with E0624 in an external consumer. Calling the public registration function directly compiles, but does not resolve the next defects.
3. Native Rust library lookup still requires `LIBOLIPHAUNT_PATH`; registering a build resource directory does not configure it.
4. The Cargo-staged native cluster seed omitted required empty directories: after explicitly setting the library path, initialization failed on missing `pg_notify`. The complete GitHub archive preserves these directories and works. The documented setup therefore uses that archive rather than the broken helper path.

These are observations against the published 0.2.0 packages. Do not advance the limitation text to a later version automatically; remove or revise it only after repeating the fresh-consumer checks on a fixed release.

## Boundaries

Swift, Kotlin, React Native, browser IndexedDB/OPFS, C ABI execution, and non-Linux native targets were not executed in this environment. Registry presence, source equivalence, and platform metadata checks are not substitutes for app builds or device tests. No blanket claim that all released integrations work is justified.

Consumer projects and logs are retained locally under `/tmp/oliphaunt-published-docs-audit/`. `pnpm --dir src/docs check`, `build`, and `smoke` passed after the corrections (49 exported HTML files). Their passing result does not override the native TypeScript failure.
