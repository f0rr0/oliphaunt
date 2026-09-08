# Oliphaunt documentation sources

Paths are relative to the repository root. Recheck them when the code moves.

## Content and generation

| Source | Use |
| --- | --- |
| `src/docs/content/` | Authored public pages; read every file in scope |
| `src/docs/docs-manifest.toml` | Route ownership, section order, sidebar entries, required SDK pages |
| `src/docs/tools/generate-content.mjs` | Copies/normalizes MDX; generates extension catalog, version matrix, API index, navigation, and version snapshot |
| `src/docs/src/lib/source.ts`, `src/docs/src/app/llms*` | Markdown text and exports from the same generated pages as the site |
| `src/docs/tools/generate-api-reference.mjs` | SDK API documentation generation |
| `tools/policy/sdk-manifest.toml` | SDK package identity, snippet ownership, supported documentation surfaces |
| `.release-please-manifest.json`, SDK `release.toml` files | Repository versions and publication identities; verify publication separately |
| `src/docs/src/components/mdx.tsx`, `src/docs/src/app/global.css` | Available content components and site styling |
| `src/docs/tools/check-docs-snippets.mjs` | Strict source type-checks for complete TypeScript quickstarts; does not execute the database |
| `src/docs/README.md` | Version tokens, build snapshots, generated platform data, authoring commands |
| `src/docs/source.config.ts` | Fumadocs source and search processing |
| `docs/maintainers/`, other `docs/` records | Authoring/engineering evidence, not public integration instructions |

`target/docs/` is generated. Fix its source instead of editing output. Before removing a page or component, search content, navigation, Markdown exports, tests, and callers.

## SDK contracts

| SDK | First sources to inspect |
| --- | --- |
| Rust | `src/sdks/rust/src/lib.rs`, `builder.rs`, `database.rs`, `session.rs`, `storage.rs`, `server.rs`, `error.rs`; `tests/public_api.rs`, `tests/native_smoke.rs`; `Cargo.toml` |
| TypeScript | `src/sdks/js/src/index.ts`, `types.ts`, `client.ts`; `package.json`, `README.md`, tests and package export map |
| Swift | `src/sdks/swift/Sources/Oliphaunt/`, `Package.swift`, `README.md`; released package-generation code for binary products |
| Kotlin | `src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/OliphauntAndroid.kt`; `src/commonMain/kotlin/`; `README.md` and Gradle plugin sources |
| React Native | `src/sdks/react-native/src/index.ts`, `client.ts`; shared JS types, Expo plugin, `README.md` and native integration tests |
| WASIX TypeScript | `src/bindings/wasix-ts/src/index.ts`, `types.ts`, `client.ts`, storage adapters, worker/server entry points; `tools-package/src/index.ts`; package export map |
| WASIX Rust | `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs`, `src/oliphaunt/`, `Cargo.toml`; integration tests and examples |
| C ABI | `src/runtimes/liboliphaunt/native/include/oliphaunt.h`; implementation, ABI tests, and managed-root setup |

Follow types into implementations for error recovery, transaction ownership, persistence, cancellation, restore compatibility, and shutdown. Read platform packaging code before claiming that an install command includes all required runtime assets.

## Regression examples for this skill

These were concrete accuracy problems found during the September 2026 rewrite. Verify the implementation again before using them as current facts.

- Native direct mode stays bound to one root/configuration for the process lifetime. Closing does not permit opening restored data at another root; use broker mode on desktop or a subsequent process launch on mobile.
- Kotlin `DatabaseStorage.Directory` receives `java.io.File`; mechanically reusing a JavaScript path string breaks the quickstart.
- A PostgreSQL connection URL does not own the Rust server. A Tauri example must retain the server handle as long as its pool needs it.
- Native and WASIX SDKs differ in defaults, storage adapters, concurrency, cancellation, and optional tools. A method present in one binding is not evidence for another.
- A Swift source checkout and the generated release package can expose different packaging details. Match installation instructions to the consumer artifact.
- Snippet comments in MDX identify ownership; they do not themselves execute or compare code. Report the actual validation level.

## Commands

Use the repository's required shell wrapper (`rtk`) where configured.

```sh
rtk proxy pnpm --dir src/docs check
rtk proxy pnpm --dir src/docs build
rtk proxy pnpm --dir src/docs smoke
```

Read `src/docs/package.json` and its task scripts before choosing a narrower command. Check `qualify-oliphaunt-change` when SDK code or release products also change. Do not run publication or native release qualification merely for a prose edit.

For browser review, use the existing docs dev command and a free localhost port. Capture screenshots outside published content; keep review artifacts and per-file findings in the maintainer audit. Do not check in generated site output.
