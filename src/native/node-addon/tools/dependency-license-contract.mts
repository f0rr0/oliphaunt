#!/usr/bin/env bun
import { createRustDependencyLicenseContract } from '../../../../tools/packaging/rust-dependency-license-contract.mts';

export function createNodeDependencyLicenseContract(sourceRoot?: string) {
  return createRustDependencyLicenseContract({
    sourceRoot,
    owner: 'src/native/node-addon',
    product: 'oliphaunt-node-direct',
    payloadLicense: 'MIT AND ISC AND Unicode-3.0 AND BSD-3-Clause',
  });
}

const contract = createNodeDependencyLicenseContract();

export const {
  RUST_DEPENDENCY_LICENSE_ROOT,
  RUST_PAYLOAD_LICENSE,
  loadRustDependencyLicenseContract,
  rustDependencyLicenseMembers,
  stageRustDependencyLicenses,
  assertRustDependencyLicensesInDirectory,
  assertRustDependencyLicensesInEntries,
  assertRustDependencyLicensesInArchive,
} = contract;

if (import.meta.main) contract.runCli();
