import { describe, expect, it } from 'bun:test';

import {
  InvalidConfigError,
  loadConfig,
} from '../../../src/infra/config/app-config';

const valid = {
  PORT: '3000',
  DATABASE_URL: 'postgresql://wager:segredo@db:5432/wager',
  AWS_REGION: 'us-east-1',
  SQS_ENDPOINT: 'http://sqs:4566',
  WAGER_QUEUE_NAME: 'wager-transactions.fifo',
  WAGER_DLQ_NAME: 'wager-transactions-dlq.fifo',
  EVENTS_QUEUE_NAME: 'wallet-events.fifo',
};

const problemsOf = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      return [...error.problems];
    }
    throw error;
  }
  throw new Error('deveria ter recusado a configuração');
};

describe('loadConfig', () => {
  it('lê TTL e polling próprios de referências pendentes', () => {
    const config = loadConfig({
      ...valid,
      PENDING_REFERENCE_TTL_SECONDS: '60',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '40',
    });
    expect(config.pendingReferenceTtlSeconds).toBe(60);
    expect(config.pendingReferencePollIntervalMs).toBe(40);
  });

  for (const name of [
    'PENDING_REFERENCE_TTL_SECONDS',
    'PENDING_REFERENCE_POLL_INTERVAL_MS',
  ]) {
    it.each(['0', '-1', '1.5', 'abc', '2147483648'])(
      `recusa ${name} inválido: %s`,
      (value) => {
        expect(problemsOf({ ...valid, [name]: value })).toEqual([
          `${name} deve ser inteiro entre 1 e 2147483647`,
        ]);
      },
    );
  }

  it('lê base de retry e concorrência do consumidor', () => {
    const config = loadConfig({
      ...valid,
      CONSUMER_RETRY_BASE_SECONDS: '1',
      CONSUMER_CONCURRENCY: '3',
    });
    expect(config.consumerRetryBaseSeconds).toBe(1);
    expect(config.consumerConcurrency).toBe(3);
  });

  it.each([
    ['CONSUMER_RETRY_BASE_SECONDS', '301', 'entre 1 e 300'],
    ['CONSUMER_RETRY_BASE_SECONDS', '0', 'entre 1 e 300'],
    ['CONSUMER_CONCURRENCY', '101', 'entre 1 e 100'],
    ['CONSUMER_CONCURRENCY', 'abc', 'entre 1 e 100'],
    ['DATABASE_POOL_MAX', '1', 'entre 2 e 200'],
    ['DATABASE_POOL_MAX', '201', 'entre 2 e 200'],
    ['DATABASE_POOL_MAX', 'abc', 'entre 2 e 200'],
  ])('recusa %s = %s', (name, value, range) => {
    expect(problemsOf({ ...valid, [name]: value })).toEqual([
      name + ' deve ser inteiro ' + range,
    ]);
  });

  it('lê o tamanho do pool do banco', () => {
    expect(
      loadConfig({ ...valid, DATABASE_POOL_MAX: '40' }).databasePoolMax,
    ).toBe(40);
  });

  it('aceita concorrência que deixa três conexões para os outros ciclos', () => {
    expect(
      loadConfig({
        ...valid,
        DATABASE_POOL_MAX: '15',
        CONSUMER_CONCURRENCY: '12',
      }).consumerConcurrency,
    ).toBe(12);
  });

  it('recusa concorrência que esgotaria o pool do banco', () => {
    expect(
      problemsOf({
        ...valid,
        DATABASE_POOL_MAX: '15',
        CONSUMER_CONCURRENCY: '13',
      }),
    ).toEqual([
      'CONSUMER_CONCURRENCY deve deixar 3 conexões de DATABASE_POOL_MAX para outbox, pendências e readiness',
    ]);
  });

  it('recusa DLQ que não é fila FIFO', () => {
    expect(problemsOf({ ...valid, WAGER_DLQ_NAME: 'dlq' })).toEqual([
      'WAGER_DLQ_NAME deve ser nome de fila FIFO',
    ]);
  });

  it('lê a configuração completa', () => {
    expect(loadConfig(valid)).toEqual({
      port: 3000,
      workerMetricsPort: 3001,
      outboxPollIntervalMs: 500,
      pendingReferencePollIntervalMs: 1000,
      pendingReferenceTtlSeconds: 3600,
      consumerRetryBaseSeconds: 2,
      consumerConcurrency: 10,
      databaseUrl: valid.DATABASE_URL,
      databasePoolMax: 15,
      sqs: {
        region: 'us-east-1',
        endpoint: 'http://sqs:4566',
        wagerQueueName: 'wager-transactions.fifo',
        wagerDeadLetterQueueName: 'wager-transactions-dlq.fifo',
        eventsQueueName: 'wallet-events.fifo',
      },
    });
  });

  it('usa a porta 3000 quando PORT não é informada', () => {
    expect(loadConfig({ ...valid, PORT: undefined }).port).toBe(3000);
  });

  it('sem SQS_ENDPOINT usa o endpoint padrão da AWS', () => {
    expect(
      loadConfig({ ...valid, SQS_ENDPOINT: '  ' }).sqs.endpoint,
    ).toBeUndefined();
  });

  it('lista todas as variáveis ausentes de uma vez', () => {
    expect(problemsOf({})).toEqual([
      'DATABASE_URL ausente',
      'AWS_REGION ausente',
      'WAGER_QUEUE_NAME ausente',
      'WAGER_DLQ_NAME ausente',
      'EVENTS_QUEUE_NAME ausente',
    ]);
  });

  it.each([['abc'], ['-1'], ['3.5'], ['70000']])('recusa PORT %s', (port) => {
    expect(problemsOf({ ...valid, PORT: port })).toEqual([
      'PORT deve ser inteiro entre 0 e 65535',
    ]);
  });

  it('recusa DATABASE_URL de outro banco sem expor a credencial', () => {
    const problems = problemsOf({
      ...valid,
      DATABASE_URL: 'mysql://root:segredo@db/wager',
    });

    expect(problems).toEqual([
      'DATABASE_URL deve usar o esquema postgres:// ou postgresql://',
    ]);
    expect(problems.join()).not.toContain('segredo');
  });

  it('lê as configurações do worker', () => {
    const config = loadConfig({
      ...valid,
      WORKER_METRICS_PORT: '4001',
      OUTBOX_POLL_INTERVAL_MS: '250',
    });
    expect(config.workerMetricsPort).toBe(4001);
    expect(config.outboxPollIntervalMs).toBe(250);
  });

  it.each(['0', '-1', '1.5', 'abc', '2147483648'])(
    'recusa intervalo de polling %s',
    (value) => {
      expect(problemsOf({ ...valid, OUTBOX_POLL_INTERVAL_MS: value })).toEqual([
        'OUTBOX_POLL_INTERVAL_MS deve ser inteiro entre 1 e 2147483647',
      ]);
    },
  );

  it.each(['-1', '1.5', 'abc', '65536'])(
    'recusa porta do worker %s',
    (value) => {
      expect(problemsOf({ ...valid, WORKER_METRICS_PORT: value })).toEqual([
        'WORKER_METRICS_PORT deve ser inteiro entre 0 e 65535',
      ]);
    },
  );

  it.each(['eventos', 'com espaço.fifo', 'a'.repeat(76) + '.fifo'])(
    'recusa nome de fila de eventos %s',
    (value) => {
      expect(problemsOf({ ...valid, EVENTS_QUEUE_NAME: value })).toEqual([
        'EVENTS_QUEUE_NAME deve ser nome de fila FIFO',
      ]);
    },
  );
});
