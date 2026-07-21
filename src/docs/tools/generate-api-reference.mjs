#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseToml } from 'smol-toml';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '../../..');
const manifestPath = path.join(docsRoot, 'docs-manifest.toml');
const apiRoot = path.join(repoRoot, 'target', 'docs', 'generated', 'api');
const summaryPath = path.join(apiRoot, 'summary.json');
const defaultCommandTimeoutMs = Number.parseInt(
  process.env.OLIPHAUNT_DOCS_API_TIMEOUT_MS ?? '600000',
  10,
);

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function parseTomlFile(filePath) {
  return parseToml(readText(filePath));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, '/');
}

function commandExists(command) {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: options.timeout ?? defaultCommandTimeoutMs,
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

function commandFailureStatus(error) {
  if (error?.signal === 'SIGTERM' || error?.killed || error?.code === 'ETIMEDOUT') {
    return 'skipped';
  }
  return 'failed';
}

function commandFailureReason(error) {
  if (error?.signal === 'SIGTERM' || error?.killed || error?.code === 'ETIMEDOUT') {
    return `timed out after ${defaultCommandTimeoutMs}ms`;
  }
  return error?.message ?? 'command failed';
}

function statusRecord(route, status, details) {
  return {
    id: route.id,
    productId: route.product_id,
    title: route.title,
    referenceKind: route.reference_kind,
    status,
    ...details,
  };
}

function parseCHeader(headerPath) {
  const header = readText(headerPath);
  const withoutComments = header.replace(/\/\*[\s\S]*?\*\//g, '');
  const functions = [
    ...withoutComments.matchAll(
      /\b(?:int32_t|uint64_t|void|const\s+char\s+\*)\s+(oliphaunt_[a-z0-9_]+)\s*\(([\s\S]*?)\);/g,
    ),
  ].map((match) => ({
    name: match[1],
    args: match[2].replace(/\s+/g, ' ').trim(),
  }));
  const constants = [
    ...header.matchAll(/^#define[ \t]+(OLIPHAUNT_[A-Z0-9_]+)(?:[ \t]+([^\r\n]+))?$/gm),
  ]
    .map((match) => ({
      name: match[1],
      value: (match[2] ?? '').trim(),
    }))
    .filter((constant) => constant.value.length > 0);
  return { functions, constants };
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function writeCReference(manifest, route, fullMode) {
  const config = manifest.api_reference?.c ?? {};
  const headerPath = path.join(
    repoRoot,
    config.header ?? 'src/runtimes/liboliphaunt/native/include/oliphaunt.h',
  );
  const outputRoot = path.join(apiRoot, 'c');
  const xmlRoot = path.join(outputRoot, 'xml');
  ensureDir(xmlRoot);

  const parsed = parseCHeader(headerPath);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<doxygen>
  <compounddef kind="file">
    <compoundname>${escapeXml(relative(headerPath))}</compoundname>
    <sectiondef kind="define">
${parsed.constants
  .map(
    (constant) =>
      `      <memberdef kind="define"><name>${escapeXml(constant.name)}</name><initializer>${escapeXml(constant.value)}</initializer></memberdef>`,
  )
  .join('\n')}
    </sectiondef>
    <sectiondef kind="func">
${parsed.functions
  .map(
    (fn) =>
      `      <memberdef kind="function"><name>${escapeXml(fn.name)}</name><argsstring>(${escapeXml(fn.args)})</argsstring></memberdef>`,
  )
  .join('\n')}
    </sectiondef>
  </compounddef>
</doxygen>
`;
  const fallbackXmlPath = path.join(xmlRoot, 'oliphaunt-header.xml');
  fs.writeFileSync(fallbackXmlPath, xml);

  const markdownPath = path.join(outputRoot, 'reference.md');
  fs.writeFileSync(
    markdownPath,
    `# C ABI Reference

Generated from \`${relative(headerPath)}\`.

## Functions

${parsed.functions.map((fn) => `- \`${fn.name}(${fn.args})\``).join('\n')}

## Constants

${parsed.constants.map((constant) => `- \`${constant.name}\` = \`${constant.value}\``).join('\n')}
`,
  );

  let doxygenStatus = 'not-run';
  let doxygenXmlPath = '';
  let doxygenFailureReason = '';
  const doxygenConfig = config.doxygen_config;
  const expectedDoxygenXml = path.join(apiRoot, 'c', 'doxygen', 'xml', 'index.xml');
  if (fullMode && doxygenConfig) {
    if (commandExists('doxygen')) {
      try {
        run('doxygen', [doxygenConfig]);
        if (fs.existsSync(expectedDoxygenXml)) {
          doxygenStatus = 'generated';
          doxygenXmlPath = relative(expectedDoxygenXml);
        } else {
          doxygenStatus = 'failed: expected Doxygen XML index missing';
          doxygenFailureReason = 'Doxygen completed but expected XML index is missing';
        }
      } catch (error) {
        doxygenStatus = `failed: ${error.message}`;
        doxygenFailureReason = commandFailureReason(error);
      }
    } else {
      doxygenStatus = 'failed: doxygen not installed';
      doxygenFailureReason = 'doxygen not installed';
    }
  } else if (doxygenConfig && fs.existsSync(expectedDoxygenXml)) {
    doxygenStatus = 'generated';
    doxygenXmlPath = relative(expectedDoxygenXml);
  }
  const fullModeRequiresDoxygen = fullMode && Boolean(doxygenConfig);
  const generatedByDoxygen = doxygenStatus === 'generated';

  return statusRecord(
    route,
    fullModeRequiresDoxygen && !generatedByDoxygen ? 'failed' : 'generated',
    {
      artifact: relative(markdownPath),
      machineReadableArtifact: relative(fallbackXmlPath),
      docsEntry: relative(markdownPath),
      symbolCount: parsed.functions.length,
      constantCount: parsed.constants.length,
      generator: generatedByDoxygen ? 'doxygen+xml' : 'header-parser+xml',
      doxygenStatus,
      doxygenXmlPath,
      reason: doxygenFailureReason,
    },
  );
}

function runCargoDoc(route, packageName, outputKey, fullMode) {
  const outputRoot = path.join(apiRoot, outputKey);
  ensureDir(outputRoot);
  const docsEntry = path.join(outputRoot, 'doc', packageName.replaceAll('-', '_'), 'index.html');
  if (!fullMode) {
    return statusRecord(route, fs.existsSync(docsEntry) ? 'generated' : 'configured', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'cargo doc',
      reason: fs.existsSync(docsEntry)
        ? 'using existing generated rustdoc artifact'
        : 'full rustdoc generation runs in release documentation checks',
    });
  }
  if (!commandExists('cargo')) {
    return statusRecord(route, 'skipped', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'cargo doc',
      reason: 'cargo not installed',
    });
  }
  try {
    run('cargo', [
      'doc',
      '--no-deps',
      '--package',
      packageName,
      '--target-dir',
      relative(outputRoot),
    ]);
    run('cargo', ['test', '--doc', '--package', packageName], { env: { RUSTDOCFLAGS: '' } });
    return statusRecord(route, fs.existsSync(docsEntry) ? 'generated' : 'failed', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'cargo doc',
      reason: fs.existsSync(docsEntry)
        ? ''
        : 'cargo doc completed but expected index.html is missing',
    });
  } catch (error) {
    return statusRecord(route, commandFailureStatus(error), {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'cargo doc',
      reason: commandFailureReason(error),
    });
  }
}

function runSwiftDocC(manifest, route, fullMode) {
  const config = manifest.api_reference?.swift ?? {};
  const outputRoot = path.join(apiRoot, 'swift');
  ensureDir(outputRoot);
  const docsEntry = path.join(outputRoot, 'Oliphaunt.doccarchive');
  if (!fullMode) {
    return statusRecord(route, fs.existsSync(docsEntry) ? 'generated' : 'configured', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'Swift-DocC',
      reason: fs.existsSync(docsEntry)
        ? 'using existing generated DocC archive'
        : 'full DocC generation runs in release documentation checks',
    });
  }
  if (!commandExists('swift')) {
    return statusRecord(route, 'skipped', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'Swift-DocC',
      reason: 'swift not installed',
    });
  }
  try {
    fs.rmSync(docsEntry, { force: true, recursive: true });
    run('swift', [
      'package',
      '--package-path',
      config.package_path ?? 'src/sdks/swift',
      '--allow-writing-to-directory',
      relative(outputRoot),
      'generate-documentation',
      '--target',
      config.target ?? 'Oliphaunt',
      '--output-path',
      relative(docsEntry),
      '--disable-indexing',
    ]);
    return statusRecord(route, fs.existsSync(docsEntry) ? 'generated' : 'failed', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'Swift-DocC',
      reason: fs.existsSync(docsEntry)
        ? ''
        : 'Swift-DocC completed but expected archive is missing',
    });
  } catch (error) {
    return statusRecord(route, commandFailureStatus(error), {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'Swift-DocC',
      reason: commandFailureReason(error),
    });
  }
}

function runKotlinDokka(manifest, route, fullMode) {
  const config = manifest.api_reference?.kotlin ?? {};
  const projectPath = path.join(repoRoot, config.project_path ?? 'src/sdks/kotlin');
  const gradlew = path.join(projectPath, 'gradlew');
  const docsEntry = path.join(apiRoot, 'kotlin', 'html', 'index.html');
  if (!fullMode) {
    return statusRecord(route, fs.existsSync(docsEntry) ? 'generated' : 'configured', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'Dokka v2',
      reason: fs.existsSync(docsEntry)
        ? 'using existing generated Dokka artifact'
        : 'full Dokka generation runs in release documentation checks',
    });
  }
  if (!fs.existsSync(gradlew)) {
    return statusRecord(route, 'skipped', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'Dokka v2',
      reason: 'Gradle wrapper missing',
    });
  }
  try {
    execFileSync(
      gradlew,
      ['--no-daemon', config.task ?? ':oliphaunt:dokkaGeneratePublicationHtml'],
      {
        cwd: projectPath,
        stdio: 'inherit',
        timeout: defaultCommandTimeoutMs,
        env: {
          ...process.env,
          OLIPHAUNT_GRADLE_BUILD_ROOT: path.join(repoRoot, 'target', 'oliphaunt-gradle-build'),
        },
      },
    );
    return statusRecord(route, fs.existsSync(docsEntry) ? 'generated' : 'failed', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'Dokka v2',
      reason: fs.existsSync(docsEntry) ? '' : 'Dokka completed but expected index.html is missing',
    });
  } catch (error) {
    return statusRecord(route, commandFailureStatus(error), {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'Dokka v2',
      reason: commandFailureReason(error),
    });
  }
}

function runTypeDoc(route, packagePath, outputKey, fullMode) {
  const docsEntry = path.join(apiRoot, outputKey, 'html', 'index.html');
  if (!fullMode) {
    return statusRecord(route, fs.existsSync(docsEntry) ? 'generated' : 'configured', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'TypeDoc',
      reason: fs.existsSync(docsEntry)
        ? 'using existing generated TypeDoc artifact'
        : 'full TypeDoc generation runs in release documentation checks',
    });
  }
  try {
    run('pnpm', ['--dir', packagePath, 'run', 'docs:api']);
    return statusRecord(route, fs.existsSync(docsEntry) ? 'generated' : 'failed', {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'TypeDoc',
      reason: fs.existsSync(docsEntry)
        ? ''
        : 'TypeDoc completed but expected index.html is missing',
    });
  } catch (error) {
    return statusRecord(route, commandFailureStatus(error), {
      artifact: relative(docsEntry),
      docsEntry: relative(docsEntry),
      generator: 'TypeDoc',
      reason: commandFailureReason(error),
    });
  }
}

function routeById(manifest, id) {
  return manifest.routes.find((route) => route.id === id);
}

export function generateApiReferenceArtifacts(options = {}) {
  const manifest = options.manifest ?? parseTomlFile(manifestPath);
  const fullMode = options.mode === 'release' || options.mode === 'full';
  ensureDir(apiRoot);
  fs.rmSync(summaryPath, { force: true });

  const records = [
    writeCReference(manifest, routeById(manifest, 'liboliphaunt-native'), fullMode),
    runCargoDoc(routeById(manifest, 'oliphaunt-rust'), 'oliphaunt', 'rust', fullMode),
    runSwiftDocC(manifest, routeById(manifest, 'oliphaunt-swift'), fullMode),
    runKotlinDokka(manifest, routeById(manifest, 'oliphaunt-kotlin'), fullMode),
    runTypeDoc(
      routeById(manifest, 'oliphaunt-react-native'),
      'src/sdks/react-native',
      'react-native',
      fullMode,
    ),
    runTypeDoc(routeById(manifest, 'oliphaunt-js'), 'src/sdks/js', 'typescript', fullMode),
    runCargoDoc(routeById(manifest, 'oliphaunt-wasix'), 'oliphaunt-wasix', 'wasm', fullMode),
  ];

  const summary = {
    mode: fullMode ? 'release' : 'fast',
    generatedAt: new Date().toISOString(),
    records,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'fast';
  const summary = generateApiReferenceArtifacts({ mode });
  console.log(
    `generated API reference status for ${summary.records.length} surfaces (${summary.mode})`,
  );
  const requireGenerated =
    mode === 'release' || process.env.OLIPHAUNT_DOCS_REQUIRE_NATIVE_API === '1';
  const failed = summary.records.filter((record) =>
    requireGenerated ? record.status !== 'generated' : record.status === 'failed',
  );
  if (failed.length > 0) {
    for (const record of failed) {
      console.error(`${record.id}: ${record.status}: ${record.reason || record.doxygenStatus}`);
    }
    process.exit(1);
  }
}
