import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dir, '../..');
test('publication scopes tag planning to the verified Release Please candidate', () => {
  const { steps } = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  ).jobs['plan-candidate'];
  const identity = steps.findIndex((step) => step.id === 'release_scope');
  const plan = steps.findIndex((step) => step.id === 'release_plan');
  assert.ok(identity >= 0 && identity < plan);
  assert.match(steps[identity].run, /--derive-products/u);
  assert.equal(steps[plan].env.PRODUCTS_JSON, `\${{ steps.release_scope.outputs.products_json }}`);
  assert.match(steps[plan].run, /--products-json "\$PRODUCTS_JSON"/u);
  const proof = steps.findIndex((step) => step.id === 'verify_publication_candidate');
  assert.ok(proof > plan);
  assert.equal(steps[proof].env.PRODUCTS_JSON, `\${{ steps.release_plan.outputs.products_json }}`);
});
test('registry bootstrap remains eligible when qualification dispatch was skipped', () => {
  const { jobs } = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  assert.ok(jobs['prepare-candidate'].needs.includes('request-qualification'));
  const bootstrap = jobs['publish-bootstrap'];
  assert.ok(bootstrap.needs.includes('prepare-candidate'));
  assert.match(bootstrap.if, /!cancelled\(\)/u);
  assert.match(bootstrap.if, /needs\.prepare-candidate\.result == 'success'/u);
  assert.match(bootstrap.if, /needs\.prepare-candidate\.outputs\.bootstrap_required == 'true'/u);
});
test('both npm publication jobs can generate required provenance', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  for (const job of ['publish', 'publish-bootstrap']) {
    assert.equal(
      workflow.jobs[job].permissions['id-token'],
      'write',
      `${job} requires OIDC for npm --provenance even with token authentication`,
    );
  }
});
