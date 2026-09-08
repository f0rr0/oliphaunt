import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('real GPG readiness signs, verifies, checks keyserver fallback, and cleans up on failure', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'maven-signing-shell.'));
  const home = path.join(scratch, 'keys');
  mkdirSync(home, { mode: 0o700 });
  const bin = path.join(scratch, 'bin');
  mkdirSync(bin);
  const runs = path.join(scratch, 'runs');
  mkdirSync(runs);
  const passphrase = 'fixture password';
  const gpg = (args, input) => {
    const result = spawnSync('gpg', ['--batch', '--homedir', home, ...args], {
      input,
      encoding: 'utf8',
      timeout: 15000,
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  try {
    gpg(
      [
        '--pinentry-mode',
        'loopback',
        '--passphrase-fd',
        '0',
        '--quick-generate-key',
        'Maven fixture <fixture@example.invalid>',
        'ed25519',
        'sign',
        '0',
      ],
      passphrase + '\n',
    );
    const fingerprint = publicKeyFingerprints(gpg(['--with-colons', '--list-keys']))[0];
    const privateKey = gpg(
      [
        '--pinentry-mode',
        'loopback',
        '--passphrase-fd',
        '0',
        '--armor',
        '--export-secret-keys',
        fingerprint,
      ],
      passphrase + '\n',
    );
    const publicFile = path.join(scratch, 'public.asc');
    writeFileSync(publicFile, gpg(['--armor', '--export', fingerprint]));
    const curlLog = path.join(scratch, 'requests');
    writeFileSync(
      path.join(bin, 'curl'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$MAVEN_CURL_LOG"
output=''
while [[ "$#" -gt 0 ]]; do
 if [[ "$1" == --output ]]; then output="$2"; shift 2; else url="$1"; shift; fi
done
[[ "$url" != *keyserver.ubuntu.com* ]] || exit 22
[[ "\${MAVEN_BAD_KEY:-}" != true ]] || { echo 'wrong public key' > "$output"; exit 0; }
cp "$MAVEN_PUBLIC_KEY" "$output"
`,
      { mode: 0o755 },
    );
    const environment = {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      RUNNER_TEMP: runs,
      MAVEN_CURL_LOG: curlLog,
      MAVEN_PUBLIC_KEY: publicFile,
      ORG_GRADLE_PROJECT_signingInMemoryKey: privateKey,
      ORG_GRADLE_PROJECT_signingInMemoryKeyId: fingerprint,
      ORG_GRADLE_PROJECT_signingInMemoryKeyPassword: passphrase,
    };
    const invoke = (env = {}) =>
      spawnSync('bash', [path.join(import.meta.dir, 'verify-maven-signing-readiness.sh')], {
        env: { ...environment, ...env },
        encoding: 'utf8',
        timeout: 20000,
      });
    const success = invoke();
    expect(success.status).toBe(0);
    expect(success.stdout).toContain(fingerprint);
    expect(success.stdout).toContain('keys.openpgp.org');
    expect(readdirSync(runs)).toEqual([]);
    const requests = readFileSync(curlLog, 'utf8').trim().split('\n');
    expect(requests.length).toBe(2);
    expect(requests.every((row) => row.includes('--max-time 15 --max-filesize 1048576'))).toBe(
      true,
    );
    const invalid = invoke({ MAVEN_BAD_KEY: 'true' });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('not verifiably published');
    expect(readdirSync(runs)).toEqual([]);
    const before = readFileSync(curlLog, 'utf8');
    expect(
      invoke({ ORG_GRADLE_PROJECT_signingInMemoryKeyPassword: 'wrong password' }).status,
    ).not.toBe(0);
    expect(readFileSync(curlLog, 'utf8')).toBe(before);
    expect(readdirSync(runs)).toEqual([]);
  } finally {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'all']);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30000);
