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

function extractRustSurface() {
  const lines = readRelative('src/sdks/rust/src/lib.rs').split('\n');
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
        symbols.push(`oliphaunt::${name}`);
      }
    } else {
      const name = spec.split('::').pop();
      if (name) {
        symbols.push(`oliphaunt::${name}`);
      }
    }
    skipDocHidden = false;
  }

  for (const file of listFiles('src/sdks/rust/src', '.rs')) {
    const source = readRelative(file);
    const macroPattern =
      /#\[\s*macro_export\s*\]\s*(?:#\[[^\]]+\]\s*)*macro_rules!\s+([A-Za-z_][A-Za-z0-9_]*)/gu;
    for (const match of source.matchAll(macroPattern)) {
      symbols.push(`oliphaunt::${match[1]}!`);
    }
  }

  return sorted(symbols);
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
  return !line.includes('{') && !line.includes(')') && !line.includes('=');
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

function extractSwiftSurface() {
  const files = listFiles('src/sdks/swift/Sources/Oliphaunt', '.swift');
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
        if (isPublicMember || isExtensionMember) {
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
  const sourceSets = ['commonMain', 'androidMain', 'jvmMain', 'nativeMain'];
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

function extractTypeScriptSurface(indexFile, memberFiles) {
  const text = readRelative(indexFile);
  const types = [];
  const values = [];

  for (const match of text.matchAll(/export\s+type\s+\{([\s\S]*?)\}\s+from/gu)) {
    types.push(...splitNames(match[1]));
  }
  for (const match of text.matchAll(/export\s+\{([\s\S]*?)\}\s+from/gu)) {
    values.push(...splitNames(match[1]));
  }
  for (const match of text.matchAll(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    values.push(match[1]);
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

function typeScriptMemberName(line) {
  const getterMatch = line.match(/^get\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u);
  if (getterMatch) {
    return getterMatch[1];
  }
  const methodMatch = line.match(/^(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/u);
  if (methodMatch) {
    return `${methodMatch[1]}()`;
  }
  const propertyMatch = line.includes(';')
    ? line.match(/^([A-Za-z_][A-Za-z0-9_]*)\??:/u)
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
      const typeMatch = trimmed.match(/^export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)/u);
      const classMatch = trimmed.match(/^export\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/u);
      const functionMatch = trimmed.match(/^export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/u);
      const constMatch = trimmed.match(/^export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/u);

      if (typeMatch) {
        if (exportedTypes.has(typeMatch[1])) {
          pendingContext = {name: typeMatch[1], depth: depth + 1};
        }
      } else if (classMatch) {
        if (exportedValues.has(classMatch[1])) {
          pendingContext = {name: classMatch[1], depth: depth + 1};
        }
      } else if (functionMatch) {
        if (exportedValues.has(functionMatch[1])) {
          members.push(`${functionMatch[1]}()`);
        }
      } else if (constMatch) {
        if (exportedValues.has(constMatch[1])) {
          members.push(constMatch[1]);
        }
      } else if (active && depth === active.depth && !trimmed.startsWith('#')) {
        const member = typeScriptMemberName(trimmed);
        if (member && !['constructor'].includes(member.replace(/\(\)$/u, ''))) {
          members.push(`${active.name}.${member}`);
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
  const kotlin = extractKotlinSurface();
  const rn = extractReactNativeSurface();
  const ts = extractOliphauntTsSurface();
  let output = `<!-- Generated by tools/policy/generate-sdk-api-surface.mjs; do not edit by hand. -->\n`;
  output += `# SDK API Surface Inventory\n\n`;
  output += `This no-build inventory makes public SDK drift visible in review. It is a symbol-level guard, not a replacement for full language reference documentation.\n\n`;
  output += `Regenerate with:\n\n`;
  output += `\`\`\`sh\n`;
  output += `node tools/policy/generate-sdk-api-surface.mjs --write\n`;
  output += `\`\`\`\n\n`;
  output += `## Rust: oliphaunt\n\n`;
  output += markdownList(extractRustSurface());
  output += `\n## Swift: Oliphaunt\n\n`;
  output += markdownList(extractSwiftSurface());
  output += `\n## Kotlin: oliphaunt\n\n`;
  for (const section of kotlin) {
    output += `### ${section.sourceSet}\n\n`;
    output += markdownList(section.symbols);
    output += `\n`;
  }
  output += `## React Native: @oliphaunt/react-native\n\n`;
  output += `### Types\n\n`;
  output += markdownList(rn.types);
  output += `\n### Values\n\n`;
  output += markdownList(rn.values);
  output += `\n### Members\n\n`;
  output += markdownList(rn.members);
  output += `\n## TypeScript: @oliphaunt/ts\n\n`;
  output += `### Types\n\n`;
  output += markdownList(ts.types);
  output += `\n### Values\n\n`;
  output += markdownList(ts.values);
  output += `\n### Members\n\n`;
  output += markdownList(ts.members);
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
