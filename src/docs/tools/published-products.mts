import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function selectProducts(releases, ids) {
  return Object.fromEntries(
    [...new Set(ids)].map((id) => {
      const prefix = `${id}-v`;
      const release = releases
        .filter(
          (entry) =>
            !entry.draft &&
            !entry.prerelease &&
            entry.published_at &&
            entry.tag_name.startsWith(prefix) &&
            /^\d+\.\d+\.\d+$/.test(entry.tag_name.slice(prefix.length)) &&
            entry.tag_name !== `${prefix}0.0.0`,
        )
        .sort((a, b) =>
          Bun.semver.order(b.tag_name.slice(prefix.length), a.tag_name.slice(prefix.length)),
        )[0];
      return [
        id,
        release
          ? {
              version: release.tag_name.slice(prefix.length),
              tag: release.tag_name,
              url: release.html_url,
            }
          : null,
      ];
    }),
  );
}

export async function publishedProducts(
  routes,
  { repoRoot = defaultRepoRoot, releasesFile = process.env.OLIPHAUNT_DOCS_RELEASES_FILE } = {},
) {
  // Release ownership supplies identities only; candidate versions are never read.
  const releaseConfig = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'release-please-config.json'), 'utf8'),
  );
  const ids = Object.values(releaseConfig.packages).map((product) => product.component);
  // Offline builds must explicitly select a previously resolved input or fixture.
  const input = releasesFile;
  const releases = input ? JSON.parse(await fs.readFile(input, 'utf8')) : [];
  if (!input) {
    for (let page = 1; ; page++) {
      const response = await fetch(
        `https://api.github.com/repos/f0rr0/oliphaunt/releases?per_page=100&page=${page}`,
        {
          signal: AbortSignal.timeout(30_000),
          headers: {
            Accept: 'application/vnd.github+json',
            ...(process.env.GITHUB_TOKEN
              ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
              : {}),
          },
        },
      );
      if (!response.ok)
        throw new Error(
          `Cannot resolve published product versions: GitHub HTTP ${response.status}`,
        );
      const batch = await response.json();
      releases.push(...batch);
      if (batch.length < 100) break;
    }
    const cache = path.join(repoRoot, 'target/docs/published-releases.json');
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, JSON.stringify(releases, null, 2) + '\n');
  }
  if (!Array.isArray(releases))
    throw new Error('Docs release input must be a GitHub releases array');
  for (const release of releases)
    if (
      !release ||
      typeof release !== 'object' ||
      typeof release.tag_name !== 'string' ||
      typeof release.draft !== 'boolean' ||
      typeof release.prerelease !== 'boolean' ||
      (release.published_at !== null && typeof release.published_at !== 'string') ||
      release.html_url !== `https://github.com/f0rr0/oliphaunt/releases/tag/${release.tag_name}`
    )
      throw new Error('Docs release input contains an invalid GitHub release record');
  return selectProducts(releases, [
    ...ids,
    ...routes.flatMap((route) => (route.product_id ? [route.product_id] : [])),
  ]);
}

// Record checkout versions for archived build provenance, independently of
// completed public releases. These versions are not inserted into examples.
export function selectSourceProducts(config, versions) {
  return Object.fromEntries(
    Object.entries(config.packages).map(([directory, product]) => {
      const version = versions[directory];
      if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
        throw new Error(`Missing source version for ${product.component}`);
      }
      return [product.component, { version }];
    }),
  );
}

export async function sourceProducts(repoRoot = defaultRepoRoot) {
  const [config, versions] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'release-please-config.json'), 'utf8'),
    fs.readFile(path.join(repoRoot, '.release-please-manifest.json'), 'utf8'),
  ]);
  return selectSourceProducts(JSON.parse(config), JSON.parse(versions));
}
