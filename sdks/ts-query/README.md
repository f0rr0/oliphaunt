# @oliphaunt/ts-query

PostgreSQL query encoding, decoding and result types shared by the native, WASIX and React Native TypeScript SDKs.

Import from `@oliphaunt/ts-query/query` or `@oliphaunt/ts-query/protocol`. ESM and CommonJS builds include TypeScript declarations.

Run `bun run build`, `bun run typecheck`, or `bun run test` from this directory.
`bun run format` rewrites formatting; `bun run format-check` and `bun run lint`
check sources. `moon run oliphaunt-query-ts:package` builds and packs the
distributable; `bun run package` packs already built outputs. SDK packages depend
on this independently versioned package instead of copying or bundling its source.
