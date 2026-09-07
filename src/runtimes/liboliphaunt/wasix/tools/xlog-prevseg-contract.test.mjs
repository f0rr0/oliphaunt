import assert from 'node:assert/strict';
import {access, readFile, readdir} from 'node:fs/promises';
import test from 'node:test';

const UINT64_MODULUS = 1n << 64n;
const UINT64_MASK = UINT64_MODULUS - 1n;
const WAL_SEGMENT_SIZES = Object.freeze(
  Array.from({length: 11}, (_, power) => 1n << BigInt(power + 20)),
);
const patchUrl = new URL(
  '../assets/build/postgres/patches/0030-oliphaunt-wasix-avoid-xlogwrite-prevseg-division.patch',
  import.meta.url,
);
const patchDirectoryUrl = new URL('../assets/build/postgres/patches/', import.meta.url);
const seriesUrl = new URL('../assets/build/postgres/patches/series', import.meta.url);
const sourceManifestUrl = new URL('../assets/build/postgres/source.toml', import.meta.url);

function uint64(value) {
  return value & UINT64_MASK;
}

function upstreamPrevLogSegNo(xlogRecPtr, segmentSize) {
  return uint64(xlogRecPtr - 1n) / segmentSize;
}

function cachedStartContainsPreviousByte(xlogRecPtr, segmentNumber, segmentSize) {
  const previousByte = uint64(xlogRecPtr - 1n);
  const segmentStart = segmentNumber * segmentSize;
  return uint64(previousByte - segmentStart) < segmentSize;
}

function wrappedExclusiveEndContainsPreviousByte(xlogRecPtr, segmentNumber, segmentSize) {
  const previousByte = uint64(xlogRecPtr - 1n);
  const segmentStart = segmentNumber * segmentSize;
  const segmentEnd = uint64(segmentStart + segmentSize);
  return previousByte >= segmentStart && previousByte < segmentEnd;
}

function assertEquivalent(xlogRecPtr, segmentNumber, segmentSize, label) {
  const expected = upstreamPrevLogSegNo(xlogRecPtr, segmentSize) === segmentNumber;
  const actual = cachedStartContainsPreviousByte(xlogRecPtr, segmentNumber, segmentSize);
  assert.equal(
    actual,
    expected,
    `${label}: xlrp=${xlogRecPtr} segno=${segmentNumber} segsize=${segmentSize}`,
  );
}

function xorshift64(seed) {
  let state = uint64(seed);
  return () => {
    state ^= uint64(state << 13n);
    state ^= state >> 7n;
    state ^= uint64(state << 17n);
    state = uint64(state);
    return state;
  };
}

test('0030 stays reserved after the unearned optimization is removed', async () => {
  await assert.rejects(access(patchUrl), (error) => error?.code === 'ENOENT');
  const [patchFiles, series, sourceManifest] = await Promise.all([
    readdir(patchDirectoryUrl),
    readFile(seriesUrl, 'utf8'),
    readFile(sourceManifestUrl, 'utf8'),
  ]);
  assert.deepEqual(
    patchFiles.filter((file) => file.startsWith('0030-')),
    [],
  );
  assert.doesNotMatch(series, /^0030-/mu);
  assert.doesNotMatch(sourceManifest, /"0030-[^"]+\.patch"/u);
});

test('a future unsigned-distance experiment matches upstream PrevLogSegNo', () => {
  const random = xorshift64(0x9e3779b97f4a7c15n);
  const endpointPointers = [0n, 1n, 2n, UINT64_MASK - 1n, UINT64_MASK];

  for (const segmentSize of WAL_SEGMENT_SIZES) {
    const segmentCount = UINT64_MODULUS / segmentSize;
    const lastSegment = segmentCount - 1n;
    const segmentNumbers = new Set([
      0n,
      1n,
      2n,
      lastSegment - 2n,
      lastSegment - 1n,
      lastSegment,
    ]);
    for (let index = 0; index < 256; index += 1) {
      segmentNumbers.add(random() % segmentCount);
    }

    for (const segmentNumber of segmentNumbers) {
      const segmentStart = segmentNumber * segmentSize;
      const previousByteOffsets = [
        -2n,
        -1n,
        0n,
        1n,
        segmentSize - 2n,
        segmentSize - 1n,
        segmentSize,
        segmentSize + 1n,
      ];
      for (const offset of previousByteOffsets) {
        const xlogRecPtr = uint64(segmentStart + offset + 1n);
        assertEquivalent(xlogRecPtr, segmentNumber, segmentSize, 'boundary');
      }
      for (const xlogRecPtr of endpointPointers) {
        assertEquivalent(xlogRecPtr, segmentNumber, segmentSize, 'uint64 endpoint');
      }
    }

    for (let index = 0; index < 4096; index += 1) {
      const xlogRecPtr = random();
      const segmentNumber = random() % segmentCount;
      assertEquivalent(xlogRecPtr, segmentNumber, segmentSize, 'random independent');

      const nearbySegment = random() % segmentCount;
      const nearbyStart = nearbySegment * segmentSize;
      const nearbyPreviousByte = uint64(
        nearbyStart + (random() % (segmentSize * 3n)) - segmentSize,
      );
      assertEquivalent(
        uint64(nearbyPreviousByte + 1n),
        nearbySegment,
        segmentSize,
        'random near-boundary',
      );
    }
  }
});

test('the retired exclusive-end bounds fail on the final uint64 segment', () => {
  for (const segmentSize of WAL_SEGMENT_SIZES) {
    const lastSegment = UINT64_MODULUS / segmentSize - 1n;
    assert.equal(upstreamPrevLogSegNo(0n, segmentSize), lastSegment);
    assert.equal(cachedStartContainsPreviousByte(0n, lastSegment, segmentSize), true);
    assert.equal(wrappedExclusiveEndContainsPreviousByte(0n, lastSegment, segmentSize), false);
    assert.equal(
      wrappedExclusiveEndContainsPreviousByte(UINT64_MASK, lastSegment, segmentSize),
      false,
    );
  }
});
