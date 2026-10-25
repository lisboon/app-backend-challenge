import { deferred } from './async';
import { testInfra } from './http-app';

export interface SqsGate {
  endpoint: string;
  entered: () => boolean;
  release: () => void;
  close: () => Promise<void>;
}

export function gateSqs(action: string): SqsGate {
  const release = deferred();
  let entered = false;
  let stopped = false;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const body = await request.text();
      if (
        !entered &&
        request.headers.get('x-amz-target')?.endsWith('.' + action)
      ) {
        entered = true;
        await release.promise;
      }
      if (stopped) {
        return new Response('indisponível', { status: 503 });
      }
      const headers = new Headers(request.headers);
      headers.delete('host');
      return fetch(testInfra().sqsEndpoint + new URL(request.url).pathname, {
        method: request.method,
        headers,
        body,
      });
    },
  });
  return {
    endpoint: 'http://127.0.0.1:' + server.port,
    entered: () => entered,
    release: () => release.resolve(),
    close: async () => {
      stopped = true;
      release.resolve();
      await server.stop(true);
    },
  };
}
