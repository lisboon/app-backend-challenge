import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';

import { migrateFresh, openTestOrm } from '../support/database';
import { startApp } from '../support/http-app';

const uuid = (): string => Bun.randomUUIDv7();
const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('métricas e logs de transações pela API real', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const orm = await openTestOrm();
    await migrateFresh(orm);
    await orm.close(true);
    ({ app, baseUrl } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('conta transações por status e tipo, replays à parte, com log sem valores', async () => {
    const playerId = uuid();
    const opened = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: brl('50.00') }),
    });
    const walletId = ((await opened.json()) as { id: string }).id;
    const wager = (overrides: Record<string, unknown> = {}) => ({
      providerId: 'provider-metrics',
      externalTransactionId: uuid(),
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: brl('40.00'),
      ...overrides,
    });
    const submit = async (body: unknown, key = uuid()) =>
      (
        await fetch(`${baseUrl}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify(body),
        })
      ).status;

    const logs: unknown[] = [];
    const spy = spyOn(Logger.prototype, 'log').mockImplementation(
      (value: unknown) => {
        logs.push(value);
      },
    );
    try {
      const processed = wager();
      const key = uuid();
      expect(await submit(processed, key)).toBe(201);
      expect(await submit(processed, key)).toBe(201);
      expect(await submit(wager())).toBe(422);
      expect(
        await submit(
          wager({ kind: 'REFUND', referenceExternalTransactionId: uuid() }),
        ),
      ).toBe(202);
    } finally {
      spy.mockRestore();
    }

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    for (const series of [
      'wager_transactions_total{status="PROCESSED",kind="BET"} 1',
      'wager_transactions_total{status="REJECTED",kind="BET"} 1',
      'wager_transactions_total{status="PENDING_REFERENCE",kind="REFUND"} 1',
      'idempotent_replays_total{status="PROCESSED"} 1',
    ]) {
      expect(metrics).toContain(series);
    }
    const recorded = logs.filter(
      (log): log is Record<string, unknown> =>
        typeof log === 'object' &&
        log !== null &&
        (log as { event?: unknown }).event === 'wager_transaction_recorded',
    );
    expect(recorded).toHaveLength(3);
    for (const log of recorded) {
      expect(Object.keys(log).sort()).toEqual([
        'correlationId',
        'event',
        'failureCode',
        'kind',
        'providerId',
        'status',
        'transactionId',
        'walletId',
      ]);
      expect(log.walletId).toBe(walletId);
    }
    expect(JSON.stringify(logs)).not.toContain('40.00');
  });
});
