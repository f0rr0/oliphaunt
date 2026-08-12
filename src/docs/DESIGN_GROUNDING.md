# Oliphaunt Docs Design Grounding

This file keeps the docs-site work scoped to the visual and UX foundation for
`src/docs`.

## Goal

Build a striking, mobile-first docs foundation for Oliphaunt. The site should
feel like a polished product surface for embedded PostgreSQL: lead with the
value of PostgreSQL inside an app, then make use cases, familiar ecosystems,
working examples, and the shortest path to a query easy to recognize. SDK,
runtime, packaging, and maintainer detail belongs after a visitor understands
why the product matters.

Documentation completeness is secondary. Presentation, wayfinding, interaction,
light/dark quality, and reusable docs affordances are the work.

The active quality bar is a calm, highly finished product surface across the
whole docs app, not just the first viewport. Every pass should inspect rendered
Oliphaunt pages, remove redundant or over-boxed UI, and keep code-looking text
semantic: inline code for identifiers, real code blocks for commands/examples.

## Reference Study Takeaways

The landing-page pass compared Supabase with open-source product sites and
component systems including Electric, Payload, Coss UI, shadcn/ui, Base UI,
Tailark, Magic UI, Velora UI, and Shadcn Space. The reusable conclusions are:

- Use one coherent system, not a collage of fashionable components. Bento is
  the page's product-story composition, not an isolated feature block followed
  by conventional marketing bands.
- Let authentic product artifacts and real code do the explanatory work.
  Electric's architecture-led composition, Payload's dramatic hierarchy, and
  Coss UI's flat Base UI patterns are stronger references than decorative
  mini-app interfaces.
- Borrow registry mechanics, not registry aesthetics. A shadcn-like catalog is
  useful for discovering composable patterns, but the final page should not
  look assembled from unrelated blocks.
- [Tailark's Mist feature block](https://github.com/tailark/blocks/blob/main/registry/bases/base/mist/blocks/features/seven.tsx)
  demonstrates a dominant artifact stage; [Magic UI's bento
  primitive](https://github.com/magicuidesign/magicui/blob/main/apps/www/registry/magicui/bento-grid.tsx)
  separates the background artifact from stable foreground copy; [Velora
  UI](https://github.com/ColorlibHQ/velora-ui/blob/main/src/components/velora/bento-grid.tsx)
  keeps motion and surface treatment restrained; and [Shadcn
  Space](https://github.com/shadcnspace/shadcnspace/blob/main/src/components/shadcn-space/blocks/bento-grid-01/bentogrid.tsx)
  uses genuine 12-column hierarchy. These are layout references, not copied
  visual identities.
- Avoid glow, gradient text, marquees, glass panels, repeated icon-card grids,
  ornamental rules, and fake interface chrome. They add trend signals without
  clarifying the product.
- Use confident headlines and generous rhythm. Keep labels, animation, and
  decorative texture to the minimum needed for comprehension.
- Code examples should be central, keyboard-operable, and switch the same
  product flow across languages.

## Oliphaunt Foundation Principles

- Keep the first screen product-like: state the visitor outcome in plain
  language and make app-owned PostgreSQL tangible through real SQL before
  introducing implementation topology.
- Prefer platforms, frameworks, use cases, and user benefits over internal
  product counts, runtime family names, package boundaries, and release terms.
- Use a warm mineral-paper palette with near-black ink. PostgreSQL blue carries
  product identity; green is reserved for ready/success state. Avoid a one-note
  green or slate UI.
- Use bento rhythm deliberately: one dominant card, supporting spans that match
  information importance, and different internal anatomy for queries, schemas,
  lifecycle, stack code, and proof. Do not turn every idea into the same card.
- Use soft radii only to group a real surface; do not add nested frames merely
  to create visual detail.
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
- [ ] Landing page and every docs route reach the current cleanliness bar on mobile
  and desktop.
- [x] Light and dark mode both have intentional contrast and texture.
- [ ] Navigation and doc reading surfaces feel compact, clean, and polished on
  every route.
- [x] Polyglot code examples show the same flow across languages.
- [ ] Reusable MDX components share a restrained row/table/prose visual language.
- [x] Browser screenshots reviewed full-page on mobile and desktop after each
  major slice.
- [x] Relevant product and open-source component references reviewed during the
  active landing-page turn.
- [x] `pnpm --dir src/docs run check` or best available equivalent is
  run before final handoff.

## Current Slice Notes

- Landing now follows a substantive value-first narrative through a dominant
  12-column bento system: outcome, product model, local query behavior,
  application lifecycle, use cases, interactive stack-specific code,
  PostgreSQL-backed product capabilities, repository proof, and a decisive
  close. Runtime and release taxonomy remains in deeper docs.
- Generated hero artwork and decorative schema/vector/device illustrations were
  discarded. The homepage visual language is now actual SQL and results, a
  product-domain relational model, PostgreSQL types, supported app surfaces,
  lifecycle states, and inspectable example paths.
- Exact-extension selection, catalog compliance language, and the three-way
  database comparison were removed from the homepage. The page sells search,
  spatial, modeling, local workflow, and ecosystem outcomes; support matrices
  and tradeoff details stay in the linked documentation.
- Homepage stack examples no longer foreground package versions, install
  commands, or internal mode names. They demonstrate the same meaningful
  PostgreSQL query through each supported application language.
- Repository proof now focuses on working Tauri, Electron, native, and
  WebAssembly applications without turning test-harness mechanics into product
  copy.
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
- This pass removed the numbered kickers, fact rail, mock application windows,
  nested borders, and repeated status microcopy. The visual system is now warm
  paper, restrained PostgreSQL blue, one green state signal, and quiet surfaces
  separated primarily by whitespace.
- Claims remain deliberately bounded: the homepage does not promise arbitrary
  extensions, universal ORM/client compatibility, automatic privacy,
  encryption, synchronization, or cloud interoperability.
- `/docs/start` now uses unboxed quickstart rows, flatter code blocks, and
  row-based next steps. Focused audit improved `borderedPanels` from 8 to 2 on
  desktop and mobile with no horizontal overflow.
- Install prose no longer renders as terminal code in shared SDK summary
  components; real install commands remain code blocks.
- Next likely targets from full audit: React Native/native runtime panels,
  embedded/mobile/SQLite/Tauri/WASM `gap-px bg-fd-border` grids, SDK index
  content duplication, API reference identifier semantics, and tabbed polyglot
  code affordances.
