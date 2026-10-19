# Documentation design

The reading task comes first: choose a runtime, install a package, run a query, and find the next integration detail. The visual design should make those steps easy to scan.

## Structure

- One documentation shell at the homepage and every docs route.
- A shallow sidebar: Get started, SDKs, Guides, Reference. Expand the active SDK and expose its guide and API reference.
- SDK rows where the reader chooses a language/runtime. Use prose, lists, and tables within documentation.
- Compact page titles, readable code, a restrained line length, and a local table of contents.
- Shared concepts live in shared guides. Put platform exceptions next to the relevant command.

## Components and style

Reuse Fumadocs navigation, search, code copying, cards, callouts, steps, and Radix tabs. These provide the same accessible primitive approach used by shadcn/ui. Do not add a second component framework for equivalent controls.

Use the available better-interface skills for layout, writing, typography, color, accessibility, and UI review. The visual references are [f0rr0.dev](https://f0rr0.dev), [GPU Postal](https://gpu-postal.f0rr0.dev), and [mealprep.party](https://mealprep.party). Their live pages and repository styles informed the near-black surfaces, quiet gray dividers, compact regular-weight headings, and limited illustration.

Use DM Sans for reading and section headings, Instrument Serif only for page titles, and Geist Mono for code and utility labels. The type roles are 40px page titles, 18px section titles, 16px prose, 14px supporting text, 13px code, and 12px utility labels. Favor regular and medium weights; the compact wordmark uses 18px semibold.

Use a centered 1248px layout: 256px navigation, 768px article, and 224px table of contents when all columns fit. Article gutters are 32px on desktop and 16px on narrow screens. Align breadcrumbs, headings, prose, code blocks, and SDK names to the same leading edge. Align page-title tops even when artwork is present.

Body text and SDK labels follow a 24px line rhythm. Use 16px paragraph spacing, 32px between the page header and body, and 48px before new sections. SDK rows are at least 80px, including their divider; wrapped descriptions add whole text lines. The SDK grid becomes two columns only when its own available width accommodates two 288px columns and a 32px gap. Avoid separate decorative icon columns that interrupt the text alignment.

Default to dark, while retaining the reader's light-theme choice. Use neutral semantic Tailwind tokens for surfaces, text, focus, and active navigation; keep syntax highlighting useful. The identity is an open, solid O with a curved terminal, paired with a lowercase wordmark. Reuse its geometry in navigation, the favicon, and social previews.

Use the monochrome elephant engraving on the start page as editorial artwork. Keep its original aspect ratio and transparency, top-align it with the title, and hide it on narrow screens so SDK selection stays near the top. Avoid cartoon mascots, extra illustration panels, animation, and canvas code. The saved asset and generation prompt are recorded in the [audit](maintainers/docs-rebase-audit.md#identity-and-spacing-refinement--2026-09-29).

Keep interactions quiet and functional. Respect reduced motion. Maintain contrast in both themes and visible keyboard focus. Provide a first-tab skip link and a main landmark. Long code and tables scroll within their containers; the page must fit a 320px viewport.

## Visual review

Inspect the actual production export at desktop and mobile widths, in light and dark modes. Include the start page, a quickstart, an API reference, and long reference tables. Exercise mobile navigation, search, tabs by keyboard, code copying, and Markdown exports.

Keep screenshots and measurements in review artifacts. Use the [audit](maintainers/docs-rebase-audit.md) for results and limitations; do not turn public pages into implementation progress logs.
