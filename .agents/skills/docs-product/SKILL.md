---
name: docs-product
description: Public docs product workflow for src/docs Fumadocs/Next content, generated route metadata, SDK matrices, API references, tested snippets, release docs gates, and llms.txt/llms-full.txt output. Use when editing src/docs, public docs content, docs-manifest.toml, docs generation scripts, API reference generation, or LLM docs output.
---

# Docs Product

## Workflow

1. Identify the docs surface:
   - public content: `src/docs/content/`
   - route/source manifest: `src/docs/docs-manifest.toml`
   - generated docs logic: `src/docs/tools/generate-content.mjs`
   - docs policy checks: `src/docs/tools/check-docs-product.mjs`
   - Next/Fumadocs app: `src/docs/src/`
   - static/LLM output: generated under `target/docs/`
2. Keep public product docs in `src/docs/content`. Root `docs/` is maintainer,
   architecture, and internal source material.
3. Treat `llms.txt` and `llms-full.txt` as generated docs artifacts, not hand
   edited source files.
4. Verify content claims against product source, release metadata, generated
   SDK metadata, and tests; maintainer docs may lag.

## Commands

```sh
moon run docs:check
moon run docs:test
moon run docs:build
moon run docs:smoke
moon run docs:release-check
pnpm --dir src/docs run generate
pnpm --dir src/docs run check
pnpm --dir src/docs run test
pnpm --dir src/docs run build
pnpm --dir src/docs run smoke
```

Use `pnpm --dir src/docs run api-reference:check` when API reference output is
part of the change.

## Validation Rules

- `check` runs docs generation, Fumadocs source checks, Next typegen, and
  TypeScript checks.
- `test` validates tested snippets and source-backed docs contracts.
- `build` exports the public site to `target/docs/build`.
- `smoke` validates built-site outputs, including `llms.txt` and
  `llms-full.txt`.
- `release-check` validates release-readiness docs gates.

## Edit Checklist

- Update `docs-manifest.toml` when adding/removing routes or required SDK pages.
- Keep SDK quickstart snippets source-backed through the manifest's
  `tested_snippet_path` and marker fields.
- Keep generated navigation, route metadata, SDK matrices, extension catalog,
  version matrix, and API-reference pages generated through docs tools.
- Do not expose monorepo source paths in public docs chrome.
- Do not commit `target/docs` output unless a future policy explicitly changes.

## Evidence To Report

Report docs routes touched, manifest changes, generated outputs affected,
snippet/API-reference evidence, and docs commands run.
