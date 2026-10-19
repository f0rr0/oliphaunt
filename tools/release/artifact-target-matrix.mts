import {
  allArtifactTargets,
  compareText,
  exactExtensionProducts,
  extensionArtifactTargets,
  extensionTargetIds,
  fail,
  liboliphauntAndroidAbi,
  liboliphauntNativeBuildRoot,
  liboliphauntNativeCiArtifactRoot,
} from './release-artifact-targets.mts';

const PREFIX = 'artifact-target-matrix';

function stringSet(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    fail(PREFIX, `${label} must be a JSON string list`);
  }
  return new Set(value);
}

function filterRuntimeMatrix(
  predicate,
  { nativeTarget = 'all', selectedTargets = undefined, label },
) {
  let include = liboliphauntNativeRuntimeMatrix().include.filter((item) => predicate(item.target));
  if (nativeTarget !== 'all') {
    include = include.filter((item) => item.target === nativeTarget);
  }
  if (selectedTargets !== undefined) {
    include = include.filter((item) => selectedTargets.has(item.target));
  }
  if (include.length === 0) {
    fail(PREFIX, `no published liboliphaunt-native ${label} targets matched the selected CI plan`);
  }
  return { include };
}

export function liboliphauntNativeRuntimeMatrix() {
  const include = allArtifactTargets(
    {
      product: 'liboliphaunt-native',
      kind: 'native-runtime',
    },
    PREFIX,
  ).map((target) => {
    if (!target.runner) {
      fail(PREFIX, `${target.id} must declare runner`);
    }
    return {
      target: target.target,
      runner: target.runner,
      'build-root': liboliphauntNativeBuildRoot(target.target),
      'ci-artifact-root': liboliphauntNativeCiArtifactRoot(target.target),
    };
  });
  if (include.length === 0) {
    fail(PREFIX, 'no published liboliphaunt-native native-runtime targets');
  }
  return { include };
}

export function liboliphauntNativeDesktopRuntimeMatrix(
  nativeTarget = 'all',
  selectedTargets = undefined,
) {
  return filterRuntimeMatrix((target) => /^(linux|macos|windows)-/u.test(target), {
    nativeTarget,
    selectedTargets,
    label: 'desktop',
  });
}

export function liboliphauntNativeAndroidRuntimeMatrix(
  nativeTarget = 'all',
  selectedTargets = undefined,
) {
  return filterRuntimeMatrix((target) => target.startsWith('android-'), {
    nativeTarget,
    selectedTargets,
    label: 'Android',
  });
}

export function liboliphauntNativeIosRuntimeMatrix(
  nativeTarget = 'all',
  selectedTargets = undefined,
) {
  return filterRuntimeMatrix((target) => target === 'ios-xcframework', {
    nativeTarget,
    selectedTargets,
    label: 'iOS',
  });
}

export function liboliphauntNativeRuntimeTargetsForSurface(surface) {
  const targets = allArtifactTargets(
    {
      product: 'liboliphaunt-native',
      kind: 'native-runtime',
      surface,
    },
    PREFIX,
  ).map((target) => target.target);
  if (targets.length === 0) {
    fail(PREFIX, `no published liboliphaunt-native native-runtime targets for surface ${surface}`);
  }
  return targets.sort(compareText);
}

export function reactNativeAndroidMobileAppMatrix(
  nativeTarget = 'all',
  selectedTargets = undefined,
) {
  const include = [];
  for (const target of allArtifactTargets(
    {
      product: 'liboliphaunt-native',
      kind: 'native-runtime',
      surface: 'react-native-android',
    },
    PREFIX,
  )) {
    if (nativeTarget !== 'all' && target.target !== nativeTarget) {
      continue;
    }
    if (selectedTargets !== undefined && !selectedTargets.has(target.target)) {
      continue;
    }
    include.push({
      target: target.target,
      abi: liboliphauntAndroidAbi(target.target),
      'build-root': liboliphauntNativeBuildRoot(target.target),
    });
  }
  if (include.length === 0) {
    const validTargets =
      liboliphauntNativeRuntimeTargetsForSurface('react-native-android').join(', ');
    fail(
      PREFIX,
      `no React Native Android app targets matched; expected one of: all, ${validTargets}`,
    );
  }
  include.sort((left, right) => compareText(left.target, right.target));
  return { include };
}

export function extensionArtifactsNativeMatrix(
  nativeTarget = 'all',
  selectedTargets = undefined,
  selectedProducts = undefined,
) {
  const runtimeTargets = new Map(
    allArtifactTargets(
      {
        product: 'liboliphaunt-native',
        kind: 'native-runtime',
      },
      PREFIX,
    )
      .filter((target) => target.extensionArtifacts)
      .map((target) => [target.target, target]),
  );
  const byTarget = new Map();
  for (const extensionTarget of extensionArtifactTargets({ family: 'native' }, PREFIX)) {
    if (selectedProducts !== undefined && !selectedProducts.has(extensionTarget.product)) {
      continue;
    }
    if (nativeTarget !== 'all' && extensionTarget.target !== nativeTarget) {
      continue;
    }
    if (selectedTargets !== undefined && !selectedTargets.has(extensionTarget.target)) {
      continue;
    }
    const runtimeTarget = runtimeTargets.get(extensionTarget.target);
    if (!runtimeTarget) {
      fail(
        PREFIX,
        `${extensionTarget.product} declares native extension target ${extensionTarget.target}, but liboliphaunt-native does not publish it`,
      );
    }
    if (!runtimeTarget.runner) {
      fail(PREFIX, `${runtimeTarget.id} must declare runner`);
    }
    const group = byTarget.get(extensionTarget.target) ?? {
      target: extensionTarget.target,
      runner: runtimeTarget.runner,
      buildRoot: liboliphauntNativeBuildRoot(extensionTarget.target),
      ciArtifactRoot: liboliphauntNativeCiArtifactRoot(extensionTarget.target),
      extensions: new Set(),
      sqlNames: new Set(),
    };
    group.extensions.add(extensionTarget.product);
    group.sqlNames.add(extensionTarget.sqlName);
    byTarget.set(extensionTarget.target, group);
  }
  const include = [...byTarget.values()].map((group) => {
    const extensions = [...group.extensions].sort(compareText);
    const sqlNames = [...group.sqlNames].sort(compareText);
    return {
      extensions_csv: extensions.join(','),
      sql_names_csv: sqlNames.join(','),
      extension_count: String(sqlNames.length),
      target: group.target,
      runner: group.runner,
      'build-root': group.buildRoot,
      'ci-artifact-root': group.ciArtifactRoot,
    };
  });
  if (include.length === 0) {
    const validTargets = extensionTargetIds({ family: 'native' }, PREFIX).join(', ');
    fail(
      PREFIX,
      `unknown native extension artifact target ${nativeTarget}; expected one of: all, ${validTargets}`,
    );
  }
  include.sort((left, right) => compareText(left.target, right.target));
  return { include };
}

export function extensionArtifactsWasixMatrix(wasmTarget = 'all', selectedProducts = undefined) {
  const byTarget = new Map();
  const extensionTargets = extensionArtifactTargets({ family: 'wasix' }, PREFIX);
  for (const target of allArtifactTargets(
    {
      product: 'liboliphaunt-wasix',
    },
    PREFIX,
  )) {
    if (target.kind !== 'wasix-runtime') {
      continue;
    }
    const extensionTargetId = target.target === 'portable' ? 'wasix-portable' : target.target;
    if (wasmTarget !== 'all' && target.target !== wasmTarget) {
      continue;
    }
    for (const declared of extensionTargets) {
      if (selectedProducts !== undefined && !selectedProducts.has(declared.product)) {
        continue;
      }
      if (declared.target !== extensionTargetId) {
        continue;
      }
      const group = byTarget.get(declared.target) ?? {
        target: declared.target,
        runner: target.runner ?? 'ubuntu-24.04',
        runtimeKind: target.kind,
        triple: target.triple ?? '',
        extensions: new Set(),
        sqlNames: new Set(),
      };
      group.extensions.add(declared.product);
      group.sqlNames.add(declared.sqlName);
      byTarget.set(declared.target, group);
    }
  }
  const include = [...byTarget.values()].map((group) => {
    const extensions = [...group.extensions].sort(compareText);
    const sqlNames = [...group.sqlNames].sort(compareText);
    return {
      extensions_csv: extensions.join(','),
      sql_names_csv: sqlNames.join(','),
      extension_count: String(sqlNames.length),
      target: group.target,
      runner: group.runner,
      'runtime-kind': group.runtimeKind,
      triple: group.triple,
    };
  });
  if (include.length === 0) {
    const validTargets = allArtifactTargets(
      {
        product: 'liboliphaunt-wasix',
      },
      PREFIX,
    )
      .filter((target) => target.kind === 'wasix-runtime')
      .map((target) => target.target)
      .join(', ');
    fail(
      PREFIX,
      `unknown WASIX extension artifact target ${wasmTarget}; expected one of: all, ${validTargets}`,
    );
  }
  include.sort((left, right) => compareText(left.target, right.target));
  return { include };
}

function wasixHostTargetMatrixRow(target) {
  if (!target.runner) {
    fail(PREFIX, `${target.id} must declare runner`);
  }
  if (!target.triple) {
    fail(PREFIX, `${target.id} must declare triple`);
  }
  if (!target.llvmUrl) {
    fail(PREFIX, `${target.id} must declare llvm_url`);
  }
  if (!target.llvmSha256 || !/^[0-9a-f]{64}$/u.test(target.llvmSha256)) {
    fail(PREFIX, `${target.id} must declare a lowercase 64-hex llvm_sha256`);
  }
  if (
    !Number.isSafeInteger(target.llvmBytes) ||
    target.llvmBytes < 1 ||
    target.llvmBytes > 2 * 1024 * 1024 * 1024
  ) {
    fail(PREFIX, `${target.id} must declare exact llvm_bytes between 1 and 2 GiB`);
  }
  return {
    os: target.runner,
    target: target.triple,
    target_id: target.target,
    llvm_url: target.llvmUrl,
    llvm_sha256: target.llvmSha256,
    llvm_bytes: target.llvmBytes,
  };
}

function releaseAssetPath(target, root) {
  const asset = target.asset;
  if (
    asset.includes('/') ||
    asset.includes('\\') ||
    (asset.match(/\{version\}/gu) ?? []).length !== 1 ||
    /[*?[\]]/u.test(asset)
  ) {
    fail(PREFIX, `${target.id} must declare one flat, versioned release asset name`);
  }
  return `${root}/${asset.replace('{version}', '*')}`;
}

export function liboliphauntWasixAotRuntimeMatrix(wasmTarget = 'all') {
  const include = [];
  for (const target of allArtifactTargets(
    {
      product: 'liboliphaunt-wasix',
      kind: 'wasix-aot-runtime',
    },
    PREFIX,
  )) {
    if (wasmTarget !== 'all' && !new Set([target.target, target.triple]).has(wasmTarget)) {
      continue;
    }
    include.push({
      ...wasixHostTargetMatrixRow(target),
      package: `liboliphaunt-wasix-aot-${target.triple}`,
      artifact: `liboliphaunt-wasix-runtime-aot-${target.target}`,
    });
  }
  if (include.length === 0) {
    const validTargets = allArtifactTargets(
      {
        product: 'liboliphaunt-wasix',
        kind: 'wasix-aot-runtime',
      },
      PREFIX,
    )
      .map((target) => target.target)
      .join(', ');
    fail(
      PREFIX,
      `unknown WASIX AOT runtime target ${wasmTarget}; expected one of: all, ${validTargets}`,
    );
  }
  include.sort((left, right) => compareText(left.target_id, right.target_id));
  return { include };
}

export function liboliphauntWasixPostmasterRuntimeMatrix() {
  const include = allArtifactTargets(
    {
      product: 'liboliphaunt-wasix-postmaster',
      kind: 'wasix-postmaster-runtime',
    },
    PREFIX,
  ).map((target) => ({
    ...wasixHostTargetMatrixRow(target),
    artifact: `liboliphaunt-wasix-postmaster-release-assets-${target.target}`,
    release_asset_path: releaseAssetPath(
      target,
      'target/oliphaunt-wasix-postmaster/release-assets',
    ),
  }));
  if (include.length === 0) {
    fail(PREFIX, 'WASIX postmaster CI matrix must contain at least one artifact target');
  }
  include.sort((left, right) => compareText(left.target_id, right.target_id));
  return { include };
}

export function brokerRuntimeMatrix(nativeTarget = 'all') {
  const matrix = {
    include: allArtifactTargets(
      {
        product: 'oliphaunt-broker',
        kind: 'broker-helper',
      },
      PREFIX,
    ).map((target) => {
      if (!target.runner) {
        fail(PREFIX, `${target.id} must declare runner`);
      }
      return {
        target: target.target,
        runner: target.runner,
      };
    }),
  };
  return filterDesktopRuntimeMatrix(matrix, nativeTarget, 'broker');
}

export function nodeDirectRuntimeMatrix(nativeTarget = 'all') {
  const matrix = {
    include: allArtifactTargets(
      {
        product: 'oliphaunt-node-direct',
        kind: 'node-direct-addon',
      },
      PREFIX,
    ).map((target) => {
      if (!target.runner) {
        fail(PREFIX, `${target.id} must declare runner`);
      }
      return {
        target: target.target,
        runner: target.runner,
      };
    }),
  };
  return filterDesktopRuntimeMatrix(matrix, nativeTarget, 'Node direct');
}

export function wasixNapiRuntimeMatrix(nativeTarget = 'all') {
  const matrix = {
    include: allArtifactTargets(
      {
        product: 'oliphaunt-wasix-napi',
        kind: 'wasix-napi-addon',
      },
      PREFIX,
    ).map((target) => {
      if (!target.runner) {
        fail(PREFIX, `${target.id} must declare runner`);
      }
      if (!target.triple) {
        fail(PREFIX, `${target.id} must declare triple`);
      }
      return {
        target: target.target,
        runner: target.runner,
        target_triple: target.triple,
      };
    }),
  };
  return filterDesktopRuntimeMatrix(matrix, nativeTarget, 'WASIX Node-API');
}

function filterDesktopRuntimeMatrix(matrix, nativeTarget, label) {
  if (matrix.include.length === 0) {
    fail(PREFIX, `no published ${label} targets`);
  }
  if (nativeTarget === 'all') {
    return matrix;
  }
  const include = matrix.include.filter((target) => target.target === nativeTarget);
  if (include.length === 0) {
    const validTargets = matrix.include.map((target) => target.target).join(', ');
    fail(PREFIX, `unknown ${label} target ${nativeTarget}; expected one of: all, ${validTargets}`);
  }
  return { include };
}
