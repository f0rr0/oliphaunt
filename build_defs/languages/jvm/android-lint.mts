import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Source = {
  kind: 'source' | 'generated' | 'conventional' | 'sdk';
  member: string;
  file: string;
};
type Library = { coordinate: string; jars: string[]; dependencies: string[] };
type Metadata = {
  agpVersion: string;
  namespace: string;
  jvmTarget: string;
  languageVersion: string;
  compileSdk: number;
  minSdk: number;
  expectIssue: string;
};

/** Resolve response-file facts only within their declared runfiles root. */
export function declaredAndroidLintArguments(specification: string, runfiles: string): string[] {
  assert(path.isAbsolute(runfiles), 'Android Lint requires an absolute declared runfiles root');
  const arguments_ = JSON.parse(specification);
  assert(Array.isArray(arguments_), 'Android Lint requires declared argument records');
  return arguments_.map((argument) => {
    assert(argument && typeof argument === 'object' && Object.keys(argument).length === 1);
    if (Object.hasOwn(argument, 'literal')) {
      assert.equal(typeof argument.literal, 'string');
      return argument.literal;
    }
    const file = argument.file;
    assert(
      typeof file === 'string' &&
        file &&
        !path.posix.isAbsolute(file) &&
        !/^[A-Za-z]:/u.test(file) &&
        !/[\\\u0000-\u001f]/u.test(file) &&
        file.split('/').every((part) => part && part !== '.' && part !== '..'),
      'Android Lint requires a safe declared runfile',
    );
    return path.join(runfiles, file);
  });
}

/** Stage exactly declared files so Lint cannot discover an ambient SDK or project. */
export function stageAndroidLintSources(root: string, sources: Source[]) {
  const seen = new Set<string>();
  const authored: string[] = [];
  const generated: string[] = [];
  for (const { kind, member, file } of sources) {
    assert(
      member &&
        !/^[A-Za-z]:/u.test(member) &&
        !/[\\\u0000-\u001f]/u.test(member) &&
        !path.posix.isAbsolute(member) &&
        member.split('/').every((part) => part && part !== '.' && part !== '..'),
      'Android Lint requires safe explicit file members',
    );
    const directory =
      kind === 'sdk'
        ? 'sdk'
        : kind === 'conventional'
          ? 'project'
          : `project/oliphaunt/${kind === 'generated' ? 'generated' : 'authored'}`;
    const relative = `${directory}/${member}`;
    assert(!seen.has(relative), `Duplicate Android Lint file ${relative}`);
    seen.add(relative);
    const destination = path.join(root, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(file, destination);
    if (kind === 'source') authored.push(destination);
    if (kind === 'generated') generated.push(destination);
  }
  assert(authored.length, 'Android Lint requires actual authored production sources');
  assert(
    sources.some(({ kind, member }) => kind === 'sdk' && member.endsWith('/android.jar')),
    'Android Lint requires the declared compiler SDK platform',
  );
  return { authored, generated };
}

if (import.meta.main) {
  const [specification, runfiles] = process.argv.slice(2);
  assert(specification && runfiles && process.argv.length === 4);
  const [java, metadataText, ...arguments_] = declaredAndroidLintArguments(
    readFileSync(specification, 'utf8'),
    runfiles,
  );
  assert(java && metadataText, 'Android Lint requires declared Java and conventional metadata');
  const metadata: Metadata = JSON.parse(metadataText);
  const tools: string[] = [];
  const classes: string[] = [];
  const proguard: string[] = [];
  const sources: Source[] = [];
  const libraries: Library[] = [];
  const dependencies: string[] = [];
  let manifest: string | undefined;
  let mergedManifest: string | undefined;
  for (let index = 0; index < arguments_.length; ) {
    const kind = arguments_[index++];
    if (
      kind === 'tool' ||
      kind === 'class' ||
      kind === 'proguard' ||
      kind === 'dependency' ||
      kind === 'manifest' ||
      kind === 'merged-manifest'
    ) {
      const file = arguments_[index++];
      assert(file, `Incomplete Android Lint ${kind} declaration`);
      if (kind === 'tool') tools.push(file);
      if (kind === 'class') classes.push(file);
      if (kind === 'proguard') proguard.push(file);
      if (kind === 'dependency') dependencies.push(file);
      if (kind === 'manifest') {
        assert(!manifest, 'Android Lint requires exactly one native manifest');
        manifest = file;
      }
      if (kind === 'merged-manifest') {
        assert(!mergedManifest, 'Android Lint requires exactly one native merged manifest');
        mergedManifest = file;
      }
    } else if (kind === 'library') {
      const [coordinate, dependencyText, countText] = arguments_.slice(index, index + 3);
      const count = Number(countText);
      assert(coordinate && dependencyText && Number.isSafeInteger(count) && count > 0);
      index += 3;
      const jars = arguments_.slice(index, index + count);
      assert.equal(jars.length, count);
      index += count;
      libraries.push({ coordinate, dependencies: JSON.parse(dependencyText), jars });
    } else {
      assert(
        ['source', 'generated', 'conventional', 'sdk'].includes(kind),
        'Unknown Android Lint input',
      );
      const [member, file] = arguments_.slice(index, index + 2);
      assert(member && file, 'Incomplete Android Lint source declaration');
      index += 2;
      sources.push({ kind: kind as Source['kind'], member, file });
    }
  }
  assert(
    tools.length && classes.length && manifest && mergedManifest,
    'Android Lint requires actual CLI, compiled classes and native manifests',
  );
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-android-lint-'));
  try {
    stageAndroidLintSources(root, sources);
    const moduleRoot = path.join(root, 'project', 'oliphaunt');
    const nativeManifest = path.join(moduleRoot, 'AndroidManifest.xml');
    copyFileSync(manifest, nativeManifest);
    const compiledManifest = path.join(moduleRoot, 'AndroidManifest.merged.xml');
    copyFileSync(mergedManifest, compiledManifest);
    const destination = path.join(root, 'model');
    const sdk = path.join(root, 'sdk');
    const spec = path.join(root, 'model.json');
    writeFileSync(
      spec,
      JSON.stringify({
        root: moduleRoot,
        destination,
        agpVersion: metadata.agpVersion,
        namespace: metadata.namespace,
        jvmTarget: metadata.jvmTarget,
        compileSdk: metadata.compileSdk,
        minSdk: metadata.minSdk,
        targetSdk: metadata.compileSdk,
        bootClasspath: [
          path.join(sdk, 'platforms', `android-${metadata.compileSdk}`, 'android.jar'),
        ],
        classes,
        manifest: nativeManifest,
        mergedManifest: compiledManifest,
        sources: [path.join(moduleRoot, 'authored')],
        generatedSources: sources.some(({ kind }) => kind === 'generated')
          ? [path.join(moduleRoot, 'generated')]
          : [],
        consumerProguard: proguard,
        libraries,
        dependencies,
      }),
    );
    const environment = { ...process.env };
    for (const key of [
      'ANDROID_HOME',
      'ANDROID_SDK_ROOT',
      'LINT_JARS',
      'JAVA_TOOL_OPTIONS',
      '_JAVA_OPTIONS',
      'JDK_JAVA_OPTIONS',
    ])
      delete environment[key];
    const prefix = [
      '-Xmx768m',
      '-XX:ActiveProcessorCount=2',
      `-Duser.home=${root}`,
      '-Dfile.encoding=UTF-8',
      '-cp',
      tools.join(path.delimiter),
    ];
    const options = {
      cwd: path.join(root, 'project'),
      env: environment,
      encoding: 'utf8' as const,
      maxBuffer: 16 * 1024 * 1024,
    };
    const model = spawnSync(java, [...prefix, 'dev.oliphaunt.build.LintModel', spec], options);
    if (model.error) throw model.error;
    assert.equal(
      model.status,
      0,
      `Official Android Lint model serialization failed:\n${model.stdout}${model.stderr}`,
    );
    const result = spawnSync(
      java,
      [
        ...prefix,
        'com.android.tools.lint.Main',
        '--lint-model',
        destination,
        '--variant',
        'debug',
        '--sdk-home',
        sdk,
        '--jdk-home',
        path.dirname(path.dirname(java)),
        '--cache-dir',
        path.join(root, 'cache'),
        '--java-language-level',
        metadata.jvmTarget,
        '--kotlin-language-level',
        metadata.languageVersion,
        '--offline',
        '--exitcode',
      ],
      options,
    );
    if (result.error) throw result.error;
    const output = `${result.stdout}${result.stderr}`;
    process.stdout.write(output);
    if (metadata.expectIssue) {
      assert.equal(
        result.status,
        1,
        'Android Lint API canary must fail with a genuine source error',
      );
      assert(
        output.includes(`[${metadata.expectIssue}]`),
        `Android Lint missed its ${metadata.expectIssue} API canary`,
      );
      assert(!output.includes('[LintError]'), 'Android Lint API canary has an analysis failure');
    } else {
      assert.equal(result.status, 0, 'Conventional Android debug source analysis failed');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
