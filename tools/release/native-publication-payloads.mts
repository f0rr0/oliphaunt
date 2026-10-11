/** Declared pre-envelope bytes; neither capture nor comparison grants release authority. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CompletedPublication } from './completed-release-publication.mts';
import type { NativeRoot, PhysicalShippingCohort } from './native-publication-artifacts.mts';
import {
  captureNativeOutputMembers,
  type NativeOutputMember,
} from './native-publication-staging.mts';

type Source = { commit: string; tree: string };
export interface NativePayloadProduct {
  id: string;
  version: string;
  roots: {
    label: string;
    executionRoot: string;
    name: string;
    configuration: string;
    role: string;
    outputs: { path: string; owner: string; members: NativeOutputMember[] }[];
  }[];
}
export interface NativePayloads {
  scope: 'construction';
  source: Source;
  products: NativePayloadProduct[];
}
export interface NativePayloadCohort extends PhysicalShippingCohort {
  source: Source;
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error('native payload requires a nonempty identity');
}
function source(value: Source) {
  if (![value?.commit, value?.tree].every((sha) => /^[0-9a-f]{40}$/u.test(sha ?? '')))
    throw new Error('native payload requires exact source SHA and tree');
}
function rootKey(root: { name: string; configuration: string; role: string }) {
  return canonical([root.name, root.configuration, root.role]);
}
export function nativePayloadDigest(product: NativePayloadProduct) {
  return createHash('sha256').update(canonical(product)).digest('hex');
}

/** Reads only supplied internal ShippingInfo outputs, never guessed source directories. */
export function captureNativePreEnvelopePayloads(
  cohorts: NativePayloadCohort[],
  { source: frozen, products }: { source: Source; products: { id: string; version: string }[] },
) {
  source(frozen);
  const observed = new Map<string, NativePayloadProduct>();
  for (const product of products) {
    nonempty(product.id);
    nonempty(product.version);
    if (observed.has(product.id)) throw new Error(`duplicate native payload product ${product.id}`);
    observed.set(product.id, { id: product.id, version: product.version, roots: [] });
  }
  const captures: ReturnType<typeof captureNativeOutputMembers>[] = [];
  for (const cohort of cohorts) {
    source(cohort.source);
    if (canonical(cohort.source) !== canonical(frozen))
      throw new Error('native payload cohort does not match the frozen source');
    for (const root of cohort.roots as NativeRoot[]) {
      const pkg = root.package;
      const product = observed.get(pkg.product);
      if (pkg.ecosystem !== 'internal' || !product) continue;
      if (pkg.version !== product.version)
        throw new Error(`native payload version disagrees for ${product.id}`);
      for (const value of [root.label, pkg.name, pkg.configuration, pkg.role]) nonempty(value);
      if (!Array.isArray(pkg.outputs) || !pkg.outputs.length)
        throw new Error(`native payload root has no declared outputs: ${root.label}`);
      if (product.roots.some((previous) => rootKey(previous) === rootKey(pkg)))
        throw new Error(`duplicate native payload root: ${product.id}:${rootKey(pkg)}`);
      const names = new Set<string>();
      const outputs = pkg.outputs.map((output) => {
        nonempty(output.owner);
        const name = path.posix.basename(output.path);
        if (names.has(name)) throw new Error(`ambiguous native payload output: ${root.label}`);
        names.add(name);
        const capture = captureNativeOutputMembers(cohort.executionRoot, output.path);
        captures.push(capture);
        return { ...output, members: capture.members };
      });
      product.roots.push({
        label: root.label,
        executionRoot: cohort.executionRoot,
        name: pkg.name,
        configuration: pkg.configuration,
        role: pkg.role,
        outputs: outputs.sort((a, b) => compareText(a.path, b.path)),
      });
    }
  }
  for (const product of observed.values())
    product.roots.sort((a, b) => compareText(rootKey(a), rootKey(b)));
  const payloads: NativePayloads = {
    scope: 'construction',
    source: { ...frozen },
    products: [...observed.values()].sort((a, b) => compareText(a.id, b.id)),
  };
  return {
    payloads,
    assertUnchanged() {
      for (const capture of captures) capture.assertUnchanged();
    },
  };
}

type DeliveryPayload = {
  name: string;
  configuration: string;
  role: string;
  outputs: { name: string; members: NativeOutputMember[] }[];
};
/**
 * Supplied by an authenticated origin/qualified-contract adapter, not by labels
 * or aquery. Physical modes can differ from the producer's declared shipping
 * modes; that adapter must provide the complete existing contract's mapping.
 */
export interface NativeDeliveryVerification {
  source: Source;
  product: string;
  version: string;
  payloadDigest: string;
  deliveredPayloads: DeliveryPayload[];
}
export interface NativeCompletedPayloadOrigin {
  publication: CompletedPublication;
  payloads: NativePayloads;
}

function deliveryShape(product: NativePayloadProduct): DeliveryPayload[] {
  return product.roots.map(({ name, configuration, role, outputs }) => ({
    name,
    configuration,
    role,
    outputs: outputs
      .map(({ path: output, members }) => ({
        name: path.posix.basename(output),
        members: [...members].sort((a, b) => compareText(a.path, b.path)),
      }))
      .sort((a, b) => compareText(a.name, b.name)),
  }));
}
function checkedDelivery(
  verification: NativeDeliveryVerification,
  product: NativePayloadProduct,
  frozen: Source,
) {
  if (
    !verification ||
    canonical(verification.source) !== canonical(frozen) ||
    verification.product !== product.id ||
    verification.version !== product.version ||
    verification.payloadDigest !== nativePayloadDigest(product) ||
    !Array.isArray(verification.deliveredPayloads)
  )
    throw new Error(
      'native delivery verification does not bind the captured product/source/payload',
    );
  const delivered = structuredClone(verification.deliveredPayloads);
  for (const root of delivered) {
    if (!Array.isArray(root.outputs)) throw new Error('native delivery contract is incomplete');
    for (const output of root.outputs) {
      if (!Array.isArray(output.members)) throw new Error('native delivery contract is incomplete');
      for (const member of output.members)
        if (!Number.isInteger(member.mode) || member.mode < 0 || member.mode > 0o777)
          throw new Error('native delivery contract has an invalid mode');
      output.members.sort((a, b) => compareText(a.path, b.path));
    }
    root.outputs.sort((a, b) => compareText(a.name, b.name));
  }
  delivered.sort((a, b) => compareText(rootKey(a), rootKey(b)));
  const withoutModes = (value) =>
    value.map((root) => ({
      ...root,
      outputs: root.outputs.map((output) => ({
        ...output,
        members: output.members.map(({ mode: _mode, ...member }) => member),
      })),
    }));
  if (canonical(withoutModes(delivered)) !== canonical(withoutModes(deliveryShape(product))))
    throw new Error(
      'native delivery contract must cover every captured member and its exact bytes',
    );
  return delivered;
}

function deliveryIdentity(payloads: DeliveryPayload[]) {
  return payloads.map((root) => ({
    ...root,
    // A singleton directory is rooted by its ShippingInfo identity. Its Bazel
    // wrapper is still bound above, but is not a delivered member inside it.
    // A regular File's basename remains part of its delivered identity.
    outputs: root.outputs.map((output) => ({
      ...output,
      name:
        root.outputs.length === 1 &&
        output.members.some((member) => member.path === '' && member.type === 'directory')
          ? ''
          : output.name,
    })),
  }));
}

/**
 * Input affectedness requests build/check work, not publication. Only qualified
 * delivered members can be compared to an authenticated completed origin.
 * Missing adapters are unknown. Even a conditional verdict retains construction
 * scope: the existing candidate/lock guard still forbids publication admission.
 */
export async function compareNativePreEnvelopeDelivery(
  current: NativePayloads,
  origins: Record<string, NativeCompletedPayloadOrigin>,
  {
    affectedProducts,
    verifyOrigin,
    verifyQualifiedCoverage,
  }: {
    affectedProducts?: string[];
    verifyOrigin?: (
      origin: NativeCompletedPayloadOrigin,
      product: NativePayloadProduct,
    ) => Promise<(NativeDeliveryVerification & { publication: CompletedPublication }) | undefined>;
    verifyQualifiedCoverage?: (
      current: NativePayloads,
      product: NativePayloadProduct,
    ) => Promise<NativeDeliveryVerification | undefined>;
  } = {},
) {
  source(current.source);
  if (current.scope !== 'construction')
    throw new Error('native payload comparison is construction');
  const results = [];
  const ids = [
    ...new Set([...current.products.map(({ id }) => id), ...Object.keys(origins)]),
  ].sort();
  for (const id of ids) {
    const product = current.products.find((product) => product.id === id);
    const origin = origins[id];
    const result = {
      product: id,
      affectedBuild:
        affectedProducts === undefined
          ? ('unknown' as const)
          : affectedProducts.includes(id)
            ? ('required' as const)
            : ('not-required' as const),
      necessaryDelivery: 'unknown' as 'needed' | 'not-needed' | 'unknown',
      reason: 'current-pre-envelope-roots-missing',
    };
    if (product?.roots.length) {
      result.reason = 'completed-origin-missing';
      const previous = origin?.payloads.products.find((product) => product.id === id);
      if (previous?.roots.length) {
        source(origin.payloads.source);
        if (
          origin.publication.product !== id ||
          origin.publication.version !== previous.version ||
          origin.publication.publicationSha !== origin.payloads.source.commit ||
          origin.publication.publicationTree !== origin.payloads.source.tree
        )
          throw new Error('native completed origin does not bind its product/source/payload');
        result.reason = 'completed-origin-unverified';
        const verifiedOrigin = await verifyOrigin?.(origin, previous);
        if (verifiedOrigin !== undefined) {
          if (canonical(verifiedOrigin.publication) !== canonical(origin.publication))
            throw new Error('native completed origin verification has a different publication');
          const before = checkedDelivery(verifiedOrigin, previous, origin.payloads.source);
          result.reason = 'qualified-delivery-contract-unverified';
          const qualified = await verifyQualifiedCoverage?.(current, product);
          if (qualified !== undefined) {
            const after = checkedDelivery(qualified, product, current.source);
            const same = canonical(deliveryIdentity(before)) === canonical(deliveryIdentity(after));
            result.necessaryDelivery = same ? 'not-needed' : 'needed';
            result.reason = same ? 'qualified-delivery-identical' : 'qualified-delivery-different';
          }
        }
      }
    }
    results.push(result);
  }
  return { scope: 'construction' as const, products: results };
}
