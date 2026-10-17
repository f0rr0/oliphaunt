import { platformCompatibilityContract } from '../../tools/release/platform-compatibility-policy.mts';

/** Compiler and packaging projections of the canonical public Apple contracts. */
export function appleDeploymentTargets(): Record<string, string> {
  const native = platformCompatibilityContract('macos-arm64').apple.platforms;
  const carrier = platformCompatibilityContract('ios-xcframework').apple.platforms;
  return {
    native_macos: native.macos.maximumMinimumOs.join('.'),
    package_macos: carrier.macos.maximumMinimumOs.join('.'),
    ios: carrier.ios.maximumMinimumOs.join('.'),
    ios_simulator: carrier.iosSimulator.maximumMinimumOs.join('.'),
  };
}
