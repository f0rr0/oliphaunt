---
name: write-oliphaunt-docs
description: Write, rewrite, audit, or redesign Oliphaunt developer documentation. Ground polyglot SDK examples and behavior in implementation, keep generated reference data synchronized, and verify the rendered Fumadocs site. Use for public docs and SDK READMEs, not release operations or historical architecture records.
---

# Write Oliphaunt docs

Help a developer choose an SDK, run a query, and ship a working integration. Use this workflow for the requested scope; a small correction does not need a whole-site audit.

## Establish the facts

- Read the affected pages completely, then follow the exported API through its implementation and focused tests. Existing prose is a claim to verify, not authority.
- Use [source-map.md](references/source-map.md) to locate SDK contracts, generated inputs, and checks. Inspect the current files; the map is a starting point, not a frozen API specification.
- Distinguish implemented behavior, released package availability, and future intent. Repository version metadata alone does not prove registry publication. Browse primary sources when documenting external installation requirements or current releases.
- For a rewrite, inventory every authored page and generated route. Record each file's purpose, accuracy findings, source evidence, and disposition in a maintainer audit under `docs/maintainers/`. Preserve useful behavior details when removing noise. Keep historical design records outside the public navigation.
- Resolve uncertain behavior before presenting it as fact. Put remaining uncertainty and unrun checks in the audit or handoff, never in public TODOs, speculative promises, or invented output.

## Organize around the developer's task

Use [research.md](references/research.md) when changing information architecture or the authoring workflow. Its recommendations are adaptations of inspected primary sources, not instructions to install other projects' skills or services.

- Start: explain the product in a short paragraph, help choose language/runtime, and lead directly to a first query.
- SDK quickstart: requirements → install → complete first query → expected result → persistence → next task. Show the code early. Include imports, required setup, parameter binding, and cleanup.
- SDK guide: recipes for persistent storage, transactions, backup/restore, extensions, errors, and shutdown where supported. Link the quickstart instead of repeating it.
- API reference: exported entry points, options/defaults, parameter and return types, errors, and lifecycle constraints. Use implementation-derived declarations when available; edit generator inputs rather than generated output.
- Shared guides: explain common concepts once. Keep language-specific differences next to the affected example. Do not imply that shared PostgreSQL semantics mean identical SDK APIs, concurrency, storage, or runtime support.
- Prefer one coherent sidebar and shallow groups. Confirm that new pages are actually navigable and searchable. Preserve URLs where possible and verify changed anchors and incoming links.

## Write and build

- Use direct sentences, sentence-case headings, descriptive links, and language-tagged code fences. Begin sections with the information needed to act. Remove marketing claims, repeated summaries, maintainer commands, release-pipeline details, and implementation vocabulary that does not affect an integration decision.
- Use `@VERSION(product-id)@` for public install and release versions; generation resolves the existing release graph. Keep `docs-version.json` with archived site builds. Do not invent a shared SDK version or a historical site that is not hosted. See the [docs README](../../../src/docs/README.md) for the version workflow.
- Make examples idiomatic for each language. Verify names, overloads, imports, ownership, async behavior, storage types, package coordinates, and failure handling separately for every SDK. Do not translate examples mechanically.
- Explain prerequisites before commands. Distinguish a complete program from a fragment that uses an existing `db`. Show expected output only when supported by execution or an unambiguous deterministic expression.
- Keep warnings next to actions that can lose data or block an integration. Do not hide mandatory steps in tabs or disclosures. Use tabs only for interchangeable choices, such as package managers.
- Reuse Fumadocs and its accessible primitives before adding components or dependencies. Use the available `better-interface` skills for layout, writing, typography, color, UI, and accessibility; use the React/Next.js skills when changing site code.

## Verify the actual result

1. Check the source-backed claims and example assumptions again after editing. A snippet marker, keyword match, successful MDX build, or AI review is not evidence that the example runs.
2. Run the existing docs checks from [source-map.md](references/source-map.md). When changing a checker, retain route, metadata, link, release-data, and API invariants; replace obsolete prose/design assertions with checks of observable behavior. Do not weaken a real check just to make a rewrite pass.
3. Execute representative complete examples against temporary databases using available runtimes. Type-check other changed examples where possible. Record each SDK as executed, compiled/type-checked, source-reviewed, or blocked with a concrete reason. Never describe source review as execution. Keep backups/restores isolated from user data.
4. For UI work, inspect actual browser screenshots on desktop and narrow mobile, in light and dark themes. Check navigation, search, keyboard focus, code copying, tabs, long tables, and horizontal overflow. Correct defects and inspect the affected screen again. Use existing browser tools; do not add a second UI stack for review.
5. Read as a newcomer using only the rendered docs: Which package fits my app? What do I install? Where does the code run? What result do I get? How do I keep data, handle failures, and close the database? Missing answers are docs defects. For lookup pages, test whether a reader can locate a specific option or method directly.

Finish with the changed scope, checks that actually ran, and material limitations. Follow the user's existing authorization; this skill adds no permission or publishing workflow.
