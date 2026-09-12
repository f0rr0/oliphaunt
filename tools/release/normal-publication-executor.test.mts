import { describe, expect, test } from 'bun:test';

import {
  collectNormalPublicationReceipts,
  executeCargoPublicationBatch,
  normalPublicationSchedule,
} from './normal-publication-executor.mts';

function operation(ecosystem, index, carrierId = `${ecosystem}:package-${index}`) {
  return {
    id: `carrier:${carrierId}`,
    kind: 'carrier',
    ecosystem,
    carrierId,
    dependencies: [],
    operationOrder: index,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function tokenFetch(methods, tokens = ['cargo-token']) {
  let tokenIndex = 0;
  return async (_url, init) => {
    methods.push(init.method);
    if (init.method === 'GET') return Response.json({ value: `jwt-${tokenIndex}` });
    if (init.method === 'POST')
      return Response.json({ token: tokens[tokenIndex++] ?? `token-${tokenIndex}` });
    return new Response('', { status: 200 });
  };
}

const tokenEnvironment = {
  GITHUB_ACTIONS: 'true',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.example/token',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
};

describe('normal publication executor', () => {
  test('collects exact per-operation receipts without omission, addition, duplication, or bootstrap replacement', () => {
    const cargo = operation('cargo', 0);
    const npm = operation('npm', 1);
    const maven = {
      id: 'maven:atomic-deployment',
      kind: 'maven-atomic-deployment',
      ecosystem: 'maven',
      carrierIds: ['maven:a', 'maven:b'],
      dependencies: [],
      operationOrder: 2,
    };
    const cargoReceipt = { id: cargo.carrierId, proof: 'bootstrap' };
    const npmReceipt = { id: npm.carrierId, proof: 'npm' };
    const mavenReceipts = maven.carrierIds.map((id) => ({ id, proof: 'maven' }));
    const plan = { operations: [cargo, npm, maven] };
    const collected = collectNormalPublicationReceipts({
      plan,
      initialReceipts: [cargoReceipt],
      operationResults: [undefined, npmReceipt, mavenReceipts],
    });
    expect([...collected.values()]).toEqual([cargoReceipt, npmReceipt, ...mavenReceipts]);
    expect(() =>
      collectNormalPublicationReceipts({
        plan,
        initialReceipts: [cargoReceipt],
        operationResults: [undefined, undefined, mavenReceipts],
      }),
    ).toThrow(/exact non-bootstrap carrier set/u);
    expect(() =>
      collectNormalPublicationReceipts({
        plan,
        initialReceipts: [cargoReceipt],
        operationResults: [cargoReceipt, npmReceipt, mavenReceipts],
      }),
    ).toThrow(/exact non-bootstrap carrier set/u);
    expect(() =>
      collectNormalPublicationReceipts({
        plan,
        initialReceipts: [cargoReceipt],
        operationResults: [undefined, npmReceipt, [mavenReceipts[0], mavenReceipts[0]]],
      }),
    ).toThrow(/duplicate registry receipt/u);
  });

  test('Cargo batches retain tokens until active uploads drain and stop peer-failure admission', async () => {
    const methods = [];
    const entered = deferred();
    const release = deferred();
    let aborted = false;
    const calls = [];
    const run = executeCargoPublicationBatch({
      operations: [operation('cargo', 0), operation('cargo', 1)],
      cargoVersionPublished: async () => false,
      isAborted: () => aborted,
      publishCarrier: async (operation, context) => {
        calls.push(operation.carrierId);
        expect(context.cargoToken).toBe('cargo-token');
        entered.resolve();
        await release.promise;
      },
      nowImpl: () => 1_000_000,
      tokenOptions: {
        env: tokenEnvironment,
        fetchImpl: tokenFetch(methods),
        maskImpl: () => {},
      },
    });
    await entered.promise;
    aborted = true;
    expect(methods).not.toContain('DELETE');
    release.resolve();
    await expect(run).rejects.toThrow('stopping Cargo admission');
    expect(calls).toEqual(['cargo:package-0']);
    expect(methods).toEqual(['GET', 'POST', 'DELETE']);
  });

  test('Cargo skips tokens for exact published carriers and enforces the token deadline', async () => {
    await executeCargoPublicationBatch({
      operations: [operation('cargo', 0)],
      cargoVersionPublished: async () => true,
      isAborted: () => false,
      publishCarrier: async (_operation, context) => expect(context.alreadyPublished).toBe(true),
      tokenOptions: {
        fetchImpl: () => {
          throw new Error('unexpected token request');
        },
      },
    });
    let now = 1_000_000;
    const methods = [];
    let published = 0;
    await expect(
      executeCargoPublicationBatch({
        operations: [operation('cargo', 0), operation('cargo', 1)],
        cargoVersionPublished: async () => false,
        isAborted: () => false,
        nowImpl: () => now,
        publishCarrier: async (_operation, context) => {
          published++;
          now = context.tokenDeadlineEpochMs;
        },
        tokenOptions: {
          env: tokenEnvironment,
          fetchImpl: tokenFetch(methods),
          maskImpl: () => {},
        },
      }),
    ).rejects.toThrow('batch expired');
    expect(published).toBe(1);
    expect(methods.at(-1)).toBe('DELETE');
  });

  test('the frozen schedule splits at cross-registry dependencies and rejects invalid bounds', () => {
    const cargo = operation('cargo', 0);
    const npm = { ...operation('npm', 1), dependencies: [cargo.id] };
    const next = { ...operation('cargo', 2), dependencies: [npm.id] };
    expect(normalPublicationSchedule({ operations: [cargo, npm, next] }).cargoBatches).toEqual([
      [0],
      [2],
    ]);
    expect(() => normalPublicationSchedule({ operations: [cargo] }, 0)).toThrow('batch size');
    expect(() =>
      normalPublicationSchedule({ operations: [{ ...cargo, dependencies: ['missing'] }] }),
    ).toThrow('unknown dependency');
  });
});
