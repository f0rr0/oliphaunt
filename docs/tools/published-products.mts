import fs from 'node:fs/promises';

const cache = new URL('../../target/docs/published-releases.json', import.meta.url);

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

export async function publishedProducts(routes) {
  // Release ownership supplies identities only; candidate versions are never read.
  const releaseConfig = JSON.parse(
    await fs.readFile(new URL('../../release-please-config.json', import.meta.url), 'utf8'),
  );
  const ids = Object.values(releaseConfig.packages).map((product) => product.component);
  // Offline builds must explicitly select a previously resolved input or fixture.
  const input = process.env.OLIPHAUNT_DOCS_RELEASES_FILE;
  let releases = input ? JSON.parse(await fs.readFile(input, 'utf8')) : [];
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
    await fs.mkdir(new URL('./', cache), { recursive: true });
    await fs.writeFile(cache, JSON.stringify(releases, null, 2) + '\n');
  }
  if (!Array.isArray(releases))
    throw new Error('Docs release input must be a GitHub releases array');
  return selectProducts(releases, [
    ...ids,
    ...routes.flatMap((route) => (route.product_id ? [route.product_id] : [])),
  ]);
}
