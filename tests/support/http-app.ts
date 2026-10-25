import { INestApplication, ModuleMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { AppConfig } from '../../src/infra/config/app-config';
import { APP_CONFIG } from '../../src/infra/config/config.module';
import { AppModule } from '../../src/infra/http/app.module';

export const WAGER_QUEUE_NAME = 'wager-transactions.fifo';
export const WAGER_DLQ_NAME = 'wager-transactions-dlq.fifo';
export const EVENTS_QUEUE_NAME = 'wallet-events.fifo';

export interface TestInfra {
  databaseUrl: string;
  sqsEndpoint: string;
  wagerQueueName: string;
  wagerDeadLetterQueueName: string;
  eventsQueueName: string;
  pendingReferenceTtlSeconds?: number;
}

export function testInfra(): TestInfra {
  return {
    databaseUrl: required('TEST_DATABASE_URL'),
    sqsEndpoint: required('TEST_SQS_ENDPOINT'),
    wagerQueueName: WAGER_QUEUE_NAME,
    wagerDeadLetterQueueName: WAGER_DLQ_NAME,
    eventsQueueName: process.env.EVENTS_QUEUE_NAME ?? EVENTS_QUEUE_NAME,
  };
}

export interface RunningApp {
  app: INestApplication;
  baseUrl: string;
}

export function testAppConfig(overrides: Partial<TestInfra> = {}): AppConfig {
  const infra = { ...testInfra(), ...overrides };
  return {
    port: 0,
    workerMetricsPort: 0,
    outboxPollIntervalMs: 500,
    pendingReferencePollIntervalMs: 1000,
    pendingReferenceTtlSeconds: infra.pendingReferenceTtlSeconds ?? 3600,
    consumerRetryBaseSeconds: 1,
    consumerConcurrency: 10,
    databaseUrl: infra.databaseUrl,
    sqs: {
      region: 'us-east-1',
      endpoint: infra.sqsEndpoint,
      wagerQueueName: infra.wagerQueueName,
      wagerDeadLetterQueueName: infra.wagerDeadLetterQueueName,
      eventsQueueName: infra.eventsQueueName,
    },
  };
}

export async function startApp(
  overrides: Partial<TestInfra> = {},
  extra: Pick<ModuleMetadata, 'controllers'> = {},
): Promise<RunningApp> {
  const config = testAppConfig(overrides);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extra.controllers ?? [],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0);
  return { app, baseUrl: await app.getUrl() };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} ausente: o bun test carrega .env.test`);
  }
  return value;
}
