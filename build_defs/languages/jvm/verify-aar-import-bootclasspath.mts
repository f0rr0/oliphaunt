/** Diagnose the pinned Android import bootclasspath using actual cached JARs. */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sdk, extras, merged, javap] = Bun.argv.slice(2);
assert.equal(
  Bun.argv.length,
  6,
  'Expected android.jar java_base_extras.jar merged_interface.jar absolute-javap',
);
assert(isAbsolute(javap), 'Use the actual declared JDK javap');
const files = [sdk, extras, merged].map(realpathSync);
// These are compiler/platform JAR diagnostics, not publication archive admission.
// Read them with the same pinned JDK whose javap inspects the actual class bytes.
const run = (executable: string, arguments_: string[]) => {
  const result = Bun.spawnSync([executable, ...arguments_], {
    env: { ...process.env, PATH: '', JAVA_TOOL_OPTIONS: '', JDK_JAVA_OPTIONS: '' },
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString();
};
const archives = files.map(
  (file) => new Set(run(join(dirname(javap), 'jar'), ['tf', file]).split('\n')),
);
const methodType = 'java/lang/invoke/MethodType.class';
const helper = 'java/lang/invoke/LambdaMetafactory.class';
const constable = 'java/lang/constant/Constable.class';
const classIdentity = (index: number, member: string) => {
  assert(archives[index].has(member), `Missing actual class ${files[index]}!/${member}`);
  const location = `jar:${pathToFileURL(files[index]).href}!/${member}`;
  const output = run(javap, ['-verbose', location]);
  assert(
    output.startsWith(`Classfile ${location}\n`),
    'javap must inspect that actual archive member',
  );
  const sha256 = output.match(/SHA-256 checksum ([a-f0-9]{64})/u)?.[1];
  assert(sha256, 'Actual class must report its SHA256');
  const declaration = output.split('\n').find((line) => line.startsWith('public '));
  assert(declaration, `Missing actual class declaration ${member}`);
  return { sha256, declaration };
};
const sdkMethod = classIdentity(0, methodType);
const extrasMethod = classIdentity(1, methodType);
const mergedMethod = classIdentity(2, methodType);
assert(!sdkMethod.declaration.includes('java.lang.constant.Constable'));
assert(extrasMethod.declaration.includes('java.lang.constant.Constable'));
assert.equal(mergedMethod.declaration, sdkMethod.declaration);
assert(
  archives.every((archive) => !archive.has(constable)),
  'Current Android closure lacks Constable',
);
const resolve = (order: number[], member: string) =>
  order.find((index) => archives[index].has(member));
assert.equal(resolve([1, 2], methodType), 1, 'Old ordering selects the incompatible extras class');
assert.equal(
  resolve([2, 1], methodType),
  2,
  'Proposed ordering selects the actual SDK-derived class',
);
assert(!archives[0].has(helper), 'The Java bootstrap helper is absent from Android public stubs');
const extrasHelper = classIdentity(1, helper);
const mergedHelper = classIdentity(2, helper);
assert.equal(mergedHelper.declaration, extrasHelper.declaration);
assert.notEqual(
  resolve([2, 1], helper),
  undefined,
  'Extras-only bootstrap helper must remain available',
);
console.log(`SDK MethodType: ${sdkMethod.sha256}\n${sdkMethod.declaration}`);
console.log(`Extras MethodType: ${extrasMethod.sha256}\n${extrasMethod.declaration}`);
console.log(`Selected SDK-derived MethodType: ${mergedMethod.sha256}`);
console.log(`Retained extras-only LambdaMetafactory: ${mergedHelper.sha256}`);
console.log(
  'Actual cached class identities prove SDK-first precedence; installed consumer execution remains required.',
);
