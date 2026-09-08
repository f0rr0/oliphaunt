# Research: AI-assisted developer documentation

Inspected 2026-09-08. These are primary project instructions, implementations, product documentation, and one empirical paper. They describe observable workflows; they do not establish that AI-generated prose is accurate or that a particular tool improves productivity. GitHub links track their named branches and may change.

## How projects use AI to write and maintain docs

| Inspected source | Observed practice | Adaptation for Oliphaunt |
| --- | --- | --- |
| [Supabase authoring guide](https://github.com/supabase/supabase/blob/master/apps/docs/CONTRIBUTING.md) | Ships separate agent skills for planning, architecture, drafting, editing, execution, and review. Defines four document types and sources reference parameters from code. | Keep the stages distinct within one small local skill; avoid a network of skills for a site this size. |
| [Supabase write-the-docs](https://github.com/supabase/supabase/blob/master/.agents/skills/write-the-docs/SKILL.md) | Reads product intent and implementation before drafting, distinguishes generated reference from authored guides, wires navigation, and removes internal planning notes. | Code establishes behavior; the user's request establishes the rewrite's purpose. Explicitly track source uncertainty outside public pages. |
| [Supabase test-the-docs](https://github.com/supabase/supabase/blob/master/.agents/skills/test-the-docs/SKILL.md) | Classifies complete examples, setup-dependent snippets, illustrative fragments, and deferred checks; executes in disposable environments and reports results. | Run Oliphaunt examples on temporary roots. Record execution versus type-checking versus source review per SDK. Its Supabase Docker stack is not applicable here. |
| [Supabase edit-the-docs](https://github.com/supabase/supabase/blob/master/.agents/skills/edit-the-docs/SKILL.md) | Gives existing-page restructuring its own workflow, separate from inventing a new product story. | Preserve useful integration facts while rebuilding hierarchy and prose. A rewrite is not permission to infer capabilities. |
| [Next.js update-docs skill](https://github.com/vercel/next.js/blob/canary/.agents/skills/update-docs/SKILL.md) | Maps source changes to docs locations, checks existing coverage, and handles shared content and examples. | Maintain a local source map; search all affected SDK pages when a common contract changes. Do not copy Next.js-specific paths or per-edit approval steps. |
| [Cloudflare agent instructions](https://github.com/cloudflare/cloudflare-docs/blob/production/AGENTS.md) and [agent style reference](https://github.com/cloudflare/cloudflare-docs/blob/production/.agents/references/style-guide.md) | Give agents the real content pipeline, component rules, validation commands, and a distilled reference linked to the authoritative style guide. | Put stable workflow in `SKILL.md`, repository details in a linked source map, and reuse the installed UI skills. |
| [Cloudflare docs review bot](https://github.com/cloudflare/cloudflare-docs/blob/production/.flue/AGENTS.md) | Separates code, conventions, and style review; validates findings against repository context. Structured results feed controlled publishing code. | Review correctness, discoverability, and writing separately. Require source evidence for findings. A bot service and automatic publishing are unnecessary for this rewrite. |
| [GitHub documentation-writer skill](https://github.com/github/awesome-copilot/blob/main/skills/documentation-writer/SKILL.md) | Uses reader goals and Diátaxis to distinguish tutorials, guides, reference, and explanations. | Give each page a clear job, rather than adding the same summary and reference block everywhere. |
| [GitHub docs-sync-audit skill](https://github.com/github/awesome-copilot/blob/main/skills/docs-sync-audit/SKILL.md) | Compares docs with code, reports drift with evidence, distinguishes confirmed findings from inference, and records checks not run. | Keep a file-by-file audit. Check generated sources and all plausible locations before declaring information missing. Its read-only scope does not apply to an authorized rewrite. |
| [Anthropic doc-coauthoring skill](https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md) | Gathers context, iterates on structure, and tests whether a reader without prior context can answer likely questions. | Perform a newcomer task review from the rendered docs. Its interview-heavy process is excessive when source and task intent are already available. |
| [Mintlify authoring skill](https://github.com/mintlify/docs/blob/main/skill.md) | Describes navigation, MDX components, concise writing, examples, and validation for its documentation framework. | Prefer shallow navigation, concrete prerequisites, and sparse callouts. Use Fumadocs APIs here; do not import Mintlify syntax or leave uncertainty as public TODOs. |
| [Mintlify agent](https://www.mintlify.com/docs/agent) | Searches docs, connected code, and web context; plans, edits, validates, and submits changes according to configured review settings. | Adopt research → source-grounded edits → validation. A subscription or connector is not required to perform these steps locally. |
| [GitBook agent](https://gitbook.com/docs/gitbook-agent) and [Git Sync](https://gitbook.com/docs/getting-started/git-sync) | Offer agent editing and repository-synchronized documentation workflows. | Keep reviewable docs-as-code changes in the existing repository; preserve the current site stack. |
| [GitLab documentation workflow](https://docs.gitlab.com/development/documentation/workflow/) | Couples docs to feature changes and expects technical and writing review, including for AI-assisted content. | Run source and editorial review as distinct checks. Do not transplant another organization's approval policy. |

The common useful pattern is constrained drafting with repository context and explicit verification. Large prompts, fluent language, and a passing site build do not establish SDK correctness. The [study of 1,997 agent/human documentation PRs](https://arxiv.org/abs/2601.20171), submitted January 2026, reports limited human follow-up on agent edits in its sampled repositories. That is evidence about review activity in the sample, not a measurement of Oliphaunt's quality or proof that agent edits are wrong. It reinforces our decision to retain independent, deterministic checks.

## How polyglot SDK docs arrange the learning path

| Inspected source | Pattern worth using |
| --- | --- |
| [DuckDB client overview](https://duckdb.org/docs/stable/clients/overview) | Start with language/client choice and distinguish support levels while sharing database concepts. |
| [Turso SDK introduction](https://docs.turso.tech/sdk/introduction) | Choose a package by language and use case; runtime choice matters as much as language. |
| [Supabase JavaScript installation](https://supabase.com/docs/reference/javascript/installing) and [reference introduction](https://supabase.com/docs/reference/javascript/introduction) | Provide installation commands and concrete examples; organize lookup material around API operations. |
| [Diátaxis introduction](https://diataxis.fr/start-here/) | Separate first learning, task instructions, technical lookup, and conceptual understanding. Apply the distinction without forcing four duplicate sections into every page. |
| [shadcn/ui tabs](https://ui.shadcn.com/docs/components/radix/tabs) | Use an accessible primitive for interchangeable choices; retain predictable focus and keyboard behavior. |
| [Fumadocs UI](https://www.fumadocs.dev/docs/ui) | Reuse the documentation framework's navigation, code blocks, search, and content components. |

For Oliphaunt, this becomes: product and SDK choice → SDK installation and first query → common application tasks → deeper concepts and API lookup. Native and WASIX variants need explicit runtime labels. Quickstarts need full examples; conceptual pages need only examples that explain the concept. One shared concept page is preferable to eight repeated introductions.

## AI authoring versus documentation for AI consumers

These are different deliverables. The local skill teaches an agent how to change this repository. Public Markdown exports and search help an agent consume the product documentation. [Mintlify's skill.md documentation](https://www.mintlify.com/docs/ai/skillmd) describes a product-facing skill alongside its documentation index; that does not make a public authoring checklist necessary. Keep Oliphaunt's existing Markdown exports accurate and navigable, and keep maintainer authoring instructions local.

## Decisions for this rewrite

- Use one repository-local skill with two references, not copied external skill bundles or new paid services.
- Audit every public page and all generated routes. Keep the audit and this research out of the public docs.
- Replace duplicated landing summaries and hidden API links with a clear SDK quickstart, task guide, and visible API reference.
- Generate version/catalog facts from existing authoritative metadata; verify published package claims separately.
- Preserve important runtime and data-safety differences. Remove build-pipeline narration from developer pages.
- Use real code examples and honest verification levels. Preserve meaningful checks while removing assertions tied only to the old wording or layout.
- Reuse Fumadocs and its Radix-based components; review desktop/mobile screenshots and keyboard behavior after implementation.
