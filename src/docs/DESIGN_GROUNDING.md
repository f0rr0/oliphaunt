# Oliphaunt Docs Design Grounding

This file keeps the docs-site work scoped to the visual and UX foundation for
`src/docs`.

## Goal

Build a striking, mobile-first docs foundation for Oliphaunt. The site should
feel like a polished product surface for a polyglot embedded PostgreSQL library:
SDK packages, runtime modes, tooling, maintainer paths, and equivalent examples
across languages.

Documentation completeness is secondary. Presentation, wayfinding, interaction,
light/dark quality, and reusable docs affordances are the work.

The active quality bar is Motion-level craft across the whole docs app, not just
the first viewport. Every pass should re-check Motion, inspect rendered
Oliphaunt pages, remove redundant or over-boxed UI, and keep code-looking text
semantic: inline code for identifiers, real code blocks for commands/examples.

## Motion Docs Takeaways

Observed from `https://motion.dev/docs`, `/docs/react`, and deeper docs pages:

- Oversized, confident page titles with tight copy and generous vertical rhythm.
- Small monospace section labels, breadcrumbs, and version-like pills create a
  product/manual feel.
- The best visual texture is functional: line grids, diagonal hatching, compact
  charts, code, and live-demo surfaces.
- Cards are crisp and low-radius, often row-based rather than decorative.
- Motion's docs home uses a dark product/manual surface, a compact technical
  chart, a small set of primary route cards, and row-based secondary links; it
  does not repeat full tutorial content on the landing page.
- Mobile strips the experience down to strong title, intro, actions, and content;
  side navigation should not dominate the first screen.
- Animations should be restrained: subtle entrances, hover shifts, focus states,
  and ambient technical motion that respects reduced-motion.
- Code examples need to feel central and copyable, with clear language switching
  for the same app flow.
- Docs pages rely mostly on prose, rows, dividers, tables, and occasional code;
  custom panels should be rare and earn their space.

## Oliphaunt Foundation Principles

- Keep the first screen product-like: Oliphaunt, embedded PostgreSQL, SDKs,
  runtime modes, and a visible code/system artifact.
- Use a balanced palette: ink/ivory neutrals with green as primary, amber/cyan
  accents for state and language surfaces. Avoid a one-note green or slate UI.
- Keep page sections unframed; cards are only for repeated items and tools.
- Use 8px or smaller radii unless Fumadocs requires otherwise.
- Prefer icons for recognisable tools/actions, with text for clear commands.
- Make polyglot examples a first-class pattern, not an afterthought.
- Maintain light and dark mode parity.
- Preserve generated-content boundaries: edit presentation components, app
  routes, theme CSS, and docs-app metadata; avoid changing generated targets.
- Prefer divider-based row lists over nested cards when the user is choosing
  among pages, SDKs, modes, or reference lookups.

## Review Protocol

- Revisit the docs app on mobile and desktop after substantial layout edits.
- Run `pnpm --dir src/docs check` before handing off docs changes.
- Use `pnpm --dir src/docs build` when changes touch route composition,
  metadata, generated content, or Next.js boundaries.

## Implementation Checklist

- [x] Scope remains inside `src/docs`.
- [ ] Landing page and every docs route reach Motion-level cleanliness on mobile
  and desktop.
- [x] Light and dark mode both have intentional contrast and texture.
- [ ] Navigation and doc reading surfaces feel compact, clean, and polished on
  every route.
- [x] Polyglot code examples show the same flow across languages.
- [ ] Reusable MDX components share a restrained row/table/prose visual language.
- [x] Browser screenshots reviewed full-page on mobile and desktop after each
  major slice.
- [x] Motion reference pages reviewed during each active implementation turn.
- [x] `pnpm --dir src/docs run check` or best available equivalent is
  run before final handoff.

## Current Slice Notes

- Landing was reduced to hero, SDK choices, and reference paths; standalone
  landing code comparisons and repeated runtime/docs/CTA sections were removed.
- `/docs/start` was reduced to quickstart, first-query comparison, and next
  steps; redundant outcome and verify panels were removed.
- `/docs/learn` was converted from card-heavy maps/tabs to divider rows and
  prose bullets.
- `/docs/sdk` moved from card-heavy SDK chooser and runtime matrix to divider
  rows. Focused audit improved `borderedPanels` from 35 to 13 and code blocks
  from 7 to 0 on the SDK index.
- Reference lookup/capability/extension/performance/release components moved
  from boxed grids to divider rows. The audit metric now separates icon tiles
  from real bordered panels.
- This pass refreshed Motion `/docs`, `/docs/react`, `/docs/react-animation`,
  `/docs/react-transitions`, and `/docs/react-layout-animations` screenshots.
- Home now uses a dark Motion-like technical hero, a visible mobile product map,
  and SDK rows instead of seven uneven SDK cards.
- `/docs/start` now uses unboxed quickstart rows, flatter code blocks, and
  row-based next steps. Focused audit improved `borderedPanels` from 8 to 2 on
  desktop and mobile with no horizontal overflow.
- Install prose no longer renders as terminal code in shared SDK summary
  components; real install commands remain code blocks.
- Next likely targets from full audit: React Native/native runtime panels,
  embedded/mobile/SQLite/Tauri/WASM `gap-px bg-fd-border` grids, SDK index
  content duplication, API reference identifier semantics, and tabbed polyglot
  code affordances.
