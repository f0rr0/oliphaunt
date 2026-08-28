#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const outputPath = path.join(root, 'docs/maintainers/sdk-api-surface.md');
const mode = process.argv[2] ?? '--check';

if (!['--check', '--write'].includes(mode)) {
  console.error('usage: tools/policy/generate-sdk-api-surface.mjs [--check|--write]');
  process.exit(2);
}

function readRelative(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function listFiles(relativeDir, extension) {
  const absoluteDir = path.join(root, relativeDir);
  if (!existsSync(absoluteDir)) {
    return [];
  }
  return readdirSync(absoluteDir, {withFileTypes: true})
    .flatMap(entry => {
      const child = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        return listFiles(child, extension);
      }
      return entry.isFile() && child.endsWith(extension) ? [child] : [];
    })
    .sort();
}

function splitNames(raw) {
  return raw
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
    .map(name => name.replace(/\s+as\s+.*/u, '').trim())
    .filter(Boolean);
}

function sorted(values) {
  return Array.from(new Set(values)).sort();
}

function extractRustRootSymbols(indexFile, crateName) {
  const lines = readRelative(indexFile).split('\n');
  const symbols = [];
  let featureGate = null;
  let skipDocHidden = false;

  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index];
    const line = sourceLine.trim();
    if (line === '#[doc(hidden)]') {
      skipDocHidden = true;
      continue;
    }
    const gate = rustFeatureGate(line);
    if (gate) {
      featureGate = gate;
      continue;
    }
    if (!sourceLine.startsWith('pub use ')) {
      if (!rustItemPreamble(line)) {
        featureGate = null;
        skipDocHidden = false;
      }
      continue;
    }

    let block = line;
    while (!block.includes(';') && index + 1 < lines.length) {
      index += 1;
      block += ` ${lines[index].trim()}`;
    }
    if (!skipDocHidden) {
      const spec = block
        .replace(/^pub use\s+/u, '')
        .replace(/;$/u, '')
        .replace(/\s+/gu, ' ')
        .trim();
      const grouped = spec.match(/^(.*)::\{(.*)\}$/u);
      const names = grouped ? splitNames(grouped[2]) : [spec.split('::').pop()];
      for (const name of names.filter(Boolean)) {
        symbols.push({featureGate, symbol: `${crateName}::${name}`});
      }
    }
    featureGate = null;
    skipDocHidden = false;
  }

  return symbols;
}

function extractRustSurface(
  indexFile = 'src/sdks/rust/src/lib.rs',
  sourceDir = 'src/sdks/rust/src',
  crateName = 'oliphaunt',
  extraSourceFiles = [],
  methodSourceFiles,
) {
  const symbols = extractRustRootSymbols(indexFile, crateName).map(
    rootSymbol => rootSymbol.symbol,
  );

  const sourceFiles = sorted([...listFiles(sourceDir, '.rs'), ...extraSourceFiles]);
  for (const file of sourceFiles) {
    const source = readRelative(file);
    const macroPattern =
      /#\[\s*macro_export\s*\]\s*(?:#\[[^\]]+\]\s*)*macro_rules!\s+([A-Za-z_][A-Za-z0-9_]*)/gu;
    for (const match of source.matchAll(macroPattern)) {
      symbols.push(`${crateName}::${match[1]}!`);
    }
  }

  const exportedNames = new Set(
    symbols
      .map(symbol => symbol.slice(`${crateName}::`.length))
      .filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)),
  );
  const exportedTypes = new Set();
  for (const file of sourceFiles) {
    const source = readRelative(file);
    for (const match of source.matchAll(
      /^\s*pub\s+(?:struct|enum|union|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/gmu,
    )) {
      if (exportedNames.has(match[1])) {
        exportedTypes.add(match[1]);
      }
    }
  }
  symbols.push(
    ...extractRustMembers(
      sourceDir,
      crateName,
      exportedTypes,
      extraSourceFiles,
      methodSourceFiles,
    ),
  );

  return sorted(symbols);
}

function extractRustModuleSurface(files, sourceDir, crateName) {
  const symbols = [];
  const exportedTypes = new Set();
  for (const file of files) {
    const source = readRelative(file);
    for (const match of source.matchAll(
      /^pub\s+(struct|enum|union|trait|type|const|static|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/gmu,
    )) {
      const [, kind, name] = match;
      symbols.push(`${crateName}::${name}${kind === 'fn' ? '()' : ''}`);
      if (['struct', 'enum', 'union', 'trait', 'type'].includes(kind)) {
        exportedTypes.add(name);
      }
    }
  }
  symbols.push(...extractRustMembers(sourceDir, crateName, exportedTypes));
  return sorted(symbols);
}

function rustFeatureGate(line) {
  const cfg = line.match(/^#\[cfg\((.*)\)\]$/u)?.[1];
  if (!cfg?.includes('feature')) {
    return null;
  }
  const simple = cfg.match(/^feature\s*=\s*"([^"]+)"$/u);
  return simple?.[1] ?? `cfg(${cfg})`;
}

function rustItemPreamble(line) {
  return line.length === 0 || line.startsWith('//') || line.startsWith('#[');
}

function rustInherentImplType(header) {
  const beforeBody = header.slice(0, header.indexOf('{')).trim();
  if (!beforeBody.startsWith('impl') || /\bfor\b/u.test(beforeBody)) {
    return null;
  }
  let cursor = 'impl'.length;
  while (/\s/u.test(beforeBody[cursor] ?? '')) cursor += 1;
  if (beforeBody[cursor] === '<') {
    let angleDepth = 0;
    do {
      const char = beforeBody[cursor];
      if (char === '<') angleDepth += 1;
      if (char === '>') angleDepth -= 1;
      cursor += 1;
    } while (cursor < beforeBody.length && angleDepth > 0);
  }
  while (/\s/u.test(beforeBody[cursor] ?? '')) cursor += 1;
  return beforeBody.slice(cursor).match(/^([A-Za-z_][A-Za-z0-9_]*)/u)?.[1] ?? null;
}

function extractRustInherentMemberRecordsFromSource(source, crateName, exportedTypes) {
  const members = [];
  let depth = 0;
  let pendingImpl = null;
  let pendingImplFeatureGate = null;
  let pendingMemberFeatureGate = null;
  let skipDocHiddenMember = false;
  let activeImpl = null;

  for (const line of source.split('\n')) {
    if (activeImpl && depth < activeImpl.depth) {
      activeImpl = null;
      pendingMemberFeatureGate = null;
      skipDocHiddenMember = false;
    }
    const trimmed = line.trim();

    if (activeImpl && depth === activeImpl.depth) {
      if (trimmed === '#[doc(hidden)]') {
        skipDocHiddenMember = true;
      }
      const gate = rustFeatureGate(trimmed);
      if (gate) {
        pendingMemberFeatureGate = gate;
      }
      const method = trimmed.match(
        /^pub\s+(?:(?:async|const|unsafe)\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)/u,
      );
      const constant = trimmed.match(
        /^pub\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/u,
      );
      const memberName = method ? `${method[1]}()` : constant?.[1];
      if (memberName) {
        if (!skipDocHiddenMember) {
          members.push({
            featureGate: pendingMemberFeatureGate ?? activeImpl.featureGate,
            symbol: `${crateName}::${activeImpl.name}.${memberName}`,
          });
        }
        pendingMemberFeatureGate = null;
        skipDocHiddenMember = false;
      } else if (!rustItemPreamble(trimmed)) {
        pendingMemberFeatureGate = null;
        skipDocHiddenMember = false;
      }
    } else if (!activeImpl && pendingImpl) {
      pendingImpl += ` ${trimmed}`;
    } else if (!activeImpl && /^impl(?:\s|<)/u.test(trimmed)) {
      pendingImpl = trimmed;
    } else if (!activeImpl) {
      const gate = rustFeatureGate(trimmed);
      if (gate) {
        pendingImplFeatureGate = gate;
      } else if (!rustItemPreamble(trimmed)) {
        pendingImplFeatureGate = null;
      }
    }

    const braces = countBraces(line);
    depth += braces.opens - braces.closes;
    if (pendingImpl?.includes('{')) {
      const name = rustInherentImplType(pendingImpl);
      if (name && exportedTypes.has(name) && braces.opens > braces.closes) {
        activeImpl = {featureGate: pendingImplFeatureGate, name, depth};
      }
      pendingImpl = null;
      pendingImplFeatureGate = null;
    }
  }
  return members;
}

function extractRustDeclaredMemberRecordsFromSource(source, crateName, exportedTypes) {
  const members = [];
  let depth = 0;
  let pendingDeclaration = null;
  let pendingDeclarationFeatureGate = null;
  let pendingMemberFeatureGate = null;
  let skipDocHiddenMember = false;
  let activeDeclaration = null;

  for (const line of source.split('\n')) {
    if (activeDeclaration && depth < activeDeclaration.depth) {
      activeDeclaration = null;
      pendingMemberFeatureGate = null;
      skipDocHiddenMember = false;
    }
    const trimmed = line.trim();

    if (activeDeclaration && depth === activeDeclaration.depth) {
      if (trimmed === '#[doc(hidden)]') {
        skipDocHiddenMember = true;
      }
      const gate = rustFeatureGate(trimmed);
      if (gate) {
        pendingMemberFeatureGate = gate;
      }

      let memberName = null;
      if (activeDeclaration.kind === 'trait') {
        const method = trimmed.match(
          /^(?:(?:async|const|unsafe)\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)/u,
        );
        const associatedType = trimmed.match(
          /^type\s+([A-Za-z_][A-Za-z0-9_]*)/u,
        );
        const associatedConstant = trimmed.match(
          /^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/u,
        );
        memberName = method
          ? `${method[1]}()`
          : associatedType?.[1] ?? associatedConstant?.[1] ?? null;
      } else {
        memberName = trimmed.match(
          /^pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/u,
        )?.[1] ?? null;
      }

      if (memberName) {
        if (!skipDocHiddenMember) {
          members.push({
            featureGate: pendingMemberFeatureGate ?? activeDeclaration.featureGate,
            symbol: `${crateName}::${activeDeclaration.name}.${memberName}`,
          });
        }
        pendingMemberFeatureGate = null;
        skipDocHiddenMember = false;
      } else if (!rustItemPreamble(trimmed)) {
        pendingMemberFeatureGate = null;
        skipDocHiddenMember = false;
      }
    } else if (!activeDeclaration && pendingDeclaration) {
      pendingDeclaration.header += ` ${trimmed}`;
    } else if (!activeDeclaration) {
      const declaration = trimmed.match(
        /^pub\s+(?:(?:unsafe|auto)\s+)?(struct|trait|union)\s+([A-Za-z_][A-Za-z0-9_]*)/u,
      );
      if (declaration) {
        pendingDeclaration = {
          featureGate: pendingDeclarationFeatureGate,
          header: trimmed,
          kind: declaration[1],
          name: declaration[2],
        };
      } else {
        const gate = rustFeatureGate(trimmed);
        if (gate) {
          pendingDeclarationFeatureGate = gate;
        } else if (!rustItemPreamble(trimmed)) {
          pendingDeclarationFeatureGate = null;
        }
      }
    }

    const braces = countBraces(line);
    depth += braces.opens - braces.closes;
    if (pendingDeclaration?.header.includes('{')) {
      if (
        exportedTypes.has(pendingDeclaration.name)
        && braces.opens > braces.closes
      ) {
        activeDeclaration = {
          depth,
          featureGate: pendingDeclaration.featureGate,
          kind: pendingDeclaration.kind,
          name: pendingDeclaration.name,
        };
      }
      pendingDeclaration = null;
      pendingDeclarationFeatureGate = null;
    } else if (pendingDeclaration?.header.includes(';')) {
      pendingDeclaration = null;
      pendingDeclarationFeatureGate = null;
    }
  }
  return members;
}

function extractRustMemberRecords(
  sourceDir,
  crateName,
  exportedTypes,
  extraSourceFiles = [],
  sourceFilesOverride,
) {
  const sourceFiles = sourceFilesOverride
    ?? sorted([...listFiles(sourceDir, '.rs'), ...extraSourceFiles]);
  return sorted(sourceFiles).flatMap(file => {
    const source = readRelative(file);
    return [
      ...extractRustInherentMemberRecordsFromSource(source, crateName, exportedTypes),
      ...extractRustDeclaredMemberRecordsFromSource(source, crateName, exportedTypes),
    ];
  });
}

function extractRustMembers(
  sourceDir,
  crateName,
  exportedTypes,
  extraSourceFiles = [],
  sourceFilesOverride,
) {
  return extractRustMemberRecords(
    sourceDir,
    crateName,
    exportedTypes,
    extraSourceFiles,
    sourceFilesOverride,
  ).map(member => member.symbol);
}

function extractNativeCSurface() {
  const header = readRelative('src/runtimes/liboliphaunt/native/include/oliphaunt.h');
  const namedTypes = Array.from(
    header.matchAll(/typedef[\s\S]*?\b(Oliphaunt[A-Za-z0-9_]*)\s*;/gu),
    match => match[1],
  );
  const functionPointerTypes = Array.from(
    header.matchAll(
      /typedef\s+[^;()]*\(\s*\*\s*(Oliphaunt[A-Za-z0-9_]*)\s*\)\s*\([^;]*\)\s*;/gu,
    ),
    match => match[1],
  );
  const constants = Array.from(
    header.matchAll(/^#define\s+(OLIPHAUNT_[A-Z0-9_]+)\s+[^\r\n]+$/gmu),
    match => match[1],
  ).filter(name => !['OLIPHAUNT_API', 'OLIPHAUNT_H'].includes(name));
  const functions = Array.from(
    header.matchAll(/^OLIPHAUNT_API\s+[\s\S]*?\b(oliphaunt_[a-z0-9_]+)\s*\(/gmu),
    match => `${match[1]}()`,
  );
  return {
    types: sorted([...namedTypes, ...functionPointerTypes]),
    constants: sorted(constants),
    functions: sorted(functions),
  };
}

function countBraces(line) {
  let opens = 0;
  let closes = 0;
  for (const char of line) {
    if (char === '{') opens += 1;
    if (char === '}') closes += 1;
  }
  return {opens, closes};
}

function multilineDeclarationStillOpen(line) {
  return (
    !line.includes('{') &&
    ((line.includes('(') && !line.includes(')')) || line.endsWith(':'))
  );
}

function swiftMemberName(line) {
  const associatedTypeMatch = line.match(
    /\bassociatedtype\s+([A-Za-z_][A-Za-z0-9_]*)/u,
  );
  if (associatedTypeMatch) {
    return associatedTypeMatch[1];
  }
  if (/\bsubscript\s*[<(]/u.test(line)) {
    return 'subscript';
  }
  if (/\binit\s*\(/u.test(line)) {
    return 'init';
  }
  const functionMatch = line.match(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)/u);
  if (functionMatch) {
    return `${functionMatch[1]}()`;
  }
  const valueMatch = line.match(/\b(?:var|let)\s+([A-Za-z_][A-Za-z0-9_]*)/u);
  if (valueMatch) {
    return valueMatch[1];
  }
  return null;
}

function extractSwiftFileSurface(source) {
  const symbols = [];
  let depth = 0;
  const stack = [];
  let awaitingContext = null;
  const memberModifiers =
    '(?:(?:static|class|final|override|required|convenience|mutating|nonmutating|nonisolated|distributed|borrowing|consuming)\\s+)*';
  const memberDeclaration = '(?:func|var|let|init|subscript|associatedtype)';
  const publicMemberPattern = new RegExp(
    `^public\\s+${memberModifiers}${memberDeclaration}\\b`,
    'u',
  );
  const implicitMemberPattern = new RegExp(
    `^${memberModifiers}${memberDeclaration}\\b`,
    'u',
  );

  for (const line of source.split('\n')) {
    while (stack.length > 0 && depth < stack[stack.length - 1].depth) {
      stack.pop();
    }

    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) {
      const braces = countBraces(line);
      depth += braces.opens - braces.closes;
      continue;
    }

    const active = awaitingContext ?? stack[stack.length - 1];
    let pendingContext = null;
    const typeMatch = trimmed.match(
      /^public\s+(?:(?:final|indirect)\s+)*(enum|struct|actor|protocol|class)\s+([A-Za-z_][A-Za-z0-9_]*)/u,
    );
    const typealiasMatch = trimmed.match(
      /^public\s+typealias\s+([A-Za-z_][A-Za-z0-9_]*)/u,
    );
    const extensionMatch = trimmed.match(
      /^public\s+extension\s+([A-Za-z_][A-Za-z0-9_.]*)/u,
    );

    if (typeMatch) {
      const name = active ? `${active.name}.${typeMatch[2]}` : typeMatch[2];
      symbols.push(`${typeMatch[1]} ${name}`);
      pendingContext = {kind: typeMatch[1], name, depth: depth + 1};
    } else if (typealiasMatch) {
      const name = active
        ? `${active.name}.${typealiasMatch[1]}`
        : typealiasMatch[1];
      symbols.push(`typealias ${name}`);
    } else if (extensionMatch) {
      symbols.push(`extension ${extensionMatch[1]}`);
      pendingContext = {
        extension: true,
        kind: 'extension',
        name: extensionMatch[1],
        depth: depth + 1,
      };
    } else {
      const inPublicExtension = active?.extension === true;
      const isPublicMember = publicMemberPattern.test(trimmed);
      const isExtensionMember =
        inPublicExtension && implicitMemberPattern.test(trimmed);
      const isProtocolRequirement =
        active?.kind === 'protocol' && implicitMemberPattern.test(trimmed);
      const isDeclarationDepth = active ? depth === active.depth : depth === 0;
      if (
        (isPublicMember || isExtensionMember || isProtocolRequirement)
        && isDeclarationDepth
      ) {
        const member = swiftMemberName(trimmed);
        if (member) {
          symbols.push(active ? `${active.name}.${member}` : member);
        }
      }
    }

    const braces = countBraces(line);
    depth += braces.opens - braces.closes;
    if (pendingContext && braces.opens > braces.closes) {
      pendingContext.depth = depth;
      stack.push(pendingContext);
      awaitingContext = null;
    } else if (pendingContext && multilineDeclarationStillOpen(trimmed)) {
      awaitingContext = pendingContext;
    } else if (awaitingContext && braces.opens > braces.closes) {
      awaitingContext.depth = depth;
      stack.push(awaitingContext);
      awaitingContext = null;
    } else if (awaitingContext && trimmed.startsWith(')')) {
      awaitingContext = null;
    }
  }

  return sorted(symbols);
}

function extractSwiftSurface(
  sourceDir = 'src/sdks/swift/Sources/Oliphaunt',
) {
  return sorted(
    listFiles(sourceDir, '.swift').flatMap(file =>
      extractSwiftFileSurface(readRelative(file)),
    ),
  );
}

function kotlinMemberName(line) {
  const functionMatch = line.match(
    /\bfun\s+(?:<[^>]+>\s*)?(?:(?:[A-Za-z_][A-Za-z0-9_]*\.)+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/u,
  );
  if (functionMatch) {
    const receiverMatch = line.match(
      /\bfun\s+(?:<[^>]+>\s*)?((?:[A-Za-z_][A-Za-z0-9_]*\.)+)[A-Za-z_][A-Za-z0-9_]*\s*\(/u,
    );
    return {
      name: `${functionMatch[1]}()`,
      receiver: receiverMatch ? receiverMatch[1].replace(/\.$/u, '') : null,
    };
  }
  const valueMatch = line.match(/\b(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)/u);
  if (valueMatch) {
    return {name: valueMatch[1], receiver: null};
  }
  return null;
}

function kotlinConstructorPropertyNames(line) {
  return Array.from(
    line.matchAll(
      /(?:^|[,(])\s*(?:(public|private|protected|internal)\s+)?(?:override\s+)?(?:vararg\s+)?(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
    ),
    match => ({name: match[2], visibility: match[1] ?? 'public'}),
  )
    .filter(property => property.visibility === 'public')
    .map(property => property.name);
}

function extractKotlinFileSurface(source) {
  const symbols = [];
  let depth = 0;
  const stack = [];
  let awaitingContext = null;

  for (const line of source.split('\n')) {
    while (stack.length > 0 && depth < stack[stack.length - 1].depth) {
      stack.pop();
    }

    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) {
      const braces = countBraces(line);
      depth += braces.opens - braces.closes;
      continue;
    }

    const active = awaitingContext ?? stack[stack.length - 1];
    let pendingContext = null;
    const typeMatch = trimmed.match(
      /^public\s+(?:(?:data|sealed|open)\s+)*(enum\s+class|data\s+class|sealed\s+class|open\s+class|value\s+class|fun\s+interface|class|object|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/u,
    );

    if (typeMatch) {
      const name = active ? `${active.name}.${typeMatch[2]}` : typeMatch[2];
      symbols.push(`${typeMatch[1]} ${name}`);
      pendingContext = {name, depth: depth + 1};
      for (const property of kotlinConstructorPropertyNames(trimmed)) {
        symbols.push(`${name}.${property}`);
      }
    } else if (awaitingContext) {
      for (const property of kotlinConstructorPropertyNames(trimmed)) {
        symbols.push(`${awaitingContext.name}.${property}`);
      }
    }

    if (!typeMatch && /^public\s+(?:expect\s+|actual\s+)?(?:suspend\s+)?fun\b/u.test(trimmed)) {
      const member = kotlinMemberName(trimmed);
      if (member) {
        const owner = member.receiver ?? active?.name;
        symbols.push(owner ? `${owner}.${member.name}` : member.name);
      }
    } else if (!typeMatch && /^public\s+(?:val|var)\b/u.test(trimmed)) {
      const member = kotlinMemberName(trimmed);
      if (member) {
        symbols.push(active ? `${active.name}.${member.name}` : member.name);
      }
    }

    const braces = countBraces(line);
    depth += braces.opens - braces.closes;
    if (pendingContext && braces.opens > braces.closes) {
      pendingContext.depth = depth;
      stack.push(pendingContext);
      awaitingContext = null;
    } else if (pendingContext && multilineDeclarationStillOpen(trimmed)) {
      awaitingContext = pendingContext;
    } else if (awaitingContext && braces.opens > braces.closes) {
      awaitingContext.depth = depth;
      stack.push(awaitingContext);
      awaitingContext = null;
    } else if (awaitingContext && trimmed.startsWith(')')) {
      awaitingContext = null;
    }
  }

  return sorted(symbols);
}

function extractKotlinSurface() {
  const sourceSets = ['commonMain', 'androidMain', 'jvmMain'];
  const sections = [];

  for (const sourceSet of sourceSets) {
    const files = listFiles(
      `src/sdks/kotlin/oliphaunt/src/${sourceSet}/kotlin/dev/oliphaunt`,
      '.kt',
    );
    const symbols = [];

    for (const file of files) {
      symbols.push(...extractKotlinFileSurface(readRelative(file)));
    }

    sections.push({sourceSet, symbols: sorted(symbols)});
  }

  return sections;
}

function extractKotlinGradlePluginSurface() {
  const build = readRelative(
    'src/sdks/kotlin/oliphaunt-android-gradle-plugin/build.gradle.kts',
  );
  const extension = readRelative(
    'src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/OliphauntAndroidExtension.java',
  );
  const symbols = [];
  const pluginId = build.match(/^\s*id\s*=\s*"([^"]+)"/mu)?.[1];
  if (pluginId) symbols.push(`plugin ${pluginId}`);
  const className = extension.match(/public\s+abstract\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/u)?.[1];
  if (className) {
    symbols.push(`class ${className}`);
    for (const match of extension.matchAll(
      /public\s+abstract\s+[^;()]+\s+(get[A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*;/gu,
    )) {
      symbols.push(`${className}.${match[1]}()`);
    }
  }
  return sorted(symbols);
}

function extractTypeScriptSurface(indexFile, memberFiles) {
  const indexFiles = Array.isArray(indexFile) ? indexFile : [indexFile];
  const text = indexFiles.map(readRelative).join('\n');
  const types = [];
  const values = [];

  for (const match of text.matchAll(/export\s+type\s+\{([\s\S]*?)\}\s+from/gu)) {
    types.push(...splitNames(match[1]));
  }
  for (const match of text.matchAll(/export\s+\{([\s\S]*?)\}\s+from/gu)) {
    for (const entry of splitTypeScriptExportNames(match[1])) {
      (entry.typeOnly ? types : values).push(entry.name);
    }
  }
  for (const match of text.matchAll(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    values.push(match[1]);
  }
  for (const match of text.matchAll(
    /export\s+(?:async\s+)?(?:class|function)\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
  )) {
    values.push(match[1]);
  }
  for (const match of text.matchAll(/export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    types.push(match[1]);
  }

  const exportedTypes = new Set(types);
  const exportedValues = new Set(values);
  const members = extractTypeScriptMembers(exportedTypes, exportedValues, memberFiles);

  return {
    types: sorted(types),
    values: sorted(values),
    members,
  };
}

function splitTypeScriptExportNames(raw) {
  return raw
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
    .map(name => {
      const typeOnly = name.startsWith('type ');
      return {
        typeOnly,
        name: name
          .replace(/^type\s+/u, '')
          .replace(/\s+as\s+.*/u, '')
          .trim(),
      };
    })
    .filter(entry => entry.name.length > 0);
}

function extractReactNativeSurface() {
  return extractTypeScriptSurface('src/sdks/react-native/src/index.ts', [
    'src/sdks/react-native/src/client.ts',
    'src/sdks/react-native/src/protocol.ts',
    'src/sdks/react-native/src/query.ts',
  ]);
}

function extractOliphauntTsSurface() {
  return extractTypeScriptSurface('src/sdks/js/src/index.ts', [
    'src/sdks/js/src/client.ts',
    'src/sdks/js/src/protocol.ts',
    'src/sdks/js/src/query.ts',
    'src/sdks/js/src/types.ts',
  ]);
}

function extractOliphauntWasixTsSurface() {
  return extractTypeScriptSurface([
    'src/bindings/wasix-ts/src/index.ts',
    'src/bindings/wasix-ts/src/public.ts',
  ], [
    'src/bindings/wasix-ts/src/client.ts',
    'src/bindings/wasix-ts/src/errors.ts',
    'src/bindings/wasix-ts/src/extension-descriptor.ts',
    'src/bindings/wasix-ts/src/protocol.ts',
    'src/bindings/wasix-ts/src/query.ts',
    'src/bindings/wasix-ts/src/storage.ts',
    'src/bindings/wasix-ts/src/types.ts',
  ]);
}

function extractOliphauntWasixWorkerTsSurface() {
  return extractTypeScriptSurface([
    'src/bindings/wasix-ts/src/worker-entry.ts',
    'src/bindings/wasix-ts/src/public.ts',
  ], [
    'src/bindings/wasix-ts/src/worker-client.ts',
    'src/bindings/wasix-ts/src/worker-node-client.ts',
    'src/bindings/wasix-ts/src/errors.ts',
    'src/bindings/wasix-ts/src/extension-descriptor.ts',
    'src/bindings/wasix-ts/src/protocol.ts',
    'src/bindings/wasix-ts/src/query.ts',
    'src/bindings/wasix-ts/src/storage.ts',
    'src/bindings/wasix-ts/src/types.ts',
  ]);
}

function extractPackageExports(manifestFile) {
  const manifest = JSON.parse(readRelative(manifestFile));
  return Object.entries(manifest.exports ?? {}).map(([subpath, entry]) =>
    `${subpath} = ${JSON.stringify(entry)}`,
  );
}

function typeScriptMemberName(line) {
  const declaration = line.replace(/^(?:public\s+)?(?:static\s+)?/u, '');
  const getterMatch = declaration.match(/^get\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u);
  if (getterMatch) {
    return getterMatch[1];
  }
  const computedMethodMatch = declaration.match(
    /^\[Symbol\.([A-Za-z_][A-Za-z0-9_]*)\]\s*\(/u,
  );
  if (computedMethodMatch) {
    return `[Symbol.${computedMethodMatch[1]}]()`;
  }
  const methodMatch = declaration.match(
    /^(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:<|\()/u,
  );
  if (methodMatch) {
    return `${methodMatch[1]}()`;
  }
  const propertyMatch = declaration.match(
    /^(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??:/u,
  );
  if (propertyMatch) {
    return propertyMatch[1];
  }
  return null;
}

function extractTypeScriptMembers(exportedTypes, exportedValues, files) {
  const members = [];

  for (const file of files) {
    let depth = 0;
    const stack = [];
    let awaitingContext = null;
    let awaitingMemberEnd = null;
    let skipInternalMember = false;
    for (const line of readRelative(file).split('\n')) {
      while (stack.length > 0 && depth < stack[stack.length - 1].depth) {
        stack.pop();
      }

      if (awaitingMemberEnd && stack[stack.length - 1]?.name !== awaitingMemberEnd) {
        awaitingMemberEnd = null;
      }

      const trimmed = line.trim();
      if (trimmed === '/** @internal */') {
        skipInternalMember = true;
        continue;
      }
      if (trimmed.length === 0 || trimmed.startsWith('//')) {
        const braces = countBraces(line);
        depth += braces.opens - braces.closes;
        continue;
      }

      const active = stack[stack.length - 1] ?? awaitingContext;
      let pendingContext = null;
      const typeMatch = trimmed.match(/^export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)/u);
      const classMatch = trimmed.match(/^export\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/u);
      const functionMatch = trimmed.match(
        /^export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/u,
      );
      const constMatch = trimmed.match(/^export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/u);

      if (typeMatch) {
        if (exportedTypes.has(typeMatch[1])) {
          pendingContext = {name: typeMatch[1], depth: depth + 1};
        }
      } else if (classMatch) {
        if (exportedValues.has(classMatch[1])) {
          pendingContext = {name: classMatch[1], depth: depth + 1};
        }
      } else if (functionMatch || constMatch) {
        // Top-level exports are already recorded in Values.
      } else if (active && depth === active.depth && awaitingMemberEnd === null) {
        const isPrivate = trimmed.startsWith('#') || /^(?:private|protected)\b/u.test(trimmed);
        const declaration = trimmed
          .replace(/^#/u, '')
          .replace(/^(?:private|protected)\s+/u, '');
        const member = typeScriptMemberName(declaration);
        if (member) {
          if (!skipInternalMember && !isPrivate) {
            members.push(`${active.name}.${member}`);
          }
          const braces = countBraces(line);
          if (!trimmed.includes(';') && braces.opens <= braces.closes) {
            awaitingMemberEnd = active.name;
          }
        }
      }
      skipInternalMember = false;

      const braces = countBraces(line);
      depth += braces.opens - braces.closes;
      if (pendingContext && braces.opens > braces.closes) {
        pendingContext.depth = depth;
        stack.push(pendingContext);
        awaitingContext = null;
      } else if (pendingContext && !trimmed.includes(';')) {
        awaitingContext = pendingContext;
      } else if (awaitingContext && braces.opens > braces.closes) {
        awaitingContext.depth = depth;
        stack.push(awaitingContext);
        awaitingContext = null;
      } else if (awaitingContext && (trimmed.startsWith('}') || trimmed.includes(';'))) {
        awaitingContext = null;
      }

      if (
        awaitingMemberEnd &&
        (trimmed.includes(';') || braces.opens > braces.closes)
      ) {
        awaitingMemberEnd = null;
      }
    }
  }

  return sorted(members);
}

function requireTypeScriptQuerySurface(surface, packageName) {
  for (const type of ['InferQueryRow', 'QueryDecoderMap', 'QueryOptions', 'QueryRowMode']) {
    if (!surface.types.includes(type)) {
      throw new Error(`TypeScript API inventory is missing ${packageName} type ${type}`);
    }
  }
  for (const member of [
    'OliphauntDatabase.query()',
    'OliphauntTransaction.query()',
    'QueryOptions.decoders',
    'QueryOptions.encoders',
    'QueryOptions.rowMode',
    'QueryOptions.valueMode',
  ]) {
    if (!surface.members.includes(member)) {
      throw new Error(`TypeScript API inventory is missing ${packageName} member ${member}`);
    }
  }
}

function markdownList(items) {
  if (items.length === 0) {
    return '- none\n';
  }
  return `${items.map(item => `- \`${item}\``).join('\n')}\n`;
}

function requireRustQueryCoreSurface(symbols, crateName) {
  for (const member of [
    'CommandResult.row_count()',
    'ExecResult.statements()',
    'FromSql.from_sql()',
    'IntoParameter.into_parameter()',
    'Parameter.binary()',
    'Parameter.typed_text()',
    'QueryField.name',
    'QueryField.type_oid_value()',
    'QueryResult.rows()',
    'QueryRow.try_get()',
    'StatementDescription.parameter_types()',
    'TypeOid.get()',
    'ValueRef.as_bytes()',
  ]) {
    const symbol = `${crateName}::${member}`;
    if (!symbols.includes(symbol)) {
      throw new Error(`Rust API inventory did not follow shared query core for ${symbol}`);
    }
  }
}

function rejectRustRootSymbols(symbols, crateName, names) {
  for (const name of names) {
    const symbol = `${crateName}::${name}`;
    if (symbols.includes(symbol)) {
      throw new Error(`Rust API inventory flattened a nested module symbol into ${symbol}`);
    }
  }
}

function addFeatureSymbol(featureSymbols, featureGate, symbol) {
  if (!featureGate) {
    return;
  }
  const symbols = featureSymbols.get(featureGate) ?? new Set();
  symbols.add(symbol);
  featureSymbols.set(featureGate, symbols);
}

function buildWasixRustFeatureSurface({
  members,
  rootSymbols,
  symbols,
  toolSymbols,
}) {
  const featureSymbols = new Map();
  const directlyGatedSymbols = new Set(
    members.filter(member => member.featureGate).map(member => member.symbol),
  );

  for (const rootSymbol of rootSymbols) {
    for (const symbol of symbols) {
      if (
        !directlyGatedSymbols.has(symbol)
        && (symbol === rootSymbol.symbol || symbol.startsWith(`${rootSymbol.symbol}.`))
      ) {
        addFeatureSymbol(featureSymbols, rootSymbol.featureGate, symbol);
      }
    }
  }
  for (const member of members) {
    addFeatureSymbol(featureSymbols, member.featureGate, member.symbol);
  }
  for (const symbol of toolSymbols) {
    addFeatureSymbol(featureSymbols, 'tools', symbol);
  }

  const gatedSymbols = new Set(
    Array.from(featureSymbols.values()).flatMap(featureSet => [...featureSet]),
  );
  return {
    defaultSymbols: symbols.filter(symbol => !gatedSymbols.has(symbol)),
    featureSymbols: new Map(
      Array.from(featureSymbols, ([feature, featureSet]) => [
        feature,
        sorted(featureSet),
      ]),
    ),
  };
}

function requireWasixRustFeatureSurface(surface) {
  const requiredDefault = [
    'oliphaunt_wasix::AsyncOliphaunt.query()',
    'oliphaunt_wasix::Oliphaunt.query()',
  ];
  const requiredExtensions = [
    'oliphaunt_wasix::AsyncOliphauntBuilder.extension()',
    'oliphaunt_wasix::Extension',
    'oliphaunt_wasix::Extension.ALL',
    'oliphaunt_wasix::OliphauntBuilder.extensions()',
  ];
  const requiredTools = [
    'oliphaunt_wasix::AsyncOliphaunt.pg_dump()',
    'oliphaunt_wasix::Error.tool_error()',
    'oliphaunt_wasix::Oliphaunt.psql()',
    'oliphaunt_wasix::tools::PgDumpOptions',
  ];
  for (const symbol of requiredDefault) {
    if (!surface.defaultSymbols.includes(symbol)) {
      throw new Error(`WASIX Rust default API inventory is missing ${symbol}`);
    }
  }
  for (const [feature, required] of [
    ['extensions', requiredExtensions],
    ['tools', requiredTools],
  ]) {
    const symbols = surface.featureSymbols.get(feature) ?? [];
    for (const symbol of required) {
      if (!symbols.includes(symbol)) {
        throw new Error(`WASIX Rust ${feature} API inventory is missing ${symbol}`);
      }
      if (surface.defaultSymbols.includes(symbol)) {
        throw new Error(`WASIX Rust default API inventory includes gated ${symbol}`);
      }
    }
  }

  const declaredExtensionFeatures = sorted(
    Array.from(
      readRelative('src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml').matchAll(
        /^(extension-[a-z0-9-]+)\s*=/gmu,
      ),
      match => match[1],
    ),
  );
  const inventoriedExtensionFeatures = sorted(
    Array.from(surface.featureSymbols.keys()).filter(feature =>
      feature.startsWith('extension-'),
    ),
  );
  if (
    JSON.stringify(declaredExtensionFeatures)
    !== JSON.stringify(inventoriedExtensionFeatures)
  ) {
    throw new Error(
      'WASIX Rust per-extension API inventory does not match declared Cargo features',
    );
  }
  for (const feature of declaredExtensionFeatures) {
    const constants = surface.featureSymbols
      .get(feature)
      ?.filter(symbol => symbol.startsWith('oliphaunt_wasix::Extension.')) ?? [];
    if (constants.length !== 1) {
      throw new Error(
        `WASIX Rust ${feature} API inventory must own exactly one Extension constant`,
      );
    }
  }
}

function markdownFeatureList(featureSymbols) {
  if (featureSymbols.length === 0) {
    return '- none\n';
  }
  return `${featureSymbols
    .map(([feature, symbol]) => `- \`${feature}\`: \`${symbol}\``)
    .join('\n')}\n`;
}

function requireExtractorFixture(label, symbols, required, forbidden) {
  for (const symbol of required) {
    if (!symbols.includes(symbol)) {
      throw new Error(`${label} extractor fixture is missing ${symbol}`);
    }
  }
  for (const symbol of forbidden) {
    if (symbols.includes(symbol)) {
      throw new Error(`${label} extractor fixture exposed ${symbol}`);
    }
  }
}

function requireApiExtractorFixtures() {
  const rustSource = `
pub struct Record {
    pub visible: u32,
    private: u32,
    pub(crate) crate_visible: u32,
}

pub trait Codec {
    type Output;
    const FORMAT: u8;
    fn decode(&self);
    #[doc(hidden)]
    fn hidden(&self);
}

impl Record {
    pub const DEFAULT: Self = Self { visible: 0, private: 0, crate_visible: 0 };
    pub fn read(&self) {}
    #[doc(hidden)]
    pub fn hidden(&self) {}
}
`;
  const rustTypes = new Set(['Codec', 'Record']);
  const rustSymbols = [
    ...extractRustDeclaredMemberRecordsFromSource(rustSource, 'fixture', rustTypes),
    ...extractRustInherentMemberRecordsFromSource(rustSource, 'fixture', rustTypes),
  ].map(member => member.symbol);
  requireExtractorFixture(
    'Rust',
    rustSymbols,
    [
      'fixture::Codec.FORMAT',
      'fixture::Codec.Output',
      'fixture::Codec.decode()',
      'fixture::Record.DEFAULT',
      'fixture::Record.read()',
      'fixture::Record.visible',
    ],
    [
      'fixture::Codec.hidden()',
      'fixture::Record.crate_visible',
      'fixture::Record.hidden()',
      'fixture::Record.private',
    ],
  );

  const swiftSymbols = extractSwiftFileSurface(`
public protocol Codec {
    associatedtype Output
    static var format: Int { get }
    mutating func decode()
    subscript(index: Int) -> Output { get }
}

internal protocol InternalCodec {
    func hidden()
}
`);
  requireExtractorFixture(
    'Swift',
    swiftSymbols,
    [
      'Codec.Output',
      'Codec.decode()',
      'Codec.format',
      'Codec.subscript',
      'protocol Codec',
    ],
    ['InternalCodec.hidden()', 'protocol InternalCodec'],
  );

  const kotlinSymbols = extractKotlinFileSurface(`
public data class Record(
    val implicit: String,
    public var explicit: Int,
    private val privateValue: String,
    internal val internalValue: String,
)

public sealed interface Node {
    public data class Leaf(val value: String, protected val hidden: String) : Node
}

internal data class InternalRecord(val hidden: String)
`);
  requireExtractorFixture(
    'Kotlin',
    kotlinSymbols,
    [
      'Node.Leaf.value',
      'Record.explicit',
      'Record.implicit',
    ],
    [
      'InternalRecord.hidden',
      'Node.Leaf.hidden',
      'Record.internalValue',
      'Record.privateValue',
    ],
  );
}

function render() {
  requireApiExtractorFixtures();
  const nativeC = extractNativeCSurface();
  const kotlin = extractKotlinSurface();
  const kotlinGradlePlugin = extractKotlinGradlePluginSurface();
  const swift = extractSwiftSurface();
  requireExtractorFixture(
    'Swift SDK',
    swift,
    [
      'OliphauntPostgresDecodable.decodePostgres()',
      'protocol OliphauntPostgresDecodable',
      'typealias OliphauntPostgresNotice',
    ],
    [],
  );
  const kotlinCommon = kotlin.find(section => section.sourceSet === 'commonMain')?.symbols ?? [];
  requireExtractorFixture(
    'Kotlin SDK',
    kotlinCommon,
    [
      'PostgresStartupGuc.name',
      'QueryField.name',
      'StatementResult.Command.result',
    ],
    [],
  );
  const rn = extractReactNativeSurface();
  const ts = extractOliphauntTsSurface();
  const wasixTs = extractOliphauntWasixTsSurface();
  const wasixWorkerTs = extractOliphauntWasixWorkerTsSurface();
  const wasixIndexedDb = extractTypeScriptSurface(
    'src/bindings/wasix-ts/src/storage/indexed-db.ts',
    ['src/bindings/wasix-ts/src/storage/indexed-db.ts'],
  );
  const wasixOpfs = extractTypeScriptSurface(
    'src/bindings/wasix-ts/src/storage/opfs.ts',
    ['src/bindings/wasix-ts/src/storage/opfs.ts'],
  );
  const wasixNodeDirectory = extractTypeScriptSurface(
    'src/bindings/wasix-ts/src/storage/node.ts',
    ['src/bindings/wasix-ts/src/storage/node.ts'],
  );
  const wasixBunDirectory = extractTypeScriptSurface(
    'src/bindings/wasix-ts/src/storage/bun.ts',
    ['src/bindings/wasix-ts/src/storage/bun.ts'],
  );
  const wasixDenoDirectory = extractTypeScriptSurface(
    'src/bindings/wasix-ts/src/storage/deno.ts',
    ['src/bindings/wasix-ts/src/storage/deno.ts'],
  );
  const nativeToolsTs = extractTypeScriptSurface(
    'src/runtimes/liboliphaunt/native/tools-npm/index.d.ts',
    ['src/runtimes/liboliphaunt/native/tools-npm/index.d.ts'],
  );
  const wasixTsServer = extractTypeScriptSurface(
    'src/bindings/wasix-ts/src/server.node.ts',
    ['src/bindings/wasix-ts/src/server.node.ts'],
  );
  const wasixToolsTs = extractTypeScriptSurface(
    'src/bindings/wasix-ts/tools-package/src/index.ts',
    ['src/bindings/wasix-ts/tools-package/src/index.ts'],
  );
  requireTypeScriptQuerySurface(rn, '@oliphaunt/react-native');
  requireTypeScriptQuerySurface(ts, '@oliphaunt/ts');
  requireTypeScriptQuerySurface(wasixTs, '@oliphaunt/wasix-ts');
  requireTypeScriptQuerySurface(wasixWorkerTs, '@oliphaunt/wasix-ts/worker');
  const sharedRustQueryCore = ['src/shared/rust-query-core/query_core.rs'];
  const nativeRustSourceDir = 'src/sdks/rust/src';
  const nativeRust = extractRustSurface(
    'src/sdks/rust/src/lib.rs',
    nativeRustSourceDir,
    'oliphaunt',
    sharedRustQueryCore,
    [
      ...listFiles(nativeRustSourceDir, '.rs'),
      ...sharedRustQueryCore,
    ],
  );
  const nativeRustBrokerSeam = extractRustModuleSurface(
    [
      'src/sdks/rust/src/broker_support.rs',
      'src/sdks/rust/src/ipc.rs',
    ],
    'src/sdks/rust/src',
    'oliphaunt::__private',
  );
  const nativeRustPackagingNames = new Set([
    'NativePackagingCatalogProfile',
    'NativePackagingResources',
    'NativePackagingRuntime',
    'materialize_native_packaging_resources()',
  ]);
  const nativeRustPackagingSeam = extractRustModuleSurface(
    ['src/sdks/rust/src/liboliphaunt/mod.rs'],
    'src/sdks/rust/src/liboliphaunt',
    'oliphaunt::__private::packaging',
  ).filter(symbol =>
    nativeRustPackagingNames.has(
      symbol.slice('oliphaunt::__private::packaging::'.length),
    ),
  );
  const wasixRustSourceDir =
    'src/bindings/wasix-rust/crates/oliphaunt-wasix/src';
  const wasixRustSourceFiles = [
    ...listFiles(wasixRustSourceDir, '.rs'),
    ...sharedRustQueryCore,
  ];
  const wasixRust = extractRustSurface(
    'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs',
    wasixRustSourceDir,
    'oliphaunt_wasix',
    sharedRustQueryCore,
    wasixRustSourceFiles,
  );
  const wasixRustExportedTypes = new Set(
    wasixRust
      .filter(symbol => /^oliphaunt_wasix::[A-Za-z_][A-Za-z0-9_]*$/u.test(symbol))
      .map(symbol => symbol.slice('oliphaunt_wasix::'.length)),
  );
  const wasixRustTools = extractRustModuleSurface(
    ['src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/tools.rs'],
    'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt',
    'oliphaunt_wasix::tools',
  );
  const wasixRustFeatureSurface = buildWasixRustFeatureSurface({
    members: extractRustMemberRecords(
      wasixRustSourceDir,
      'oliphaunt_wasix',
      wasixRustExportedTypes,
      sharedRustQueryCore,
      wasixRustSourceFiles,
    ),
    rootSymbols: extractRustRootSymbols(
      'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs',
      'oliphaunt_wasix',
    ).filter(rootSymbol => rootSymbol.featureGate),
    symbols: wasixRust,
    toolSymbols: wasixRustTools,
  });
  requireWasixRustFeatureSurface(wasixRustFeatureSurface);
  requireRustQueryCoreSurface(nativeRust, 'oliphaunt');
  requireRustQueryCoreSurface(wasixRust, 'oliphaunt_wasix');
  rejectRustRootSymbols(nativeRust, 'oliphaunt', [
    'BrokerIpcRequest',
    'NativePackagingCatalogProfile',
    'NativePackagingResources',
    'NativePackagingRuntime',
    'broker_ipc_read_request',
    'materialize_native_packaging_resources',
  ]);
  for (const required of [
    'oliphaunt::__private::open()',
    'oliphaunt::__private::BrokerSession.exec_protocol_raw_stream()',
    'oliphaunt::__private::broker_ipc_read_request()',
  ]) {
    if (!nativeRustBrokerSeam.includes(required)) {
      throw new Error(`Rust broker seam inventory is missing ${required}`);
    }
  }
  for (const required of [
    'oliphaunt::__private::packaging::NativePackagingResources',
    'oliphaunt::__private::packaging::materialize_native_packaging_resources()',
  ]) {
    if (!nativeRustPackagingSeam.includes(required)) {
      throw new Error(`Rust packaging seam inventory is missing ${required}`);
    }
  }
  rejectRustRootSymbols(wasixRust, 'oliphaunt_wasix', [
    'PgDumpOptions',
    'PostgresToolError',
    'PsqlOptions',
    'pg_dump',
    'psql',
  ]);
  let output = `<!-- Generated by tools/policy/generate-sdk-api-surface.mjs; do not edit by hand. -->\n`;
  output += `# SDK API Surface Inventory\n\n`;
  output += `This no-build inventory records exported type names and statically named public members that its source extractors can resolve: named Rust fields, inherent members, and trait requirements; Swift public members and public-protocol requirements; Kotlin explicit public members and public primary-constructor properties; and TypeScript declared members. It intentionally does not model complete signatures, enum variants, unnamed Rust tuple fields, inherited or synthesized members, or JavaScript default exports. Compile-time public-API tests and package-shape checks own those contracts; this inventory is not a replacement for full language reference documentation.\n\n`;
  output += `Regenerate with:\n\n`;
  output += `\`\`\`sh\n`;
  output += `node tools/policy/generate-sdk-api-surface.mjs --write\n`;
  output += `\`\`\`\n\n`;
  output += `## Rust: oliphaunt\n\n`;
  output += markdownList(nativeRust);
  output += `\n### Version-locked broker seam (not application API)\n\n`;
  output += `The separately built \`oliphaunt-broker\` executable enables \`__internal-broker-helper\` and consumes this exact-version seam. It is absent from default builds and may change only in lockstep with that executable.\n\n`;
  output += markdownList(nativeRustBrokerSeam);
  output += `\n### Version-locked native packaging seam (not application API)\n\n`;
  output += `The unpublished workspace packaging tool enables \`internal-native-packaging\` and consumes \`oliphaunt::__private::packaging\`. It is absent from default builds and may change only in lockstep with that tool.\n\n`;
  output += markdownList(nativeRustPackagingSeam);
  output += `\n## Rust build integration: oliphaunt-build\n\n`;
  output += markdownList(
    extractRustModuleSurface(
      ['src/sdks/rust/crates/oliphaunt-build/src/lib.rs'],
      'src/sdks/rust/crates/oliphaunt-build/src',
      'oliphaunt_build',
    ),
  );
  output += `\n## Native Rust tools: oliphaunt-tools\n\n`;
  output += markdownList(
    extractRustModuleSurface(
      ['src/runtimes/liboliphaunt/native/crates/tools/src/lib.rs'],
      'src/runtimes/liboliphaunt/native/crates/tools/src',
      'oliphaunt_tools',
    ),
  );
  output += `\n## Rust WASIX: oliphaunt-wasix\n\n`;
  output += `### Default Cargo features (cross-target union)\n\n`;
  output +=
    `These symbols require no optional Cargo feature. Target-gated symbols ` +
    `(for example Unix-domain listener helpers) remain a cross-target union; ` +
    `consumer compile tests own target availability.\n\n`;
  output += markdownList(wasixRustFeatureSurface.defaultSymbols);
  const wasixRustFeatureOrder = new Map([['extensions', 0], ['tools', 1]]);
  const nonLeafWasixRustFeatures = Array.from(
    wasixRustFeatureSurface.featureSymbols.keys(),
  )
    .filter(feature => !feature.startsWith('extension-'))
    .sort(
      (left, right) =>
        (wasixRustFeatureOrder.get(left) ?? 2)
          - (wasixRustFeatureOrder.get(right) ?? 2)
        || left.localeCompare(right),
    );
  for (const feature of nonLeafWasixRustFeatures) {
    output += `\n### \`${feature}\` feature\n\n`;
    output += markdownList(wasixRustFeatureSurface.featureSymbols.get(feature) ?? []);
  }
  output += `\n### Individual \`extension-*\` features\n\n`;
  output +=
    `Each leaf feature also enables \`extensions\`; the constant below additionally ` +
    `requires the feature shown.\n\n`;
  output += markdownFeatureList(
    Array.from(wasixRustFeatureSurface.featureSymbols.entries())
      .filter(([feature]) => feature.startsWith('extension-'))
      .flatMap(([feature, symbols]) => symbols.map(symbol => [feature, symbol]))
      .sort(([leftFeature], [rightFeature]) => leftFeature.localeCompare(rightFeature)),
  );
  output += `\n## Native C ABI: liboliphaunt\n\n`;
  output += `### Types\n\n`;
  output += markdownList(nativeC.types);
  output += `\n### Constants\n\n`;
  output += markdownList(nativeC.constants);
  output += `\n### Functions\n\n`;
  output += markdownList(nativeC.functions);
  output += `\n## Swift: Oliphaunt\n\n`;
  output += markdownList(swift);
  output += `\n## Swift: OliphauntExtensionSupport\n\n`;
  output +=
    `This version-locked carrier seam is consumed by generated Swift extension ` +
    `products. It is not ordinary application API; applications select extensions ` +
    `by SQL name through \`Oliphaunt\`. See ` +
    `[SDK parity policy](./sdk-parity-policy.md).\n\n`;
  output += markdownList(
    extractSwiftSurface('src/sdks/swift/Sources/OliphauntExtensionSupport'),
  );
  output += `\n## Kotlin: oliphaunt\n\n`;
  for (const section of kotlin) {
    output += `### ${section.sourceSet}\n\n`;
    output += markdownList(section.symbols);
    output += `\n`;
  }
  output += `## Kotlin Android Gradle plugin\n\n`;
  output += markdownList(kotlinGradlePlugin);
  output += `\n`;
  output += `## React Native: @oliphaunt/react-native\n\n`;
  output += `### Package exports\n\n`;
  output += markdownList(extractPackageExports('src/sdks/react-native/package.json'));
  output += `\n`;
  output += `### Types\n\n`;
  output += markdownList(rn.types);
  output += `\n### Values\n\n`;
  output += markdownList(rn.values);
  output += `\n### Members\n\n`;
  output += markdownList(rn.members);
  output += `\n## TypeScript: @oliphaunt/ts\n\n`;
  output += `### Package exports\n\n`;
  output += markdownList(extractPackageExports('src/sdks/js/package.json'));
  output += `\n`;
  output += `### Types\n\n`;
  output += markdownList(ts.types);
  output += `\n### Values\n\n`;
  output += markdownList(ts.values);
  output += `\n### Members\n\n`;
  output += markdownList(ts.members);
  output += `\n## Native TypeScript tools: @oliphaunt/tools\n\n`;
  output += `### Package exports\n\n`;
  output += markdownList(extractPackageExports('src/runtimes/liboliphaunt/native/tools-npm/package.json'));
  output += `\n### Types\n\n`;
  output += markdownList(nativeToolsTs.types);
  output += `\n### Values\n\n`;
  output += markdownList(nativeToolsTs.values);
  output += `\n### Members\n\n`;
  output += markdownList(nativeToolsTs.members);
  output += `\n## WASIX TypeScript: @oliphaunt/wasix-ts\n\n`;
  output += `### Package exports\n\n`;
  output += markdownList(extractPackageExports('src/bindings/wasix-ts/package.json'));
  output += `\n`;
  output += `### Types\n\n`;
  output += markdownList(wasixTs.types);
  output += `\n### Values\n\n`;
  output += markdownList(wasixTs.values);
  output += `\n### Members\n\n`;
  output += markdownList(wasixTs.members);
  output += `\n### Worker subpath: @oliphaunt/wasix-ts/worker\n\n`;
  output += `#### Types\n\n`;
  output += markdownList(wasixWorkerTs.types);
  output += `\n#### Values\n\n`;
  output += markdownList(wasixWorkerTs.values);
  output += `\n#### Members\n\n`;
  output += markdownList(wasixWorkerTs.members);
  output += `\n### Storage subpath: @oliphaunt/wasix-ts/storage/indexed-db\n\n`;
  output += markdownList([...wasixIndexedDb.types, ...wasixIndexedDb.values]);
  output += `\n### Storage subpath: @oliphaunt/wasix-ts/storage/opfs\n\n`;
  output += markdownList([...wasixOpfs.types, ...wasixOpfs.values]);
  output += `\n### Storage subpath: @oliphaunt/wasix-ts/storage/node\n\n`;
  output += markdownList([...wasixNodeDirectory.types, ...wasixNodeDirectory.values]);
  output += `\n### Storage subpath: @oliphaunt/wasix-ts/storage/bun\n\n`;
  output += markdownList([...wasixBunDirectory.types, ...wasixBunDirectory.values]);
  output += `\n### Storage subpath: @oliphaunt/wasix-ts/storage/deno\n\n`;
  output += markdownList([...wasixDenoDirectory.types, ...wasixDenoDirectory.values]);
  output += `\n### Server subpaths: @oliphaunt/wasix-ts/server/{node,bun,deno}\n\n`;
  output += markdownList([
    ...wasixTsServer.types,
    ...wasixTsServer.values,
    ...wasixTsServer.members,
  ]);
  output += `\n## WASIX TypeScript tools: @oliphaunt/wasix-tools\n\n`;
  output += `### Package exports\n\n`;
  output += markdownList(
    extractPackageExports('src/bindings/wasix-ts/tools-package/package.json'),
  );
  output += `\n### Types\n\n`;
  output += markdownList(wasixToolsTs.types);
  output += `\n### Values\n\n`;
  output += markdownList(wasixToolsTs.values);
  output += `\n### Members\n\n`;
  output += markdownList(wasixToolsTs.members);
  return output;
}

const generated = render();
if (mode === '--write') {
  writeFileSync(outputPath, generated);
} else {
  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  if (current !== generated) {
    console.error('docs/maintainers/sdk-api-surface.md is stale; run node tools/policy/generate-sdk-api-surface.mjs --write');
    process.exit(1);
  }
}
