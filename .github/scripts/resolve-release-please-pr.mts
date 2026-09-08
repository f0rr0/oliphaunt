#!/usr/bin/env bun

function candidateObjectsFromEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [];
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null && typeof item === 'object');
  }
  if (value !== null && typeof value === 'object') {
    return [value];
  }
  return [];
}

function pullRequestNumber(item) {
  const value = item.number ?? item.pullRequestNumber;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

const candidates = [
  ...candidateObjectsFromEnv('RELEASE_PLEASE_PR'),
  ...candidateObjectsFromEnv('RELEASE_PLEASE_PRS'),
];

for (const item of candidates) {
  const number = pullRequestNumber(item);
  if (number !== undefined) {
    console.log(number);
    process.exit(0);
  }
}
