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

function extractRustSurface(
  indexFile = 'src/sdks/rust/src/lib.rs',
  sourceDir = 'src/sdks/rust/src',
  crateName = 'oliphaunt',
) {
  const lines = readRelative(indexFile).split('\n');
  const symbols = [];
  let skipDocHidden = false;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === '#[doc(hidden)]') {
      skipDocHidden = true;
      continue;
    }
    if (!trimmed.startsWith('pub use ')) {
      if (trimmed.length > 0 && !trimmed.startsWith('#[')) {
        skipDocHidden = false;
      }
      continue;
    }

    let block = trimmed;
    while (!block.includes(';') && index + 1 < lines.length) {
      index += 1;
      block += ` ${lines[index].trim()}`;
    }
    if (skipDocHidden) {
      skipDocHidden = false;
      continue;
    }

    const spec = block
      .replace(/^pub use\s+/u, '')
      .replace(/;$/u, '')
      .replace(/\s+/gu, ' ')
      .trim();
    const grouped = spec.match(/^(.*)::\{(.*)\}$/u);
    if (grouped) {
      for (const name of splitNames(grouped[2])) {
        symbols.push(`${crateName}::${name}`);
      }
    } else {
      const name = spec.split('::').pop();
      if (name) {
        symbols.push(`${crateName}::${name}`);
      }
    }
    skipDocHidden = false;
  }

  for (const file of listFiles(sourceDir, '.rs')) {
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
  for (const file of listFiles(sourceDir, '.rs')) {
    const source = readRelative(file);
    for (const match of source.matchAll(
      /^\s*pub\s+(?:struct|enum|union|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/gmu,
    )) {
      if (exportedNames.has(match[1])) {
        exportedTypes.add(match[1]);
      }
    }
  }
  symbols.push(...extractRustInherentMethods(sourceDir, crateName, exportedTypes));

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
  symbols.push(...extractRustInherentMethods(sourceDir, crateName, exportedTypes));
  return sorted(symbols);
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

function extractRustInherentMethods(sourceDir, crateName, exportedTypes) {
  const methods = [];
  for (const file of listFiles(sourceDir, '.rs')) {
    let depth = 0;
    let pendingImpl = null;
    let activeImpl = null;

    for (const line of readRelative(file).split('\n')) {
      if (activeImpl && depth < activeImpl.depth) {
        activeImpl = null;
      }
      const trimmed = line.trim();

      if (activeImpl && depth === activeImpl.depth) {
        const method = trimmed.match(
          /^pub\s+(?:(?:async|const|unsafe)\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)/u,
        );
        if (method) {
          methods.push(`${crateName}::${activeImpl.name}.${method[1]}()`);
        }
      } else if (!activeImpl && pendingImpl) {
        pendingImpl += ` ${trimmed}`;
      } else if (!activeImpl && /^impl(?:\s|<)/u.test(trimmed)) {
        pendingImpl = trimmed;
      }

      const braces = countBraces(line);
      depth += braces.opens - braces.closes;
      if (pendingImpl?.includes('{')) {
        const name = rustInherentImplType(pendingImpl);
        if (name && exportedTypes.has(name) && braces.opens > braces.closes) {
          activeImpl = {name, depth};
        }
        pendingImpl = null;
      }
    }
  }
  return methods;
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

function extractSwiftSurface(
  sourceDir = 'src/sdks/swift/Sources/Oliphaunt',
) {
  const files = listFiles(sourceDir, '.swift');
  const symbols = [];

  for (const file of files) {
    let depth = 0;
    const stack = [];
    let awaitingContext = null;

    for (const line of readRelative(file).split('\n')) {
      while (stack.length > 0 && depth < stack[stack.length - 1].depth) {
        stack.pop();
      }

      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('//')) {
        const braces = countBraces(line);
        depth += braces.opens - braces.closes;
        continue;
      }

      const active = stack[stack.length - 1] ?? awaitingContext;
      let pendingContext = null;
      const typeMatch = trimmed.match(
        /^public\s+(?:final\s+)?(enum|struct|actor|protocol|class)\s+([A-Za-z_][A-Za-z0-9_]*)/u,
      );
      const extensionMatch = trimmed.match(
        /^public\s+extension\s+([A-Za-z_][A-Za-z0-9_.]*)/u,
      );

      if (typeMatch) {
        const name = active ? `${active.name}.${typeMatch[2]}` : typeMatch[2];
        symbols.push(`${typeMatch[1]} ${name}`);
        pendingContext = {name, depth: depth + 1};
      } else if (extensionMatch) {
        symbols.push(`extension ${extensionMatch[1]}`);
        pendingContext = {name: extensionMatch[1], depth: depth + 1, extension: true};
      } else {
        const inPublicExtension = active?.extension === true;
        const isPublicMember = /^public\s+(?:static\s+)?(?:func|var|let|init)\b/u.test(trimmed);
        const isExtensionMember =
          inPublicExtension && /^(?:static\s+)?(?:func|var|let|init)\b/u.test(trimmed);
        const isDeclarationDepth = active ? depth === active.depth : depth === 0;
        if ((isPublicMember || isExtensionMember) && isDeclarationDepth) {
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
  }

  return sorted(symbols);
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
      let depth = 0;
      const stack = [];
      let awaitingContext = null;

      for (const line of readRelative(file).split('\n')) {
        while (stack.length > 0 && depth < stack[stack.length - 1].depth) {
          stack.pop();
        }

        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('//')) {
          const braces = countBraces(line);
          depth += braces.opens - braces.closes;
          continue;
        }

        const active = stack[stack.length - 1] ?? awaitingContext;
        let pendingContext = null;
        const typeMatch = trimmed.match(
          /^public\s+(?:(?:data|sealed|open)\s+)*(enum\s+class|data\s+class|sealed\s+class|open\s+class|class|object|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/u,
        );

        if (typeMatch) {
          const name = active ? `${active.name}.${typeMatch[2]}` : typeMatch[2];
          symbols.push(`${typeMatch[1]} ${name}`);
          pendingContext = {name, depth: depth + 1};
        } else if (/^public\s+(?:expect\s+|actual\s+)?(?:suspend\s+)?fun\b/u.test(trimmed)) {
          const member = kotlinMemberName(trimmed);
          if (member) {
            const owner = member.receiver ?? active?.name;
            symbols.push(owner ? `${owner}.${member.name}` : member.name);
          }
        } else if (/^public\s+(?:val|var)\b/u.test(trimmed)) {
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
    /^(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]+>)?\s*\(/u,
  );
  if (methodMatch) {
    return `${methodMatch[1]}()`;
  }
  const propertyMatch = declaration.includes(';')
    ? declaration.match(/^(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??:/u)
    : null;
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
    let skipInternalMember = false;
    for (const line of readRelative(file).split('\n')) {
      while (stack.length > 0 && depth < stack[stack.length - 1].depth) {
        stack.pop();
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
      } else if (active && depth === active.depth && !trimmed.startsWith('#')) {
        if (!skipInternalMember && !/^(?:private|protected)\b/u.test(trimmed)) {
          const member = typeScriptMemberName(trimmed);
          if (member) {
            members.push(`${active.name}.${member}`);
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
      } else if (pendingContext && multilineDeclarationStillOpen(trimmed)) {
        awaitingContext = pendingContext;
      } else if (awaitingContext && braces.opens > braces.closes) {
        awaitingContext.depth = depth;
        stack.push(awaitingContext);
        awaitingContext = null;
      } else if (awaitingContext && trimmed.startsWith('}')) {
        awaitingContext = null;
      }
    }
  }

  return sorted(members);
}

function markdownList(items) {
  if (items.length === 0) {
    return '- none\n';
  }
  return `${items.map(item => `- \`${item}\``).join('\n')}\n`;
}

function render() {
  const nativeC = extractNativeCSurface();
  const kotlin = extractKotlinSurface();
  const kotlinGradlePlugin = extractKotlinGradlePluginSurface();
  const rn = extractReactNativeSurface();
  const ts = extractOliphauntTsSurface();
  const wasixTs = extractOliphauntWasixTsSurface();
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
  let output = `<!-- Generated by tools/policy/generate-sdk-api-surface.mjs; do not edit by hand. -->\n`;
  output += `# SDK API Surface Inventory\n\n`;
  output += `This no-build inventory makes public SDK drift visible in review. It is a symbol-level guard, not a replacement for full language reference documentation.\n\n`;
  output += `Regenerate with:\n\n`;
  output += `\`\`\`sh\n`;
  output += `node tools/policy/generate-sdk-api-surface.mjs --write\n`;
  output += `\`\`\`\n\n`;
  output += `## Rust: oliphaunt\n\n`;
  output += markdownList(extractRustSurface());
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
  output += markdownList(
    sorted([
      ...extractRustSurface(
        'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs',
        'src/bindings/wasix-rust/crates/oliphaunt-wasix/src',
        'oliphaunt_wasix',
      ),
      ...extractRustModuleSurface(
        [
          'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/extensions.rs',
          'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/generated_extensions.rs',
        ],
        'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt',
        'oliphaunt_wasix::extensions',
      ),
      ...extractRustModuleSurface(
        ['src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/tools.rs'],
        'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt',
        'oliphaunt_wasix::tools',
      ),
    ]),
  );
  output += `\n## Native C ABI: liboliphaunt\n\n`;
  output += `### Types\n\n`;
  output += markdownList(nativeC.types);
  output += `\n### Constants\n\n`;
  output += markdownList(nativeC.constants);
  output += `\n### Functions\n\n`;
  output += markdownList(nativeC.functions);
  output += `\n## Swift: Oliphaunt\n\n`;
  output += markdownList(extractSwiftSurface());
  output += `\n## Swift: OliphauntExtensionSupport\n\n`;
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
