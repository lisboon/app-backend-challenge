import { describe, expect, it } from 'bun:test';

import { OutboxMessage } from '../../../src/modules/@shared/domain/outbox/outbox-message.entity';
import {
  TransactionContext,
  type TransactionManager,
} from '../../../src/modules/@shared/domain/transaction/transaction-manager';
import type { OutboxMonitor } from '../../../src/modules/@shared/gateway/outbox-monitor.gateway';
import type { PendingOutboxGateway } from '../../../src/modules/@shared/gateway/outbox.gateway';
import { PublishOutboxUseCase } from '../../../src/modules/@shared/usecase/publish-outbox/publish-outbox.usecase';

class FakeContext extends TransactionContext {
  constructor() {
    super();
  }
}
const at = new Date('2026-10-24T12:00:00.000Z');
const transactions: TransactionManager = {
  execute: (work) => work(new FakeContext()),
  snapshot: (work) => work(new FakeContext()),
};
const monitor: OutboxMonitor = {
  published: () => undefined,
  publicationFailed: () => undefined,
  retryScheduled: () => undefined,
  lag: () => undefined,
  lagUnavailable: () => undefined,
};

function message(
  publishedAt: Date | undefined,
  nextAttemptAt: Date,
): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: 'event',
    aggregateId: 'wallet',
    eventType: 'WagerTransactionProcessed',
    occurredAt: at,
    attempts: 0,
    nextAttemptAt,
    publishedAt,
    payload: {
      eventId: 'event',
      aggregateId: 'wallet',
      eventType: 'WagerTransactionProcessed',
      correlationId: 'correlation',
      occurredAt: at.toISOString(),
      version: 1,
      data: {},
    },
  });
}

describe('PublishOutboxUseCase', () => {
  it.each([
    ['já publicada', at, at],
    ['ainda não devida', undefined, new Date(at.getTime() + 1000)],
  ] as const)(
    'não publica mensagem %s devolvida por um gateway',
    async (_case, publishedAt, nextAttemptAt) => {
      const supplied = message(publishedAt, nextAttemptAt);
      let sent = 0;
      let updated = 0;
      const gateway: PendingOutboxGateway = {
        findDue: async () => [supplied],
        update: async () => {
          updated++;
        },
        oldestPending: async () => null,
      };
      const useCase = new PublishOutboxUseCase(
        transactions,
        gateway,
        {
          publish: async () => {
            sent++;
          },
        },
        { now: () => at },
        monitor,
      );
      expect(await useCase.execute({ limit: 10 })).toEqual({ attempted: 0 });
      expect(sent).toBe(0);
      expect(updated).toBe(0);
    },
  );

  it('lote commitado continua contado quando a leitura do lag falha depois', async () => {
    const unavailable: unknown[] = [];
    const lost = new Error('banco caiu depois do commit');
    const useCase = new PublishOutboxUseCase(
      transactions,
      {
        findDue: async () => [message(undefined, at)],
        update: async () => undefined,
        oldestPending: async () => {
          throw lost;
        },
      },
      { publish: async () => undefined },
      { now: () => at },
      { ...monitor, lagUnavailable: (error) => unavailable.push(error) },
    );

    expect(await useCase.execute({ limit: 10 })).toEqual({ attempted: 1 });
    expect(unavailable).toEqual([lost]);
  });
});
