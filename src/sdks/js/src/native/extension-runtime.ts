import {
  type GeneratedExtensionMetadata,
  generatedExtensionBySqlName,
} from '../generated/extensions.js';

export type RuntimeFileHost = {
  join(...parts: string[]): string;
  readDir(path: string): Promise<ReadonlyArray<{ name: string; isFile?: boolean }>>;
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
};

export type PreparedRuntimeExtensions = {
  runtimeDirectory: string;
  moduleDirectory?: string;
};

export async function validatePreparedRuntimeExtensions(config: {
  runtimeDirectory?: string;
  extensions: ReadonlyArray<string>;
  target: string;
  source: string;
  host: RuntimeFileHost;
  moduleDirectoryRelativePaths?: ReadonlyArray<string>;
  requiredModuleStems?: ReadonlyArray<string>;
}): Promise<PreparedRuntimeExtensions> {
  const selected = selectedExtensionClosure(config.extensions);
  if (selected.length === 0) {
    return { runtimeDirectory: config.runtimeDirectory ?? '' };
  }
  if (config.runtimeDirectory === undefined) {
    throw new Error(
      `${config.source} requires runtimeDirectory with selected extension assets: ${selected.join(', ')}`,
    );
  }

  const runtimeDirectory = await preparedRuntimeDirectory(config.runtimeDirectory, config.host);
  const moduleDirectoryRelativePaths = config.moduleDirectoryRelativePaths ?? [
    'lib/modules',
    'lib/postgresql',
  ];
  if (moduleDirectoryRelativePaths.length === 0) {
    throw new Error(`${config.source} must declare at least one module directory`);
  }
  const moduleDirectoryCandidates = moduleDirectoryRelativePaths.map((relativePath) =>
    config.host.join(runtimeDirectory, relativePath),
  );
  let moduleDirectory = moduleDirectoryCandidates[0];
  for (const candidate of moduleDirectoryCandidates) {
    if (await config.host.isDirectory(candidate)) {
      moduleDirectory = candidate;
      break;
    }
  }
  if (moduleDirectory === undefined) {
    throw new Error(`${config.source} cannot resolve a module directory`);
  }
  for (const sqlName of selected) {
    const extension = generatedExtensionBySqlName(sqlName);
    if (extension === undefined) {
      throw new Error(`unknown Oliphaunt extension id '${sqlName}'`);
    }
    await requireExtensionRuntimePayload({
      extension,
      target: config.target,
      runtimeDirectories: [runtimeDirectory],
      moduleDirectories: [moduleDirectory],
      runtimeSource: config.source,
      moduleSource: `${config.source} module directory`,
      host: config.host,
    });
  }
  for (const moduleStem of config.requiredModuleStems ?? []) {
    await requireFileInAnyRoot(
      [moduleDirectory],
      `${moduleStem}${nativeModuleSuffixForTarget(config.target)}`,
      `${config.source} module directory`,
      config.host,
    );
  }

  return { runtimeDirectory, moduleDirectory };
}

export async function requireExtensionRuntimePayload(config: {
  extension: GeneratedExtensionMetadata;
  target: string;
  runtimeDirectories: readonly string[];
  moduleDirectories: readonly string[];
  runtimeSource: string;
  moduleSource: string;
  host: RuntimeFileHost;
}): Promise<void> {
  if (config.extension.createsExtension) {
    const entries = await extensionSqlDirectoryEntries(config.runtimeDirectories, config.host);
    const hasControl = entries.includes(`${config.extension.sqlName}.control`);
    if (!hasControl) {
      throw new Error(`${config.runtimeSource} is missing ${config.extension.sqlName}.control`);
    }
    const hasInstallSql = entries.some(
      (entry) => entry.endsWith('.sql') && extensionSqlFileBelongs(config.extension, entry),
    );
    if (!hasInstallSql) {
      throw new Error(
        `${config.runtimeSource} is missing SQL install files for ${config.extension.sqlName}`,
      );
    }
  }

  for (const dataFile of config.extension.dataFiles) {
    await requireFileInAnyRoot(
      config.runtimeDirectories,
      dataFile,
      config.runtimeSource,
      config.host,
    );
  }

  if (config.extension.nativeModuleStem !== null) {
    const moduleFile = `${config.extension.nativeModuleStem}${nativeModuleSuffixForTarget(
      config.target,
    )}`;
    await requireFileInAnyRoot(
      config.moduleDirectories,
      moduleFile,
      config.moduleSource,
      config.host,
    );
  }
}

export function selectedExtensionClosure(extensions: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const queue = [...extensions];
  while (queue.length > 0) {
    const sqlName = queue.shift();
    if (sqlName === undefined || seen.has(sqlName)) {
      continue;
    }
    seen.add(sqlName);
    const metadata = generatedExtensionBySqlName(sqlName);
    if (metadata === undefined) {
      throw new Error(`unknown Oliphaunt extension id '${sqlName}'`);
    }
    for (const dependency of metadata.selectedExtensionDependencies) {
      queue.push(dependency);
    }
  }
  return [...seen].sort();
}

export function nativeModuleSuffixForTarget(target: string): string {
  if (target.startsWith('macos-')) {
    return '.dylib';
  }
  if (target === 'windows-x64-msvc') {
    return '.dll';
  }
  return '.so';
}

async function preparedRuntimeDirectory(
  runtimeDirectory: string,
  host: RuntimeFileHost,
): Promise<string> {
  const releaseShapedRuntime = host.join(runtimeDirectory, 'oliphaunt/runtime/files');
  if (await host.isDirectory(releaseShapedRuntime)) {
    return releaseShapedRuntime;
  }
  return runtimeDirectory;
}

async function extensionSqlDirectoryEntries(
  runtimeDirectories: readonly string[],
  host: RuntimeFileHost,
): Promise<string[]> {
  const entries: string[] = [];
  for (const runtimeDirectory of runtimeDirectories) {
    const extensionDirectory = host.join(runtimeDirectory, 'share/postgresql/extension');
    if (!(await host.isDirectory(extensionDirectory))) {
      continue;
    }
    for (const entry of await host.readDir(extensionDirectory)) {
      if (entry.isFile !== false) {
        entries.push(entry.name);
      }
    }
  }
  return entries;
}

function extensionSqlFileBelongs(extension: GeneratedExtensionMetadata, fileName: string): boolean {
  return (
    fileName === `${extension.sqlName}.control` ||
    fileName === `${extension.sqlName}.sql` ||
    (fileName.startsWith(`${extension.sqlName}--`) && fileName.endsWith('.sql')) ||
    extension.extensionSqlFileNames.includes(fileName) ||
    extension.extensionSqlFilePrefixes.some((prefix) => fileName.startsWith(prefix))
  );
}

async function requireFileInAnyRoot(
  roots: readonly string[],
  relativePath: string,
  source: string,
  host: RuntimeFileHost,
): Promise<void> {
  for (const root of roots) {
    if (await host.isFile(host.join(root, relativePath))) {
      return;
    }
  }
  throw new Error(`${source} is missing required file ${relativePath}`);
}
