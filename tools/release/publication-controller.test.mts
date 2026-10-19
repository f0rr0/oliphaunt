import assert from 'node:assert/strict';
import { assertPublicationController } from './publication-controller.mts';

const [mode, source, controller] = process.argv.slice(2);
if (mode === 'inherited') {
  assert.deepEqual(assertPublicationController({ source, controller }), { source, controller });
} else if (mode === 'proof') {
  const proof = { source, controller, mode: 'checkout' };
  assert.deepEqual(
    assertPublicationController({
      source,
      controller,
      environment: { OLIPHAUNT_PUBLICATION_CONTROLLER_JSON: JSON.stringify(proof) },
    }),
    { source, controller },
  );
  for (const changed of [null, { ...proof, source: controller }, { ...proof, mode: 'changes' }])
    assert.throws(
      () =>
        assertPublicationController({
          source,
          controller,
          environment: { OLIPHAUNT_PUBLICATION_CONTROLLER_JSON: JSON.stringify(changed) },
        }),
      /matching proof/u,
    );
} else throw Error('expected inherited or proof');
