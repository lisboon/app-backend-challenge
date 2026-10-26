import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';

import { MikroOrmTransactionManager } from '../../src/infra/database/mikro-orm-transaction-manager';
import { payloadHash } from '../../src/modules/@shared/domain/payload-hash';
import {
  WageringFactory,
  type WageringUseCases,
} from '../../src/modules/wagering/factory/wagering.factory';
import type { SubmitWagerTransactionUseCaseInputDto } from '../../src/modules/wagering/usecase/submit/submit.usecase.dto';
import {
  ledgerMatchesBalance,
  migrateFresh,
  openTestOrm,
} from '../support/database';
import { startApp } from '../support/http-app';

const uuid = (): string => Bun.randomUUIDv7();
const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('registro de FAILED com PostgreSQL real', () => {
  let orm: MikroORM;
  let app: INestApplication;
  let baseUrl: string;
  let useCases: WageringUseCases;

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    ({ app, baseUrl } = await startApp());
    useCases = WageringFactory.create({
      transactions: new MikroOrmTransactionManager(orm),
      ids: { next: uuid },
      clock: { now: () => new Date() },
      pendingMonitor: {
        pending: () => undefined,
        resolved: () => undefined,
        retryScheduled: () => undefined,
        failed: () => undefined,
      },
      pendingReferenceTtlSeconds: 3600,
    });
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  const open = async (): Promise<{ walletId: string; playerId: string }> => {
    const playerId = uuid();
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: brl('100.00') }),
    });
    return {
      walletId: ((await response.json()) as { id: string }).id,
      playerId,
    };
  };

  const input = (wallet: {
    walletId: string;
    playerId: string;
  }): SubmitWagerTransactionUseCaseInputDto => ({
    correlationId: uuid(),
    idempotencyKey: uuid(),
    providerId: 'provider-f',
    externalTransactionId: uuid(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('10.00'),
  });

  const recordFailure = (data: SubmitWagerTransactionUseCaseInputDto) =>
    useCases
      .recordFailureFor({
        consumerName: 'record-failure-test',
        messageId: uuid(),
        payloadHash: payloadHash(data.idempotencyKey),
      })
      .execute(data);

  const invariant = async (walletId: string): Promise<void> => {
    const state = await ledgerMatchesBalance(orm, walletId);
    expect(state.stored).toBe(state.rebuilt);
  };

  const count = async (sql: string, params: unknown[]): Promise<number> => {
    const [row] = await orm.em.fork().execute<{ n: string }[]>(sql, params);
    return Number(row.n);
  };

  it('grava FAILED sem mover saldo, ledger nem outbox', async () => {
    const wallet = await open();
    const data = input(wallet);
    const { transactionId } = await recordFailure(data);

    expect(transactionId).not.toBeNull();
    expect(
      await useCases.findById.execute({ id: transactionId ?? '' }),
    ).toMatchObject({ status: 'FAILED', failureCode: 'PROCESSING_FAILED' });
    expect(
      await count(
        'select count(*) as n from wallet_ledger_entries where transaction_id = ?',
        [transactionId],
      ),
    ).toBe(0);
    expect(
      await count(
        'select count(*) as n from outbox_messages where aggregate_id = ?',
        [transactionId],
      ),
    ).toBe(0);
    expect(
      (
        (await (
          await fetch(`${baseUrl}/wallets/${wallet.walletId}`)
        ).json()) as {
          balance: { amount: string };
        }
      ).balance.amount,
    ).toBe('100.00');
    await invariant(wallet.walletId);
  });

  it('não sobrescreve a chave que já tem desfecho', async () => {
    const wallet = await open();
    const data = input(wallet);
    const processed = await useCases.submit.execute(data);

    expect(await recordFailure(data)).toEqual({ transactionId: null });
    expect(
      await useCases.findById.execute({
        id: processed.transactionId,
      }),
    ).toMatchObject({ status: 'PROCESSED' });
    expect(
      await count(
        'select count(*) as n from wager_transactions where idempotency_key = ?',
        [data.idempotencyKey],
      ),
    ).toBe(1);
    await invariant(wallet.walletId);
  });

  it('wallet inexistente não ganha transação órfã', async () => {
    const data = input({ walletId: uuid(), playerId: uuid() });

    expect(await recordFailure(data)).toEqual({ transactionId: null });
    expect(
      await count(
        'select count(*) as n from wager_transactions where idempotency_key = ?',
        [data.idempotencyKey],
      ),
    ).toBe(0);
  });

  it('reversão de uma referência FAILED é rejeitada em vez de ficar pendente', async () => {
    const wallet = await open();
    const failed = input(wallet);
    await recordFailure(failed);

    const refund = await useCases.submit.execute({
      ...input(wallet),
      kind: 'REFUND',
      providerId: failed.providerId,
      referenceExternalTransactionId: failed.externalTransactionId,
    });

    expect(refund).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_PROCESSED',
    });
    await invariant(wallet.walletId);
  });
});
