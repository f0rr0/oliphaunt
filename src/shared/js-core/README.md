# Shared JavaScript Core

Canonical TypeScript helpers shared by the JavaScript, React Native, and WASIX
TypeScript SDKs through the private `@oliphaunt/js-core` workspace package.

SDK source imports this package directly. Moon builds its two exported modules
once in ESM and CommonJS formats before the dependent SDK tasks. npm packaging
bundles only those `dist/module` and `dist/commonjs` allowlists, so published
SDKs remain self-contained without committed source mirrors or unrelated
workspace files.
