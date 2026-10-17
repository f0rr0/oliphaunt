/** Tools source facades always describe every canonical platform, independent of payload selection. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeToolsFacadeCrate } from '../../../src/native/postgres-tools/tools/package-cargo-artifacts.mts';
import { emitJavaScript } from '../../../tools/packaging/emit-javascript.mts';
import { freezeSourceCrate } from '../../../tools/packaging/native-cargo-payload.mts';
import { packGeneratedNpmCarrier } from '../../../tools/packaging/npm-package.mts';
import {
  stageNpmPackageDescriptor,
  validatePackedNpmPackage,
} from '../../../tools/packaging/release-carrier.mts';
import {
  assertReleaseNoticesInArchive,
  releaseNoticeRows,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import { type Artifact, member, stageLegalSources } from './payload.mts';

export interface FacadeSpec {
  phase: 'npm' | 'cargo';
  version: string;
  targets: Artifact[];
  carriers: {
    ecosystem: string;
    name: string;
    version: string;
    role: string;
    target: string | null;
  }[];
  sources: Record<string, string>;
  legal: Record<string, string>;
  output: string;
}

export function toolsFacadeTargets(spec: FacadeSpec): Artifact[] {
  const targets = spec.targets.filter(
    (row) => row.product === 'postgres-tools-native' && row.kind === 'native-tools',
  );
  assert(
    targets.length > 0 && new Set(targets.map(({ target }) => target)).size === targets.length,
    'canonical tools target list must be unique and complete',
  );
  const leaves = spec.carriers.filter((row) => row.ecosystem === 'npm' && row.target !== null);
  assert.deepEqual(
    targets.map(({ npm_package }) => npm_package).sort(),
    leaves.map(({ name }) => name).sort(),
    'tools facade must describe all declared platform leaves',
  );
  assert(
    leaves.every(({ version }) => version === spec.version),
    'tools platform leaf version disagrees with product',
  );
  return targets;
}

export function packageToolsFacade(spec: FacadeSpec): void {
  const targets = toolsFacadeTargets(spec);
  const root = mkdtempSync(path.join(tmpdir(), 'native-tools-facade-'));
  try {
    const sourceRoot = path.join(root, 'legal');
    const sources = path.join(root, 'sources');
    stageLegalSources(spec.legal, sourceRoot);
    stageLegalSources(spec.sources, sources);
    mkdirSync(path.dirname(spec.output), { recursive: true });
    if (spec.phase === 'npm') {
      const rows = spec.carriers.filter((row) => row.ecosystem === 'npm' && row.target === null);
      assert.equal(rows.length, 1, 'canonical tools npm facade must be unique');
      const row = rows[0];
      const stage = stageNpmPackageDescriptor(row.name, sources, spec.version, {
        stageDir: path.join(root, 'package'),
      });
      const manifestFile = path.join(stage, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      assert.deepEqual(
        Object.keys(manifest.optionalDependencies).sort(),
        targets.map(({ npm_package }) => npm_package).sort(),
        'authored tools optional dependencies disagree with canonical leaves',
      );
      delete manifest.scripts;
      manifest.optionalDependencies = Object.fromEntries(
        Object.keys(manifest.optionalDependencies)
          .sort()
          .map((name) => [name, spec.version]),
      );
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
      emitJavaScript(path.join(sources, 'index.mts'), path.join(stage, 'index.js'));
      copyFileSync(path.join(sources, 'index.d.ts'), path.join(stage, 'index.d.ts'));
      const notices = { profile: 'source-sdk', sourceRoot };
      stageReleaseNotices(stage, notices);
      const tarball = packGeneratedNpmCarrier(stage, path.join(root, 'tarballs'));
      validatePackedNpmPackage({
        packageName: row.name,
        version: spec.version,
        tarball,
        requiredMembers: [
          'package/index.js',
          'package/index.d.ts',
          ...releaseNoticeRows(notices).map(({ member }) => `package/${member}`),
        ],
      });
      assertReleaseNoticesInArchive(tarball, { ...notices, prefix: 'package' });
      copyFileSync(tarball, spec.output);
    } else {
      assert.equal(spec.phase, 'cargo');
      const pkg = writeToolsFacadeCrate(path.join(root, 'generated'), {
        version: spec.version,
        toolsTargets: targets,
        templateRoot: sources,
        fixture: member(sources, 'testdata/logical-tools.json'),
        noticeSourceRoot: sourceRoot,
      });
      const rows = spec.carriers.filter((row) => row.ecosystem === 'cargo' && row.target === null);
      assert.equal(rows.length, 1);
      assert.equal(pkg.name, rows[0].name);
      mkdirSync(path.join(root, 'out'), { recursive: true });
      const frozen = freezeSourceCrate(pkg, path.join(root, 'out'), path.join(root, 'cargo'), {
        noticeSourceRoot: sourceRoot,
      });
      copyFileSync(frozen.cratePath, spec.output);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: facades.mts <declared-inputs.json>');
  packageToolsFacade(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
