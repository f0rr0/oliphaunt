# Documentation rewrite audit — 2026-09-08

## Scope and target

All **41 authored public pages** were read file by file and rewritten. All **44 generated routes** remain available: the authored pages plus the extension catalog, version matrix, and API index. The root README and seven public SDK READMEs were also rewritten. The docs-app README and design notes now describe the actual authoring workflow.

The target is the current checkout, with its package versions treated as published as requested. Registry availability is not claimed as verified. Native/WASIX/runtime/extension products retain independent versions. Historical architecture, maintainer policies, and engineering reports are classified below and remain outside public content; they were not rewritten as consumer guides.

Research was completed before the rewrite and distilled into the repository-local [authoring skill](../../.codex/skills/write-oliphaunt-docs/SKILL.md), [source map](../../.codex/skills/write-oliphaunt-docs/references/source-map.md), and [primary-source research](../../.codex/skills/write-oliphaunt-docs/references/research.md). No external skill bundle or publishing service was installed.

## Public page ledger

Paths below are relative to `src/docs/content/`. Every listed page was rewritten. Source review identifies the implementation inspected; the validation ledger below distinguishes compilation from execution.

| File | Original problem | Result | Source review |
| --- | --- | --- | --- |
| [`learn/embedded-postgres.mdx`](../../src/docs/content/learn/embedded-postgres.mdx) | Mixed storage internals and repeated extension introductions. | Storage choices, ownership, SQL, and recovery explained once. | Native/WASIX storage implementations; SDK close and transaction contracts. |
| [`learn/index.mdx`](../../src/docs/content/learn/index.mdx) | Custom route map repeated the suggested paths. | Task-oriented guide index. | All six guide routes. |
| [`learn/mobile-stability.mdx`](../../src/docs/content/learn/mobile-stability.mdx) | Broad assurances and close/reopen language hid application responsibilities. | Application ownership, persistent paths, background writes, restore across launches, and failure recovery. | Swift actor; Kotlin owner dispatcher; RN client and platform adapters. |
| [`learn/native-runtime.mdx`](../../src/docs/content/learn/native-runtime.mdx) | Mode matrix mixed concepts, packaging, and generic SDK narration. | Direct/broker/server choice, session counts, ownership, and process-root lifetime. | Rust direct/server; JS runtime providers; native detach semantics. |
| [`learn/sqlite-upgrade.mdx`](../../src/docs/content/learn/sqlite-upgrade.mdx) | A custom concept map took space without a concrete migration sequence. | Schema/type differences, parameter example, migration sequence, and selection tradeoffs. | PostgreSQL types and SQL; SDK storage/backup contracts. |
| [`learn/tauri.mdx`](../../src/docs/content/learn/tauri.mdx) | Server helper returned only a connection URL, dropping its process owner. | Async managed database state, bound commands, retained server ownership, packaging, and shutdown. | Rust async/server implementation; Tauri state and command docs. |
| [`reference/capabilities.mdx`](../../src/docs/content/reference/capabilities.mdx) | Custom summary mixed products and feature selection. | Runtime feature comparison plus platform requirements generated from policy. | SDK implementations; platform-compatibility-policy.mjs. |
| [`reference/extensions.mdx`](../../src/docs/content/reference/extensions.mdx) | Artifact-flow diagrams, package validation, and repeated selection rules. | Select, package, enable SQL, handle dependencies, and upgrade. | Generated extension registry; SDK extension resolver/build integrations. |
| [`reference/index.mdx`](../../src/docs/content/reference/index.mdx) | Custom lookup and steps described how to read reference. | Direct links to the lookups a developer needs. | Reference route manifest. |
| [`reference/performance.mdx`](../../src/docs/content/reference/performance.mdx) | Decorative result grid and release measurements implied a reusable performance conclusion. | Measure startup/query/durability costs, compare equivalent workloads, and record conditions. | Actual SDK execution and storage behavior; no fabricated benchmark results. |
| [`reference/releases.mdx`](../../src/docs/content/reference/releases.mdx) | First-release history and release machinery dominated consumer upgrade guidance. | Dependency compatibility, upgrade steps, version map, and honest build snapshots. | Release graph, centralized version substitutions, docs-version.json. |
| [`reference/sdk-products.mdx`](../../src/docs/content/reference/sdk-products.mdx) | Release-product taxonomy duplicated SDK choice. | Package mapping and independent-version meaning; URL retained. | SDK and release manifests. |
| [`sdk/c-abi/api-reference.md`](../../src/docs/content/sdk/c-abi/api-reference.md) | Lookup prose was sparse or mixed generated-artifact commentary with contract detail. | Visible API reference: entry points, options/defaults, operations, results, errors, and lifecycle limits. | Native oliphaunt.h, ABI implementation and C smoke. |
| [`sdk/c-abi/guide.mdx`](../../src/docs/content/sdk/c-abi/guide.mdx) | Long step/proof/summary wrapper repeated installation and mixed application recipes. | Managed-root preparation, off-thread scheduling, response/error capture ownership, terminal close. | Native oliphaunt.h, ABI implementation and C smoke. |
| [`sdk/c-abi/index.mdx`](../../src/docs/content/sdk/c-abi/index.mdx) | Repeated SdkLanding/first-query sections and responsibilities delayed the runnable path. | Prepared-root prerequisite; complete C program; response ownership and SQL-versus-transport status. | Native oliphaunt.h, ABI implementation and C smoke. |
| [`sdk/index.mdx`](../../src/docs/content/sdk/index.mdx) | Repeated chooser, mode matrix, and navigation instructions. | A single language/runtime chooser and shared concepts link. | SDK manifest; package entry points. |
| [`sdk/kotlin/api-reference.md`](../../src/docs/content/sdk/kotlin/api-reference.md) | Lookup prose was sparse or mixed generated-artifact commentary with contract detail. | Visible API reference: entry points, options/defaults, operations, results, errors, and lifecycle limits. | Kotlin Android facade, common query types, Gradle plugin, native owner. |
| [`sdk/kotlin/guide.mdx`](../../src/docs/content/sdk/kotlin/guide.mdx) | Long step/proof/summary wrapper repeated installation and mixed application recipes. | Typed params; transactions; matching Gradle/runtime selections; restore on next launch. | Kotlin Android facade, common query types, Gradle plugin, native owner. |
| [`sdk/kotlin/index.mdx`](../../src/docs/content/sdk/kotlin/index.mdx) | Repeated SdkLanding/first-query sections and responsibilities delayed the runnable path. | Matching plugin/dependency versions; coroutine example; Directory takes File. | Kotlin Android facade, common query types, Gradle plugin, native owner. |
| [`sdk/react-native/api-reference.md`](../../src/docs/content/sdk/react-native/api-reference.md) | Lookup prose was sparse or mixed generated-artifact commentary with contract detail. | Visible API reference: entry points, options/defaults, operations, results, errors, and lifecycle limits. | RN index/client, peer dependencies, config plugin, Swift/Kotlin adapters. |
| [`sdk/react-native/architecture.mdx`](../../src/docs/content/sdk/react-native/architecture.mdx) | Transport internals and boundary diagram dominated app integration. | Native integration: Expo/bare iOS and Android packaging, lifecycle, and extension requirements. | RN config plugin; CocoaPods/Gradle integrations; Swift/Kotlin adapters. |
| [`sdk/react-native/guide.mdx`](../../src/docs/content/sdk/react-native/guide.mdx) | Long step/proof/summary wrapper repeated installation and mixed application recipes. | Transactions; install/select/rebuild extensions; restore on next launch; errors and shutdown. | RN index/client, peer dependencies, config plugin, Swift/Kotlin adapters. |
| [`sdk/react-native/index.mdx`](../../src/docs/content/sdk/react-native/index.mdx) | Repeated SdkLanding/first-query sections and responsibilities delayed the runnable path. | New Architecture and Expo native-build prerequisites; typed first query and app-data storage. | RN index/client, peer dependencies, config plugin, Swift/Kotlin adapters. |
| [`sdk/rust/api-reference.md`](../../src/docs/content/sdk/rust/api-reference.md) | Lookup prose was sparse or mixed generated-artifact commentary with contract detail. | Visible API reference: entry points, options/defaults, operations, results, errors, and lifecycle limits. | Rust builder, direct/async owners, rows/DecodeError, server, liboliphaunt adapter. |
| [`sdk/rust/guide.mdx`](../../src/docs/content/sdk/rust/guide.mdx) | Long step/proof/summary wrapper repeated installation and mixed application recipes. | Idiomatic queries/transactions; mode choice; extensions; restored root uses broker; cleanup. | Rust builder, direct/async owners, rows/DecodeError, server, liboliphaunt adapter. |
| [`sdk/rust/index.mdx`](../../src/docs/content/sdk/rust/index.mdx) | Repeated SdkLanding/first-query sections and responsibilities delayed the runnable path. | Complete compiled parameterized query; compatible error type and native storage lifetime. | Rust builder, direct/async owners, rows/DecodeError, server, liboliphaunt adapter. |
| [`sdk/swift/api-reference.md`](../../src/docs/content/sdk/swift/api-reference.md) | Lookup prose was sparse or mixed generated-artifact commentary with contract detail. | Visible API reference: entry points, options/defaults, operations, results, errors, and lifecycle limits. | Swift Oliphaunt actor/types; Package.swift and released package/extension generator. |
| [`sdk/swift/guide.mdx`](../../src/docs/content/sdk/swift/guide.mdx) | Long step/proof/summary wrapper repeated installation and mixed application recipes. | Queries/transactions; physical restore on next launch; actual generated extension product workflow. | Swift Oliphaunt actor/types; Package.swift and released package/extension generator. |
| [`sdk/swift/index.mdx`](../../src/docs/content/sdk/swift/index.mdx) | Repeated SdkLanding/first-query sections and responsibilities delayed the runnable path. | SwiftPM product installation, async function with imports/cleanup, and app-owned URL. | Swift Oliphaunt actor/types; Package.swift and released package/extension generator. |
| [`sdk/typescript/api-reference.md`](../../src/docs/content/sdk/typescript/api-reference.md) | Lookup prose was sparse or mixed generated-artifact commentary with contract detail. | Visible API reference: entry points, options/defaults, operations, results, errors, and lifecycle limits. | JS index/types/client; native bindings and direct/broker/server providers. |
| [`sdk/typescript/guide.mdx`](../../src/docs/content/sdk/typescript/guide.mdx) | Long step/proof/summary wrapper repeated installation and mixed application recipes. | Queries/transactions; exact extensions; broker restore; server ownership; Electron packaging. | JS index/types/client; native bindings and direct/broker/server providers. |
| [`sdk/typescript/index.mdx`](../../src/docs/content/sdk/typescript/index.mdx) | Repeated SdkLanding/first-query sections and responsibilities delayed the runnable path. | Versioned npm/Bun/Deno setup; strict-typed first query, cleanup, and persistent alternative. | JS index/types/client; native bindings and direct/broker/server providers. |
| [`sdk/wasix-rust/api-reference.md`](../../src/docs/content/sdk/wasix-rust/api-reference.md) | Lookup prose was sparse or mixed generated-artifact commentary with contract detail. | Visible API reference: entry points, options/defaults, operations, results, errors, and lifecycle limits. | WASIX Rust lib/oliphaunt modules, Cargo features, owner/runtime/tools. |
| [`sdk/wasix-rust/dump-restore.mdx`](../../src/docs/content/sdk/wasix-rust/dump-restore.mdx) | Physical/logical formats, tool flags, and CLI usage were interleaved. | Choose physical backup or logical SQL; complete tools example and import constraints. | WASIX Rust tools API, PgDumpOptions, CLI entry points. |
| [`sdk/wasix-rust/guide.mdx`](../../src/docs/content/sdk/wasix-rust/guide.mdx) | Long step/proof/summary wrapper repeated installation and mixed application recipes. | Queries/transactions, explicit extensions, backup/restore, async owner, errors. | WASIX Rust lib/oliphaunt modules, Cargo features, owner/runtime/tools. |
| [`sdk/wasix-rust/index.mdx`](../../src/docs/content/sdk/wasix-rust/index.mdx) | Repeated SdkLanding/first-query sections and responsibilities delayed the runnable path. | Compiled first query, memory default, persistent directory, and thread-affine versus async ownership. | WASIX Rust lib/oliphaunt modules, Cargo features, owner/runtime/tools. |
| [`sdk/wasix-rust/runtime.mdx`](../../src/docs/content/sdk/wasix-rust/runtime.mdx) | Repeated API descriptions and custom runtime diagram. | Thread affinity, owner placement, storage, concurrency, and server limits. | WASIX Rust owner/direct/server and storage implementations. |
| [`sdk/wasix-typescript/api-reference.md`](../../src/docs/content/sdk/wasix-typescript/api-reference.md) | Lookup prose was sparse or mixed generated-artifact commentary with contract detail. | Visible API reference: entry points, options/defaults, operations, results, errors, and lifecycle limits. | WASIX TS exports/types/client, host storage, Worker/server and tools. |
| [`sdk/wasix-typescript/guide.mdx`](../../src/docs/content/sdk/wasix-typescript/guide.mdx) | Long step/proof/summary wrapper repeated installation and mixed application recipes. | Transactions, host storage, tools, extensions, execution placement, server limits. | WASIX TS exports/types/client, host storage, Worker/server and tools. |
| [`sdk/wasix-typescript/index.mdx`](../../src/docs/content/sdk/wasix-typescript/index.mdx) | Repeated SdkLanding/first-query sections and responsibilities delayed the runnable path. | Browser headers, host requirements, complete query, and persistent Worker alternative. | WASIX TS exports/types/client, host storage, Worker/server and tools. |
| [`start/index.mdx`](../../src/docs/content/start/index.mdx) | Three custom flow panels obscured the entry point. | Product explanation, eight SDK links, and a short next-task list. | SDK manifest; all eight public entry points. |

## Generated pages and shared UI

| Source or output | Decision |
| --- | --- |
| `reference/extension-catalog` | Generated from extension metadata; title and introduction rewritten, setup linked, upstream version distinguished from package version. |
| `reference/version-matrix` | Generated from the release graph; product, current version, and release link. Removed first-release history and internal build columns. Exposed in the sidebar. |
| `reference/api-reference` | Generated index linking each SDK quickstart, guide, and API reference. |
| `src/docs/moon.yml` | Added the source/type-config/platform-policy inputs read by docs checks so cached builds respond to those changes. |
| `docs-manifest.toml` and generated metadata | One shallow sidebar; API references visible; active SDK expands; existing route URLs retained. |
| Home and documentation layouts | Same Fumadocs reading shell; compact headings, useful breadcrumbs, copy Markdown, local contents. |
| `global.css` | Replaced the large decorative stylesheet with a compact semantic theme, readable code, responsive cards, focus, and reduced-motion rules. |
| `components/oliphaunt.tsx`, `docs-data.ts` | Eight plain language/runtime links with existing language icons; server rendered. |
| `components/mdx.tsx` | Reused standard Fumadocs/Radix content primitives. Removed obsolete specialized proof/flow/summary components. |
| Old hero/animation components | Deleted after checking callers; removed the unused direct Motion dependency. Fumadocs retains its own dependencies. |
| Search | Changed the static route to export the Orama index and enabled Fumadocs static search. The previous static GET emitted an empty query response. Smoke now searches the exported index. |
| Markdown exports | Removed the older generator that overwrote Next exports; SDK chooser resolves to actual Markdown links and versions match HTML. |
| `check-docs-product.mjs` | Retained route, source, API, navigation, link, metadata, and generated-data checks. Replaced exact old-copy/layout assertions with invariants. |
| `check-docs-snippets.mjs` | Type-checks complete TS quickstarts against current SDK sources in disposable projects. |
| `smoke-built-site.mjs` | Checks real exported links/anchors and unresolved Markdown components/versions. |

## README ledger

| File | Result |
| --- | --- |
| [`README.md`](../../README.md) | Developer entry point with SDK links, basic operating model, and a contributing link; removed first-release and release-pipeline narration. |
| [`src/sdks/rust/README.md`](../../src/sdks/rust/README.md) | Package introduction, installation, complete first query, storage/lifecycle limits, and canonical guide/API links. Removed duplicated low-level implementation notes and stale compatibility tables. |
| [`src/sdks/js/README.md`](../../src/sdks/js/README.md) | Package introduction, installation, complete first query, storage/lifecycle limits, and canonical guide/API links. Removed duplicated low-level implementation notes and stale compatibility tables. |
| [`src/sdks/swift/README.md`](../../src/sdks/swift/README.md) | Package introduction, installation, complete first query, storage/lifecycle limits, and canonical guide/API links. Removed duplicated low-level implementation notes and stale compatibility tables. Retained release-synchronized exact SwiftPM dependency; extension workflow is in the guide. |
| [`src/sdks/kotlin/README.md`](../../src/sdks/kotlin/README.md) | Package introduction, installation, complete first query, storage/lifecycle limits, and canonical guide/API links. Removed duplicated low-level implementation notes and stale compatibility tables. Plugin setup links to the canonical versioned quickstart; release sync advances the README dependency pin. |
| [`src/sdks/react-native/README.md`](../../src/sdks/react-native/README.md) | Package introduction, installation, complete first query, storage/lifecycle limits, and canonical guide/API links. Removed duplicated low-level implementation notes and stale compatibility tables. |
| [`src/bindings/wasix-ts/README.md`](../../src/bindings/wasix-ts/README.md) | Package introduction, installation, complete first query, storage/lifecycle limits, and canonical guide/API links. Removed duplicated low-level implementation notes and stale compatibility tables. |
| [`src/bindings/wasix-rust/crates/oliphaunt-wasix/README.md`](../../src/bindings/wasix-rust/crates/oliphaunt-wasix/README.md) | Package introduction, installation, complete first query, storage/lifecycle limits, and canonical guide/API links. Removed duplicated low-level implementation notes and stale compatibility tables. |
| [`src/docs/README.md`](../../src/docs/README.md) | Replaced scaffold instructions with authoring, commands, centralized versions, snapshots, and honest verification limits. |
| [`src/docs/DESIGN_GROUNDING.md`](../../src/docs/DESIGN_GROUNDING.md) | Replaced obsolete presentation-first mandate and progress checklist with reader-first design and visual-review criteria. |

## Version maintenance

Public MDX uses `@VERSION(product-id)@`; the generator resolves release metadata once and fails unknown IDs/invalid values. Install commands, release links, version table, and Markdown agree. The build emits `docs-version.json` with the full source revision, dirty flag, and product-version map. Archive it with the exported directory. A clean commit is required for a reproducible snapshot; a dirty flag alone does not preserve local changes.

The release synchronizer now updates only standalone Swift/Kotlin README pins; public MDX is no longer subject to fragile version-string replacements. The existing synchronizer test exercises standalone pins and a second idempotent pass. Native platform prose is rendered directly from the existing compatibility policy. No platform support values changed.

There is one current public documentation set. Historical hosted versions and a picker are not fabricated; source tags and archived build directories are the path to future snapshots.

## Repository records retained outside the public site

This is a scope/classification inventory, not a new correctness certification of old engineering records. These files remain useful to contributors; public pages no longer route developers into them for ordinary integration instructions.

| File | Classification |
| --- | --- |
| `docs/README.md` | Repository documentation index; retained outside public navigation. |
| `docs/architecture/cluster-seeds-and-icu.md` | Architecture/design reference; retained outside public navigation. |
| `docs/architecture/database-storage.md` | Architecture/design reference; retained outside public navigation. |
| `docs/architecture/final-product-source-architecture.md` | Architecture/design reference; retained outside public navigation. |
| `docs/architecture/ios.md` | Architecture/design reference; retained outside public navigation. |
| `docs/architecture/native-liboliphaunt.md` | Architecture/design reference; retained outside public navigation. |
| `docs/architecture/orm-integration-report.md` | Architecture/design reference; retained outside public navigation. |
| `docs/architecture/pglite-public-api-comparison.md` | Architecture/design reference; retained outside public navigation. |
| `docs/architecture/stable-database-api.md` | Architecture/design reference; retained outside public navigation. |
| `docs/architecture/wasix-typescript-napi.md` | Architecture/design reference; retained outside public navigation. |
| `docs/internal/CI_RELEASE_PROCESS_AUDIT_2026-09-02.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/DONE.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/IMPLEMENTATION_CHECKLIST.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/MONOREPO_SIMPLIFICATION_PLAN_2026-09-04.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/OLIPHAUNT_PATCH_STACK.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/OLIPHAUNT_README.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/OLIPHAUNT_TRACK_REVIEW.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/PERFORMANCE.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/PG18_WASIX_PERF_STATUS.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/PG18_WASIX_POSTGRES.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/README.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/RELEASE_PIPELINE_READINESS_2026-09-03.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/REPOSITORY_ORGANIZATION_AUDIT_2026-09-03.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/TODO.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/WASIX_NODE_BULK_PERF_REVIEW_20260814.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/internal/WASIX_PATCH_STACK.md` | Internal or historical engineering record; retained outside public navigation. |
| `docs/maintainers/README.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/assets.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/compiler-caching.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/consumer-dx-release-blueprint.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/development.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/extension-packaging-policy.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/mobile-stability-model.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/native-runtime-contract.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/performance-evidence.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/physical-archive-format.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/release-setup.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/release.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/repo-structure.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/rust-sdk-policy.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/sdk-api-surface.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/sdk-parity-policy.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/sdk-products-policy.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/testing.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/tooling.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/wasix-postmaster.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/wasix-usage.md` | Maintainer policy or procedure; retained outside public navigation. |
| `docs/maintainers/windows-vc-runtime.md` | Maintainer policy or procedure; retained outside public navigation. |

## Verification

Completed on 2026-09-08 against the working tree. SDK execution is not implied by a passing docs build.

| Check | Result |
| --- | --- |
| `pnpm --dir src/docs check` | Passed: generated content, 44 documentation routes, links, navigation, version substitution, MDX/site types, and three TypeScript quickstarts. |
| `pnpm --dir src/docs build` | Passed: production static export, including the final platform wording and syntax theme. |
| `pnpm --dir src/docs smoke` | Passed: 49 HTML files, internal links/anchors, assets, all 44 pages in Markdown exports, published version metadata, and a real Orama search query. |
| `moon run release-tools:unit` | Passed using the repository-pinned Moon 2.5.4 binary; final full run completed in 4m 58s. Earlier attempts exposed a transient fixture timeout and a duplicate README sync rule; the rule was corrected before the successful run. |
| Focused release/version/platform tests | 19 passed. |
| Frozen dependency install | Passed; no new dependency added. Removed the unused direct motion dependency. |
| Changed UI/tooling Biome checks, `git diff --check`, local skill validator | Passed. |
| Native Rust first-query example | Compiled; execution requires the native library (`LIBOLIPHAUNT_PATH`), unavailable in this checkout. |
| WASIX Rust first-query example | `cargo check` passed against checkout source; not executed. |
| C first-query example | Strict C11 syntax check passed against the real header; not executed. |
| Native TypeScript, React Native, WASIX TypeScript first-query examples | Strict type-checks passed against SDK source; database execution was not performed. |
| Swift, Kotlin, Tauri and mobile packaging | Source-reviewed; no Apple/Android application execution or packaging qualification performed. |

### Rendered-site review

Reviewed the production export in Chromium at desktop and mobile sizes, in light and dark themes. All 44 documentation routes had one H1 and no page-level horizontal overflow at 320px. Wide tables and code blocks retain their own horizontal scrolling.

Exercised search with a real backup query and navigation to its result, Ctrl+K/Escape, arrow-key installation tabs, mobile sidebar navigation to API reference, code copying, and Copy Markdown through clipboard paste. Copied installation commands contain resolved versions; copied Markdown contains SDK links without unresolved MDX components or version tokens.

Visual inspection covered the SDK chooser, TypeScript quickstart, dark code blocks, and a narrow capability table. Switching the dark syntax theme to `github-dark-default` increased comment contrast against the code surface from 3.60:1 to 5.64:1.

Review artifacts are retained locally outside the repository and published site: `before.png`, `desktop.png`, `typescript-dark.png`, `typescript-mobile.png`, `table-320.png`, and `layout-audit.json`.

No registry publication, deployment, hosted CI qualification, or complete cross-platform SDK runtime execution is claimed. The version snapshot records this working tree as dirty; archive a clean-commit build for a reproducible released snapshot.


## Published-release follow-up

See [published-package verification](published-docs-verification.md) for fresh registry execution after publication, runtime setup corrections, and native release defects found. This supersedes the earlier source-only execution boundaries where new evidence is available.
