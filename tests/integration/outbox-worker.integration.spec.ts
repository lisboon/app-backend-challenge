import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

import { deferred, eventually } from '../support/async';
import { openTestOrm, migrateFresh } from '../support/database';
import { testInfra } from '../support/http-app';
import {
  eventsQueue,
  receiveEvents,
  seedOutbox,
  testSqs,
} from '../support/outbox';
import { freePort, spawnWorker, testAppEnv } from '../support/process';

function gateSqs() {
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
        request.headers.get('x-amz-target')?.endsWith('.SendMessage')
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

describe('processo publicador da outbox', () => {
  let orm: MikroORM;

  const sqs = testSqs();
  let queue: Awaited<ReturnType<typeof eventsQueue>>;

  beforeAll(async () => {
    orm = await openTestOrm();
  });
  beforeEach(async () => {
    await migrateFresh(orm);
    queue = await eventsQueue(sqs);
  });
  afterEach(async () => {
    await queue.close();
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  const countPublished = async () =>
    Number(
      (
        await orm.em
          .fork()
          .execute<{ n: string }[]>(
            'select count(*)::text as n from outbox_messages where published_at is not null',
          )
      )[0].n,
    );

  const start = async (endpoint = testInfra().sqsEndpoint) => {
    const port = freePort();
    const child = spawnWorker({
      ...testAppEnv(0),
      SQS_ENDPOINT: endpoint,
      EVENTS_QUEUE_NAME: queue.name,
      WORKER_METRICS_PORT: String(port),
      OUTBOX_POLL_INTERVAL_MS: '50',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      await eventually(async () => {
        if (child.exitCode !== null) {
          throw new Error('worker terminou no boot: ' + (await stderr));
        }
        return (
          (
            await fetch('http://127.0.0.1:' + port + '/metrics').catch(
              () => undefined,
            )
          )?.status === 200
        );
      });
    } catch (error) {
      child.kill('SIGKILL');
      await child.exited;
      throw error;
    }
    return { child, stdout, stderr, port };
  };

  it('PostgreSQL indisponível mantém a identificação da falha no log do ciclo', async () => {
    const port = freePort();
    const child = spawnWorker({
      ...testAppEnv(0),
      DATABASE_URL: 'postgresql://wager:senha-secreta@127.0.0.1:1/wager',
      WORKER_METRICS_PORT: String(port),
      OUTBOX_POLL_INTERVAL_MS: '50',
    });
    const stdout = new Response(child.stdout).text();
    let errors = '';
    const stderr = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        errors += decoder.decode(chunk, { stream: true });
      }
      errors += decoder.decode();
    })();
    const failures = () =>
      errors
        .split('\n')
        .slice(0, -1)
        .map(
          (line) =>
            JSON.parse(line) as {
              message: { event?: string; errorCode?: string };
            },
        )
        .filter((line) => line.message.event === 'outbox_cycle_failed');
    try {
      await eventually(async () => failures().length > 0);
      expect(
        (await fetch('http://127.0.0.1:' + port + '/metrics')).status,
      ).toBe(200);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
      await stderr;
    }
    expect(new Set(failures().map((line) => line.message.errorCode))).toEqual(
      new Set(['InfrastructureUnavailableError']),
    );
    const output = errors + (await stdout);
    expect(output).not.toContain('senha-secreta');
    expect(output).not.toContain('postgresql://');
  });

  it('SIGKILL durante o lote libera locks e outro processo publica todos os eventos confirmados', async () => {
    const messages = await seedOutbox(orm, 5);
    const proxy = gateSqs();
    const first = await start(proxy.endpoint);
    try {
      await eventually(async () => proxy.entered());
      expect(await countPublished()).toBe(0);
      first.child.kill('SIGKILL');
      await first.child.exited;
    } finally {
      first.child.kill('SIGKILL');
      await proxy.close();
    }
    const second = await start();
    try {
      await eventually(async () => (await countPublished()) === 5);
      const received = await receiveEvents(sqs, queue.url, 5);
      expect(
        new Set(received.map((message) => JSON.parse(message.Body!).eventId)),
      ).toEqual(new Set(messages.map((message) => message.id)));
      const metrics = await fetch(
        'http://127.0.0.1:' + second.port + '/metrics',
      );
      expect(metrics.headers.get('content-type')).toBe(
        'text/plain; version=0.0.4; charset=utf-8',
      );
      const text = await metrics.text();
      expect(text).toContain(
        'outbox_published_total{event_type="WagerTransactionProcessed"} 5',
      );
      expect(text).toContain('outbox_lag_seconds 0');
    } finally {
      second.child.kill('SIGKILL');
      await second.child.exited;
    }
    const output = await second.stdout;
    expect(output).not.toContain('123456.78');
    const logs = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { message: unknown });
    expect(
      logs.some(
        (line) =>
          typeof line.message === 'object' &&
          line.message !== null &&
          (line.message as { event?: string }).event === 'outbox_published',
      ),
    ).toBe(true);
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'SIGTERM conclui o lote em andamento, não começa outro e sai com zero',
    async () => {
      await seedOutbox(orm, 101);
      const proxy = gateSqs();
      const worker = await start(proxy.endpoint);
      try {
        await eventually(async () => proxy.entered());
        worker.child.kill('SIGTERM');
        await Bun.sleep(50);
        expect(worker.child.exitCode).toBeNull();
        proxy.release();
        await eventually(async () => worker.child.exitCode !== null, 15_000);
        expect(await worker.child.exited).toBe(0);
        expect(await countPublished()).toBe(100);
        expect(await receiveEvents(sqs, queue.url, 100)).toHaveLength(100);
        expect(await worker.stdout).toContain('outbox_worker_stopped');
      } finally {
        worker.child.kill('SIGKILL');
        await proxy.close();
      }
    },
    30_000,
  );
});
