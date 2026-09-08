# Documentation design

The reading task comes first: choose a runtime, install a package, run a query, and find the next integration detail. The visual design should make those steps easy to scan.

## Structure

- One documentation shell at the homepage and every docs route.
- A shallow sidebar: Get started, SDKs, Guides, Reference. Expand the active SDK and expose its guide and API reference.
- SDK cards only where the reader chooses a language/runtime. Use prose, lists, and tables within documentation.
- Compact page titles, readable code, a restrained line length, and a local table of contents.
- Shared concepts live in shared guides. Put platform exceptions next to the relevant command.

## Components and style

Reuse Fumadocs navigation, search, code copying, cards, callouts, steps, and Radix tabs. These provide the same accessible primitive approach used by shadcn/ui. Do not add a second component framework for equivalent controls.

Use the available better-interface skills for layout, writing, typography, color, accessibility, and UI review. Use IBM Plex Sans for prose and IBM Plex Mono for code, neutral surfaces, and green for links, focus, and active navigation. Use existing language icons and the Oliphaunt mark.

Keep interactions quiet and functional. Respect reduced motion. Maintain contrast in both themes and visible keyboard focus. Long code and tables scroll within their containers; the page must fit a 320px viewport.

## Visual review

Inspect the actual production export at desktop and mobile widths, in light and dark modes. Include the start page, a quickstart, an API reference, and long reference tables. Exercise mobile navigation, search, tabs by keyboard, code copying, and Markdown exports.

Keep screenshots and measurements in review artifacts. Use the [audit](../../docs/maintainers/docs-rewrite-audit.md) for results and limitations; do not turn public pages into implementation progress logs.
