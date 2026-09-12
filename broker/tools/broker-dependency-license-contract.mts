#!/usr/bin/env bun
import { createRustDependencyLicenseContract } from '../../tools/packaging/rust-dependency-license-contract.mts';
const contract = createRustDependencyLicenseContract({
  owner: 'broker',
  product: 'oliphaunt-broker',
  payloadLicense: 'MIT AND ISC AND Unicode-3.0 AND BSD-3-Clause',
  noticeProfile: 'broker',
});
export const {
  RUST_DEPENDENCY_LICENSE_ROOT: BROKER_DEPENDENCY_LICENSE_ROOT,
  RUST_PAYLOAD_LICENSE: BROKER_PAYLOAD_LICENSE,
  isAllowedRustPathPackageMetadataRow: isAllowedBrokerPathPackageMetadataRow,
  hasCanonicalRustFilesystemMode: hasCanonicalBrokerFilesystemMode,
  hasSafeRustSourceFilesystemMode: hasSafeBrokerSourceFilesystemMode,
  loadRustDependencyLicenseContract: loadBrokerDependencyLicenseContract,
  rustDependencyLicenseMembers: brokerDependencyLicenseMembers,
  normalizeRustDependencyLicenseModes: normalizeBrokerDependencyLicenseModes,
  stageRustDependencyLicenses: stageBrokerDependencyLicenses,
  assertRustDependencyLicensesInDirectory: assertBrokerDependencyLicensesInDirectory,
  assertRustDependencyLicensesInEntries: assertBrokerDependencyLicensesInEntries,
  assertRustDependencyLicensesInArchive: assertBrokerDependencyLicensesInArchive,
} = contract;
if (import.meta.main) contract.runCli();
