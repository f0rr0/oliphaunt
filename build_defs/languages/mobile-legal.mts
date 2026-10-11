import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createMobileDependencyLicenseContract } from '../../src/native/mobile-bindings/tools/dependency-license-contract.mts';

const OWNER = 'src/native/mobile-bindings';
const REQUIRED = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'Cargo.lock',
  `${OWNER}/dependency-licenses.json`,
];
const LEGAL_INPUT = new RegExp(`^${OWNER}/dependency-license-blobs/[a-f0-9]{64}\\.base64$`);

/** Stage only the explicit, canonical legal inputs shared by both mobile SDKs. */
export function stageMobileLegalSources(sources: Record<string, string>, sourceRoot: string) {
  assert.ok(path.isAbsolute(sourceRoot), 'Mobile legal source root must be absolute');
  assert.ok(sources && typeof sources === 'object' && !Array.isArray(sources));
  for (const member of REQUIRED)
    assert.equal(typeof sources[member], 'string', `Missing ${member}`);
  const contract = createMobileDependencyLicenseContract(sourceRoot);
  for (const [member, file] of Object.entries(sources)) {
    assert.ok(
      REQUIRED.includes(member) ||
        LEGAL_INPUT.test(member) ||
        member === `${OWNER}/tools/dependency-license-contract.mts`,
      `Unexpected legal source ${member}`,
    );
    assert.equal(typeof file, 'string');
    const physical = realpathSync(file);
    const stat = statSync(physical);
    assert.ok(
      stat.isFile() && contract.hasSafeRustSourceFilesystemMode(stat.mode),
      `Unsafe legal source ${member}`,
    );
    const destination = path.join(sourceRoot, member);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(physical, destination);
    chmodSync(destination, 0o644);
  }
  contract.loadRustDependencyLicenseContract({ auditLock: true });
  return contract;
}
