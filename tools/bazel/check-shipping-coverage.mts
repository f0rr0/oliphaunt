#!/usr/bin/env bun
/** Read-only coverage check; never builds, selects releases or admits publication. */
import { readFileSync } from 'node:fs';
import { loadPublicationCatalog, resolveActualCarrier } from '../release/publication-catalog.mts';
import { expectedProductArtifactRows } from '../release/publication-lock.mts';
import { type ConfiguredShippingCohort, checkShippingCoverage } from './shipping-coverage.mts';

async function main() {
  const products: string[] = [];
  const cohorts: (ConfiguredShippingCohort & { executionRoot?: string })[] = [];
  let includeReleaseInputs = false;
  let physical = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--product') {
      const product = args[++index];
      if (!product || product.startsWith('--')) throw new Error('--product requires a product id');
      products.push(product);
    } else if (option === '--cohort') {
      const roots = args[++index];
      const graph = args[++index];
      if (!roots || !graph || roots.startsWith('--') || graph.startsWith('--'))
        throw new Error('--cohort requires roots.jsonl and aquery.json');
      cohorts.push({
        roots: readFileSync(roots, 'utf8')
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line)),
        aquery: JSON.parse(readFileSync(graph, 'utf8')),
      });
    } else if (option === '--execution-root') {
      const executionRoot = args[++index];
      const cohort = cohorts.at(-1);
      if (!executionRoot || executionRoot.startsWith('--') || !cohort || cohort.executionRoot)
        throw new Error('--execution-root requires one path for the preceding cohort');
      cohort.executionRoot = executionRoot;
    } else if (option === '--physical') {
      physical = true;
    } else if (option === '--release-inputs') {
      includeReleaseInputs = true;
    } else {
      throw new Error(
        `unknown argument ${option}; use [--product ID] --cohort roots.jsonl aquery.json [--release-inputs] [--physical --execution-root ROOT]`,
      );
    }
  }
  if (!cohorts.length) throw new Error('at least one actual configured cohort is required');
  if (!physical && cohorts.some((cohort) => cohort.executionRoot))
    throw new Error('--execution-root requires --physical');
  const catalog = loadPublicationCatalog('native-shipping-coverage');
  const selected = products.length
    ? new Set(products)
    : new Set(catalog.products.map(({ id }) => id));
  const authority = {
    catalog,
    artifactRows: expectedProductArtifactRows(
      catalog.products.filter(({ id }) => selected.has(id)),
    ),
    resolveCarrier: (ecosystem: string, name: string) =>
      resolveActualCarrier(catalog, ecosystem, name, 'native-shipping-coverage'),
  };
  const options = { products: products.length ? products : undefined };
  let report;
  if (physical) {
    const { readNativePublicationArtifacts } = await import(
      '../release/native-publication-artifacts.mts'
    );
    report = readNativePublicationArtifacts(
      authority,
      cohorts.map((cohort) => {
        if (!cohort.executionRoot)
          throw new Error(
            '--physical requires an explicit captured --execution-root for every cohort',
          );
        return { ...cohort, executionRoot: cohort.executionRoot };
      }),
      options,
    );
  } else {
    report = checkShippingCoverage(authority, cohorts, { ...options, includeReleaseInputs });
  }
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
