import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  WINDOWS_VC_RUNTIME_DLLS,
  WINDOWS_VC_RUNTIME_PROFILES,
  WINDOWS_VC_RUNTIME_RECEIPT,
  inspectPortableExecutable,
  resolveInitializedVcRuntimeDirectory,
  stageWindowsVcRuntime,
  verifyWindowsVcRuntimeClosure,
} from "./windows-vc-runtime-closure.mjs";

function pe({ machine = 0x8664, imports = [], delayImports = [] } = {}) {
  const buffer = Buffer.alloc(0x800);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "binary");
  const coff = 0x84;
  buffer.writeUInt16LE(machine, coff);
  buffer.writeUInt16LE(1, coff + 2);
  buffer.writeUInt16LE(0xf0, coff + 16);
  const optional = coff + 20;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeBigUInt64LE(0x140000000n, optional + 24);
  buffer.writeUInt32LE(16, optional + 108);
  const directories = optional + 112;
  const section = optional + 0xf0;
  buffer.write(".rdata", section, "ascii");
  buffer.writeUInt32LE(0x600, section + 8);
  buffer.writeUInt32LE(0x1000, section + 12);
  buffer.writeUInt32LE(0x600, section + 16);
  buffer.writeUInt32LE(0x200, section + 20);

  let strings = 0x600;
  const writeName = (name) => {
    const offset = strings;
    buffer.write(`${name}\0`, offset, "ascii");
    strings += Buffer.byteLength(name) + 1;
    return 0x1000 + offset - 0x200;
  };
  if (imports.length > 0) {
    buffer.writeUInt32LE(0x1000, directories + 8);
    buffer.writeUInt32LE((imports.length + 1) * 20, directories + 12);
    imports.forEach((name, index) => buffer.writeUInt32LE(writeName(name), 0x200 + index * 20 + 12));
  }
  if (delayImports.length > 0) {
    const delayRva = 0x1200;
    buffer.writeUInt32LE(delayRva, directories + 13 * 8);
    buffer.writeUInt32LE((delayImports.length + 1) * 32, directories + 13 * 8 + 4);
    delayImports.forEach((name, index) => {
      const descriptor = 0x400 + index * 32;
      buffer.writeUInt32LE(1, descriptor);
      buffer.writeUInt32LE(writeName(name), descriptor + 4);
    });
  }
  return buffer.subarray(0, strings);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-vc-runtime-"));
  const redist = path.join(root, "redist");
  const source = path.join(redist, "x64/Microsoft.VC145.CRT");
  mkdirSync(source, { recursive: true });
  for (const name of WINDOWS_VC_RUNTIME_DLLS) {
    writeFileSync(path.join(source, name), pe({ imports: ["KERNEL32.dll"] }));
  }
  return { root, redist, source };
}

describe("Windows VC runtime dependency closure", () => {
  test("parses normal and delay-load imports without an external Windows tool", () => {
    const parsed = inspectPortableExecutable(pe({
      imports: ["VCRUNTIME140.dll"],
      delayImports: ["MSVCP140.dll"],
    }), "fixture");
    assert.equal(parsed.machine, 0x8664);
    assert.equal(parsed.magic, 0x20b);
    assert.deepEqual(parsed.imports, ["MSVCP140.dll", "VCRUNTIME140.dll"]);
  });

  test("the provider profile carries the exact supported-extension union", () => {
    const { root, redist } = fixture();
    try {
      const carrier = path.join(root, "carrier");
      const bin = path.join(carrier, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, "oliphaunt.dll"), pe({ imports: ["VCRUNTIME140.dll"] }));
      const result = stageWindowsVcRuntime({
        root: carrier,
        redistRoot: redist,
        destinations: [bin],
        profile: "provider",
      });
      assert.deepEqual(result.required, WINDOWS_VC_RUNTIME_PROFILES.provider);
      assert.deepEqual(
        readFileSync(path.join(bin, WINDOWS_VC_RUNTIME_RECEIPT), "utf8").trim().split("\n").map((line) => line.split("  ")[1]),
        WINDOWS_VC_RUNTIME_PROFILES.provider,
      );
      assert.throws(
        () => verifyWindowsVcRuntimeClosure({ root: carrier, searchRoots: [bin] }),
        /extra \[msvcp140\.dll, vcruntime140_1\.dll\]/u,
      );
      assert.deepEqual(
        verifyWindowsVcRuntimeClosure({ root: carrier, searchRoots: [bin], profile: "provider" }).required,
        WINDOWS_VC_RUNTIME_PROFILES.provider,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves exactly one initialized x64 CRT and atomically stages the audited union", () => {
    const { root, redist, source } = fixture();
    try {
      assert.equal(resolveInitializedVcRuntimeDirectory(redist), source);
      const first = path.join(root, "stage/bin");
      const second = path.join(root, "stage/runtime/bin");
      mkdirSync(path.join(root, "stage"), { recursive: true });
      writeFileSync(path.join(root, "stage/app.exe"), pe({ imports: ["VCRUNTIME140.dll"] }));
      stageWindowsVcRuntime({ root: path.join(root, "stage"), redistRoot: redist, destinations: [first, second] });
      stageWindowsVcRuntime({ root: path.join(root, "stage"), redistRoot: redist, destinations: [first, second] });
      assert.deepEqual(readFileSync(path.join(first, "vcruntime140.dll")), readFileSync(path.join(source, "vcruntime140.dll")));
      assert.deepEqual(readFileSync(path.join(second, "vcruntime140.dll")), readFileSync(path.join(source, "vcruntime140.dll")));
      assert.match(readFileSync(path.join(first, WINDOWS_VC_RUNTIME_RECEIPT), "utf8"), /^[0-9a-f]{64}  vcruntime140\.dll\n$/u);
      assert.equal(WINDOWS_VC_RUNTIME_DLLS.filter((name) => name !== "vcruntime140.dll").some((name) => readFileSync(path.join(first, WINDOWS_VC_RUNTIME_RECEIPT), "utf8").includes(name)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires the exact VC145 redistributable directory and x64 source DLLs", () => {
    const { root, redist, source } = fixture();
    try {
      rmSync(source, { recursive: true, force: true });
      const duplicate = path.join(redist, "x64/Microsoft.VC143.CRT");
      mkdirSync(duplicate, { recursive: true });
      for (const name of WINDOWS_VC_RUNTIME_DLLS) writeFileSync(path.join(duplicate, name), pe());
      assert.throws(() => resolveInitializedVcRuntimeDirectory(redist), /exactly one initialized/u);
      rmSync(duplicate, { recursive: true, force: true });
      mkdirSync(source, { recursive: true });
      for (const name of WINDOWS_VC_RUNTIME_DLLS) writeFileSync(path.join(source, name), pe());
      writeFileSync(path.join(source, WINDOWS_VC_RUNTIME_DLLS[0]), pe({ machine: 0x14c }));
      const carrier = path.join(root, "carrier");
      mkdirSync(carrier);
      writeFileSync(path.join(carrier, "app.exe"), pe({ imports: [WINDOWS_VC_RUNTIME_DLLS[0]] }));
      assert.throws(
        () => stageWindowsVcRuntime({ root: carrier, redistRoot: redist, destinations: [path.join(carrier, "bin")] }),
        /not an x64 PE32\+ image/u,
      );
      const pe32 = pe();
      pe32.writeUInt16LE(0x10b, 0x98);
      writeFileSync(path.join(source, WINDOWS_VC_RUNTIME_DLLS[0]), pe32);
      assert.throws(
        () => stageWindowsVcRuntime({ root: carrier, redistRoot: redist, destinations: [path.join(carrier, "bin")] }),
        /not an x64 PE32\+ image/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("atomically replaces a stale regular destination from the initialized toolchain", () => {
    const { root, redist, source } = fixture();
    try {
      const destination = path.join(root, "out");
      mkdirSync(destination);
      writeFileSync(path.join(destination, "app.exe"), pe({ imports: [WINDOWS_VC_RUNTIME_DLLS[0]] }));
      stageWindowsVcRuntime({ root: destination, redistRoot: redist, destinations: [destination] });
      writeFileSync(path.join(destination, WINDOWS_VC_RUNTIME_DLLS[0]), "tampered");
      stageWindowsVcRuntime({ root: destination, redistRoot: redist, destinations: [destination] });
      assert.deepEqual(
        readFileSync(path.join(destination, WINDOWS_VC_RUNTIME_DLLS[0])),
        readFileSync(path.join(source, WINDOWS_VC_RUNTIME_DLLS[0])),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("binary stripping cannot mutate redistributable bytes or invalidate their receipt", () => {
    if (process.platform === "win32") return;
    const { root, redist } = fixture();
    try {
      const carrier = path.join(root, "carrier");
      const bin = path.join(carrier, "bin");
      mkdirSync(bin, { recursive: true });
      const producer = path.join(bin, "app.exe");
      const runtime = path.join(bin, "vcruntime140.dll");
      const receipt = path.join(bin, WINDOWS_VC_RUNTIME_RECEIPT);
      writeFileSync(producer, pe({ imports: ["VCRUNTIME140.dll"] }));
      stageWindowsVcRuntime({ root: carrier, redistRoot: redist, destinations: [bin] });
      const runtimeBefore = readFileSync(runtime);
      const receiptBefore = readFileSync(receipt);
      const producerBefore = readFileSync(producer);
      const fakeStrip = path.join(root, "fake-strip.sh");
      writeFileSync(fakeStrip, "#!/bin/sh\nfor value do last=$value; done\nprintf X >> \"$last\"\n");
      chmodSync(fakeStrip, 0o755);
      const result = spawnSync(
        process.execPath,
        ["tools/release/strip_native_release_binaries.mjs", "--target", "windows-x64-msvc", carrier],
        {
          cwd: path.resolve(import.meta.dir, "../.."),
          env: { ...process.env, OLIPHAUNT_PE_STRIP: fakeStrip },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.notDeepEqual(readFileSync(producer), producerBefore);
      assert.deepEqual(readFileSync(runtime), runtimeBefore);
      assert.deepEqual(readFileSync(receipt), receiptBefore);
      assert.match(result.stderr, /preservedAppLocalVcRuntime=.*vcruntime140\.dll/u);
      verifyWindowsVcRuntimeClosure({ root: carrier, searchRoots: [bin] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a missing app-local DLL and an undeclared future VC runtime import", () => {
    const { root, redist } = fixture();
    try {
      const payload = path.join(root, "payload");
      const bin = path.join(payload, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, "postgres.exe"), pe({ imports: ["VCRUNTIME140.dll"] }));
      stageWindowsVcRuntime({ root: payload, redistRoot: redist, destinations: [bin] });
      assert.equal(verifyWindowsVcRuntimeClosure({ root: payload, searchRoots: [bin] }).inventory.length, 2);

      rmSync(path.join(bin, "vcruntime140.dll"));
      assert.throws(
        () => verifyWindowsVcRuntimeClosure({ root: payload, searchRoots: [bin] }),
        /is missing import-derived vcruntime140\.dll/u,
      );
      writeFileSync(path.join(bin, "vcruntime140.dll"), pe());
      writeFileSync(path.join(bin, "future.dll"), pe({ delayImports: ["MSVCP999.dll"] }));
      assert.throws(
        () => verifyWindowsVcRuntimeClosure({ root: payload, searchRoots: [bin] }),
        /imports undeclared or debug VC runtime MSVCP999\.dll/u,
      );
      rmSync(path.join(bin, "future.dll"));
      writeFileSync(path.join(bin, "debug.dll"), pe({ imports: ["ucrtbased.dll"] }));
      assert.throws(
        () => verifyWindowsVcRuntimeClosure({ root: payload, searchRoots: [bin] }),
        /imports undeclared or debug VC runtime ucrtbased\.dll/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
