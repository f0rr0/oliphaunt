// Cargo normalizes inline dependency syntax when packaging. Compare resolved
// dependency semantics, not TOML spelling or independently maintained package lists.
function dependencyTables(manifest) {
  const tables = new Map();
  const add = (prefix, table) => {
    for (const kind of ['dependencies', 'build-dependencies', 'dev-dependencies']) {
      for (const [name, value] of Object.entries(table[kind] ?? {})) {
        const dependency = typeof value === 'string' ? { version: value } : value;
        // Cargo omits development-only path dependencies with no registry version.
        if (kind === 'dev-dependencies' && !dependency.version) continue;
        tables.set(JSON.stringify([...prefix, kind, name]), dependency);
      }
    }
  };
  add([], manifest);
  for (const [target, table] of Object.entries(manifest.target ?? {}))
    add(['target', target], table);
  return tables;
}

export function assertPackagedCargoDependencies(actual, expected, label) {
  const wanted = dependencyTables(expected);
  const packed = dependencyTables(actual);
  for (const key of new Set([...wanted.keys(), ...packed.keys()])) {
    const source = wanted.get(key);
    const dependency = packed.get(key);
    if (!source || !dependency)
      throw new Error(`${label} dependency ${key} is missing or unexpected`);
    if (
      ['path', 'workspace', 'git', 'registry', 'registry-index'].some(
        (field) => field in dependency,
      )
    ) {
      throw new Error(`${label} dependency ${key} must resolve through crates.io`);
    }
    const normalize = (row) => ({
      version: row.version,
      package: row.package ?? null,
      optional: row.optional ?? false,
      defaultFeatures: row['default-features'] ?? true,
      features: [...new Set(row.features ?? [])].sort(),
    });
    if (JSON.stringify(normalize(dependency)) !== JSON.stringify(normalize(source))) {
      throw new Error(
        `${label} dependency ${key} differs from its resolved source manifest: expected ${JSON.stringify(normalize(source))}, received ${JSON.stringify(normalize(dependency))}`,
      );
    }
  }
}
