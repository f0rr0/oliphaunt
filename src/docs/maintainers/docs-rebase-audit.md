# Documentation rebase audit — 2026-09-29

## Scope and baseline

Rebased PR #205 onto remote `main` at `32ce7b29510b74333e799601b69a71fd28122e80`. Reviewed all **42 authored public pages**, **44 generated documentation routes**, the root README, and seven SDK READMEs. This record supersedes the September 8 audit for the current checkout; historical registry experiments are not evidence for current packages.

The requested target remains the checkout API, treating its versions as published. Completed GitHub releases can lag that target. Examples resolve `{{release:product-id}}` from the existing Release Please config and manifest, while the version table separately links completed releases. The export includes `docs-version.json` with revision, dirty state, and documented product versions. No registry publication or hosted historical version selector is claimed.

Applied `better-writing`: installation and required resources precede a complete query; persistence and application recipes follow; references stay visible. Removed maintainer implementation/design explanations from the developer path while retaining constraints needed for correct use. The updated [local skill](../../../.codex/skills/write-oliphaunt-docs/SKILL.md) records this process.

The primary-source review drew on [Turso quickstarts](https://docs.turso.tech/sdk/ts/quickstart), [PGlite documentation](https://pglite.dev/docs/), [Supabase React setup](https://supabase.com/docs/guides/getting-started/quickstarts/reactjs), and [Motion React docs](https://motion.dev/docs/react). Adapted their early runnable examples, ecosystem entry points, and separation of setup, recipes, and reference; retained Oliphaunt-specific lifecycle and packaging requirements. Details are in the skill's [research notes](../../../.codex/skills/write-oliphaunt-docs/references/research.md).

## Public page ledger

Every file below was read completely and compared with its current API or route source. This is a source review, not a claim that every recipe was executed. Source locations are indexed in the [source map](../../../.codex/skills/write-oliphaunt-docs/references/source-map.md).

| File | Developer task | Findings and disposition | Evidence inspected |
| --- | --- | --- | --- |
| [learn/embedded-postgres.mdx](../content/learn/embedded-postgres.mdx) | Understand storage and recovery | Distinguished native process-root lifetime from WASIX lifetime; mobile broker now available. | Native/WASIX storage, direct and broker lifecycle |
| [learn/index.mdx](../content/learn/index.mdx) | Find application guides | Reviewed all destinations and descriptions; retained task-based cards. | Route manifest and the five application guides |
| [learn/mobile-stability.mdx](../content/learn/mobile-stability.mdx) | Ship a mobile database | Added Swift, Kotlin, and Expo broker setup, worker-process guard, resource placement, backup/restore, and failure recovery. | Swift broker/templates, Kotlin broker/service, Expo plugin and RN types |
| [learn/native-runtime.mdx](../content/learn/native-runtime.mdx) | Choose direct, broker, or server | Updated mobile broker support and retained only constraints that affect an application. | Rust/TS modes; Swift/Kotlin/RN broker entry points |
| [learn/sqlite-upgrade.mdx](../content/learn/sqlite-upgrade.mdx) | Move an existing application | Reviewed schema, parameter, SQL and data-movement guidance; retained the migration sequence. | PostgreSQL SQL semantics and SDK query/storage APIs |
| [learn/tauri.mdx](../content/learn/tauri.mdx) | Integrate a Rust desktop application | Removed obsolete manual native-resource setup; retained async state, commands, and server ownership. | Rust builder/async/server implementation and Tauri state API |
| [reference/api-reference.mdx](../content/reference/api-reference.mdx) | Find each SDK API | Replaced generated-artifact narration with SDK, guide, and reference links. | All eight SDK route groups |
| [reference/capabilities.mdx](../content/reference/capabilities.mdx) | Compare runtime and platform support | Updated mobile broker capabilities; platform requirements remain generated from policy. | SDK exports and platform compatibility policy |
| [reference/extensions.mdx](../content/reference/extensions.mdx) | Install and enable an extension | Used typed descriptors and per-ecosystem packaging; removed unsupported universal availability claims. | Generated extension surfaces and SDK resolvers |
| [reference/index.mdx](../content/reference/index.mdx) | Find exact integration details | Kept direct links; versions describe the documentation target. | Reference routes |
| [reference/performance.mdx](../content/reference/performance.mdx) | Measure an application workload | Kept reproducible measurement advice; removed shared-engine internals and unsupported performance implications. | Native/WASIX owner and query semantics |
| [reference/releases.mdx](../content/reference/releases.mdx) | Upgrade dependencies and data | Removed obsolete 0.2 defects and build machinery; documented dependency pins, backups, rebuilds and compatibility. | Current SDK fixes, release metadata and backup/restore APIs |
| [reference/sdk-products.mdx](../content/reference/sdk-products.mdx) | Map languages to packages | Corrected package/family mapping without release-pipeline details. | Release config and package manifests |
| [sdk/c-abi/api-reference.md](../content/sdk/c-abi/api-reference.md) | Look up C entry points | Added streaming backup/restore and token-bound stream-input lifetime contract. | Current oliphaunt.h declarations and function comments |
| [sdk/c-abi/guide.mdx](../content/sdk/c-abi/guide.mdx) | Build a language binding | Updated source/header paths; checked terminal close, scheduling and response/error ownership. | C ABI header and native lifecycle implementation |
| [sdk/c-abi/index.mdx](../content/sdk/c-abi/index.mdx) | Open and query through C | Kept prepared-root prerequisite, matching header/library and protocol-result handling; centralized version. | Current oliphaunt.h and native init/query implementation |
| [sdk/index.mdx](../content/sdk/index.mdx) | Find the right SDK | Corrected native/WASIX source layout and retained a single chooser. | SDK manifest and SDK entry points |
| [sdk/kotlin/api-reference.md](../content/sdk/kotlin/api-reference.md) | Look up Kotlin APIs | Corrected extension, ApplicationData storage and broker API descriptions. | Common/Android public types and broker implementation |
| [sdk/kotlin/guide.mdx](../content/sdk/kotlin/guide.mdx) | Build an Android application | Used typed extension descriptors, matched build selection, and linked broker setup. | Kotlin extension/configuration, query and restore APIs |
| [sdk/kotlin/index.mdx](../content/sdk/kotlin/index.mdx) | Install and query on Android | Added Gradle seedProfile requirement and kept File-based persistent storage. | Gradle plugin and Android open/storage API |
| [sdk/react-native/api-reference.md](../content/sdk/react-native/api-reference.md) | Look up React Native APIs | Updated extension types and broker timeouts; separated build topology from runtime configuration. | RN exported types/client and Expo options |
| [sdk/react-native/architecture.mdx](../content/sdk/react-native/architecture.mdx) | Configure native integration | Rewrote integration steps around app setup; corrected awaited manual iOS staging and Gradle seed profile. | Published plugin/staging script and Android resource plugin |
| [sdk/react-native/guide.mdx](../content/sdk/react-native/guide.mdx) | Build a React Native application | Corrected descriptor imports and seed/resource selection; linked broker setup and explicit recovery. | RN client, extensions, native adapters and plugin |
| [sdk/react-native/index.mdx](../content/sdk/react-native/index.mdx) | Install and query on mobile | Added required iOS seed npm dependency and matching Expo build setup. | RN package, seed discovery, Expo plugin and query types |
| [sdk/rust/api-reference.md](../content/sdk/rust/api-reference.md) | Look up native Rust APIs | Reviewed builder, direct/async/broker/server, result, backup and error contracts; retained accurate reference. | Rust public exports, builders, error and result types |
| [sdk/rust/guide.mdx](../content/sdk/rust/guide.mdx) | Build a native Rust application | Selected vector through its extension crate; checked broker restore, transactions and server lifetime. | Rust extension/config, database, session and server APIs |
| [sdk/rust/index.mdx](../content/sdk/rust/index.mdx) | Install and query native PostgreSQL | Removed obsolete runtime archive/environment workaround; corrected temporary-storage lifetime. | Native Rust builder, resources and public query API |
| [sdk/swift/api-reference.md](../content/sdk/swift/api-reference.md) | Look up Swift APIs | Added broker entry point/configuration and corrected resource/extension options. | Swift public actor, broker and configuration types |
| [sdk/swift/guide.mdx](../content/sdk/swift/guide.mdx) | Build an Apple application | Corrected typed extension/resource selection and Bun generator path; linked mobile broker setup. | Swift extension generator, actor transactions and backup/restore |
| [sdk/swift/index.mdx](../content/sdk/swift/index.mdx) | Install and query on Apple platforms | Added required iOS seed package/product; kept macOS initialization distinction. | Swift Package generation, runtime resource discovery and actor API |
| [sdk/typescript/api-reference.md](../content/sdk/typescript/api-reference.md) | Look up JavaScript APIs | Corrected NativeExtension[], restore storage, seed and ICU options. | TS exports and declared types |
| [sdk/typescript/guide.mdx](../content/sdk/typescript/guide.mdx) | Build a desktop JavaScript application | Changed extension selection to descriptors and restore to a DirectoryStorage object; checked broker/server use. | TS config/client, extensions, storage and server provider |
| [sdk/typescript/index.mdx](../content/sdk/typescript/index.mdx) | Install and query from JavaScript | Removed obsolete Linux release warning; added runnable file command and Deno --allow-run for initdb. | Package exports/engines, client and Deno native adapter |
| [sdk/wasix-rust/api-reference.md](../content/sdk/wasix-rust/api-reference.md) | Look up WASIX Rust APIs | Corrected server crate ownership and extension package references. | WASIX exports and separate pgwire server crate |
| [sdk/wasix-rust/dump-restore.mdx](../content/sdk/wasix-rust/dump-restore.mdx) | Export and restore data | Updated optional tools product token; retained physical/logical format distinctions and CLI behavior. | WASIX tools, PgDumpOptions and CLI source |
| [sdk/wasix-rust/guide.mdx](../content/sdk/wasix-rust/guide.mdx) | Build a WASIX Rust application | Used extension crate with WASIX feature; checked transactions, physical backup and async owner. | WASIX extension declarations, owner and database APIs |
| [sdk/wasix-rust/index.mdx](../content/sdk/wasix-rust/index.mdx) | Install and query WebAssembly PostgreSQL | Reviewed memory and directory storage, query example and thread ownership; centralized version. | WASIX Rust exports/builder/storage |
| [sdk/wasix-rust/runtime.mdx](../content/sdk/wasix-rust/runtime.mdx) | Choose execution and server placement | Moved server example to oliphaunt-pgwire-server; removed shared-engine implementation detail. | Pgwire server crate and WASIX owner/storage APIs |
| [sdk/wasix-typescript/api-reference.md](../content/sdk/wasix-typescript/api-reference.md) | Look up WASIX JavaScript APIs | Corrected desktop-only direct import and WasixSeed type name. | WASIX TS export map and types |
| [sdk/wasix-typescript/guide.mdx](../content/sdk/wasix-typescript/guide.mdx) | Build a WASIX JavaScript application | Limited /direct to desktop; removed blanket compiled-extension availability; checked host setup and tools. | Host adapters, storage, extensions and tools package |
| [sdk/wasix-typescript/index.mdx](../content/sdk/wasix-typescript/index.mdx) | Install and query in browsers or desktop JS | Reviewed browser isolation, root/Worker import, IndexedDB persistence and independent version. | WASIX TS package exports, worker and browser storage |
| [start/index.mdx](../content/start/index.mdx) | Choose an ecosystem and run a query | Kept the eight SDK links and short next-task list; no implementation overview. | SDK manifest, package exports, all quickstarts |

## Generated pages and README review

- `reference/version-matrix`: documented versions and completed releases are distinct columns. A unit test prevents older completed releases from selecting example versions.
- `reference/extension-catalog`: generated SQL names, activation and upstream versions remain authoritative; removed misleading availability prose.
- One sidebar exposes all SDK quickstarts, guides and API references, plus shared guides and version lookup. Existing URLs remain intact.
- The root README now links to the relocated assets and maintainer index.
- Native Rust and TypeScript READMEs no longer prescribe superseded runtime workarounds or release defects.
- Swift and Kotlin READMEs link to canonical installation instructions instead of maintaining unsynchronized exact version pins; their first-query and storage examples were reviewed against current types.
- React Native README includes the seed dependency required by the quickstart.
- WASIX Rust and TypeScript READMEs were reviewed against current exports and lifetime/storage behavior; no additional content change was needed.
- The docs README explains authoring, centralized versions, generated platform requirements and static snapshots. Main's Bun toolchain and release-refresh mechanism remain in place.
- Removed the duplicate generator that overwrote Next's Markdown exports. Expanded SDK links and resolved versions now survive publication.
- Complete TypeScript quickstarts are source-type-checked during the production build as well as the explicit docs check.

## Verification

| Check | Result and boundary |
| --- | --- |
| Frozen Bun installation | Passed; no new dependency. Removed the obsolete direct Motion dependency. |
| Docs check | Passed: routes, metadata, source links, MDX/site types, version resolution and three TypeScript quickstarts. |
| Docs tests | Passed: completed-release selection, documented-version selection, live-version verifier and refresh failure handling. |
| Production build and smoke | Passed: 44 documentation routes, 49 HTML files, internal links/anchors, static assets, all routes in Markdown exports, version snapshot and a real Orama backup query. |
| Moon docs format and lint | Passed using repository-pinned Moon 2.5.4. |
| Platform compatibility policy tests | Three passed; no platform floor or support value changed. |
| Skill validator and diff whitespace check | Passed. |
| Native Rust first-query example | Compiled as an external consumer against current source; not executed. |
| WASIX Rust first-query example | Compiled as an external consumer against current source; not executed. |
| C first-query example | Strict C11 syntax check with warnings as errors against the current header; not linked or executed. |
| Native TS, WASIX TS, RN first-query examples | Strict type-checks against source; not runtime execution. |
| Swift, Kotlin, Tauri and native mobile packaging | Source-reviewed; no device, simulator, app package or runtime qualification in this pass. |

The docs build cannot prove that an untested SDK release works on every host. In particular, removing obsolete defect notices follows the fixes present on main, not new cross-platform registry execution.

## Visual review

Reviewed production screenshots at desktop width in light and dark themes and at 390px mobile width. All 44 routes passed a 320px viewport audit: one H1 per page, no page-level horizontal overflow, no unresolved version tokens and no JavaScript errors. Code blocks and tables scroll within the article.

Browser interactions passed: arrow-key installation tabs, code copying with resolved versions, Copy Markdown, Ctrl+K search and navigation to the Rust API result, and opening the mobile sidebar. Clipboard checks required the isolated test browser's clipboard permissions; no site change was needed.

Artifacts remain outside the repository under the thread's visualization directory in `docs-rebase/`: `desktop.png`, `typescript-dark.png`, `swift-mobile.png`, and `layout-audit.json`.
