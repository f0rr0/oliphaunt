#!/usr/bin/env bun
import {existsSync, readFileSync} from 'node:fs';
import process from 'node:process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseJson(raw, source) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`invalid ${source} JSON: ${error.message}`);
  }
}

function plannedTargetsJson() {
  const envJson = process.env.OLIPHAUNT_CI_JOB_TARGETS_JSON;
  if (envJson) {
    return parseJson(envJson, 'OLIPHAUNT_CI_JOB_TARGETS_JSON');
  }

  const planPath = 'target/graph/ci-plan.json';
  if (!existsSync(planPath)) {
    fail('missing OLIPHAUNT_CI_JOB_TARGETS_JSON or target/graph/ci-plan.json');
  }

  const plan = parseJson(readFileSync(planPath, 'utf8'), planPath);
  return plan.job_targets ?? {};
}

const job = process.argv[2] ?? '';
if (!job) {
  fail('usage: select-planned-moon-targets.mjs <job-id>');
}

const mapping = plannedTargetsJson();
const targets = mapping?.[job] ?? [];
if (!Array.isArray(targets) || targets.some((target) => typeof target !== 'string')) {
  fail(`CI job ${JSON.stringify(job)} has invalid target list`);
}
for (const target of targets) {
  console.log(target);
}
