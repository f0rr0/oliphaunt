import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkDocsProduct } from './check-docs-product.mts';
import { generateDocs } from './generate-content.mts';

export type DocsSource = { path: string; source: string };
export type DocsPackage = {
  package: string;
  version: string;
  integrity: string;
  dependencies: Record<string, string>;
};
function relativePath(value: string) {
  assert(
    typeof value === 'string' &&
      value &&
      !path.isAbsolute(value) &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Invalid declared docs path: ${value}`,
  );
  return value;
}

export function stageDocsSources(root: string, sources: DocsSource[]) {
  const paths = new Set<string>();
  for (const file of sources) {
    relativePath(file.path);
    assert(!paths.has(file.path), `Duplicate declared docs path: ${file.path}`);
    assert(
      lstatSync(realpathSync(file.source)).isFile(),
      `Docs input must be a regular file: ${file.path}`,
    );
    paths.add(file.path);
  }
  for (const file of sources) {
    const target = path.join(root, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(file.source, target);
    chmodSync(target, 0o644);
  }
}

export function docsBuildId(
  sources: DocsSource[],
  contentRoot: string,
  packages: Record<string, DocsPackage>,
  options: { basePath: string; siteUrl: string },
  tools: DocsSource[] = [],
) {
  const hash = createHash('sha256');
  function member(name: string, contents: Buffer | string) {
    hash.update(JSON.stringify(name)).update('\0').update(contents).update('\0');
  }
  for (const file of [...sources].sort((a, b) => a.path.localeCompare(b.path)))
    member(file.path, readFileSync(file.source));
  for (const tool of [...tools].sort((a, b) => a.path.localeCompare(b.path)))
    member(`toolchain/${relativePath(tool.path)}`, readFileSync(tool.source));
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.join(directory, entry.name);
      const resolved = lstatSync(realpathSync(file));
      if (resolved.isDirectory()) visit(file);
      else {
        assert(resolved.isFile(), 'Docs content must contain regular files');
        member(
          `content/${path.relative(contentRoot, file).split(path.sep).join('/')}`,
          readFileSync(file),
        );
      }
    }
  }
  visit(contentRoot);
  for (const [id, row] of Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)))
    member(
      `package/${id}`,
      JSON.stringify({
        package: row.package,
        version: row.version,
        integrity: row.integrity,
        dependencies: Object.fromEntries(
          Object.entries(row.dependencies).sort(([a], [b]) => a.localeCompare(b)),
        ),
      }),
    );
  member('configuration', JSON.stringify(options));
  return hash.digest('hex');
}

async function scratch<T>(operation: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'oliphaunt-docs-'));
  try {
    return await operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type ContentSpec = {
  sources: DocsSource[];
  releasesFile: string;
  provenanceFile: string;
  outputs: { siteDocs: string; static: string; routes: string; metadata: string };
};

export async function buildDocsContent(specification: ContentSpec) {
  assert(
    specification.releasesFile && specification.provenanceFile,
    'Native docs generation requires completed-release and source-provenance inputs',
  );
  return scratch(async (root) => {
    stageDocsSources(root, specification.sources);
    const result = await generateDocs({
      repoRoot: root,
      releasesFile: path.resolve(specification.releasesFile),
      provenanceFile: path.resolve(specification.provenanceFile),
    });
    checkDocsProduct(result);
    cpSync(result.paths.siteDocsRoot, specification.outputs.siteDocs, { recursive: true });
    cpSync(result.paths.staticRoot, specification.outputs.static, { recursive: true });
    cpSync(result.paths.generatedMetaRoot, specification.outputs.metadata, { recursive: true });
    copyFileSync(
      path.join(result.paths.generatedMetaRoot, 'routes.json'),
      specification.outputs.routes,
    );
  });
}

if (import.meta.main) {
  const [operation, specificationFile] = Bun.argv.slice(2);
  assert(specificationFile, 'Expected a declared docs operation and input specification');
  const specification = JSON.parse(readFileSync(specificationFile, 'utf8'));
  if (operation === 'content') await buildDocsContent(specification);
  else if (operation === 'build-id')
    writeFileSync(
      specification.output,
      `${docsBuildId(specification.sources, specification.siteDocs, specification.packages, { basePath: specification.basePath, siteUrl: specification.siteUrl }, specification.tools)}\n`,
    );
  else if (operation === 'export') {
    cpSync(specification.site, specification.output, { recursive: true });
    cpSync(specification.static, specification.output, { recursive: true });
    stageDocsSources(specification.output, specification.licenses ?? []);
  } else throw new Error(`Unknown docs operation: ${operation}`);
}
