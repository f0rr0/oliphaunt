# Oliphaunt documentation

The public site is a static Next.js/Fumadocs application. Author developer content in `content/`; `docs-manifest.toml` owns routes and sidebar order. Repository architecture and release procedures belong in `docs/maintainers/`, outside the public site.

## Write or change a page

Use the repository-local [write-oliphaunt-docs skill](../../.codex/skills/write-oliphaunt-docs/SKILL.md). Its [source map](../../.codex/skills/write-oliphaunt-docs/references/source-map.md) identifies SDK contracts and its [research](../../.codex/skills/write-oliphaunt-docs/references/research.md) explains the authoring workflow.

Read the source API and tests before editing examples. A quickstart follows requirements, installation, a complete query, expected output, persistence, and next steps. Guides contain application recipes; reference pages contain lookup details. Keep each integration's important storage, threading, recovery, and packaging constraints.

## Preview and check

From the repository root, with workspace dependencies installed:

```sh
rtk proxy pnpm --dir src/docs dev --port 4317
rtk proxy pnpm --dir src/docs check
rtk proxy pnpm --dir src/docs build
rtk proxy pnpm --dir src/docs smoke
```

`check` validates generated routes, navigation, links, metadata, version substitution, MDX, site types, and the three TypeScript quickstarts against SDK source. This is type-checking, not database execution. Snippet markers identify ownership; they do not prove that source tests execute identical documentation text.

`build` exports the site to `target/docs/build`. Stop the dev server before rebuilding for visual review. Serve the static result with `python3 -m http.server 4318 --bind 127.0.0.1 --directory target/docs/build`. `smoke` checks exported pages, rendered internal links and anchors, assets, and Markdown exports. Browser review must also exercise search, tabs, copy buttons, sidebar, keyboard focus, narrow screens, and both themes.

API artifact generation has separate platform/toolchain requirements; see the `api-reference` scripts in `package.json`. A normal docs build does not execute every SDK or generate every native API artifact.

## Versions and snapshots

Use version variables in public MDX, never copied release numbers:

```text
Cargo: oliphaunt = "@VERSION(oliphaunt-rust)@"
npm: npm install @oliphaunt/ts@@VERSION(oliphaunt-js)@
Swift: exact: "@VERSION(oliphaunt-swift)@"
```

The generator resolves product IDs through the existing release metadata graph, including `.release-please-manifest.json` and product `release.toml` files. Unknown IDs and invalid versions fail generation. A release metadata change updates install examples, generated version tables, release links, and Markdown exports together. Documentation targets the current checkout's APIs and associated package versions; release preparation can describe packages before publication.

`docs-version.json` accompanies each exported site. It records the full source commit, whether the tree was dirty, and the product/version map. Archive `target/docs/build` together with this file when retaining a deployed snapshot. Use a clean commit for a reproducible release snapshot; a dirty flag discloses local edits but does not preserve them.

SDKs release independently, so the site represents a **set of product versions**, not a fictitious shared version. The current site serves one such set. Release tags retain source documentation; add historical hosted snapshots and a version selector when there are archived builds to serve. Do not create empty version routes or imply that old sites already exist.

Standalone Swift and Kotlin README pins are advanced by `SDK_INSTALL_VERSION_RULES` in `tools/release/sync-release-pr.mjs`; other READMEs use package-manager commands and link to canonical versioned instructions. The release script must not rewrite MDX version tokens.

Native platform requirements use `<!-- oliphaunt-platforms -->`, expanded from `tools/release/platform-compatibility-policy.mjs`. Extension catalog data, API indexes, and navigation are generated too. Edit their inputs, never `target/docs/` output.

## Review records

The [rewrite audit](../../docs/maintainers/docs-rewrite-audit.md) records per-file decisions and actual validation. [Design grounding](DESIGN_GROUNDING.md) records the visual rules. Neither document is public SDK content.
