/** PROJ's pinned FileEmbed/lib_proj resource generation, with declared inputs. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { spec: { type: 'string' } } });
if (!values.spec) throw new Error('expected --spec');
const spec = JSON.parse(readFileSync(values.spec, 'utf8')) as {
  output: string;
  database: string;
  resources: Record<string, string>;
};
const emit = (name: string, content: string): void => {
  const destination = join(spec.output, 'file_embed', name);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
};
for (const [name, path] of Object.entries({ 'proj.db': spec.database, ...spec.resources })) {
  const identifier = name.replace(/[^A-Za-z_0-9]/gu, '_');
  const bytes = readFileSync(path);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    chunks.push(
      Array.from(
        bytes.subarray(offset, offset + 16),
        (byte) => `0x${byte.toString(16).padStart(2, '0')},`,
      ).join(''),
    );
  }
  emit(
    `${identifier}.h`,
    `#ifndef ${identifier}_H\n#define ${identifier}_H\n#include <stdint.h>\nextern const uint8_t ${identifier}_data[];\nextern const unsigned ${identifier}_size;\n#endif\n`,
  );
  emit(
    `${identifier}.c`,
    `#include "${identifier}.h"\nconst uint8_t ${identifier}_data[] = {\n${chunks.join('\n')}\n};\nconst unsigned ${identifier}_size = sizeof(${identifier}_data);\n`,
  );
}
emit(
  'embedded_resources.c',
  `const unsigned char *pj_get_embedded_resource(const char *filename, unsigned int *pnSize) {\n${Object.keys(
    spec.resources,
  )
    .map((name) => {
      const identifier = name.replace(/[^A-Za-z_0-9]/gu, '_');
      return `  if (strcmp(filename, ${JSON.stringify(name)}) == 0) { *pnSize = ${identifier}_size; return ${identifier}_data; }`;
    })
    .join('\n')}\n  *pnSize = 0; return NULL;\n}\n`,
);
// The upstream dispatcher includes this file and sees the generated declarations.
const declarations = Object.keys(spec.resources)
  .map((name) => `#include "${name.replace(/[^A-Za-z_0-9]/gu, '_')}.h"`)
  .join('\n');
const dispatcher = join(spec.output, 'file_embed', 'embedded_resources.c');
writeFileSync(dispatcher, `${declarations}\n${readFileSync(dispatcher, 'utf8')}`);
