import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  detectLinuxLibc,
  loadNativeWasixAddon,
  nativeTarget,
  optionalEnvironmentValue,
  type NativeWasixAddon,
  validateNativeWasixAddon,
} from '../native-addon.js';

const standardOverride = process.env.OLIPHAUNT_WASIX_NAPI;

afterEach(() => {
  restoreEnvironment('OLIPHAUNT_WASIX_NAPI', standardOverride);
});

describe('WASIX Node-API addon selection', () => {
  it('detects glibc and rejects musl before selecting a GNU carrier', () => {
    expect(
      detectLinuxLibc({ header: { glibcVersionRuntime: '2.38' }, sharedObjects: [] }, {}),
    ).toBe('glibc');
    expect(detectLinuxLibc({ header: {}, sharedObjects: ['/lib/ld-musl-x86_64.so.1'] }, {})).toBe(
      'musl',
    );
    expect(() => nativeTarget('linux', 'x64', 'musl')).toThrow(
      'Oliphaunt WASIX Node-API does not support Linux musl; install on a glibc-based system',
    );
    expect(nativeTarget('linux', 'x64', 'glibc')).toEqual({
      id: 'linux-x64-gnu',
      packageName: '@oliphaunt/wasix-napi-linux-x64-gnu',
      libc: 'glibc',
    });
    expect(detectLinuxLibc(undefined, {}, 'x86_64-unknown-linux-gnu')).toBe('glibc');
    expect(detectLinuxLibc(undefined, {}, 'x86_64-unknown-linux-musl')).toBe('musl');
  });

  it('fails closed when Linux libc cannot be identified', () => {
    expect(() => nativeTarget('linux', 'arm64', 'unknown')).toThrow(
      'Oliphaunt WASIX Node-API could not verify a supported Linux glibc runtime',
    );
  });

  it('fails closed when an explicit native addon is missing', () => {
    const missing = join(tmpdir(), `oliphaunt-missing-${process.pid}.node`);
    process.env.OLIPHAUNT_WASIX_NAPI = missing;

    expect(() => loadNativeWasixAddon()).toThrow(
      `OLIPHAUNT_WASIX_NAPI does not point to a regular file: ${missing}`,
    );
  });

  it('does not require Deno environment permission when no addon override is usable', () => {
    expect(
      optionalEnvironmentValue(
        'OLIPHAUNT_WASIX_NAPI',
        () => {
          const denied = new Error('Requires env access');
          denied.name = 'NotCapable';
          throw denied;
        },
        true,
      ),
    ).toBeUndefined();

    expect(() =>
      optionalEnvironmentValue('OLIPHAUNT_WASIX_NAPI', () => {
        throw new Error('unexpected environment failure');
      }),
    ).toThrow('unexpected environment failure');
  });

  it('requires the complete direct, actor, server, tool, stream, and profile surface', () => {
    const complete = addonFixture();
    expect(() => validateNativeWasixAddon(complete, '/fixture.node', metadata())).not.toThrow();

    const missingStream = addonFixture();
    Object.defineProperty(missingStream.NativeWasixDatabase.prototype, 'execProtocolRawStream', {
      configurable: true,
      value: undefined,
    });
    expect(() =>
      validateNativeWasixAddon(missingStream, '/missing-stream.node', metadata()),
    ).toThrow('invalid export surface');

    const missingActor = addonFixture() as unknown as {
      NativeWasixActorDatabase?: NativeWasixAddon['NativeWasixActorDatabase'];
    };
    delete missingActor.NativeWasixActorDatabase;
    expect(() =>
      validateNativeWasixAddon(missingActor as NativeWasixAddon, '/missing-actor.node', metadata()),
    ).toThrow('invalid export surface');

    const wrongProfiles = addonFixture();
    wrongProfiles.supportedProfiles = () => ['icu', 'standard'];
    expect(() => validateNativeWasixAddon(wrongProfiles, '/profiles.node', metadata())).toThrow(
      'incompatible catalog profiles',
    );
  });
});

function addonFixture(): NativeWasixAddon {
  class Database {
    readonly closed = false;
    static open(): Database {
      return new Database();
    }
    execProtocolRaw(): Uint8Array {
      return new Uint8Array();
    }
    execProtocolRawStream(): 'complete' {
      return 'complete';
    }
    backup(): Uint8Array {
      return new Uint8Array();
    }
    pgDump() {
      return { status: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
    }
    psql() {
      return { status: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
    }
    close(): void {}
  }
  class ActorDatabase {
    readonly closed = false;
    static async open(): Promise<ActorDatabase> {
      return new ActorDatabase();
    }
    async execProtocolRaw(): Promise<Uint8Array> {
      return new Uint8Array();
    }
    async execProtocolRawStream(): Promise<'complete'> {
      return 'complete';
    }
    async backup(): Promise<Uint8Array> {
      return new Uint8Array();
    }
    async pgDump() {
      return { status: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
    }
    async psql() {
      return { status: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
    }
    async close(): Promise<void> {}
  }
  class Server {
    readonly connectionString = 'postgresql://fixture';
    readonly closed = false;
    static async open(): Promise<Server> {
      return new Server();
    }
    async close(): Promise<void> {}
  }
  return {
    NativeWasixDatabase: Database,
    NativeWasixActorDatabase: ActorDatabase,
    NativeWasixServer: Server,
    async restore() {},
    restoreDirect() {},
    addonAbiVersion: () => 1,
    nodeApiVersion: () => 8,
    runtimeVersion: () => '0.1.1',
    supportedProfiles: () => ['standard', 'icu'],
    payloadIdentity: () => `${'a'.repeat(64)}:1`,
    extensionIdentity: () => `${'a'.repeat(64)}:1`,
    toolIdentity: () => `${'a'.repeat(64)}:1`,
  };
}

function metadata() {
  return {
    name: '@oliphaunt/wasix-ts',
    oliphaunt: {
      runtimeProduct: 'liboliphaunt-wasix',
      runtimeVersion: '0.1.1',
      wasixNapiProduct: 'oliphaunt-wasix-napi',
      wasixNapiVersion: '0.1.1',
      wasixAddonAbiVersion: 1,
      nodeApiVersion: 8,
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
