import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkKotlinPackage } from '../../../src/native/sdks/kotlin/tools/check-package.mts';
import { validateKotlinMavenStagingClosure } from '../../../src/native/sdks/kotlin/tools/kotlin-maven-staging.mts';
import { readJavaArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { stageMobileLegalSources } from '../mobile-legal.mts';

const PUBLIC_CONSUMER_CLASSES = [
  'dev/oliphaunt/consumer/PublicApiConsumerKt.class',
  'dev/oliphaunt/consumer/JavaPublicApiConsumer.class',
];

export function requirePublicConsumerClasses(files: string[]) {
  assert(files.length, 'Installed Android public API consumer must compile to declared JARs');
  const members = new Set(files.flatMap((file) => [...readJavaArchiveEntries(file).keys()]));
  for (const member of PUBLIC_CONSUMER_CLASSES)
    assert(members.has(member), `Installed Android public API consumer is missing ${member}`);
}

export async function checkInstalledKotlinMaven(version: string, arguments_: string[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-installed-kotlin-'));
  try {
    const packageRoot = path.join(root, 'package');
    const maven = path.join(packageRoot, 'maven');
    mkdirSync(maven, { recursive: true });
    const copied = new Set<string>();
    const consumers: string[] = [];
    const legalSources: Record<string, string> = {};
    for (let index = 0; index < arguments_.length; ) {
      const kind = arguments_[index++];
      if (kind === 'consumer') {
        const file = arguments_[index++];
        assert(file, 'Compiled public API consumer requires its declared JAR');
        const destination = path.join(root, `consumer-${consumers.length}.jar`);
        copyFileSync(file, destination);
        consumers.push(destination);
        continue;
      }
      if (kind === 'legal') {
        const member = arguments_[index++];
        const source = arguments_[index++];
        assert(member && source, 'Installed Kotlin test requires declared legal source files');
        assert(!Object.hasOwn(legalSources, member), `Duplicate declared legal source ${member}`);
        legalSources[member] = source;
        continue;
      }
      assert.equal(
        kind,
        'maven',
        'Installed Kotlin test accepts only declared Maven files and consumer JARs',
      );
      const relative = arguments_[index++];
      const source = arguments_[index++];
      assert(
        relative &&
          source &&
          !relative.includes('\\') &&
          !path.posix.isAbsolute(relative) &&
          relative.split('/').every((part) => part && part !== '.' && part !== '..'),
        'Declared Maven member must be a safe repository relative file',
      );
      assert(!copied.has(relative), `Duplicate declared Maven file ${relative}`);
      copied.add(relative);
      const destination = path.join(maven, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    validateKotlinMavenStagingClosure(maven, version, { allowLocalMetadata: false });
    const sourceRoot = path.join(root, 'legal-sources');
    stageMobileLegalSources(legalSources, sourceRoot);
    assert(
      await checkKotlinPackage(packageRoot, { sourceRoot }),
      'Final Kotlin Maven repository must contain checked packages',
    );
    requirePublicConsumerClasses(consumers);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [version, ...arguments_] = process.argv.slice(2);
  assert(version, 'Installed Kotlin test requires its canonical owner version');
  await checkInstalledKotlinMaven(version, arguments_);
}
