import type { NativeExtensionDescriptor } from '@oliphaunt/js-core/resources';
import { GENERATED_EXTENSION_METADATA } from './generated/extensions';

type ContribId = Extract<
  (typeof GENERATED_EXTENSION_METADATA)[number],
  { readonly runtimeBound: true }
>['id'];

/** Bundled contrib resources. Listing a value selects it; no SQL is executed. */
export const extensions: Readonly<Record<ContribId, NativeExtensionDescriptor>> = Object.freeze(
  Object.fromEntries(
    GENERATED_EXTENSION_METADATA.filter((row) => row.runtimeBound).map((row) => [
      row.id,
      Object.freeze({
        schema: 'oliphaunt-native-extension-v1' as const,
        sqlName: row.sqlName,
        product: row.artifactProduct,
        packageName: row.npmPackage,
      }),
    ]),
  ) as Record<ContribId, NativeExtensionDescriptor>,
);
