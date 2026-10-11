import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { kotlinMavenCentralCoordinates } from '../../../src/native/sdks/kotlin/tools/kotlin-maven-staging.mts';
import { createDeterministicZip } from '../../../tools/packaging/archive-directory.mts';
import { validateMavenCentralPublication } from '../../../tools/packaging/maven-central-contract.mts';
import { inspectPlatformBinaryBuffer } from '../../../tools/packaging/platform-binary-contract.mts';
import {
  readJavaArchiveEntries,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../../tools/packaging/release-notices.mts';
import { stageMobileLegalSources } from '../mobile-legal.mts';
import { mavenPom } from './maven-pom.mts';

const ANDROID_TARGETS = { 'arm64-v8a': 'android-arm64', x86_64: 'android-x86_64' };
function put(root: string, member: string, bytes: Uint8Array | string) {
  assert.ok(
    member &&
      !member.startsWith('/') &&
      !member.includes('\\') &&
      member.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe package member ${member}`,
  );
  const file = path.join(root, member);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes, { mode: 0o644 });
}
function archiveFiles(file: string, { javaArchive = false } = {}) {
  const entries = javaArchive
    ? readJavaArchiveEntries(realpathSync(file))
    : readPortableArchiveEntries(realpathSync(file), { format: 'zip' });
  return new Map(
    [...entries]
      .filter(([, entry]) => entry.isFile)
      .map(([name, entry]) => [name, Buffer.from(entry.data())]),
  );
}
async function mergeClasses(inputs: string[], directory: string, output: string) {
  const seen = new Map<string, Buffer>();
  for (const input of inputs)
    for (const [name, bytes] of archiveFiles(input, { javaArchive: true })) {
      if (name === 'META-INF/MANIFEST.MF') continue;
      const previous = seen.get(name);
      assert.ok(!previous || previous.equals(bytes), `Conflicting compiled class/resource ${name}`);
      seen.set(name, bytes);
    }
  assert.ok(
    [...seen.keys()].some((name) => name.endsWith('.class')),
    'Publication must contain compiled classes',
  );
  put(directory, 'META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\r\n\r\n');
  for (const [name, bytes] of seen) put(directory, name, bytes);
  writeFileSync(output, await createDeterministicZip(directory));
}
function sourceMember(member: string, bytes: Buffer) {
  if (member.startsWith('generated/')) {
    const packageName = bytes.toString('utf8').match(/^package ([A-Za-z0-9_.]+)\s*;?$/mu)?.[1];
    assert.ok(packageName, `Generated source ${member} must declare its package`);
    return `${packageName.replaceAll('.', '/')}/${path.posix.basename(member)}`;
  }
  return member;
}
function validateAndroidManifest(manifest: string, kotlin) {
  const root = manifest.match(/<manifest\b[^>]*>/u);
  assert.ok(root, 'Compiler manifest must declare its manifest root');
  const namespaces = [...root[0].matchAll(/\sxmlns:android\s*=\s*(["'])([^"']*)\1/gu)];
  assert.deepEqual(
    namespaces.map((match) => match[2]),
    ['http://schemas.android.com/apk/res/android'],
    'Compiler manifest must bind the canonical Android namespace',
  );
  const sdkTags = [...manifest.matchAll(/<\/?uses-sdk\b[^>]*>/gu)];
  assert.equal(sdkTags.length, 1, 'Compiler manifest must declare exactly one uses-sdk');
  const sdk = sdkTags[0][0].match(/^<uses-sdk\b([\s\S]*?)\/>$/u);
  assert.ok(sdk, 'Compiler uses-sdk must be self-closing');
  assert.match(
    sdk[1],
    /^(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/u,
    'Compiler uses-sdk must contain canonical Android SDK attributes',
  );
  const attributes = [...sdk[1].matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(["'])([^"']*)\2/gu)]
    .map((match) => [match[1], match[3]])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(
    attributes,
    [
      ['android:minSdkVersion', String(kotlin.minSdk)],
      ['android:targetSdkVersion', String(kotlin.compileSdk)],
    ],
    'Compiler uses-sdk must contain canonical Android SDK attributes',
  );
}
function sdkDependencies(specification) {
  const libraries = specification.kotlin.libraries;
  const coroutines = libraries['kotlinx-coroutines-core'];
  const [group, artifact] = coroutines.module.split(':');
  // MavenInfo identifies the locked JVM variant; maintained Java processing
  // may change its declared JAR filename without changing that identity.
  assert.equal(
    specification.coroutinesCoordinates,
    `${group}:${artifact}-jvm:${coroutines.version}`,
    'Resolved coroutine dependency must have the canonical JVM Maven coordinates',
  );
  assert.ok(
    archiveFiles(specification.coroutinesJvm, { javaArchive: true }).has(
      'kotlinx/coroutines/Job.class',
    ),
    'Resolved coroutine dependency must be the actual JVM library',
  );
  return [
    { ...libraries['kotlin-stdlib'], scope: 'compile' },
    {
      ...libraries.jna,
      type: 'aar',
      scope: 'runtime',
      exclusions: [{ groupId: '*', artifactId: '*' }],
    },
    {
      module: `${group}:${artifact}-jvm`,
      version: coroutines.version,
      scope: 'runtime',
      exclusions: [
        'kotlin-stdlib-common',
        'kotlin-test-common',
        'kotlin-test-annotations-common',
      ].map((artifactId) => ({ groupId: 'org.jetbrains.kotlin', artifactId })),
    },
  ];
}
export async function packageKotlinMaven(output: string, specification) {
  output = path.resolve(output);
  mkdirSync(output, { recursive: true });
  const coordinate = kotlinMavenCentralCoordinates(specification.version).find(
    (value) => `${value.groupId}:${value.artifactId}` === specification.coordinate,
  );
  assert.ok(
    coordinate && specification.registryPackages.includes(`maven:${specification.coordinate}`),
    'Publication coordinate must belong to the canonical Kotlin owner',
  );
  const scratch = mkdtempSync(path.join(output, '.maven-package-'));
  try {
    const isSdk = coordinate.packaging === 'aar';
    const isMarker = coordinate.packaging === 'pom';
    const metadata = isSdk ? specification.kotlin.sdkPom : specification.kotlin.pluginPom;
    const prefix = `${coordinate.artifactId}-${coordinate.version}`;
    const directory = path.join(output, coordinate.directory);
    mkdirSync(directory, { recursive: true });
    if (!isMarker) {
      const sourceRoot = path.join(scratch, 'sources');
      let contract;
      if (isSdk) contract = stageMobileLegalSources(specification.legalSources, sourceRoot);
      else
        for (const member of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
          assert.equal(typeof specification.legalSources[member], 'string', `Missing ${member}`);
          put(sourceRoot, member, readFileSync(realpathSync(specification.legalSources[member])));
        }
      if (isSdk) {
        assert.deepEqual(
          Object.keys(specification.nativeLibraries).sort(),
          Object.keys(ANDROID_TARGETS).sort(),
          'AAR must consume both exact declared Android ABI outputs',
        );
        const aar = path.join(scratch, 'aar');
        // Android's compiler creates a Java ZIP container; final publication
        // bytes below still pass the strict portable archive reader.
        for (const [member, bytes] of archiveFiles(specification.androidAar, { javaArchive: true }))
          if (member !== 'classes.jar') {
            assert.ok(
              !member.startsWith('jni/') && !member.startsWith('assets/oliphaunt'),
              'Compiler AAR may not smuggle native runtime payloads',
            );
            put(aar, member, bytes);
          }
        const manifest = readFileSync(path.join(aar, 'AndroidManifest.xml'), 'utf8');
        validateAndroidManifest(manifest, specification.kotlin);
        await mergeClasses(
          specification.classJars,
          path.join(scratch, 'classes'),
          path.join(aar, 'classes.jar'),
        );
        for (const [abi, target] of Object.entries(ANDROID_TARGETS)) {
          const bytes = readFileSync(realpathSync(specification.nativeLibraries[abi]));
          inspectPlatformBinaryBuffer(bytes, {
            target: `android-${abi}`,
            label: `Kotlin ${abi} mobile bindings`,
          });
          put(aar, `jni/${abi}/liboliphaunt_mobile_bindings.so`, bytes);
          const legal = path.join(aar, 'assets/oliphaunt-native-bindings', target);
          stageReleaseNotices(legal, { profile: 'source-sdk', sourceRoot });
          contract.stageRustDependencyLicenses(legal, target);
          contract.assertRustDependencyLicensesInDirectory(legal, { target });
        }
        stageReleaseNotices(aar, { profile: 'source-sdk', sourceRoot });
        const archive = path.join(directory, `${prefix}.aar`);
        writeFileSync(archive, await createDeterministicZip(aar));
        const entries = readPortableArchiveEntries(archive, { format: 'zip' });
        for (const target of Object.values(ANDROID_TARGETS))
          contract.assertRustDependencyLicensesInEntries(entries, {
            target,
            prefix: `assets/oliphaunt-native-bindings/${target}`,
          });
      } else {
        const jar = path.join(scratch, 'plugin');
        await mergeClasses(specification.classJars, jar, path.join(scratch, 'compiled.jar'));
        stageReleaseNotices(path.join(jar, 'META-INF'), { profile: 'source-sdk', sourceRoot });
        const descriptor = readFileSync(
          path.join(jar, 'META-INF/gradle-plugins/dev.oliphaunt.android.properties'),
          'utf8',
        );
        assert.equal(
          descriptor,
          'implementation-class=dev.oliphaunt.android.OliphauntAndroidPlugin\n',
        );
        assert.ok(
          archiveFiles(specification.classJars[0], { javaArchive: true }).has(
            'dev/oliphaunt/android/OliphauntAndroidPlugin.class',
          ),
          'Actual plugin implementation must be compiled',
        );
        writeFileSync(path.join(directory, `${prefix}.jar`), await createDeterministicZip(jar));
      }
      const sources = path.join(scratch, 'published-sources');
      for (const [member, file] of Object.entries(specification.sources) as [string, string][]) {
        const bytes = readFileSync(realpathSync(file));
        put(sources, sourceMember(member, bytes), bytes);
      }
      assert.ok(
        Object.keys(specification.sources).length > 0,
        'Source companion must contain actual publication sources',
      );
      stageReleaseNotices(path.join(sources, 'META-INF'), { profile: 'source-sdk', sourceRoot });
      writeFileSync(
        path.join(directory, `${prefix}-sources.jar`),
        await createDeterministicZip(sources),
      );
      const docs = path.join(scratch, 'published-docs');
      const javadoc = specification.javadocArchive
        ? archiveFiles(specification.javadocArchive)
        : new Map(
            Object.entries(specification.javadoc ?? {}).map(([member, file]) => [
              member,
              readFileSync(realpathSync(file as string)),
            ]),
          );
      if (!isSdk)
        assert.ok(
          [...javadoc.keys()].some((name) => name.endsWith('.html')),
          'Plugin documentation companion requires real Javadoc output',
        );
      for (const [member, bytes] of javadoc) put(docs, member, bytes);
      stageReleaseNotices(path.join(docs, 'META-INF'), { profile: 'source-sdk', sourceRoot });
      // The existing Android publication has a legal-only javadoc companion.
      writeFileSync(
        path.join(directory, `${prefix}-javadoc.jar`),
        await createDeterministicZip(docs),
      );
      if (!isSdk) {
        const file = path.join(directory, `${prefix}.jar`);
        const bytes = readFileSync(file);
        const artifact = {
          name: path.basename(file),
          url: path.basename(file),
          size: bytes.length,
          sha512: createHash('sha512').update(bytes).digest('hex'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sha1: createHash('sha1').update(bytes).digest('hex'),
          md5: createHash('md5').update(bytes).digest('hex'),
        };
        writeFileSync(
          path.join(directory, `${prefix}.module`),
          `${JSON.stringify({ formatVersion: '1.1', component: { group: coordinate.groupId, module: coordinate.artifactId, version: coordinate.version, attributes: { 'org.gradle.status': 'release' } }, variants: ['java-api', 'java-runtime'].map((usage) => ({ name: usage === 'java-api' ? 'apiElements' : 'runtimeElements', attributes: { 'org.gradle.category': 'library', 'org.gradle.dependency.bundling': 'external', 'org.gradle.jvm.version': Number(specification.kotlin.jvmTarget), 'org.gradle.libraryelements': 'jar', 'org.gradle.usage': usage }, files: [artifact] })) }, null, 2)}\n`,
        );
      }
    }
    const dependencies = isSdk
      ? sdkDependencies(specification)
      : isMarker
        ? [{ module: 'dev.oliphaunt:oliphaunt-android-gradle-plugin', version: coordinate.version }]
        : [];
    const pom = mavenPom({ coordinate, metadata, dependencies });
    writeFileSync(path.join(directory, `${prefix}.pom`), pom);
    const files = coordinate.files.map((relative) => ({
      name: path.basename(relative),
      size: readFileSync(path.join(output, relative)).length,
    }));
    validateMavenCentralPublication({ pomText: pom, files, context: specification.coordinate });
    return coordinate.files;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [output, specification] = process.argv.slice(2);
  assert.equal(
    process.argv.length,
    4,
    'Expected output directory and explicit publication input JSON',
  );
  await packageKotlinMaven(output, JSON.parse(readFileSync(specification, 'utf8')));
}
