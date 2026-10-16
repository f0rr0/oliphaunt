import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderGeneratedArtifacts } from './generate.mjs';

test('shared numeric edits reach each generated consumer', () => {
  const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url), 'utf8'));
  contract.modes.find(({ name }) => name === 'hybrid').value = 7;
  contract.streamedOutput.callbackChunkMaxBytes = 12345;
  contract.directToolInput.readBatchMaxBytes = 54321;
  contract.modes.find(({ name }) => name === 'buffered-input-streamed-output-with-copy').value = 8;
  const files = renderGeneratedArtifacts(contract);
  assert.match(
    files['src/wasix/sdks/rust/src/oliphaunt/protocol_limits_generated.rs'],
    /PROTOCOL_HYBRID: i32 = 7;/,
  );
  assert.match(
    files['src/wasix/browser-host/protocol-contract.generated.rs'],
    /PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT_WITH_COPY: i32 = 8;/,
  );
  assert.doesNotMatch(
    files['src/wasix/browser-host/protocol-contract.generated.rs'],
    /PROTOCOL_HYBRID/,
  );
  for (const contents of Object.values(files)) assert.match(contents, /12345/);
  assert.match(
    files[
      'src/wasix/runtime/assets/build/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h'
    ],
    /OLIPHAUNT_WASIX_PROTOCOL_HYBRID 7/,
  );
  const header =
    files[
      'src/wasix/runtime/assets/build/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h'
    ];
  assert.match(header, /OLIPHAUNT_WASIX_DIRECT_TOOL_READ_BATCH_MAX 54321U/);
  assert.match(header, /OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT_WITH_COPY 8/);
  assert.match(
    files['src/wasix/sdks/rust/src/oliphaunt/protocol_limits_generated.rs'],
    /PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT_WITH_COPY: i32 = 8;/,
  );
});
