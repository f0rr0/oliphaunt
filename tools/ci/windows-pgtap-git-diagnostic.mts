import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uninstallRecipe } from '../../build_defs/extensions/pgtap_sql.mts';

const qualifiedSha256 = '24288f38f6a50a61fa351903716bef0d76b892ca1e88f21f396adf067ef24fe7';

export function makefileFacts(file: string) {
  const bytes = readFileSync(file);
  let cr = 0,
    lf = 0,
    crlf = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 13) cr++;
    if (bytes[index] === 10) {
      lf++;
      if (index > 0 && bytes[index - 1] === 13) crlf++;
    }
  }
  let recipe: { pass: boolean; error?: string } = { pass: true };
  try {
    uninstallRecipe(file);
  } catch (error) {
    assert(error instanceof Error);
    assert(
      [
        'pgTAP Makefile installation semantics require upstream-byte parity qualification',
        'unsupported upstream pgTAP uninstall recipe',
      ].includes(error.message),
      'Unexpected failure from the original uninstallRecipe',
    );
    recipe = { pass: false, error: error.message };
  }
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    cr,
    lf,
    crlf,
    uninstallRecipe: recipe,
  };
}

if (import.meta.main) {
  const source = Bun.TOML.parse(
    readFileSync(
      new URL('../../src/extensions/external/pgtap/source.toml', import.meta.url),
      'utf8',
    ),
  ) as { url: string; mirror_url?: string; commit: string };
  assert.match(source.commit, /^[a-f0-9]{40}$/);
  const remote = source.mirror_url ?? source.url;
  const url = new URL(remote);
  assert(url.protocol === 'https:' && !url.username && !url.password);
  const root = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'pgtap-git-'));
  const checkout = path.join(root, 'checkout');
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // Match Bazel 8.8.1 git_worker's local-environment exclusions.
  for (const name of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_OBJECT_DIRECTORY',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_GRAFT_FILE',
    'GIT_INDEX_FILE',
    'GIT_NO_REPLACE_OBJECTS',
    'GIT_REPLACE_REF_BASE',
    'GIT_PREFIX',
    'GIT_INTERNAL_SUPER_PREFIX',
    'GIT_SHALLOW_FILE',
    'GIT_COMMON_DIR',
  ])
    delete environment[name];
  const git = (args: string[], config: string[] = [], cwd = checkout) => {
    const command = args[0] === 'init' ? args : ['-c', 'core.fsmonitor=false', ...config, ...args];
    const result = spawnSync('git', command, {
      cwd,
      env: environment,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    assert(!result.error && result.status === 0, `git ${args[0]} failed (exit ${result.status})`);
    return result.stdout;
  };
  const settings = (config: string[]) =>
    Object.fromEntries(
      Object.entries({
        'core.autocrlf': ['true', 'false', 'input'],
        'core.eol': ['lf', 'crlf', 'native'],
      }).map(([key, allowed]) => {
        const value = git(['config', '--default', '<unset>', '--get', key], config)
          .toString('utf8')
          .trim();
        return [key, allowed.includes(value) || value === '<unset>' ? value : '<unexpected>'];
      }),
    );
  git(['init', checkout], [], root);
  git(['remote', 'add', 'origin', remote]);
  git(['fetch', '--depth=1', 'origin', source.commit]);
  git(['reset', '--hard', source.commit]);
  git(['clean', '-xdf']);
  const commit = git(['log', '-n', '1', '--pretty=format:%H']).toString('utf8');
  assert.equal(commit, source.commit);
  const report = (phase: string, file: string, config: string[] = []) => {
    const facts = makefileFacts(file);
    console.log(JSON.stringify({ phase, commit, ...settings(config), ...facts }));
    return facts;
  };
  const makefile = path.join(checkout, 'Makefile');
  const before = report('stock-reset', makefile);
  const blob = path.join(root, 'Makefile.blob');
  writeFileSync(blob, git(['cat-file', 'blob', 'HEAD:Makefile']));
  const canonical = report('git-blob', blob);
  let forced: ReturnType<typeof makefileFacts> | undefined;
  if (before.sha256 === qualifiedSha256) {
    const config = ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf'];
    git(['checkout-index', '--force', '--all'], config);
    forced = report('forced-crlf-control', makefile, config);
  }
  const config = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];
  git(['checkout-index', '--force', '--all'], config);
  const repaired = report('command-only-lf-control', makefile, config);
  const response = await fetch(`https://codeload.github.com/theory/pgtap/tar.gz/${source.commit}`, {
    signal: AbortSignal.timeout(120_000),
  });
  assert(response.ok, `Pinned pgTAP archive download failed (${response.status})`);
  const archive = Buffer.from(await response.arrayBuffer());
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  assert.equal(archiveSha256, 'ffd501f27670a7d3d7f0cfd4ea7f291848112c2ef408a0b73e4cb727ac83e604');
  const archiveFile = path.join(root, 'pgtap.tar.gz');
  writeFileSync(archiveFile, archive);
  const extracted = spawnSync('tar', ['-xOf', archiveFile, `pgtap-${source.commit}/Makefile`], {
    env: environment,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert(!extracted.error && extracted.status === 0, 'Pinned archive Makefile extraction failed');
  const archivedMakefile = path.join(root, 'Makefile.archive');
  writeFileSync(archivedMakefile, extracted.stdout);
  const archived = makefileFacts(archivedMakefile);
  console.log(
    JSON.stringify({
      phase: 'pinned-http-archive',
      commit,
      archiveBytes: archive.length,
      archiveSha256,
      ...archived,
    }),
  );
  assert.equal(
    canonical.sha256,
    qualifiedSha256,
    'Pinned Git blob differs from the qualified bytes',
  );
  assert(canonical.uninstallRecipe.pass, 'Original recipe rejected the pinned Git blob');
  assert.equal(
    repaired.sha256,
    qualifiedSha256,
    'Command-only checkout did not restore exact bytes',
  );
  assert(repaired.uninstallRecipe.pass, 'Original recipe rejected the command-only checkout');
  assert.equal(
    archived.sha256,
    canonical.sha256,
    'Archive Makefile differs from the pinned Git blob',
  );
  assert(archived.uninstallRecipe.pass, 'Original recipe rejected the pinned archive Makefile');
  if (forced) {
    assert(forced.crlf > 0 && !forced.uninstallRecipe.pass, 'Forced CRLF control did not reject');
  }
}
