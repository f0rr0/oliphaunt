#!/usr/bin/env bun

const FULL_SHA = /^[0-9a-f]{40}$/u;

export function resolveReleaseSourceCommit({
  controlCommit,
  sourceCommit,
}, {
  prefix = "release-source-identity",
} = {}) {
  const control = String(controlCommit ?? "").trim();
  if (!FULL_SHA.test(control)) {
    throw new Error(`${prefix}: release control commit must be a full lowercase commit SHA`);
  }
  const configuredSource = String(sourceCommit ?? "").trim();
  const source = configuredSource || control;
  if (!FULL_SHA.test(source)) {
    throw new Error(
      `${prefix}: release source commit must be a full lowercase commit SHA when provided`,
    );
  }
  return source;
}
