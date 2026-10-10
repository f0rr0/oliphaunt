# Oliphaunt documentation

The site at oliphaunt.dev contains latest-product guides, maintained on main.
It has no documentation-version archives or SDK API generation dependencies.
Authored SDK API maps remain ordinary guides.

From this directory after installing the root Bun workspace:

- `bun run dev`: prepare content and start Next.js.
- `bun run check`: check internal links, site TypeScript, and TypeScript quickstart snippets.
- `bun run test`: exercise published-release selection and refresh-request handling.
- `bun run build`: resolve published-release data, type-check TypeScript quickstarts, and export the site.
- `bun run smoke`: check exported routes and text endpoints.

## Versions and example accuracy

These guides target the current checkout, per the documentation rewrite's scope.
Install commands name packages without prescribing versions. Where the package
manager requires a version field, show a placeholder for the application's
chosen dependency. Compatibility belongs in package manifests and release
qualification, not in a documentation-generated version set. Generated
`docs-version.json` records checkout product versions and the source revision for
build provenance only; set
`OLIPHAUNT_DOCS_GIT_SHA` for a local archived build (Vercel uses its commit SHA).
Keep this record with an archived static export. No historical picker is hosted.

The release table lists completed stable GitHub releases and links to their notes.
It does not recommend versions or establish compatibility. A source build does
not prove registry availability. SDK dependencies select compatible runtimes.

Each preparation resolves GitHub metadata anew and fails on network errors.
For an explicit offline build set `OLIPHAUNT_DOCS_RELEASES_FILE` to a previously
resolved `target/docs/published-releases.json` (absolute path recommended), or
a fixture containing GitHub release records. This is an opt-in snapshot, not
automatic stale fallback. `GITHUB_TOKEN` is optional for GitHub rate limits.

Vercel should build main for documentation changes, and rebuild once after an
entire product release operation has finalized. Build from this project with
`bun run build`; the export is `out` and the repository qualification copy
is `target/docs/build`. Deployment-hook credentials and actual deployment
status monitoring are release-integration responsibilities. No remote Vercel
configuration is changed by local builds.

## Release-triggered refresh

After the complete `publish` job successfully promotes a nonempty public release batch, the Release workflow runs a separate
`Refresh published docs` job in the `Production` environment. It snapshots completed
public releases, sends one POST, and checks the live version page for links to
those releases (or newer stable releases). The check waits up to ten minutes and
fails on stale content or persistent HTTP errors; hook acceptance is insufficient.
The expected releases and hook receipt are retained for diagnosis.
A failed refresh does not rerun registry publication. Retry only
the docs job after inspecting Vercel; an ambiguous HTTP failure may already have
queued a deployment, so the command does not automatically retry POST requests.

Read-only inspection on 2026-09-14 confirmed the existing `oliphaunt-docs`
project uses `src/docs`, Next.js, Node 24, automatic build/install/output
settings and production branch `main`. The restored source layout matches its
root setting. No deploy hook exists and GitHub's `Production` environment has
no hook secret or branch restriction. No remote settings were changed.

External prerequisites still required:

- Create/select one deploy hook for the oliphaunt.dev project targeting `main`;
  store its URL as `VERCEL_DOCS_DEPLOY_HOOK` in GitHub's protected `Production`
  environment, with deployment restricted to `main`.
- Confirm Vercel's project root is `src/docs`, its build command is
  `bun run build`, and output is `out`. Root workspace files and the extension
  catalog must remain accessible. Installation must use the pinned root Bun
  lockfile. Normal Git deployments should follow docs inputs; hook-triggered
  builds must not be skipped merely because the source commit is unchanged.
- Exercise a real release refresh and a docs-only main update. The live check
  verifies advertised product versions rather than guessing a provider API from
  the hook's job ID. Vercel's Git integration owns guide deployment status;
  verify its production promotion and ordering in the project dashboard.

Verify those prerequisites before relying on automatic release refresh. See [Vercel's deploy-hook contract](https://vercel.com/docs/deploy-hooks).

## Authoring and review

Use [write-oliphaunt-docs](../../.codex/skills/write-oliphaunt-docs/SKILL.md) and
`better-writing`. The public path is SDK choice → installation → first query →
persistence → application recipes → API lookup. Keep maintainer procedures and
validation limitations under `maintainers/`. Review every edited example against
its own SDK, including defaults, extension descriptors, resource prerequisites,
and restore destinations.

The sidebar follows `docs-manifest.toml`. The platform table is generated from
release compatibility policy, and the extension catalog from generated extension
metadata. Next/Fumadocs exports Markdown and search from the same pages as HTML;
do not overwrite those text exports with a second static generator.
