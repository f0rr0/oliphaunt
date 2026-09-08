import * as fs from 'node:fs';

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'normalize': {
    const [metadataPath, requestedRaw, platformLabel] = args;
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const bySqlName = new Map();
    for (const row of metadata.extensions ?? []) {
      if (typeof row['sql-name'] === 'string') {
        bySqlName.set(row['sql-name'], row);
      }
    }

    const supported = [...bySqlName.values()].map((row) => row['sql-name']).sort();
    const ordered = [];
    const seen = new Set();
    function visit(sqlName) {
      if (seen.has(sqlName)) {
        return;
      }
      const row = bySqlName.get(sqlName);
      if (!row) {
        throw new Error(
          `unsupported mobile extension for ${platformLabel} Expo smoke: ${sqlName} ` +
            `(supported: ${supported.join(',')})`,
        );
      }
      seen.add(sqlName);
      const dependencies = row['selected-extension-dependencies'] ?? [];
      if (
        !Array.isArray(dependencies) ||
        dependencies.some((dependency) => typeof dependency !== 'string')
      ) {
        throw new Error(
          `extension ${sqlName} has invalid selected-extension-dependencies metadata`,
        );
      }
      for (const dependency of dependencies) {
        visit(dependency);
      }
      ordered.push(sqlName);
    }
    for (const sqlName of requestedRaw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      visit(sqlName);
    }
    process.stdout.write(ordered.join(','));
    break;
  }
  case 'createable': {
    const [metadataPath, selectedRaw] = args;
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const bySqlName = new Map(
      (metadata.extensions ?? [])
        .filter((row) => typeof row['sql-name'] === 'string')
        .map((row) => [row['sql-name'], row]),
    );
    const selected = [
      ...new Set(
        selectedRaw
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].sort();
    const createable = [];
    for (const sqlName of selected) {
      const row = bySqlName.get(sqlName);
      if (row === undefined) {
        throw new Error(`selected mobile extension is missing from generated metadata: ${sqlName}`);
      }
      if (row['creates-extension'] === true) {
        createable.push(sqlName);
      }
    }
    process.stdout.write(createable.join(','));
    break;
  }
  case 'static': {
    const [metadataPath, staticSpecsPath, selectedRaw] = args;
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const bySqlName = new Map(
      (metadata.extensions ?? [])
        .filter((row) => typeof row['sql-name'] === 'string')
        .map((row) => [row['sql-name'], row]),
    );
    const specLines = fs
      .readFileSync(staticSpecsPath, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    const header = specLines.shift()?.split('\t') ?? [];
    const sqlNameIndex = header.indexOf('sql-name');
    const moduleStemIndex = header.indexOf('native-module-stem');
    if (sqlNameIndex === -1 || moduleStemIndex === -1) {
      throw new Error('generated mobile static extension specs are missing identity columns');
    }
    const staticSpecs = new Map();
    for (const line of specLines) {
      const fields = line.split('\t');
      staticSpecs.set(fields[sqlNameIndex], fields[moduleStemIndex]);
    }
    const selectedStatic = [];
    const seen = new Set();
    for (const sqlName of selectedRaw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (seen.has(sqlName)) continue;
      seen.add(sqlName);
      const row = bySqlName.get(sqlName);
      if (!row) {
        throw new Error(
          `selected mobile extension ${sqlName} is absent from generated React Native metadata`,
        );
      }
      const metadataStem = row['native-module-stem'];
      const staticStem = staticSpecs.get(sqlName);
      if (metadataStem === null) {
        if (staticStem !== undefined) {
          throw new Error(
            `SQL-only mobile extension ${sqlName} must not have a native static-module spec`,
          );
        }
        continue;
      }
      if (typeof metadataStem !== 'string' || metadataStem.length === 0) {
        throw new Error(
          `selected mobile extension ${sqlName} has invalid native-module-stem metadata`,
        );
      }
      if (staticStem === undefined) {
        throw new Error(
          `selected native mobile extension is missing a static-module spec: ${sqlName}`,
        );
      }
      if (staticStem !== metadataStem) {
        throw new Error(
          `selected mobile extension ${sqlName} static-module stem mismatch: ` +
            `metadata=${metadataStem}, static-spec=${staticStem}`,
        );
      }
      selectedStatic.push(sqlName);
    }
    process.stdout.write(selectedStatic.join(','));
    break;
  }
  case 'data-files': {
    const [registryPath, mode, selectedRaw] = args;
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const selected = new Set(
      selectedRaw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const files = new Set();
    for (const module of registry.modules ?? []) {
      const sqlName = module['sql-name'];
      if (mode === 'selected' && !selected.has(sqlName)) {
        continue;
      }
      for (const file of module['data-files'] ?? []) {
        if (typeof file === 'string' && file.length > 0) {
          files.add(file);
        }
      }
    }
    for (const file of [...files].sort()) {
      console.log(file);
    }
    break;
  }
  default:
    throw new Error('unknown mobile-extension-runtime command: ' + command);
}
