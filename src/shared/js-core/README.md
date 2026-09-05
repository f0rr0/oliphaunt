# Shared JavaScript Core

Canonical TypeScript helpers shared by the JavaScript, React Native, and WASIX
TypeScript SDKs through the private `@oliphaunt/js-core` workspace package.

Moon builds its ESM and CommonJS exports once. Published SDKs bundle that
minimal private package so registry consumers do not need another dependency.
