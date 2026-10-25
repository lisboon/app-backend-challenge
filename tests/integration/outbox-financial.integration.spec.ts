import { beforeAll, afterAll, describe, it, expect } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';

import { MikroOrmTransactionManager } from '../../src/infra/database/mikro-orm-transaction-manager';
import type { IntegrationEventJSON } from '../../src/modules/@shared/domain/event/integration-event';
import type { OutboxGateway } from '../../src/modules/@shared/gateway/outbox.gateway';
import { OutboxMessageRepository } from '../../src/modules/@shared/repository/outbox-message.repository';
import { WagerTransactionRepository } from '../../src/modules/wagering/repository/wager-transaction.repository';
import { SubmitWagerTransactionUseCase } from '../../src/modules/wagering/usecase/submit-wager-transaction/submit-wager-transaction.usecase';
import { LedgerRepository } from '../../src/modules/wallet/repository/ledger.repository';
import { WalletMovementRepository } from '../../src/modules/wallet/repository/wallet-movement.repository';
import { WalletRepository } from '../../src/modules/wallet/repository/wallet.repository';
import { deferred, eventually } from '../support/async';
import {
  openTestOrm,
  migrateFresh,
  ledgerMatchesBalance,
} from '../support/database';
import { startApp } from '../support/http-app';

const uuid = (): string => Bun.randomUUIDv7();
const money = (amount: string) => ({ amount, currency: 'BRL' });
type Event = IntegrationEventJSON<{
  transactionId: string;
  kind: string;
  status: string;
  money: { amount: string };
  balance: { amount: string };
  failureCode?: string;
}>;

describe('eventos financeiros atômicos na outbox', () => {
  let orm: MikroORM;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    ({ app, baseUrl } = await startApp());
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  const open = async (amount = '100.00', correlationId = uuid()) => {
    const playerId = uuid();
    const response = await fetch(baseUrl + '/wallets', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify({ playerId, initialBalance: money(amount) }),
    });
    expect(response.status).toBe(201);
    return {
      walletId: ((await response.json()) as { id: string }).id,
      playerId,
      correlationId: response.headers.get('x-correlation-id')!,
    };
  };

  const body = (
    wallet: { walletId: string; playerId: string },
    kind: 'BET' | 'LOSS' = 'BET',
    amount = '10.00',
  ) => ({
    walletId: wallet.walletId,
    playerId: wallet.playerId,
    providerId: 'provider-outbox',
    externalTransactionId: uuid(),
    roundId: 'round',
    gameId: 'game',
    kind,
    money: money(amount),
  });

  const events = async (walletId: string): Promise<Event[]> =>
    (
      await orm.em
        .fork()
        .execute<{ payload: Event }[]>(
          'select payload from outbox_messages where aggregate_id=? order by sequence',
          [walletId],
        )
    ).map((row) => row.payload);

  const invariant = async (walletId: string) => {
    const row = await ledgerMatchesBalance(orm, walletId);
    expect(row.stored).toBe(row.rebuilt);
  };

  const submit = (payload: unknown, key = uuid(), correlationId = uuid()) =>
    fetch(baseUrl + '/wagering/transactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': key,
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify(payload),
    });

  it('abertura com saldo gera dois eventos correlacionados e com causalidade', async () => {
    const wallet = await open('100.00', uuid().toUpperCase());
    const recorded = await events(wallet.walletId);
    expect(recorded.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const processed = recorded.find(
      (event) => event.eventType === 'WagerTransactionProcessed',
    )!;
    const changed = recorded.find(
      (event) => event.eventType === 'WalletBalanceChanged',
    )!;
    expect(processed).toMatchObject({
      aggregateId: wallet.walletId,
      correlationId: wallet.correlationId,
      data: {
        kind: 'OPENING',
        money: money('100.00'),
        balance: money('100.00'),
      },
    });
    expect(changed).toMatchObject({
      aggregateId: wallet.walletId,
      correlationId: wallet.correlationId,
      causationId: processed.eventId,
      occurredAt: processed.occurredAt,
    });
    expect(processed).not.toHaveProperty('causationId');
    await invariant(wallet.walletId);
  });

  it('abertura zero não gera evento e correlação inválida ganha UUIDv7', async () => {
    const wallet = await open('0.00', 'inválida');
    expect(wallet.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(await events(wallet.walletId)).toEqual([]);
    await invariant(wallet.walletId);
  });

  it.each([
    ['BET', '10.00', 201, 2],
    ['BET', '101.00', 422, 1],
    ['LOSS', '0.00', 201, 1],
  ] as const)(
    '%s %s gera somente os eventos devidos',
    async (kind, amount, status, count) => {
      const wallet = await open();
      const payload = body(wallet, kind, amount);
      const key = uuid(),
        correlationId = uuid();
      const response = await submit(payload, key, correlationId);
      expect(response.status).toBe(status);
      expect(response.headers.get('x-correlation-id')).toBe(correlationId);
      const output = (await response.json()) as { transactionId: string };
      const recorded = (await events(wallet.walletId)).filter(
        (event) => event.data.transactionId === output.transactionId,
      );
      expect(recorded).toHaveLength(count);
      if (count === 2) {
        expect(recorded.map((event) => event.eventType)).toEqual([
          'WagerTransactionProcessed',
          'WalletBalanceChanged',
        ]);
      }
      const transaction = recorded.find(
        (event) => event.eventType !== 'WalletBalanceChanged',
      )!;
      expect(transaction).toMatchObject({
        correlationId,
        data: { kind, money: money(amount) },
      });
      if (status === 422) {
        expect(transaction.eventType).toBe('WagerTransactionRejected');
        expect(transaction.data.failureCode).toBe('INSUFFICIENT_BALANCE');
      } else {
        expect(transaction.eventType).toBe('WagerTransactionProcessed');
      }
      if (count === 2) {
        expect(
          recorded.find((event) => event.eventType === 'WalletBalanceChanged'),
        ).toMatchObject({
          causationId: transaction.eventId,
          correlationId,
          occurredAt: transaction.occurredAt,
        });
      }
      const before = (await events(wallet.walletId)).length;
      expect((await submit(payload, key, uuid())).status).toBe(status);
      expect(await events(wallet.walletId)).toHaveLength(before);
      await invariant(wallet.walletId);
    },
  );

  it.each(['antes', 'depois'] as const)(
    'falha %s da gravação na outbox desfaz todo o movimento',
    async (stage) => {
      const wallet = await open();
      const real = new OutboxMessageRepository();
      const failing: OutboxGateway = {
        create: async (message, trx) => {
          if (stage === 'antes') {
            throw new Error('falha ao gravar outbox');
          }
          await real.create(message, trx);
          if (message.eventType === 'WagerTransactionProcessed') {
            throw new Error('falha após gravar outbox');
          }
        },
      };
      const useCase = new SubmitWagerTransactionUseCase(
        new MikroOrmTransactionManager(orm),
        new WagerTransactionRepository(),
        new WalletMovementRepository(
          new WalletRepository(),
          new LedgerRepository(),
          failing,
        ),
        { next: uuid },
        { now: () => new Date() },
        failing,
      );
      expect(
        await useCase
          .execute({
            ...body(wallet),
            idempotencyKey: uuid(),
            correlationId: uuid(),
          })
          .catch((error: unknown) => error),
      ).toBeInstanceOf(Error);
      const [counts] = await orm.em
        .fork()
        .execute<
          { wagers: string; ledger: string; outbox: string; balance: string }[]
        >(
          `select balance::text,
      (select count(*)::text from wager_transactions where wallet_id=w.id) as wagers,
      (select count(*)::text from wallet_ledger_entries where wallet_id=w.id) as ledger,
      (select count(*)::text from outbox_messages where aggregate_id=w.id) as outbox from wallets w where id=?`,
          [wallet.walletId],
        );
      expect(counts).toEqual({
        balance: '100.00',
        wagers: '1',
        ledger: '1',
        outbox: '2',
      });
      await invariant(wallet.walletId);
    },
  );

  it('lê occurredAt depois do lock enquanto outra submissão segura a wallet', async () => {
    const wallet = await open();
    const firstRecorded = deferred();
    const release = deferred();
    const secondLock = deferred();
    let now = new Date(Date.now() + 1000);
    const firstAt = now;
    const outbox = new OutboxMessageRepository();
    const realWallets = new WalletMovementRepository(
      new WalletRepository(),
      new LedgerRepository(),
      outbox,
    );
    let blocked = false;
    const holding: OutboxGateway = {
      create: async (message, trx) => {
        await outbox.create(message, trx);
        if (!blocked && message.eventType === 'WagerTransactionProcessed') {
          blocked = true;
          firstRecorded.resolve();
          await release.promise;
        }
      },
    };
    const make = (gateway: OutboxGateway, lock: typeof realWallets) =>
      new SubmitWagerTransactionUseCase(
        new MikroOrmTransactionManager(orm),
        new WagerTransactionRepository(),
        lock,
        { next: uuid },
        { now: () => now },
        gateway,
      );
    const first = make(holding, realWallets).execute({
      ...body(wallet),
      idempotencyKey: uuid(),
      correlationId: uuid(),
    });
    await firstRecorded.promise;
    const waiting = new WalletMovementRepository(
      new WalletRepository(),
      new LedgerRepository(),
      outbox,
    );
    const original = waiting.lock.bind(waiting);
    waiting.lock = (id, trx) => {
      secondLock.resolve();
      return original(id, trx);
    };
    const second = make(outbox, waiting).execute({
      ...body(wallet),
      idempotencyKey: uuid(),
      correlationId: uuid(),
    });
    try {
      await secondLock.promise;
      await eventually(
        async () =>
          Number(
            (
              await orm.em
                .fork()
                .execute<{ n: string }[]>(
                  "select count(*)::text as n from pg_stat_activity where wait_event_type='Lock' and query ilike '%wallets%'",
                )
            )[0].n,
          ) > 0,
      );
      now = new Date(firstAt.getTime() + 1000);
    } finally {
      release.resolve();
    }
    const outputs = await Promise.all([first, second]);
    const recorded = (await events(wallet.walletId)).filter(
      (event) =>
        outputs.some(
          (output) => output.transactionId === event.data.transactionId,
        ) && event.eventType === 'WagerTransactionProcessed',
    );
    expect(recorded.map((event) => event.occurredAt)).toEqual([
      firstAt.toISOString(),
      now.toISOString(),
    ]);
    await invariant(wallet.walletId);
  });
});
