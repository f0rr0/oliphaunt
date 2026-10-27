import { IOS_CARRIER_FILENAME } from '../../swift/tools/swift-native-carrier-contract.mts';

/** Shared conventional and Bazel public-package attachment; carrier bytes stay separate. */
export function attachReactNativeCarrierManifest(manifest) {
  return {
    ...manifest,
    oliphaunt: {
      ...(manifest.oliphaunt ?? {}),
      iosCarrierManifest: `./${IOS_CARRIER_FILENAME}`,
    },
    files: [...new Set([...(manifest.files ?? []), IOS_CARRIER_FILENAME])],
    exports: {
      ...(manifest.exports ?? {}),
      './ios-carriers': `./${IOS_CARRIER_FILENAME}`,
    },
  };
}
