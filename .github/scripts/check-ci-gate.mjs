#!/usr/bin/env bun
import { env, exit } from 'node:process';

function fail(message) {
  console.error(message);
  exit(1);
}

function parseJsonEnv(name, fallback) {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`invalid ${name} JSON: ${error.message}`);
  }
}

function selectedJobs() {
  const jobs = parseJsonEnv('SELECTED_JOBS_JSON', []);
  if (!Array.isArray(jobs) || jobs.some((job) => typeof job !== 'string')) {
    fail('SELECTED_JOBS_JSON must be a JSON string array');
  }
  return [...new Set(jobs)].sort();
}

function requiredJobs() {
  const fromJson = parseJsonEnv('REQUIRED_JOBS_JSON', null);
  if (fromJson !== null) {
    if (!Array.isArray(fromJson) || fromJson.some((job) => typeof job !== 'string')) {
      fail('REQUIRED_JOBS_JSON must be a JSON string array');
    }
    return [...new Set(fromJson)].sort();
  }
  return (env.REQUIRED_JOBS ?? '')
    .split(',')
    .map((job) => job.trim())
    .filter(Boolean)
    .sort();
}

function needs() {
  const parsed = parseJsonEnv('NEEDS_JSON', {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('NEEDS_JSON must be a JSON object');
  }
  return parsed;
}

function resultFor(needsByJob, job) {
  const result = needsByJob[job]?.result;
  return typeof result === 'string' && result.length > 0 ? result : 'missing';
}

function checkJobs(jobs, { label }) {
  const needsByJob = needs();
  const failures = jobs
    .map((job) => [job, resultFor(needsByJob, job)])
    .filter(([, result]) => result !== 'success')
    .map(([job, result]) => `${job}=${result}`);

  if (failures.length > 0) {
    fail(`${label} failures: ${failures.join(', ')}`);
  }

  console.log(`${label} passed: ${jobs.length > 0 ? jobs.join(', ') : '(none selected)'}`);
}

const mode = process.argv[2] ?? '';
switch (mode) {
  case 'selected':
    checkJobs(selectedJobs(), { label: env.GATE_LABEL || 'selected jobs' });
    break;
  case 'required':
    checkJobs(requiredJobs(), { label: env.GATE_LABEL || 'required jobs' });
    break;
  default:
    fail('usage: check-ci-gate.mjs [selected|required]');
}
