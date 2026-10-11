import assert from 'node:assert/strict';

/** Import the literal publication metadata already authored in the Gradle build. */
export function conventionalPomMetadata(gradle: string, version: string) {
  const start = gradle.indexOf('\n    pom {');
  assert.ok(
    start >= 0 && gradle.indexOf('\n    pom {', start + 1) < 0,
    'Expected one conventional Maven pom block',
  );
  const source = gradle.slice(start);
  function field(name: string, occurrences = 1) {
    const matches = [
      ...source.matchAll(new RegExp(`^\\s*${name}[.]set\\("([^"\\n]+)"\\)\\s*$`, 'gm')),
    ];
    assert.equal(matches.length, occurrences, `Expected ${occurrences} literal POM ${name} values`);
    return matches.map((match) => match[1]!.replaceAll('${project.version}', version));
  }
  const names = field('name', 3);
  const urls = field('url', 4);
  for (const value of [
    ...names,
    ...urls,
    ...field('description'),
    ...field('connection'),
    ...field('developerConnection'),
  ])
    assert.ok(!value.includes('${'), 'Unsupported dynamic conventional Maven metadata');
  return {
    name: names[0]!,
    description: field('description')[0]!,
    inceptionYear: field('inceptionYear')[0]!,
    url: urls[0]!,
    license: { name: names[1]!, url: urls[1]!, distribution: field('distribution')[0]! },
    developer: { id: field('id')[0]!, name: names[2]!, url: urls[2]! },
    scm: {
      url: urls[3]!,
      connection: field('connection')[0]!,
      developerConnection: field('developerConnection')[0]!,
    },
  };
}

const xml = (value: string) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const tag = (name: string, value: string) => `<${name}>${xml(value)}</${name}>`;

export function mavenPom({ coordinate, metadata, dependencies = [] }) {
  const { groupId, artifactId, version, packaging } = coordinate;
  const dependencyXml = dependencies
    .map(({ module, version: dependencyVersion, scope, type, exclusions = [] }) => {
      const [group, artifact] = module.split(':');
      assert.ok(group && artifact && dependencyVersion);
      return `<dependency>${tag('groupId', group)}${tag('artifactId', artifact)}${tag('version', dependencyVersion)}${scope ? tag('scope', scope) : ''}${type ? tag('type', type) : ''}${exclusions.length ? `<exclusions>${exclusions.map(({ groupId: excludedGroup, artifactId: excludedArtifact }) => `<exclusion>${tag('groupId', excludedGroup)}${tag('artifactId', excludedArtifact)}</exclusion>`).join('')}</exclusions>` : ''}</dependency>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">${tag('modelVersion', '4.0.0')}${tag('groupId', groupId)}${tag('artifactId', artifactId)}${tag('version', version)}${tag('packaging', packaging)}${tag('name', metadata.name)}${tag('description', metadata.description)}${tag('inceptionYear', metadata.inceptionYear)}${tag('url', metadata.url)}<licenses><license>${tag('name', metadata.license.name)}${tag('url', metadata.license.url)}${tag('distribution', metadata.license.distribution)}</license></licenses><developers><developer>${tag('id', metadata.developer.id)}${tag('name', metadata.developer.name)}${tag('url', metadata.developer.url)}</developer></developers><scm>${tag('url', metadata.scm.url)}${tag('connection', metadata.scm.connection)}${tag('developerConnection', metadata.scm.developerConnection)}</scm>${dependencyXml ? `<dependencies>${dependencyXml}</dependencies>` : ''}</project>\n`;
}
