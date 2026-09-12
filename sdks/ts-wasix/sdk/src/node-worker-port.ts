import type { Worker } from 'node:worker_threads';

import type { WorkerResponse } from './rpc.js';
import type { WasixWorkerPort } from './worker-rpc.js';

/** @internal Adapt Node-compatible Worker events to the shared RPC transport. */
export function nodeWorkerPort(worker: Worker, runtimeName = 'Node'): WasixWorkerPort {
  let terminationRequested = false;
  let selfExitExpected = false;
  let selfExitResponseObserved = false;
  let exited = false;
  let messageListener: ((message: WorkerResponse) => void) | undefined;
  let fatalListener: ((error: Error) => void) | undefined;
  let fatalError: Error | undefined;
  let fatalDelivered = false;
  let exitFailure: Error | undefined;
  let resolveExit!: () => void;
  let rejectExit!: (error: Error) => void;
  const exit = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  // An unexpected Worker may never have an orderly waiter. Keep its rejected
  // exit promise observed while preserving it for expectSelfExit().
  void exit.catch(() => undefined);

  const fatal = (error: Error) => {
    if (terminationRequested || fatalError !== undefined) return;
    fatalError = error;
    deliverFatal();
  };
  const deliverFatal = () => {
    if (fatalDelivered || fatalError === undefined || fatalListener === undefined) return;
    fatalDelivered = true;
    fatalListener(fatalError);
  };
  const failExpectedExit = (error: Error) => {
    if (exitFailure !== undefined || exited) return;
    exitFailure = error;
    rejectExit(error);
  };

  worker.on('message', (message) => {
    if (selfExitExpected) selfExitResponseObserved = true;
    messageListener?.(message as WorkerResponse);
  });
  worker.on('messageerror', (error) => {
    const failure =
      error instanceof Error
        ? error
        : new Error(`Oliphaunt WASIX ${runtimeName} Worker returned an unreadable message`);
    if (selfExitExpected) {
      failExpectedExit(failure);
      if (!selfExitResponseObserved) fatal(failure);
    } else fatal(failure);
  });
  worker.on('error', (error) => {
    if (selfExitExpected) {
      failExpectedExit(error);
      if (!selfExitResponseObserved) fatal(error);
    } else fatal(error);
  });
  worker.on('exit', (code) => {
    exited = true;
    if (selfExitExpected) {
      if (exitFailure !== undefined) return;
      if (code === 0 && selfExitResponseObserved) resolveExit();
      else {
        const error = new Error(
          code === 0
            ? `Oliphaunt WASIX ${runtimeName} Worker self-exited before its shutdown reply`
            : `Oliphaunt WASIX ${runtimeName} Worker self-exited with code ${code}`,
        );
        rejectExit(error);
        if (!selfExitResponseObserved) fatal(error);
      }
      return;
    }
    if (terminationRequested) {
      resolveExit();
      return;
    }
    fatal(new Error(`Oliphaunt WASIX ${runtimeName} Worker exited unexpectedly with code ${code}`));
  });

  return {
    supportsSharedMemory: true,
    postMessage(message, transfer): void {
      if (exited) throw new Error(`Oliphaunt WASIX ${runtimeName} Worker is closed`);
      worker.postMessage(message, transfer as readonly ArrayBuffer[]);
    },
    expectSelfExit(): Promise<void> {
      selfExitExpected = true;
      return exit;
    },
    async terminate(): Promise<void> {
      terminationRequested = true;
      // An observed exit is the Node-compatible Worker's completed teardown
      // contract. Bun 1.3 does not settle terminate() after that event, so
      // reserve forced termination for startup/fatal cleanup before exit.
      if (exited) return;
      await worker.terminate();
    },
    onMessage(listener): void {
      messageListener = listener;
    },
    onFatal(listener): void {
      fatalListener = listener;
      deliverFatal();
    },
  };
}
