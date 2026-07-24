const NATIVE_TARGET_CFG = Object.freeze({
  "linux-arm64-gnu": 'all(target_os = "linux", target_arch = "aarch64", target_env = "gnu")',
  "linux-x64-gnu": 'all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")',
  "macos-arm64": 'all(target_os = "macos", target_arch = "aarch64")',
  "windows-x64-msvc": 'all(target_os = "windows", target_arch = "x86_64", target_env = "msvc")',
});

function fail(message) {
  throw new Error(`rust-native-targets: ${message}`);
}

function nonEmptyUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    fail(`${label} must be a non-empty string list`);
  }
  if (!values.every((value) => typeof value === "string" && value.trim() === value && value.length > 0)) {
    fail(`${label} must contain only non-empty, trimmed strings`);
  }
  if (new Set(values).size !== values.length) {
    fail(`${label} must not contain duplicates`);
  }
  return values;
}

export function rustNativeTargetCfg(target) {
  const targetId = typeof target === "string" ? target : target?.target;
  if (typeof targetId !== "string" || !(targetId in NATIVE_TARGET_CFG)) {
    fail(`unsupported native Cargo target ${JSON.stringify(targetId)}`);
  }
  return NATIVE_TARGET_CFG[targetId];
}

export function assertSameNativeTargetSet(label, expected, actual) {
  const expectedTargets = [...nonEmptyUniqueStrings(expected, `${label} expected targets`)].sort();
  const actualTargets = [...nonEmptyUniqueStrings(actual, `${label} actual targets`)].sort();
  if (JSON.stringify(expectedTargets) !== JSON.stringify(actualTargets)) {
    fail(
      `${label} target mismatch: expected=${JSON.stringify(expectedTargets)}, `
      + `actual=${JSON.stringify(actualTargets)}`,
    );
  }
}

export function renderUnsupportedNativeTargetGuard({
  product,
  nativeTargets,
  nativeCfgs,
  feature = null,
  featureLabel = null,
  guidance,
}) {
  if (typeof product !== "string" || product.trim() !== product || product.length === 0) {
    fail("guard product must be a non-empty, trimmed string");
  }
  const targets = nonEmptyUniqueStrings(nativeTargets, `${product} guard targets`);
  const cfgs = nonEmptyUniqueStrings(nativeCfgs, `${product} guard cfgs`);
  if (targets.length !== cfgs.length) {
    fail(`${product} guard requires one cfg per declared target`);
  }
  if (feature !== null && (typeof feature !== "string" || feature.trim() !== feature || feature.length === 0)) {
    fail(`${product} guard feature must be null or a non-empty, trimmed string`);
  }
  if (featureLabel !== null && feature === null) {
    fail(`${product} guard cannot declare a feature label without a feature`);
  }
  if (typeof guidance !== "string" || guidance.trim() !== guidance || guidance.length === 0) {
    fail(`${product} guard guidance must be a non-empty, trimmed string`);
  }

  const unsupportedTarget = `not(any(${cfgs.join(", ")}))`;
  const condition = feature === null
    ? unsupportedTarget
    : `all(feature = ${JSON.stringify(feature)}, ${unsupportedTarget})`;
  const subject = feature === null
    ? product
    : `${product}'s ${featureLabel ?? `${feature} feature`}`;
  const message = `${subject} supports only ${targets.join(", ")}; ${guidance}`;
  return `#[cfg(${condition})]\ncompile_error!(${JSON.stringify(message)});`;
}
