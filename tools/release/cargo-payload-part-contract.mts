/** Shared canonical dynamic Cargo payload-part set validation. */
import { compareText } from './release-graph.mts';

function error(message) {
  return new Error(`publication-lock: ${message}`);
}

export function validateCargoPayloadPartSets(carriers) {
  const byId = new Map(carriers.map((carrier) => [carrier.id, carrier]));
  const partsByParent = new Map();
  for (const carrier of carriers) {
    if (carrier.role !== 'payload-part') {
      continue;
    }
    if (
      carrier.declared ||
      carrier.ecosystem !== 'cargo' ||
      typeof carrier.parentCarrier !== 'string'
    ) {
      throw error(`${carrier.id} has invalid dynamic Cargo payload-part metadata`);
    }
    const list = partsByParent.get(carrier.parentCarrier) ?? [];
    list.push(carrier);
    partsByParent.set(carrier.parentCarrier, list);
  }

  const parents = new Set(partsByParent.keys());
  for (const carrier of carriers) {
    if (carrier.ecosystem !== 'cargo' || carrier.role === 'payload-part') {
      continue;
    }
    if (
      (carrier.packageDependencies ?? []).some(
        (dependency) =>
          dependency.ecosystem === 'cargo' && dependency.name.startsWith(`${carrier.name}-part-`),
      )
    ) {
      parents.add(carrier.id);
    }
  }

  for (const parentId of [...parents].sort(compareText)) {
    const parent = byId.get(parentId);
    if (parent === undefined || parent.ecosystem !== 'cargo' || !parent.declared) {
      throw error(`dynamic Cargo payload parts require their declared parent carrier ${parentId}`);
    }
    const parts = [...(partsByParent.get(parentId) ?? [])].sort(
      (left, right) => left.part - right.part,
    );
    if (parts.length === 0 || parts.length > 999) {
      throw error(`${parentId} must have between 1 and 999 Cargo payload parts`);
    }
    const actualNumbers = parts.map((part) => part.part);
    const expectedNumbers = Array.from({ length: parts.length }, (_, index) => index + 1);
    if (JSON.stringify(actualNumbers) !== JSON.stringify(expectedNumbers)) {
      throw error(
        `${parentId} Cargo payload parts must be contiguous from part-001; found ${actualNumbers.map((part) => String(part).padStart(3, '0')).join(', ')}`,
      );
    }
    const actualIds = parts.map((part) => part.id).sort(compareText);
    const dependencyIds = (parent.packageDependencies ?? [])
      .filter(
        (dependency) =>
          dependency.ecosystem === 'cargo' && dependency.name.startsWith(`${parent.name}-part-`),
      )
      .map((dependency) => `cargo:${dependency.name}`)
      .sort(compareText);
    if (JSON.stringify(actualIds) !== JSON.stringify(dependencyIds)) {
      throw error(`${parentId} must depend on exactly its complete Cargo payload part set`);
    }
  }
}
