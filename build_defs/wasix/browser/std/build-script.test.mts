import { expect, test } from 'bun:test';
import { buildScriptDirectives } from './build-script.mts';

test('preserves native upstream cfg/check-cfg/env directives', () => {
  expect(
    buildScriptDirectives(
      'cargo::rustc-cfg=feature="mem"\ncargo:rustc-check-cfg=cfg(test)\ncargo:rustc-env=STD_ENV_ARCH=wasm32\ncargo:rerun-if-changed=build.rs\n',
    ),
  ).toEqual({
    flags: ['--cfg', 'feature="mem"', '--check-cfg', 'cfg(test)'],
    env: { STD_ENV_ARCH: 'wasm32' },
  });
});

test('fails closed when a source pin asks for a new native linker dependency', () => {
  expect(() => buildScriptDirectives('cargo:rustc-link-lib=external')).toThrow('Undeclared');
});
