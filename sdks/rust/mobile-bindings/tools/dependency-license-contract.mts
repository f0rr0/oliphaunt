import { createRustDependencyLicenseContract } from '../../../../tools/packaging/rust-dependency-license-contract.mts';

const contract = createRustDependencyLicenseContract({
  owner: 'sdks/rust/mobile-bindings',
  product: 'oliphaunt-mobile-bindings',
  payloadLicense: 'MIT AND ISC AND Unicode-3.0 AND BSD-3-Clause AND MPL-2.0',
  targets: [
    { id: 'android-arm64', cargoTarget: 'aarch64-linux-android' },
    { id: 'android-x86_64', cargoTarget: 'x86_64-linux-android' },
    { id: 'android-arm', cargoTarget: 'armv7-linux-androideabi' },
    { id: 'android-x86', cargoTarget: 'i686-linux-android' },
    { id: 'ios-arm64', cargoTarget: 'aarch64-apple-ios' },
    { id: 'ios-simulator-arm64', cargoTarget: 'aarch64-apple-ios-sim' },
    { id: 'macos-arm64', cargoTarget: 'aarch64-apple-darwin' },
  ],
});
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
