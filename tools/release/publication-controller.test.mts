import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPublicationController as assertProof } from './publication-controller.mts';

const script = path.resolve(import.meta.dirname, 'publication-controller.sh');
function assertPublicationChanges({ source, controller, root }, checkout = false) {
  execFileSync('bash', [script, ...(checkout ? [] : ['--changes-only']), source, controller], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return { source, controller };
}
const assertPublicationController = (options) => assertPublicationChanges(options, true);

test('only clean publication-only descendants can execute an older frozen candidate', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'publication-controller-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), value);
  };
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    write('product', 'original');
    const source = commit();
    assertPublicationController({ source, controller: source, root });
    write('tools/release/crates-io-bootstrap-capacity.mts', 'fixed publisher');
    const controller = commit();
    const proof = { source, controller, mode: 'checkout' };
    assert.deepEqual(
      assertProof({
        source,
        controller,
        environment: { OLIPHAUNT_PUBLICATION_CONTROLLER_JSON: JSON.stringify(proof) },
      }),
      { source, controller },
    );
    for (const changed of [null, { ...proof, source: controller }, { ...proof, mode: 'changes' }])
      assert.throws(
        () =>
          assertProof({
            source,
            controller,
            environment: { OLIPHAUNT_PUBLICATION_CONTROLLER_JSON: JSON.stringify(changed) },
          }),
        /matching proof/u,
      );
    const probe = path.join(root, 'probe.mts');
    writeFileSync(
      probe,
      'import { assertPublicationController } from ' +
        JSON.stringify(path.resolve(import.meta.dirname, 'publication-controller.mts')) +
        '; assertPublicationController({source:process.argv[2],controller:process.argv[3]});',
    );
    // The probe is an ignored temporary file so it cannot weaken the clean-checkout check.
    writeFileSync(path.join(root, '.git/info/exclude'), 'probe.mts\n');
    execFileSync('bash', [script, source, controller, 'node', probe, source, controller], {
      cwd: root,
      stdio: 'pipe',
    });
    assert.deepEqual(assertPublicationController({ source, controller, root }), {
      source,
      controller,
    });
    write('.github/scripts/download-completed-bootstrap.mts', 'newer publisher');
    const newer = commit();
    assertPublicationController({ source, controller: newer, root });
    assert.deepEqual(assertPublicationChanges({ source, controller, root }), {
      source,
      controller,
    });
    assert.throws(
      () => assertPublicationController({ source, controller, root }),
      /checkout|HEAD/u,
    );
    for (const file of [
      'product',
      'src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts',
      'Cargo.lock',
      '.github/workflows/ci.yml',
      'tools/release/moon.yml',
    ]) {
      git('checkout', '--detach', controller);
      write(file, 'changed');
      assert.throws(
        () => assertPublicationController({ source, controller, root }),
        /clean source checkout/u,
      );
      const changed = commit();
      assert.throws(
        () => assertPublicationController({ source, controller: changed, root }),
        /non-publication changes/u,
      );
    }
    git('checkout', '--detach', source);
    assert.throws(
      () => assertPublicationController({ source: controller, controller: source, root }),
      /ancestor/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
