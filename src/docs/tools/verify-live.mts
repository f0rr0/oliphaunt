import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedProducts } from './published-products.mts';

const pageUrl = 'https://oliphaunt.dev/docs/reference/version-matrix/';
type Products = Record<string, { version: string; url: string } | null>;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export async function writeNativeDocsInputs(
  directory: string,
  releasesFile: string,
  source: { sourceRevision: string; dirty: boolean },
) {
  if (
    typeof source.sourceRevision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(source.sourceRevision) ||
    typeof source.dirty !== 'boolean'
  )
    throw new Error('Native docs inputs require actual Git revision and dirty state');
  await mkdir(directory, { recursive: true });
  await copyFile(releasesFile, path.join(directory, 'completed-releases.json'));
  await writeFile(path.join(directory, 'provenance.json'), `${JSON.stringify(source, null, 2)}\n`);
  await writeFile(
    path.join(directory, 'WORKSPACE.bazel'),
    'workspace(name = "docs_build_inputs")\n',
  );
  await writeFile(
    path.join(directory, 'BUILD.bazel'),
    'exports_files(["completed-releases.json", "provenance.json"], visibility = ["//visibility:public"])\n',
  );
}

// Verify what users can read, independently of a deployment provider's job status.
export function missingPublishedProducts(html: string, products: Products) {
  const links = new Set(
    [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]),
  );
  return Object.entries(products)
    .filter(([, product]) => {
      if (!product) return false;
      const prefix = product.url.slice(0, -product.version.length);
      // A later completed release may deploy while this refresh is waiting.
      return ![...links].some(
        (link) =>
          link.startsWith(prefix) &&
          /^\d+\.\d+\.\d+$/.test(link.slice(prefix.length)) &&
          Bun.semver.order(link.slice(prefix.length), product.version) >= 0,
      );
    })
    .map(([id, product]) => `${id}@${product?.version}`);
}

export async function verifyLive(
  products: Products,
  { timeoutMs = 600_000, fetchPage = fetch } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let failure = 'No response from the live documentation';
  do {
    try {
      const response = await fetchPage(pageUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
      });
      if (!response.ok) throw new Error(`Docs returned HTTP ${response.status}`);
      const missing = missingPublishedProducts(await response.text(), products);
      if (missing.length === 0) return;
      failure = `Live docs do not yet advertise: ${missing.join(', ')}`;
    } catch (error) {
      failure = String(error);
    }
    if (Date.now() >= deadline) break;
    await Bun.sleep(Math.min(10_000, deadline - Date.now()));
  } while (Date.now() < deadline);
  throw new Error(failure);
}

if (import.meta.main) {
  const [mode, file, nativeInputs] = process.argv.slice(2);
  if (!file || !['snapshot', 'verify'].includes(mode))
    throw new Error(
      'usage: verify-live.mts snapshot|verify EXPECTED_PRODUCTS_JSON [NATIVE_INPUTS_DIRECTORY]',
    );
  if (mode === 'snapshot') {
    await writeFile(file, `${JSON.stringify(await publishedProducts([]), null, 2)}\n`);
    if (nativeInputs) {
      await writeNativeDocsInputs(
        nativeInputs,
        path.join(repoRoot, 'target/docs/published-releases.json'),
        {
          sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repoRoot,
            encoding: 'utf8',
          }).trim(),
          dirty:
            execFileSync('git', ['status', '--porcelain'], {
              cwd: repoRoot,
              encoding: 'utf8',
            }).trim().length > 0,
        },
      );
    }
  } else {
    await verifyLive(JSON.parse(await readFile(file, 'utf8')));
    console.log('Live documentation advertises the expected completed public releases.');
  }
}
