import { describe, expect, it } from 'bun:test';
import { Registry } from 'prom-client';

import { OutboxWorker } from '../../../src/infra/worker/outbox-worker';
import { PendingReferenceWorker } from '../../../src/infra/worker/pending-reference-worker';
import { eventually } from '../../support/async';
import { testAppConfig } from '../../support/http-app';

const LONG_INTERVAL_MS = 60_000;

const batches = (...attempted: number[]) => {
  const limits: number[] = [];
  return {
    limits,
    execute: async (input: { limit: number }) => {
      limits.push(input.limit);
      return { attempted: attempted.shift() ?? 0 };
    },
  };
};

const config = {
  ...testAppConfig(),
  workerMetricsPort: 0,
  outboxPollIntervalMs: LONG_INTERVAL_MS,
  pendingReferencePollIntervalMs: LONG_INTERVAL_MS,
};

describe('workers de polling', () => {
  it('outbox com lote cheio busca o próximo na hora e espera o intervalo depois do lote parcial', async () => {
    const publisher = batches(100, 100, 7);
    const worker = new OutboxWorker(publisher, config, new Registry());
    worker.onModuleInit();
    try {
      await eventually(async () => publisher.limits.length === 3, 2_000);
      await Bun.sleep(200);
      expect(publisher.limits).toEqual([100, 100, 100]);
    } finally {
      await worker.onModuleDestroy();
    }
  });

  it('pendências com lote cheio buscam o próximo na hora e esperam o intervalo depois do lote parcial', async () => {
    const resolver = batches(100, 3);
    const worker = new PendingReferenceWorker(resolver, config);
    worker.onModuleInit();
    try {
      await eventually(async () => resolver.limits.length === 2, 2_000);
      await Bun.sleep(200);
      expect(resolver.limits).toEqual([100, 100]);
    } finally {
      await worker.onModuleDestroy();
    }
  });
});
