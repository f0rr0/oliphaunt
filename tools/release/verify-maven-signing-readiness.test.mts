import { expect, test } from 'bun:test';
import {
  normalizedGpgKeyId,
  publicKeyFingerprints,
  verifySigningStatus,
} from './verify-maven-signing-readiness.mts';

const primary = 'A'.repeat(40);
const subkey = 'B'.repeat(40);
test('Maven fingerprints require an exact primary signing key and matching public key', () => {
  const status = (signer, owner = signer) =>
    `[GNUPG:] VALIDSIG ${signer} 2026-07-20 0 4 0 1 10 00 ${owner}\n`;
  expect(verifySigningStatus(status(primary), '0x' + primary.slice(-16)).primaryFingerprint).toBe(
    primary,
  );
  expect(() => verifySigningStatus(status(primary), subkey)).toThrow('does not match');
  expect(() => verifySigningStatus(status(subkey, primary), primary)).toThrow(
    'primary OpenPGP key',
  );
  expect(() => verifySigningStatus(status(primary) + status(primary), primary)).toThrow(
    'expected one',
  );
  expect(() => normalizedGpgKeyId('release@example.invalid')).toThrow('8-64 hexadecimal');
  expect(
    publicKeyFingerprints(
      `pub:::::::::\nfpr:::::::::${primary}:\nsub:::::::::\nfpr:::::::::${subkey}:\n`,
    ),
  ).toEqual([primary]);
  expect(() => publicKeyFingerprints('pub:::::::::\nfpr:::::::::bad:\n')).toThrow(
    'invalid primary',
  );
});
