import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packageGeneratedCargoSource } from '../../../../../tools/packaging/cargo-source-package.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from '../../../../../tools/packaging/release-notices.mts';
import {
  renderUnsupportedNativeTargetGuard,
  rustNativeTargetCfg,
} from '../../../../../tools/packaging/rust-native-targets.mts';
import {
  type ExtensionOwnerMetadata,
  frozenExtensionOwnerRequirements,
} from '../../../../../tools/release/extension-release-metadata.mts';
import { extensionOwnerForSqlName } from '../../../../../tools/release/release-artifact-targets.mts';
import { compareText } from '../../../../../tools/release/release-graph.mts';
import {
  expectedExtensionAotTargets,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from '../../../../wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { assertWasixExtensionInstall } from '../../../contracts/wasix-extension-install.mts';
import { nativeExtensionCargoPackageName } from './extension-registry-packages.mts';

const FACADE_NOTICE_OPTIONS = Object.freeze({ profile: 'code-facade' });

function fail(message) {
  throw new Error(`package-extension-cargo-facades: ${message}`);
}

function dependencyFeature(name) {
  return `dep:${name}`;
}

function facadeLinksName(product) {
  return `oliphaunt_artifact_relay_extension_${product
    .replace(/^oliphaunt-extension-/u, '')
    .replaceAll('-', '_')}`;
}

const FACADE_BUILD_RS = `use std::collections::BTreeMap;
use std::env;

const PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_";
const RELAY_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_RELAY_";
const EXTENSION_RELAY_PREFIX: &str = "DEP_OLIPHAUNT_ARTIFACT_RELAY_EXTENSION_";
const SUFFIX: &str = "_MANIFEST";

fn main() {
    #[cfg(feature = "native")]
    {
        let embedded = oliphaunt_build::embed_resolved_artifacts().expect("embed native extension resources");
        println!("cargo::rustc-env=OLIPHAUNT_EMBEDDED_RESOURCES_RS={}", embedded.display());
    }
    let mut manifests = BTreeMap::new();
    for (key, value) in env::vars() {
        if value.is_empty() || (key.starts_with(RELAY_PREFIX) && !key.starts_with(EXTENSION_RELAY_PREFIX)) {
            continue;
        }
        let Some(stem) = key.strip_prefix(PREFIX).and_then(|value| value.strip_suffix(SUFFIX)) else {
            continue;
        };
        if stem.is_empty() {
            panic!("empty Oliphaunt artifact metadata stem");
        }
        if let Some(previous) = manifests.insert(stem.to_ascii_lowercase(), value.clone()) {
            if previous != value {
                panic!("conflicting Oliphaunt extension leaf manifests for {stem}");
            }
        }
        println!("cargo::rerun-if-changed={value}");
    }
    if manifests.is_empty() && env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
        panic!("extension facade resolved no target-leaf artifact manifest");
    }
    for (stem, manifest) in manifests {
        println!("cargo::metadata={stem}_manifest={manifest}");
    }
}
`;

export function renderUnsupportedNativeGuard(product, nativeTargets, nativeCfgs) {
  return renderUnsupportedNativeTargetGuard({
    product,
    nativeTargets,
    nativeCfgs,
    feature: 'native',
    featureLabel: 'default native feature',
    guidance:
      'use a declared native target leaf, or depend on the WASIX carrier directly for WASIX builds.',
  });
}

export interface ExtensionCargoFacadeMetadata {
  nativeOwner: string;
  wasixOwner: string;
  ownerMetadata?: ExtensionOwnerMetadata;
  version: string;
  sqlNames: string[];
  targets: { nativeCargoTargets: string[]; includeWasixAot: boolean };
  compatibility: { nativeRuntimeVersion: string; wasixRuntimeVersion: string };
  memberContracts?: { sqlName: string; dependencies: string[]; wasixInstall?: unknown }[];
  wasixDependencies?: {
    product: string;
    version: string;
    members: { sqlName: string; wasixInstall: unknown }[];
  }[];
}

export function writeFacadeSource(
  product,
  outputRoot,
  {
    dependencyPaths = {},
    metadata = undefined,
  }: {
    dependencyPaths?: Record<string, string>;
    metadata?: ExtensionCargoFacadeMetadata;
  } = {},
) {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== 'object') {
    fail(`${product} facade metadata must be an object`);
  }
  const { nativeOwner, wasixOwner, version, sqlNames, targets, compatibility } = metadata;
  const nativeOnly = nativeOwner !== wasixOwner;
  const uniqueStrings = (values) =>
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value)) &&
    new Set(values).size === values.length;
  const stableVersion = (value) =>
    typeof value === 'string' &&
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(value);
  if (
    typeof product !== 'string' ||
    !/^oliphaunt-extension-[A-Za-z0-9_-]+$/u.test(product) ||
    ![nativeOwner, wasixOwner].every((owner) => typeof owner === 'string' && owner.length > 0) ||
    !uniqueStrings(sqlNames) ||
    !uniqueStrings(targets?.nativeCargoTargets) ||
    typeof targets.includeWasixAot !== 'boolean' ||
    ![version, compatibility?.nativeRuntimeVersion, compatibility?.wasixRuntimeVersion].every(
      stableVersion,
    )
  ) {
    fail(`${product} facade metadata must declare exact owners, members, targets and versions`);
  }
  for (const target of targets.nativeCargoTargets) rustNativeTargetCfg(target);
  const api = Bun.TOML.parse(readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8'));
  const wasixAotTargets =
    !nativeOnly && targets.includeWasixAot ? expectedExtensionAotTargets() : [];
  const installContracts = new Map();
  if (
    !Array.isArray(metadata.memberContracts) ||
    JSON.stringify(metadata.memberContracts.map((member) => member.sqlName)) !==
      JSON.stringify(sqlNames)
  )
    fail(`${product} facade must supply its exact frozen member contracts`);
  if (!nativeOnly) {
    for (const member of metadata.memberContracts) {
      installContracts.set(
        member.sqlName,
        assertWasixExtensionInstall(member.wasixInstall, {
          expectedSqlName: member.sqlName,
          label: `${product}/${member.sqlName} frozen WASIX install`,
        }),
      );
    }
    if (
      targets.includeWasixAot !==
      [...installContracts.values()].some((install) => install.nativeModules.length > 0)
    )
      fail(`${product} declared WASIX AOT targets differ from its frozen native modules`);
  }
  const ownerForSqlName = (sqlName: string, family: 'native' | 'wasix' = 'wasix') => {
    return extensionOwnerForSqlName(sqlName, family, {
      ownerMetadata: metadata.ownerMetadata,
      prefix: 'package-extension-cargo-facades',
    });
  };
  const nativeRequirements = frozenExtensionOwnerRequirements({
    product,
    releaseProduct: nativeOwner,
    members: metadata.memberContracts,
    runtimeProduct: 'liboliphaunt-native',
    runtimeVersion: compatibility.nativeRuntimeVersion,
    ownerForSqlName: (sqlName) => ownerForSqlName(sqlName, 'native'),
  });
  const requirements = nativeOnly
    ? []
    : frozenExtensionOwnerRequirements({
        product,
        releaseProduct: wasixOwner,
        members: sqlNames.map((sqlName) => ({
          sqlName,
          dependencies: installContracts.get(sqlName).dependencies,
        })),
        runtimeProduct: 'liboliphaunt-wasix',
        runtimeVersion: compatibility.wasixRuntimeVersion,
        ownerForSqlName,
      });
  const capturedDependencies = metadata.wasixDependencies ?? [];
  if (
    !Array.isArray(capturedDependencies) ||
    JSON.stringify(
      capturedDependencies
        .map(({ product, version }) => ({ product, version }))
        .sort((a, b) => compareText(a.product, b.product)),
    ) !== JSON.stringify(requirements)
  ) {
    fail(`${product} facade requires the exact captured WASIX dependency owner documents`);
  }
  for (const dependency of capturedDependencies) {
    if (
      !Array.isArray(dependency.members) ||
      new Set(dependency.members.map((member) => member.sqlName)).size !== dependency.members.length
    )
      fail(`${dependency.product} frozen WASIX members must be unique`);
  }
  const selectedDependencies = new Map();
  const visiting = new Set();
  const visited = new Set();
  const selectDependencies = (sqlName, install) => {
    if (visited.has(sqlName)) return;
    if (visiting.has(sqlName))
      fail(`${product} frozen WASIX dependencies contain a cycle at ${sqlName}`);
    visiting.add(sqlName);
    for (const dependencySqlName of install.dependencies) {
      if (dependencySqlName === 'plpgsql') continue;
      const own = installContracts.get(dependencySqlName);
      if (own) {
        selectDependencies(dependencySqlName, own);
        continue;
      }
      if (selectedDependencies.has(dependencySqlName)) continue;
      const owner = ownerForSqlName(dependencySqlName);
      const captured = capturedDependencies.find((row) => row.product === owner.product);
      const member = captured?.members.find((row) => row.sqlName === dependencySqlName);
      if (!member)
        fail(
          `${product} is missing the original WASIX dependency install for ${dependencySqlName}`,
        );
      const dependencyInstall = assertWasixExtensionInstall(member.wasixInstall, {
        expectedSqlName: dependencySqlName,
        label: `${captured.product}/${dependencySqlName} frozen WASIX dependency install`,
      });
      selectDependencies(dependencySqlName, dependencyInstall);
      selectedDependencies.set(dependencySqlName, {
        product: captured.product,
        version: captured.version,
        sqlName: dependencySqlName,
        install: dependencyInstall,
      });
    }
    visiting.delete(sqlName);
    visited.add(sqlName);
  };
  for (const [sqlName, install] of installContracts) selectDependencies(sqlName, install);
  const foreignMembers = [...selectedDependencies.values()].sort((a, b) =>
    compareText(a.sqlName, b.sqlName),
  );
  const foreignAotProducts = requirements.filter((requirement) =>
    foreignMembers.some(
      (member) => member.product === requirement.product && member.install.nativeModules.length > 0,
    ),
  );
  const foreignPortableNames = requirements.map(({ product }) =>
    wasixExtensionPackageName(product),
  );
  const foreignAotNames = foreignAotProducts.flatMap(({ product, version }) =>
    expectedExtensionAotTargets().map((target) => ({
      product,
      version,
      target,
      name: wasixExtensionAotPackageName(product, target),
    })),
  );
  const sourceDir = path.join(outputRoot, 'sources', product);
  mkdirSync(path.join(sourceDir, 'src'), { recursive: true });

  const nativeNames = targets.nativeCargoTargets.map((target) =>
    nativeExtensionCargoPackageName(product, target),
  );
  const wasixName = nativeOnly ? null : wasixExtensionPackageName(product);
  const aotNames = wasixAotTargets.map((target) => wasixExtensionAotPackageName(product, target));
  const features = [
    `default = ["native"]`,
    `native = ["dep:liboliphaunt-native-bindings", "dep:oliphaunt-build", ${[...nativeNames, ...nativeRequirements.map(({ product }) => product)].map((name) => JSON.stringify(dependencyFeature(name))).join(', ')}]`,
    ...(wasixName === null
      ? []
      : [
          `wasix = ["dep:oliphaunt-wasix", ${[wasixName, ...aotNames, ...foreignPortableNames, ...foreignAotNames.map(({ name }) => name)].map((name) => JSON.stringify(dependencyFeature(name))).join(', ')}]`,
        ]),
    ...aotNames.map(
      (name, index) => `${JSON.stringify(`wasix-aot-${wasixAotTargets[index]}`)} = ["wasix"]`,
    ),
  ];
  const targetDependencies = [];
  const nativeCfgs = [];
  for (const target of targets.nativeCargoTargets) {
    const cfg = rustNativeTargetCfg(target);
    const name = nativeExtensionCargoPackageName(product, target);
    nativeCfgs.push(cfg);
    targetDependencies.push(
      `[target.'cfg(${cfg})'.dependencies]\n${name} = { version = "=${version}", optional = true${dependencyPaths[name] ? `, path = ${JSON.stringify(dependencyPaths[name])}` : ''} }`,
    );
  }
  const dependency = (name, version, exact = true, optional = true) =>
    `${name} = { version = "${exact ? `=${version}` : version}"${optional ? ', optional = true' : ''}, default-features = false${dependencyPaths[name] ? `, path = ${JSON.stringify(dependencyPaths[name])}` : ''} }`;
  const cfgForTriple = (triple) =>
    rustNativeTargetCfg(
      {
        'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
        'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
        'aarch64-apple-darwin': 'macos-arm64',
        'x86_64-pc-windows-msvc': 'windows-x64-msvc',
      }[triple],
    );
  // Both native and WASIX leaves use the same host selection table.
  for (const [index, name] of aotNames.entries()) {
    const cfg = cfgForTriple(wasixAotTargets[index]);
    const header = `[target.'cfg(${cfg})'.dependencies]`;
    const existing = targetDependencies.findIndex((entry) => entry.startsWith(header));
    const row = dependency(name, version);
    if (existing < 0) targetDependencies.push(`${header}\n${row}`);
    else targetDependencies[existing] += `\n${row}`;
  }
  for (const { name, version, target } of foreignAotNames) {
    const header = `[target.'cfg(${cfgForTriple(target)})'.dependencies]`;
    const existing = targetDependencies.findIndex((entry) => entry.startsWith(header));
    const row = dependency(name, version);
    if (existing < 0) targetDependencies.push(`${header}\n${row}`);
    else targetDependencies[existing] += `\n${row}`;
  }
  const optionalDependencies = [
    dependency(
      'liboliphaunt-native-bindings',
      api.dependencies['liboliphaunt-native-bindings'],
      false,
    ),
    ...nativeRequirements.map((requirement) =>
      dependency(requirement.product, requirement.version).replace(
        'default-features = false',
        'default-features = false, features = ["native"]',
      ),
    ),
    ...(wasixName === null
      ? []
      : [
          dependency(wasixName, version),
          ...requirements.map((requirement) =>
            dependency(wasixExtensionPackageName(requirement.product), requirement.version),
          ),
          dependency('oliphaunt-wasix', api.dependencies['oliphaunt-wasix'], false).replace(
            'default-features = false',
            'default-features = false, features = ["extensions"]',
          ),
        ]),
  ].join('\n');
  const unsupportedNativeGuard = renderUnsupportedNativeGuard(
    product,
    targets.nativeCargoTargets,
    nativeCfgs,
  );
  const legalMembers = releaseNoticeRows(FACADE_NOTICE_OPTIONS).map((row) => row.member);
  const rustConstant = (sqlName) => sqlName.replaceAll('-', '_').toUpperCase();
  const installArguments = (sqlName, install) =>
    [
      `&[${install.dependencies.map((value) => JSON.stringify(value)).join(', ')}]`,
      `&[${install.nativeModules.map((module) => `(${JSON.stringify(module.path)}, ${JSON.stringify(`extension:${sqlName}${module.name === sqlName ? '' : `:${module.name}`}`)})`).join(', ')}]`,
      `&[${install.lifecycle.startupConfig.map((value) => JSON.stringify(value)).join(', ')}]`,
    ].join(', ');
  const foreignAotAlias = (dependencyProduct) =>
    `dependency_aot_${requirements.findIndex((row) => row.product === dependencyProduct)}`;
  writeFileSync(
    path.join(sourceDir, 'Cargo.toml'),
    `[package]
name = ${JSON.stringify(product)}
version = ${JSON.stringify(version)}
edition = "2024"
rust-version = "1.93"
description = ${JSON.stringify(`Target-selecting Cargo facade for ${sqlNames.length} Oliphaunt PostgreSQL extension member${sqlNames.length === 1 ? '' : 's'}.`)}
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = ${JSON.stringify(releaseProfilePackageLicense('code-facade').spdx)}
links = ${JSON.stringify(facadeLinksName(product))}
build = "build.rs"
include = ${JSON.stringify(['Cargo.toml', 'README.md', 'build.rs', 'src/**', ...legalMembers])}

[lib]
path = "src/lib.rs"

[features]
${features.join('\n')}

[dependencies]
${optionalDependencies}

[build-dependencies]
${dependency('oliphaunt-build', api['build-dependencies']['oliphaunt-build'], false)}

${targetDependencies.join('\n\n')}

[workspace]
`,
  );
  writeFileSync(path.join(sourceDir, 'build.rs'), FACADE_BUILD_RS);
  writeFileSync(
    path.join(sourceDir, 'README.md'),
    `# ${product}

Target-selecting Cargo facade for ${sqlNames.length === 1 ? `the \`${sqlNames[0]}\` PostgreSQL extension` : `the PostgreSQL 18 contrib bundle (${sqlNames.length} exact SQL members)`}.

The default \`native\` feature selects the matching native artifact leaf.${
      nativeOnly
        ? ''
        : ` Use
\`default-features = false, features = ["wasix"]\` (or a host-specific
\`wasix-aot-*\` feature) for WASIX artifacts.`
    }
`,
  );
  writeFileSync(
    path.join(sourceDir, 'src/lib.rs'),
    `#![doc = include_str!("../README.md")]
#![deny(unsafe_op_in_unsafe_fn)]

${unsupportedNativeGuard}

pub const PRODUCT: &str = ${JSON.stringify(product)};
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const EXTENSION_SQL_NAMES: &[&str] = &[${sqlNames.map((sqlName) => JSON.stringify(sqlName)).join(', ')}];
${sqlNames.length === 1 ? `pub const EXTENSION_SQL_NAME: &str = ${JSON.stringify(sqlNames[0])};` : ''}

#[cfg(feature = "native")]
pub mod native {
    use super::{PRODUCT, VERSION};
    const PACKAGE: liboliphaunt_native_bindings::ExtensionPackage = liboliphaunt_native_bindings::ExtensionPackage {
        product: PRODUCT, version: VERSION, runtime_version: ${JSON.stringify(compatibility.nativeRuntimeVersion)},
        resources: include!(env!("OLIPHAUNT_EMBEDDED_RESOURCES_RS")),
    };
${sqlNames
  .map((sql) => {
    const foreign = metadata.memberContracts
      .find((member) => member.sqlName === sql)
      .dependencies.filter((name) => name !== 'plpgsql' && !sqlNames.includes(name))
      .map((name) => {
        const owner = ownerForSqlName(name, 'native');
        return `${owner.product.replaceAll('-', '_')}::native::${rustConstant(name)}`;
      });
    return `    pub const ${rustConstant(sql)}: liboliphaunt_native_bindings::Extension = liboliphaunt_native_bindings::Extension::${rustConstant(sql)}.with_package(&PACKAGE)${foreign.length ? `.with_dependencies(&[${foreign.join(', ')}])` : ''};`;
  })
  .join('\n')}
}
#[cfg(feature = "native")]
pub use native::*;
${
  wasixName === null
    ? ''
    : `
#[cfg(feature = "wasix")]
pub mod wasix {
    use super::{PRODUCT, VERSION};
    ${aotNames.map((name, index) => `#[cfg(${cfgForTriple(wasixAotTargets[index])})] use ${name.replaceAll('-', '_')} as aot;`).join('\n    ')}
    ${foreignAotNames.map(({ name, target, product }) => `#[cfg(${cfgForTriple(target)})] use ${name.replaceAll('-', '_')} as ${foreignAotAlias(product)};`).join('\n    ')}
${foreignMembers
  .map((member) => {
    const constant = rustConstant(member.sqlName);
    return `    // SAFETY: resources retain their original qualified dependency owner and exact runtime pin.
    const DEPENDENCY_${constant}: oliphaunt_wasix::ExtensionPackage = unsafe {
        oliphaunt_wasix::ExtensionPackage::from_trusted_release(
            ${JSON.stringify(member.product)}, ${JSON.stringify(member.version)}, ${JSON.stringify(compatibility.wasixRuntimeVersion)},
            ${wasixExtensionPackageName(member.product).replaceAll('-', '_')}::ARCHIVES,
            ${member.install.nativeModules.length > 0 ? `${foreignAotAlias(member.product)}::${constant}_MANIFEST, ${foreignAotAlias(member.product)}::ARTIFACTS` : '"", &[]'},
        )
    }.with_install(${installArguments(member.sqlName, member.install)});`;
  })
  .join('\n')}
${sqlNames
  .map((sql) => {
    const constant = rustConstant(sql);
    return `    // SAFETY: these immutable AOT bytes are built and verified by this release's producer.
    const ${constant}_RESOURCES: oliphaunt_wasix::ExtensionPackage = unsafe {
        oliphaunt_wasix::ExtensionPackage::from_trusted_release(
            PRODUCT, VERSION, ${JSON.stringify(compatibility.wasixRuntimeVersion)},
            ${wasixName.replaceAll('-', '_')}::ARCHIVES,
            ${aotNames.length ? `aot::${constant}_MANIFEST, aot::ARTIFACTS` : '"", &[]'},
        )
    }.with_install(${installArguments(sql, installContracts.get(sql))});`;
  })
  .join('\n')}
${sqlNames
  .map((sql) => {
    const constant = rustConstant(sql);
    const dependencies = [
      ...sqlNames
        .filter((name) => name !== sql)
        .map((name) => `${rustConstant(name)}_RESOURCES.as_dependency(${JSON.stringify(name)})`),
      ...foreignMembers.map(
        (member) =>
          `DEPENDENCY_${rustConstant(member.sqlName)}.as_dependency(${JSON.stringify(member.sqlName)})`,
      ),
    ];
    return `    const ${constant}_PACKAGE: oliphaunt_wasix::ExtensionPackage = ${constant}_RESOURCES.with_dependencies(&[${dependencies.join(', ')}]);
    pub const ${constant}: oliphaunt_wasix::Extension = oliphaunt_wasix::Extension::${constant}.with_package(&${constant}_PACKAGE);`;
  })
  .join('\n')}
}
#[cfg(all(feature = "wasix", not(feature = "native")))]
pub use wasix::*;
`
}

`,
  );
  stageReleaseNotices(sourceDir, FACADE_NOTICE_OPTIONS);
  assertReleaseNoticesInDirectory(sourceDir, FACADE_NOTICE_OPTIONS);
  return { product, releaseProduct: nativeOwner, version, sourceDir };
}

export function packageExtensionCargoFacades(
  products,
  outputRoot,
  { metadataByProduct }: { metadataByProduct?: Record<string, ExtensionCargoFacadeMetadata> } = {},
) {
  const selected = [...new Set(products)].sort(compareText);
  if (selected.length !== products.length || selected.length === 0) {
    fail('products must be a non-empty duplicate-free list');
  }
  if (metadataByProduct !== undefined) {
    if (
      metadataByProduct === null ||
      Array.isArray(metadataByProduct) ||
      typeof metadataByProduct !== 'object' ||
      JSON.stringify(Object.keys(metadataByProduct).sort(compareText)) !==
        JSON.stringify(selected) ||
      selected.some(
        (product) =>
          metadataByProduct[product] === null ||
          Array.isArray(metadataByProduct[product]) ||
          typeof metadataByProduct[product] !== 'object',
      )
    ) {
      fail('declared facade metadata must exactly match the selected products');
    }
  }
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(path.join(outputRoot, 'crates'), { recursive: true });
  const packages = [];
  for (const product of selected) {
    const source = writeFacadeSource(product, outputRoot, {
      metadata: metadataByProduct?.[product],
    });
    const cratePath = packageGeneratedCargoSource(
      path.join(source.sourceDir, 'Cargo.toml'),
      path.join(outputRoot, 'crates'),
      {
        fail,
        rel: String,
      },
    );
    assertReleaseNoticesInArchive(cratePath, {
      ...FACADE_NOTICE_OPTIONS,
      prefix: path.basename(cratePath, '.crate'),
    });
    packages.push({
      product,
      name: product,
      version: source.version,
      cratePath,
      manifestPath: path.join(source.sourceDir, 'Cargo.toml'),
      kind: 'extension-facade',
    });
  }
  return packages;
}
