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

Use DM Sans for reading, Instrument Serif for the wordmark and first two heading levels, and Geist Mono for code. Keep the type scale small: 32px page titles, 22px section titles, 16px prose, 14px supporting text, and 13px code. Favor regular and medium weights. Use an 8px spacing rhythm and an 800px article including its padding.

Default to dark, while retaining the reader's light-theme choice. Use neutral semantic Tailwind tokens for surfaces, text, focus, and active navigation; keep syntax highlighting useful. SDK choices use open rows with thin dividers and existing language icons. A small, static dithered elephant gives the start page character without animation or a canvas dependency.

Keep interactions quiet and functional. Respect reduced motion. Maintain contrast in both themes and visible keyboard focus. Provide a first-tab skip link and a main landmark. Long code and tables scroll within their containers; the page must fit a 320px viewport.

## Visual review

Inspect the actual production export at desktop and mobile widths, in light and dark modes. Include the start page, a quickstart, an API reference, and long reference tables. Exercise mobile navigation, search, tabs by keyboard, code copying, and Markdown exports.

Keep screenshots and measurements in review artifacts. Use the [audit](maintainers/docs-rebase-audit.md) for results and limitations; do not turn public pages into implementation progress logs.
