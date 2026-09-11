import assert from 'node:assert/strict';
import {
  derivePublicationProducts,
  resolvePublicationPlanningSource,
  verifyPublicationCandidate,
} from './verify-publication-candidate.mts';

const [scenario, repo, release, headRef] = process.argv.slice(2);
const options = { repo, headRef, products: ['alpha'] };
switch (scenario) {
  case 'rerun':
    assert.equal(headRef, release);
    assert.deepEqual(derivePublicationProducts(options), ['alpha']);
    assert.deepEqual(resolvePublicationPlanningSource(options), {
      planHeadSha: release,
      publicationSha: release,
    });
    assert.deepEqual(verifyPublicationCandidate(options), {
      mode: 'release-bump',
      publicationSha: release,
      releaseSha: release,
      products: ['alpha'],
      versions: { alpha: '0.1.0' },
    });
    break;
  case 'controller':
    assert.notEqual(headRef, release);
    assert.deepEqual(verifyPublicationCandidate(options), {
      mode: 'release-bump',
      publicationSha: headRef,
      releaseSha: release,
      products: ['alpha'],
      versions: { alpha: '0.1.0' },
    });
    assert.throws(
      () => verifyPublicationCandidate({ ...options, products: ['other'] }),
      /selected products do not match release commit/u,
    );
    break;
  case 'changed-version':
    assert.notEqual(headRef, release);
    assert.throws(
      () => verifyPublicationCandidate(options),
      /publication versions .* do not match release commit/u,
    );
    break;
  default:
    throw new Error('run through verify-publication-candidate.test.sh');
}
console.log(`publication candidate ${scenario}: passed`);
