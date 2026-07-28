import {
  EMPTY_TREE,
  ROOT,
  commitForRef,
  latestProductTag,
  productVersionTransitionStatus,
} from "./release-graph.mjs";

function policyError(prefix, message) {
  return new Error(`${prefix}: ${message}`);
}

function stableVersion(value, context, prefix) {
  const match = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$/u.exec(value);
  if (match === null) {
    throw policyError(prefix, `${context} must be a stable x.y.z version, got ${JSON.stringify(value)}`);
  }
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * Choose the immutable source of a compatibility field. A sink whose manifest
 * advances in the release commit follows the current source product. Every
 * unchanged released sink follows its own immutable current tag, regardless of
 * whether it is an extension, runtime, or SDK product.
 */
export function compatibilityVersionSource(
  entry,
  products,
  transitionedProducts,
  {
    root = ROOT,
    headRef = "HEAD",
    prefix = "compatibility-version-policy",
  } = {},
) {
  const sink = products[entry.product];
  if (sink === undefined) {
    throw policyError(prefix, `compatibility sink ${entry.product} is not a release product`);
  }
  if (sink.version === "0.0.0") {
    return { kind: "current-source", ref: null, tag: null };
  }
  const baseRef = latestProductTag(sink, headRef, prefix, root);
  const status = productVersionTransitionStatus(entry.product, sink, baseRef, headRef, {
    prefix,
    root,
  });
  if (status.currentTagCommit !== null) {
    const headCommit = commitForRef(headRef, root);
    if (transitionedProducts.has(entry.product)) {
      if (status.currentTagCommit !== headCommit) {
        throw policyError(
          prefix,
          `${entry.product} cannot advance to already-tagged immutable version ${sink.version} from ${status.currentTag}`,
        );
      }
      return { kind: "current-source", ref: null, tag: null };
    }
    return {
      kind: "tagged-sink",
      ref: status.currentTagCommit,
      tag: status.currentTag,
    };
  }

  if (transitionedProducts.has(entry.product)) {
    if (!status.eligible && !status.firstRelease) {
      throw policyError(
        prefix,
        `${entry.product} advanced in the current release commit without an eligible version transition`,
      );
    }
    return { kind: "current-source", ref: null, tag: null };
  }

  const prior = baseRef === EMPTY_TREE ? "no prior product tag" : `latest reachable tag ${baseRef}`;
  throw policyError(
    prefix,
    `${entry.product} version ${sink.version} has no immutable current-version tag and did not advance in the current release commit (${prior})`,
  );
}

export function requireCompatibilityVersionBinding(
  {
    id,
    value,
    expected,
    sourceProduct,
    sourceVersion,
    provenance,
  },
  { prefix = "compatibility-version-policy" } = {},
) {
  const valueParts = stableVersion(value, `${id} compatibility value`, prefix);
  const sourceParts = stableVersion(sourceVersion, `${sourceProduct} version`, prefix);
  stableVersion(expected, `${id} expected compatibility value`, prefix);
  if (compareVersions(valueParts, sourceParts) > 0) {
    throw policyError(
      prefix,
      `${id} compatibility value ${JSON.stringify(value)} cannot be newer than ${sourceProduct} ${sourceVersion}`,
    );
  }
  if (value !== expected) {
    throw policyError(
      prefix,
      `${id} compatibility value ${JSON.stringify(value)} must match ${provenance}`,
    );
  }
}
