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

function plannedTargetsJson(environment = process.env) {
  const envJson = environment.OLIPHAUNT_CI_JOB_TARGETS_JSON;
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

export function plannedTargets(job, environment = process.env) {
  const targets = plannedTargetsJson(environment)?.[job] ?? [];
  if (!Array.isArray(targets) || targets.some((target) => typeof target !== 'string')) {
    throw new Error(`CI job ${JSON.stringify(job)} has invalid target list`);
  }
  return targets;
}

if (import.meta.main) {
  const job = process.argv[2] ?? '';
  if (!job) {
    fail('usage: select-planned-moon-targets.mjs <job-id>');
  }
  try {
    for (const target of plannedTargets(job)) {
      console.log(target);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
