import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { extensionProjections } from '../../src/extensions/tools/extension-projections.mts';
import {
  nativeComponentInventory,
  validateNativeComponentContract,
} from '../../src/extensions/tools/native-component-contract.mts';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    spec: { type: 'string' },
    components: { type: 'string' },
    sdk: { type: 'string' },
    generated: { type: 'string' },
    descriptors: { type: 'string' },
    metadata: { type: 'string' },
  },
  strict: true,
});
assert(values.spec && values.components);
if (!values.metadata) {
  assert(values.generated && values.descriptors);
  assert(
    values.sdk === 'ts' || values.sdk === 'react-native' || values.sdk === 'kotlin',
    'unsupported native SDK projection',
  );
}
const spec = JSON.parse(readFileSync(values.spec, 'utf8'));
assert.equal(spec.schema, 'oliphaunt-native-sdk-extension-projections-v1');
const profiles = new Map<string, string>();
for (const profile of spec.profiles.profiles)
  for (const row of profile.targets) {
    assert(!profiles.has(row.target), `duplicate target profile ${row.target}`);
    profiles.set(row.target, `${row.family}\0${row.kind}`);
  }
const contract = validateNativeComponentContract(
  Bun.TOML.parse(readFileSync(values.components, 'utf8')),
  {
    targetProfiles: profiles,
    knownExtensions: new Set(spec.catalog.extensions.map((row: any) => row['sql-name'])),
    checkSourcePaths: false,
  },
);
const outputs = extensionProjections(spec.catalog, spec.releases, {
  context: {
    inventory: nativeComponentInventory(contract),
    contrib: spec.contrib,
    recipes: new Map(Object.entries(spec.recipes)),
  },
  sdkOnly: values.sdk as 'ts' | 'react-native' | 'kotlin' | undefined,
  metadataOnly: Boolean(values.metadata),
});
if (values.metadata) {
  const metadata = outputs.get('src/extensions/generated/sdk/extensions.json');
  assert(metadata, 'SDK projection renderer omitted metadata');
  writeFileSync(values.metadata, metadata);
  process.exit(0);
}
const base =
  values.sdk === 'kotlin'
    ? 'src/native/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt'
    : `src/native/sdks/${values.sdk}/src`;
const generated = outputs.get(
  `${base}/${values.sdk === 'kotlin' ? 'GeneratedExtensions.kt' : 'generated/extensions.ts'}`,
);
const descriptors = outputs.get(
  `${base}/${values.sdk === 'kotlin' ? 'OliphauntExtension.kt' : 'extensions.ts'}`,
);
assert(generated && descriptors, 'SDK projection renderer omitted a required output');
assert(values.generated && values.descriptors);
writeFileSync(values.generated, generated);
writeFileSync(values.descriptors, descriptors);
