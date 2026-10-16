import type { Worker } from 'node:worker_threads';

import {
  loadNativeWasixAddon,
  supportsNativeWorkerOutput,
  type NativeWasixToolChunk,
  type NativeWasixToolOutputHandle,
} from './native-addon.js';

import type { WorkerResponse } from '../../workers/rpc.js';
import type { WasixWorkerPort } from '../../workers/worker-rpc.js';

/** @internal Adapt Node-compatible Worker events to the shared RPC transport. */
export function nodeWorkerPort(worker: Worker, runtimeName = 'Node'): WasixWorkerPort {
  const outputs = new Map<
    number,
    {
      handle: NativeWasixToolOutputHandle;
      pending: Map<'stdout' | 'stderr', { sequence: number; packet: NativeWasixToolChunk }>;
    }
  >();
  const releaseOutput = (id: number) => {
    const output = outputs.get(id);
    outputs.delete(id);
    output?.handle.close();
  };
  const releaseOutputs = () => {
    for (const id of outputs.keys()) releaseOutput(id);
  };
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
    releaseOutputs();
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
    if (message !== null && typeof message === 'object' && !('kind' in message)) {
      releaseOutput(message.id);
    }
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
      if (message.method === 'toolOutputCredit') {
        const output = outputs.get(message.id);
        if (output !== undefined) {
          const pending = output.pending.get(message.stream);
          if (pending?.sequence === message.sequence) {
            output.pending.delete(message.stream);
            pending.packet.acknowledge(message.error);
          }
          return;
        }
      }
      if (message.method === 'runToolStream') {
        const addon = loadNativeWasixAddon();
        if (supportsNativeWorkerOutput(addon)) {
          const registration = addon.NativeWasixToolOutput!;
          const pending = new Map<
            'stdout' | 'stderr',
            { sequence: number; packet: NativeWasixToolChunk }
          >();
          const sequences = { stdout: 0, stderr: 0 };
          const receive = (stream: 'stdout' | 'stderr') => (packet: NativeWasixToolChunk) => {
            const sequence = ++sequences[stream];
            pending.set(stream, { sequence, packet });
            try {
              if (messageListener === undefined || fatalError !== undefined) {
                throw new Error('Oliphaunt WASIX Worker output owner is closed');
              }
              messageListener({
                id: message.id,
                kind: 'toolChunk',
                stream,
                sequence,
                value: packet.chunk,
              });
            } catch {
              pending.delete(stream);
              packet.acknowledge('Oliphaunt WASIX Worker output owner is closed');
            }
          };
          const handle = registration.open({
            stdout: receive('stdout'),
            ...(message.stderr ? { stderr: receive('stderr') } : {}),
          });
          outputs.set(message.id, { handle, pending });
          try {
            worker.postMessage(
              { ...message, nativeOutputRegistration: handle.id },
              transfer as readonly ArrayBuffer[],
            );
          } catch (error) {
            releaseOutput(message.id);
            throw error;
          }
          return;
        }
      }
      worker.postMessage(message, transfer as readonly ArrayBuffer[]);
    },
    expectSelfExit(): Promise<void> {
      selfExitExpected = true;
      return exit;
    },
    async terminate(): Promise<void> {
      terminationRequested = true;
      releaseOutputs();
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
