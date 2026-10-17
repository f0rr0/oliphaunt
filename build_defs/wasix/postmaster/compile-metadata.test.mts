import { expect, test } from 'bun:test';
import { compilerZstdLabel, postmasterCompileMetadata } from './compile-metadata.mts';

const manifest = {
  package: { name: 'executor', version: '7.2.0-alpha.2', edition: '2024' },
  features: { default: [], execute: ['memory'], memory: [], compile: [] },
  bin: [
    { name: 'postmaster-executor', path: 'src/executor.rs', 'required-features': ['execute'] },
    { name: 'postmaster-compiler', path: 'src/compiler.rs', 'required-features': ['compile'] },
  ],
};
const context = (features: string[]) => ({
  workspace_members: { 'executor 7.2.0-alpha.2': '' },
  crates: { 'executor 7.2.0-alpha.2': { common_attrs: { crate_features: features } } },
});

test('projects the exact selected transitive zstd repository instead of assuming a hub alias', () => {
  const row = {
    name: 'zstd',
    version: '0.13.3',
    library_target_name: 'zstd',
    repository: { Http: { sha256: 'a'.repeat(64), url: 'https://registry.test/zstd/0.13.3' } },
  };
  const context = { crates: { 'zstd 0.13.3': row } };
  const rendered = `\n    maybe(\n        http_archive,\n        name = "compiler_hub__zstd-0.13.3",\n        sha256 = "${row.repository.Http.sha256}",\n        urls = ["${row.repository.Http.url}"],\n        strip_prefix = "zstd-0.13.3",\n        build_file = Label("@compiler_hub//compiler_hub:BUILD.zstd-0.13.3.bazel"),\n    )\n`;
  expect(compilerZstdLabel(context, rendered, '+actual_extension+compiler_hub')).toBe(
    '@@+actual_extension+compiler_hub__zstd-0.13.3//:zstd',
  );
  expect(() =>
    compilerZstdLabel({ crates: {} }, rendered, '+actual_extension+compiler_hub'),
  ).toThrow('one actual selected');
  expect(() =>
    compilerZstdLabel(
      { crates: { one: row, two: { ...row, version: 'other' } } },
      rendered,
      '+actual_extension+compiler_hub',
    ),
  ).toThrow('one actual selected');
  expect(() =>
    compilerZstdLabel(
      context,
      rendered.replace(row.repository.Http.sha256, 'b'.repeat(64)),
      '+actual_extension+compiler_hub',
    ),
  ).toThrow('one exact rendered');
  expect(() =>
    compilerZstdLabel(context, rendered + rendered, '+actual_extension+compiler_hub'),
  ).toThrow('one exact rendered');
  expect(() => compilerZstdLabel(context, rendered, '+actual_extension+different_hub')).toThrow(
    'mapping differs',
  );
});
test('projects actual resolved role features while preserving no-default conventional compilation', () => {
  const contexts = {
    executor: context(['default', 'execute', 'memory']),
    compiler: context(['default', 'compile']),
  };
  const facts = postmasterCompileMetadata(manifest, contexts);
  expect(facts.roles.executor.features).toEqual(['execute', 'memory']);
  expect(facts.roles.compiler.features).toEqual(['compile']);
  expect(facts.version).toBe(manifest.package.version);
  expect(facts.roles.compiler.source).toBe(manifest.bin[1].path);
  expect(() =>
    postmasterCompileMetadata(manifest, { ...contexts, executor: context(['default']) }),
  ).toThrow('lost canonical feature');
  expect(() =>
    postmasterCompileMetadata(manifest, { ...contexts, compiler: context(['compile', 'fake']) }),
  ).toThrow('Unknown resolved feature');
  expect(() =>
    postmasterCompileMetadata(manifest, { ...contexts, executor: context(['execute', 'execute']) }),
  ).toThrow();
  expect(() =>
    postmasterCompileMetadata(
      { ...manifest, package: { ...manifest.package, version: '7.2.1' } },
      contexts,
    ),
  ).toThrow();
});
