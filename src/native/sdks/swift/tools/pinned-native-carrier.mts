import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { currentProductVersionSync } from '../../../../../tools/release/release-artifact-targets.mts';
import { fetchText } from './render_swiftpm_release_package.mts';
import { materialize } from './swift-carrier-resolver.mts';

// Source builds use the same-run producer for the current runtime. Independent
// SDK releases keep their exact older runtime and verify its published bytes.
export async function pinnedNativeCarrierDirectory({
  version,
  assetDir,
  workRoot,
  fetchImpl = fetch,
}) {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error(`invalid native runtime pin: ${version}`);
  }
  if (version === currentProductVersionSync('liboliphaunt-native', 'pinned-native-carrier')) {
    if (!assetDir) throw new Error(`native runtime ${version} requires same-run producer assets`);
    return assetDir;
  }
  const tag = `liboliphaunt-native-v${version}`;
  const api = 'https://api.github.com/repos/f0rr0/oliphaunt';
  const readJson = async (url) => JSON.parse(await fetchText(url, { fetchImpl }));
  const release = await readJson(`${api}/releases/tags/${tag}`);
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0
  ) {
    throw new Error(`native runtime pin ${version} requires a published stable release ${tag}`);
  }
  const assets = [];
  for (let page = 1; ; page += 1) {
    if (page > 10) throw new Error(`${tag} has too many release assets`);
    const rows = await readJson(`${api}/releases/${release.id}/assets?per_page=100&page=${page}`);
    if (!Array.isArray(rows) || rows.length > 100)
      throw new Error(`${tag} has invalid release assets`);
    assets.push(...rows);
    if (rows.length < 100) break;
  }
  const directory = path.join(workRoot, 'pinned-native-carrier', version);
  mkdirSync(directory, { recursive: true });
  for (const name of [
    `liboliphaunt-${version}-apple-spm-xcframework.zip`,
    `liboliphaunt-${version}-runtime-resources-ios-datum64.tar.gz`,
  ]) {
    const matches = assets.filter((row) => row.name === name);
    const row = matches[0];
    const url = `https://github.com/f0rr0/oliphaunt/releases/download/${tag}/${name}`;
    if (
      matches.length !== 1 ||
      row.browser_download_url !== url ||
      !/^sha256:[a-f0-9]{64}$/u.test(row.digest) ||
      !Number.isSafeInteger(row.size) ||
      row.size <= 0 ||
      row.size > 512 * 1024 * 1024
    ) {
      throw new Error(`${tag} must publish one checksummed ${name}`);
    }
    const file = await materialize(
      { name, url, bytes: row.size, sha256: row.digest.slice(7) },
      path.join(workRoot, 'pinned-native-carrier-cache'),
      { fetchImpl },
    );
    copyFileSync(file, path.join(directory, name));
  }
  return directory;
}
