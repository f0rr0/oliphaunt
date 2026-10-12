/** Licensed application/device tools from the same selected Xcode/OS boundary. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import type { Component } from './host-sdk.mts';

export const APPLE_APP_TOOL_NAMES = [
  'actool',
  'ibtool',
  'codesign',
  'codesign_allocate',
  'ditto',
  'lipo',
  'swift-stdlib-tool',
  'simctl',
] as const;
export function captureAppleAppTools(developer: string, find: (name: string) => string) {
  const components: Component[] = [],
    tools: Record<string, string> = {},
    observations: Record<string, string> = {};
  for (const name of APPLE_APP_TOOL_NAMES) {
    const file = find(name),
      physical = realpathSync(file);
    assert(statSync(physical).isFile(), 'Licensed application tool must be a file: ' + name);
    if (name !== 'codesign' && name !== 'ditto')
      assert(
        physical.startsWith(realpathSync(developer) + '/'),
        'Application tool must come from the selected Xcode: ' + name,
      );
    const logical = 'tools/' + name;
    components.push({
      name: logical,
      path: file,
      resolvedPath: physical,
      directory: false,
      roles: [],
    });
    tools[name] = logical;
    observations[name + '_sha256'] = createHash('sha256')
      .update(readFileSync(physical))
      .digest('hex');
  }
  return { components, tools, observations };
}
