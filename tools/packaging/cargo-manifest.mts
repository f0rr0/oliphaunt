type Table = Record<string, any>;

/** Resolve Cargo's conventional workspace inheritance without changing requirements. */
export function resolveCargoWorkspaceInheritance(manifest: Table, workspace: Table): Table {
  const result = structuredClone(manifest);
  for (const [key, value] of Object.entries(result.package ?? {}) as [string, Table][]) {
    if (!value || typeof value !== 'object' || value.workspace !== true) continue;
    if (workspace.package?.[key] === undefined)
      throw new Error(`Missing inherited Cargo package.${key}`);
    result.package[key] = structuredClone(workspace.package[key]);
  }
  for (const table of [result, ...Object.values(result.target ?? {})] as Table[]) {
    for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      for (const [name, value] of Object.entries(table[section] ?? {}) as [string, Table][]) {
        if (!value || typeof value !== 'object' || value.workspace !== true) continue;
        const inherited = workspace.dependencies?.[name];
        if (inherited === undefined)
          throw new Error(`Missing inherited Cargo dependencies.${name}`);
        const base = typeof inherited === 'string' ? { version: inherited } : inherited;
        const member = Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'workspace'),
        );
        table[section][name] = { ...structuredClone(base), ...member };
        if (base.features || member.features)
          table[section][name].features = [
            ...new Set([...(base.features ?? []), ...(member.features ?? [])]),
          ];
      }
    }
  }
  return result;
}

export function cargoSatisfies(version: string, requirement: string): boolean {
  // Cargo ignores build metadata for version requirements; Bun does not.
  const range = requirement.replaceAll(',', ' ');
  return Bun.semver.satisfies(version.split('+', 1)[0], /^\d/.test(range) ? `^${range}` : range);
}

/** The exact stable floor satisfying an owner's internal Cargo requirements. */
export function cargoDependencyMinimum(requirement: string | string[]): string {
  if (Array.isArray(requirement)) {
    if (!requirement.length)
      throw new Error('Internal Cargo minimum needs an authored requirement');
    const floor = requirement.map(cargoDependencyMinimum).sort(Bun.semver.order).at(-1)!;
    if (!requirement.every((range) => cargoSatisfies(floor, range.trim())))
      throw new Error(`Internal Cargo minimum requirements conflict: ${requirement.join(', ')}`);
    return floor;
  }
  const match =
    /^(?:\^|~|=|>=)?\s*(\d+(?:\.\d+){0,2})(?:\s*,\s*<={0,1}\s*\d+(?:\.\d+){0,2})?$/u.exec(
      requirement.trim(),
    );
  if (!match)
    throw new Error(`Internal Cargo minimum needs an explicit stable floor: ${requirement}`);
  const floor = [...match[1].split('.'), '0', '0'].slice(0, 3).join('.');
  if (!cargoSatisfies(floor, requirement.trim()))
    throw new Error(`Internal Cargo minimum is excluded by its requirement: ${requirement}`);
  return floor;
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`)
      .join(', ')} }`;
  throw new Error(`Unsupported Cargo TOML value: ${String(value)}`);
}

export function renderCargoToml(table: Table): string {
  const scalars = Object.entries(table).filter(
    ([, value]) => !value || typeof value !== 'object' || Array.isArray(value),
  );
  const tables = Object.entries(table).filter(
    ([, value]) => value && typeof value === 'object' && !Array.isArray(value),
  );
  return `${[
    ...scalars.map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}`),
    ...tables.flatMap(([key, value]) => [
      '',
      `[${JSON.stringify(key)}]`,
      ...Object.entries(value as Table).map(
        ([name, item]) => `${JSON.stringify(name)} = ${tomlValue(item)}`,
      ),
    ]),
  ].join('\n')}\n`;
}
