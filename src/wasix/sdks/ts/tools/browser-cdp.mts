type CdpResponse = { result?: { value?: string }; exceptionDetails?: unknown };

export function createCdpClient(
  webSocket: WebSocket,
  recordFailure: (failure: string) => void,
  deadline: number,
) {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }
  >();

  const rejectPending = (reason: string) => {
    const error = new Error(`Chrome DevTools Protocol connection ${reason}`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  webSocket.addEventListener('close', () => rejectPending('closed'));
  webSocket.addEventListener('error', () => rejectPending('failed'));

  webSocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (request !== undefined) {
        pending.delete(message.id);
        if (message.error === undefined) request.resolve(message.result);
        else
          request.reject(
            new Error(`Chrome DevTools Protocol error: ${JSON.stringify(message.error)}`),
          );
      }
      return;
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const failure = formatCdpException(message.params.exceptionDetails);
      recordFailure(failure);
      console.error(`browser exception: ${failure}`);
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const values = message.params.args.map(
        (argument: { value?: unknown; description?: string; type: string }) =>
          argument.value ?? argument.description ?? argument.type,
      );
      console.error(`browser console ${message.params.type}: ${values.join(' ')}`);
    } else if (message.method === 'Log.entryAdded') {
      console.error(`browser log ${message.params.entry.level}: ${message.params.entry.text}`);
    } else if (message.method === 'Target.attachedToTarget') {
      const sessionId = message.params.sessionId;
      void send('Runtime.enable', {}, sessionId).catch((error) => recordFailure(error.message));
      void send('Log.enable', {}, sessionId).catch((error) => recordFailure(error.message));
    }
  });

  function send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = nextId++;
    return new Promise<CdpResponse>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          rejectRequest(new Error(`Chrome DevTools Protocol ${method} timed out`));
        },
        Math.max(1, Math.min(30_000, deadline - Date.now())),
      );
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject(error) {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      try {
        webSocket.send(
          JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
        );
      } catch (cause) {
        pending.delete(id);
        clearTimeout(timer);
        rejectRequest(cause);
      }
    });
  }

  return { send };
}

function formatCdpException(details: {
  exception?: { description?: string; value?: unknown };
  text?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}) {
  const description = details.exception?.description ?? details.exception?.value ?? details.text;
  const location = details.url
    ? `${details.url}:${Number(details.lineNumber ?? 0) + 1}:${Number(details.columnNumber ?? 0) + 1}`
    : undefined;
  return [description, location].filter(Boolean).join('\n');
}
