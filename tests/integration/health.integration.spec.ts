import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { INestApplication, Logger } from '@nestjs/common';

import { RunningApp, startApp, TestInfra } from '../support/http-app';

const CLOSED_PORT = 'http://127.0.0.1:1';

describe('health (integração com PostgreSQL e LocalStack reais)', () => {
  const opened: INestApplication[] = [];

  const boot = async (
    overrides: Partial<TestInfra> = {},
  ): Promise<RunningApp> => {
    const running = await startApp(overrides);
    opened.push(running.app);
    return running;
  };

  const ready = async (
    baseUrl: string,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${baseUrl}/health/ready`);
    return { status: response.status, body: await response.json() };
  };

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((app) => app.close()));
  });

  it('live responde sem consultar dependências', async () => {
    const { baseUrl } = await boot({
      databaseUrl: 'postgresql://wager:wager@127.0.0.1:1/wager',
      sqsEndpoint: CLOSED_PORT,
    });
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'up' });
  });

  it('ready responde 200 com PostgreSQL e SQS alcançáveis', async () => {
    const { baseUrl } = await boot();

    expect(await ready(baseUrl)).toEqual({
      status: 200,
      body: { status: 'up', checks: { postgres: 'up', sqs: 'up' } },
    });
  });

  it('a app sobe com o PostgreSQL fora e ready aponta qual dependência caiu', async () => {
    const { baseUrl } = await boot({
      databaseUrl: 'postgresql://wager:wager@127.0.0.1:1/wager',
    });

    expect(await ready(baseUrl)).toEqual({
      status: 503,
      body: { status: 'down', checks: { postgres: 'down', sqs: 'up' } },
    });
  });

  it('ready responde 503 com o SQS fora', async () => {
    const { baseUrl } = await boot({ sqsEndpoint: CLOSED_PORT });

    expect(await ready(baseUrl)).toEqual({
      status: 503,
      body: { status: 'down', checks: { postgres: 'up', sqs: 'down' } },
    });
  });

  it('ready responde 503 quando a fila não foi provisionada', async () => {
    const { baseUrl } = await boot({ wagerQueueName: 'fila-inexistente.fifo' });

    expect((await ready(baseUrl)).body).toEqual({
      status: 'down',
      checks: { postgres: 'up', sqs: 'down' },
    });
  });

  it('ready também recusa a fila de eventos ausente', async () => {
    const { baseUrl } = await boot({
      eventsQueueName: 'eventos-inexistentes.fifo',
    });
    expect(await ready(baseUrl)).toEqual({
      status: 503,
      body: { status: 'down', checks: { postgres: 'up', sqs: 'down' } },
    });
  });

  it('loga a dependência e o código do erro sem expor a URL de conexão', async () => {
    const warnings: string[] = [];
    const spy = spyOn(Logger.prototype, 'warn').mockImplementation(
      (message: unknown) => {
        warnings.push(String(message));
      },
    );
    try {
      const { baseUrl } = await boot({
        databaseUrl: 'postgresql://wager:senha-secreta@127.0.0.1:1/wager',
        sqsEndpoint: CLOSED_PORT,
      });
      await ready(baseUrl);
    } finally {
      spy.mockRestore();
    }

    expect(warnings.sort()).toEqual([
      expect.stringMatching(/^postgres indisponível: \w+ ECONNREFUSED$/),
      expect.stringMatching(/^sqs indisponível: \w+ ECONNREFUSED$/),
    ]);
    expect(warnings.join()).not.toContain('senha-secreta');
  });

  it('dependência que aceita conexão e não responde vira down dentro do timeout', async () => {
    const silent = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });
    const warnings: string[] = [];
    const spy = spyOn(Logger.prototype, 'warn').mockImplementation(
      (message: unknown) => {
        warnings.push(String(message));
      },
    );
    try {
      const { baseUrl } = await boot({
        databaseUrl: `postgresql://wager:wager@127.0.0.1:${silent.port}/wager`,
        sqsEndpoint: `http://127.0.0.1:${silent.port}`,
      });
      const started = Date.now();
      const result = await ready(baseUrl);

      expect(result).toEqual({
        status: 503,
        body: { status: 'down', checks: { postgres: 'down', sqs: 'down' } },
      });
      expect(Date.now() - started).toBeLessThan(4000);
      expect(warnings.sort()).toEqual([
        expect.stringMatching(/^postgres indisponível: \w+: .*time/i),
        expect.stringMatching(/^sqs indisponível: \w+: .*time/i),
      ]);
    } finally {
      spy.mockRestore();
      silent.stop(true);
    }
  });
});
