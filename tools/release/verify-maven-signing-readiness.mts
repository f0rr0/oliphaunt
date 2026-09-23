import { readFileSync } from 'node:fs';

function error(message) {
  return new Error('Maven signing: ' + message);
}

export function normalizedGpgKeyId(keyId) {
  if (typeof keyId !== 'string') {
    throw error('Maven signing key ID must be a hexadecimal OpenPGP key ID or fingerprint');
  }
  const normalized = keyId.trim().replace(/^0x/iu, '').toUpperCase();
  if (!/^[0-9A-F]{8,64}$/u.test(normalized)) {
    throw error(
      'Maven signing key ID must be 8-64 hexadecimal characters, optionally prefixed by 0x',
    );
  }
  return normalized;
}

export function verifySigningStatus(status, keyId) {
  const signingKeyId = normalizedGpgKeyId(keyId);
  const validSignatures = status
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('[GNUPG:] VALIDSIG '));
  if (validSignatures.length !== 1) {
    throw error(
      `Maven signing preflight expected one valid signature, got ${validSignatures.length}`,
    );
  }
  const fingerprints = validSignatures[0]
    .trim()
    .split(/\s+/u)
    .filter((field) => /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/iu.test(field))
    .map((field) => field.toUpperCase());
  if (fingerprints.length === 0) {
    throw error('Maven signing preflight did not report a valid signature fingerprint');
  }
  const signerFingerprint = fingerprints[0];
  const primaryFingerprint = fingerprints.length > 1 ? fingerprints.at(-1) : signerFingerprint;
  if (signerFingerprint !== primaryFingerprint) {
    throw error(
      'Maven Central requires artifacts to be signed by the primary OpenPGP key, not a signing subkey',
    );
  }
  if (!primaryFingerprint.endsWith(signingKeyId)) {
    throw error(
      'configured Maven signing key ID does not match the verified signature fingerprint',
    );
  }
  return {
    signerFingerprint,
    primaryFingerprint,
  };
}

export function publicKeyFingerprints(listing) {
  const primaryFingerprints = [];
  let awaitingPrimaryFingerprint = false;
  for (const line of listing.split(/\r?\n/u)) {
    const fields = line.split(':');
    if (fields[0] === 'pub') {
      awaitingPrimaryFingerprint = true;
      continue;
    }
    if (fields[0] === 'sub') {
      awaitingPrimaryFingerprint = false;
      continue;
    }
    if (fields[0] === 'fpr' && awaitingPrimaryFingerprint) {
      const fingerprint = fields[9]?.toUpperCase() ?? '';
      if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u.test(fingerprint)) {
        throw error('published Maven signing key reported an invalid primary fingerprint');
      }
      primaryFingerprints.push(fingerprint);
      awaitingPrimaryFingerprint = false;
    }
  }
  if (primaryFingerprints.length === 0) {
    throw error('published Maven signing key did not contain a primary OpenPGP fingerprint');
  }
  return primaryFingerprints;
}

if (import.meta.main) {
  try {
    const [phase, file, key] = process.argv.slice(2);
    if (phase === '--key-id') console.log(normalizedGpgKeyId(file));
    else if (phase === '--signature')
      console.log(verifySigningStatus(readFileSync(file, 'utf8'), key).primaryFingerprint);
    else if (phase === '--public-key') {
      if (!publicKeyFingerprints(readFileSync(file, 'utf8')).includes(key))
        throw error('keyserver response did not contain the exact primary fingerprint');
    } else throw error('unknown signing data phase');
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}
