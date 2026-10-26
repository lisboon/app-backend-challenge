import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';

import { MikroOrmTransactionManager } from '../../src/infra/database/mikro-orm-transaction-manager';
import { WagerQueue } from '../../src/infra/queue/wager-queue';
import { WagerMessageWorker } from '../../src/infra/worker/wager-message-worker';
import { FailureCode } from '../../src/modules/@shared/domain/failure-code';
import {
  WageringFactory,
  type WageringUseCases,
} from '../../src/modules/wagering/factory/wagering.factory';
import type { PendingReferenceMonitor } from '../../src/modules/wagering/gateway/pending-reference-monitor.gateway';
import { deferred, eventually } from '../support/async';
import {
  ledgerMatchesBalance,
  migrateFresh,
  openTestOrm,
} from '../support/database';
import { startApp, testAppConfig } from '../support/http-app';
import { testSqs } from '../support/outbox';
import {
  approximateMessages,
  receiveDeadLetters,
  sendWagerMessage,
  wagerQueues,
  type WagerQueues,
} from '../support/wager-queue';

const uuid = (): string => Bun.randomUUIDv7();
const brl = (amount: string) => ({ amount, currency: 'BRL' });

const silentMonitor: PendingReferenceMonitor = {
  pending: () => undefined,
  resolved: () => undefined,
  retryScheduled: () => undefined,
  failed: () => undefined,
};

interface Wallet {
  walletId: string;
  playerId: string;
}

describe('consumidor SQS com PostgreSQL e LocalStack reais', () => {
  const sqs = testSqs();
  let orm: MikroORM;
  let app: INestApplication;
  let baseUrl: string;
  let queues: WagerQueues;
  let useCases: WageringUseCases;
  let worker: WagerMessageWorker | undefined;

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    ({ app, baseUrl } = await startApp());
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  beforeEach(async () => {
    queues = await wagerQueues(sqs);
    useCases = WageringFactory.create({
      transactions: new MikroOrmTransactionManager(orm),
      ids: { next: uuid },
      clock: { now: () => new Date() },
      pendingMonitor: silentMonitor,
      pendingReferenceTtlSeconds: 3600,
    });
  });

  afterEach(async () => {
    await worker?.onModuleDestroy();
    worker = undefined;
    await queues.close();
  });

  const startConsumer = (): void => {
    worker = new WagerMessageWorker(
      new WagerQueue(sqs, queues.sourceName, queues.deadLetterName),
      useCases.submitFor,
      useCases.recordFailureFor,
      testAppConfig(),
    );
    worker.onModuleInit();
  };

  const open = async (amount = '100.00'): Promise<Wallet> => {
    const playerId = uuid();
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: brl(amount) }),
    });
    expect(response.status).toBe(201);
    return {
      walletId: ((await response.json()) as { id: string }).id,
      playerId,
    };
  };

  const message = (
    wallet: Wallet,
    data: Record<string, unknown> = {},
    envelope: Record<string, unknown> = {},
  ) => ({
    messageId: uuid(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-q',
      externalTransactionId: uuid(),
      idempotencyKey: uuid(),
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: brl('10.00'),
      ...data,
    },
    ...envelope,
  });

  const send = (body: unknown, groupId: string, deduplicationId?: string) =>
    sendWagerMessage(sqs, queues.sourceUrl, body, groupId, deduplicationId);

  const balanceOf = async (walletId: string): Promise<string> =>
    (
      (await (await fetch(`${baseUrl}/wallets/${walletId}`)).json()) as {
        balance: { amount: string };
      }
    ).balance.amount;

  const count = async (sql: string, params: unknown[]): Promise<number> => {
    const [row] = await orm.em.fork().execute<{ n: string }[]>(sql, params);
    return Number(row.n);
  };

  const debits = (walletId: string) =>
    count(
      "select count(*) as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
      [walletId],
    );

  const drained = async (): Promise<boolean> =>
    (await approximateMessages(sqs, queues.sourceUrl)) === 0;

  const invariant = async (walletId: string): Promise<void> => {
    const state = await ledgerMatchesBalance(orm, walletId);
    expect(state.stored).toBe(state.rebuilt);
  };

  const holdWallet = async (walletId: string) => {
    const release = deferred();
    const locked = deferred();
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute('select 1 from wallets where id = ? for update', [
        walletId,
      ]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    return async (): Promise<void> => {
      release.resolve();
      await holder;
    };
  };

  it('aplica a aposta, registra a inbox e confirma a mensagem só depois do commit', async () => {
    const wallet = await open();
    const body = message(wallet);
    await send(body, wallet.walletId);
    startConsumer();

    await eventually(
      async () => (await balanceOf(wallet.walletId)) === '90.00',
    );
    await eventually(drained);
    expect(
      await count(
        'select count(*) as n from inbox_messages where message_id = ? and processed_at is not null',
        [body.messageId],
      ),
    ).toBe(1);
    expect(
      await count(
        'select count(*) as n from wager_transactions where external_transaction_id = ? and correlation_id = ?',
        [body.data.externalTransactionId, body.messageId],
      ),
    ).toBe(1);
    await invariant(wallet.walletId);
  });

  it('a mesma mensagem entregue duas vezes debita uma vez e confirma as duas', async () => {
    const wallet = await open();
    const body = message(wallet);
    await send(body, wallet.walletId);
    await send(body, wallet.walletId);
    startConsumer();

    await eventually(drained);
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await receiveDeadLetters(sqs, queues.deadLetterUrl)).toEqual([]);
  });

  it('a mesma idempotencyKey em mensagens diferentes vira replay sem novo débito', async () => {
    const wallet = await open();
    const first = message(wallet);
    await send(first, wallet.walletId);
    await send({ ...first, messageId: uuid() }, wallet.walletId);
    startConsumer();

    await eventually(drained);
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
  });

  it('cenário do §8 pela fila: duas apostas de 80 sobre 100 aplicam uma e rejeitam outra', async () => {
    const wallet = await open('100.00');
    const first = message(wallet, { money: brl('80.00') });
    const second = message(wallet, { money: brl('80.00') });
    await send(first, wallet.walletId);
    await send(second, wallet.walletId);
    startConsumer();

    await eventually(drained);
    const statuses = await orm.em
      .fork()
      .execute<{ status: string; failure_code: string | null }[]>(
        'select status, failure_code from wager_transactions where wallet_id = ? and kind = ? order by created_at',
        [wallet.walletId, 'BET'],
      );
    expect(statuses).toEqual([
      { status: 'PROCESSED', failure_code: null },
      { status: 'REJECTED', failure_code: FailureCode.INSUFFICIENT_BALANCE },
    ]);
    expect(await balanceOf(wallet.walletId)).toBe('20.00');
    expect(await debits(wallet.walletId)).toBe(1);
    await invariant(wallet.walletId);
  });

  it.each([
    ['JSON inválido', () => '{nao-json', FailureCode.MESSAGE_INVALID],
    [
      'tipo desconhecido',
      (wallet: Wallet) =>
        message(wallet, {}, { type: 'WagerTransactionCreated' }),
      FailureCode.MESSAGE_INVALID,
    ],
    [
      'OPENING pela fila',
      (wallet: Wallet) => message(wallet, { kind: 'OPENING' }),
      FailureCode.TRANSACTION_KIND_NOT_SUBMITTABLE,
    ],
    [
      'wallet inexistente',
      (wallet: Wallet) => message({ ...wallet, walletId: uuid() }),
      FailureCode.WALLET_NOT_FOUND,
    ],
  ] as const)(
    'mensagem permanente vai direto para a DLQ: %s',
    async (_caso, build, failureCode) => {
      const wallet = await open();
      const body = build(wallet);
      await send(body, wallet.walletId);
      startConsumer();

      await eventually(async () =>
        (await receiveDeadLetters(sqs, queues.deadLetterUrl)).some(
          (letter) => letter.failureCode === failureCode,
        ),
      );
      await eventually(drained);
      expect(await balanceOf(wallet.walletId)).toBe('100.00');
    },
  );

  it('mesma idempotencyKey com outro conteúdo vai para a DLQ como conflito', async () => {
    const wallet = await open();
    const first = message(wallet);
    await send(first, wallet.walletId);
    await send(
      message(wallet, {
        idempotencyKey: first.data.idempotencyKey,
        money: brl('11.00'),
      }),
      wallet.walletId,
    );
    startConsumer();

    await eventually(async () =>
      (await receiveDeadLetters(sqs, queues.deadLetterUrl)).some(
        (letter) =>
          letter.failureCode === FailureCode.IDEMPOTENCY_PAYLOAD_CONFLICT,
      ),
    );
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
  });

  it('falha transitória devolve a mensagem com backoff e aplica uma vez quando o lock é liberado', async () => {
    const wallet = await open();
    const release = await holdWallet(wallet.walletId);
    await send(message(wallet), wallet.walletId);
    startConsumer();

    await eventually(
      async () =>
        (await count(
          'select count(*) as n from wager_transactions where wallet_id = ? and kind = ?',
          [wallet.walletId, 'BET'],
        )) === 0 && (await approximateMessages(sqs, queues.sourceUrl)) === 1,
    );
    await Bun.sleep(2500);
    await release();

    await eventually(
      async () => (await balanceOf(wallet.walletId)) === '90.00',
      30_000,
    );
    expect(await debits(wallet.walletId)).toBe(1);
    expect(await receiveDeadLetters(sqs, queues.deadLetterUrl)).toEqual([]);
  }, 40_000);

  it('falha transitória persistente chega à DLQ pelo redrive depois de 5 recebimentos', async () => {
    const wallet = await open();
    const release = await holdWallet(wallet.walletId);
    await send(message(wallet), wallet.walletId);
    startConsumer();

    await eventually(
      async () =>
        (await receiveDeadLetters(sqs, queues.deadLetterUrl)).length === 1,
      60_000,
    );
    await release();
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    expect(await debits(wallet.walletId)).toBe(0);
  }, 70_000);

  it('mensagem transitória segura as seguintes do mesmo grupo e a ordem é mantida', async () => {
    const wallet = await open();
    const release = await holdWallet(wallet.walletId);
    const first = message(wallet, { money: brl('10.00') });
    const second = message(wallet, { money: brl('20.00') });
    await send(first, wallet.walletId);
    await send(second, wallet.walletId);
    startConsumer();

    await Bun.sleep(7000);
    expect(await debits(wallet.walletId)).toBe(0);
    await release();

    await eventually(
      async () => (await balanceOf(wallet.walletId)) === '70.00',
      30_000,
    );
    const order = await orm.em
      .fork()
      .execute<{ amount: string }[]>(
        "select amount::text as amount from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT' order by wallet_version",
        [wallet.walletId],
      );
    expect(order).toEqual([{ amount: '10.00' }, { amount: '20.00' }]);
  }, 40_000);

  it('a mesma chave pela HTTP e depois pela fila é replay, sem novo débito', async () => {
    const wallet = await open();
    const body = message(wallet);
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': body.data.idempotencyKey,
      },
      body: JSON.stringify({ ...body.data, idempotencyKey: undefined }),
    });
    expect(response.status).toBe(201);
    await send(body, wallet.walletId);
    startConsumer();

    await eventually(drained);
    expect(await debits(wallet.walletId)).toBe(1);
  });

  it('a mesma chave pela fila e depois pela HTTP devolve o resultado original', async () => {
    const wallet = await open();
    const body = message(wallet);
    await send(body, wallet.walletId);
    startConsumer();
    await eventually(
      async () => (await balanceOf(wallet.walletId)) === '90.00',
    );

    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': body.data.idempotencyKey,
      },
      body: JSON.stringify({ ...body.data, idempotencyKey: undefined }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ idempotentReplay: true });
    expect(await debits(wallet.walletId)).toBe(1);
  });

  it('reversão pela fila antes da referência fica pendente e é resolvida quando o BET chega', async () => {
    const wallet = await open();
    const bet = message(wallet, { money: brl('25.00') });
    const refund = message(wallet, {
      kind: 'REFUND',
      money: brl('25.00'),
      referenceExternalTransactionId: bet.data.externalTransactionId,
    });
    await send(refund, `${wallet.walletId}-refund`);
    startConsumer();
    await eventually(
      async () =>
        (await count(
          "select count(*) as n from wager_transactions where external_transaction_id = ? and status = 'PENDING_REFERENCE'",
          [refund.data.externalTransactionId],
        )) === 1,
    );

    await send(bet, wallet.walletId);
    await eventually(
      async () => (await balanceOf(wallet.walletId)) === '75.00',
    );
    await useCases.resolvePending.execute({ limit: 10 });

    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    await invariant(wallet.walletId);
  });

  const failInserts = async (
    externalTransactionId: string,
    condition: string,
  ): Promise<() => Promise<void>> => {
    await orm.em.fork().execute(`
      create function consumer_test_fail() returns trigger language plpgsql as $$
      begin
        if new.external_transaction_id = '${externalTransactionId}' and ${condition} then
          raise exception 'falha induzida pelo teste';
        end if;
        return new;
      end $$`);
    await orm.em
      .fork()
      .execute(
        'create trigger consumer_test_fail before insert on wager_transactions for each row execute function consumer_test_fail()',
      );
    return async () => {
      await orm.em
        .fork()
        .execute('drop trigger consumer_test_fail on wager_transactions');
      await orm.em.fork().execute('drop function consumer_test_fail()');
    };
  };

  it('falha interna desfaz o efeito inteiro e grava FAILED auditável antes da DLQ', async () => {
    const wallet = await open();
    const body = message(wallet);
    const restore = await failInserts(
      body.data.externalTransactionId,
      "new.status <> 'FAILED'",
    );
    try {
      await send(body, wallet.walletId);
      startConsumer();

      await eventually(async () =>
        (await receiveDeadLetters(sqs, queues.deadLetterUrl)).some(
          (letter) => letter.failureCode === FailureCode.PROCESSING_FAILED,
        ),
      );
      const recorded = await useCases.findByExternalId.execute({
        providerId: body.data.providerId,
        externalTransactionId: body.data.externalTransactionId,
      });
      expect(recorded).toMatchObject({
        status: 'FAILED',
        failureCode: FailureCode.PROCESSING_FAILED,
        balance: null,
      });
      expect(
        await count(
          'select count(*) as n from wager_transactions where id = ? and correlation_id = ?',
          [recorded.transactionId, body.messageId],
        ),
      ).toBe(1);
      expect(await balanceOf(wallet.walletId)).toBe('100.00');
      expect(
        await count(
          'select count(*) as n from inbox_messages where message_id = ? and processed_at is not null',
          [body.messageId],
        ),
      ).toBe(1);
      expect(
        await count(
          'select count(*) as n from outbox_messages where aggregate_id = ?',
          [wallet.walletId],
        ),
      ).toBe(2);
      expect(
        await count(
          'select count(*) as n from wallet_ledger_entries where transaction_id = ?',
          [recorded.transactionId],
        ),
      ).toBe(0);
      const replay = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': body.data.idempotencyKey,
        },
        body: JSON.stringify({ ...body.data, idempotencyKey: undefined }),
      });
      expect(replay.status).toBe(500);
      expect(await replay.json()).toMatchObject({
        transactionId: recorded.transactionId,
        status: 'FAILED',
        failureCode: FailureCode.PROCESSING_FAILED,
        idempotentReplay: true,
      });
    } finally {
      await restore();
    }
  });

  it('falha ao gravar FAILED devolve a mensagem para retry em vez de perder a auditoria', async () => {
    const wallet = await open();
    const body = message(wallet);
    const restore = await failInserts(body.data.externalTransactionId, 'true');
    try {
      await send(body, wallet.walletId);
      startConsumer();

      await eventually(
        async () =>
          (await receiveDeadLetters(sqs, queues.deadLetterUrl)).some(
            (letter) => letter.failureCode === undefined,
          ),
        40_000,
      );
      expect(await balanceOf(wallet.walletId)).toBe('100.00');
      expect(
        await count(
          'select count(*) as n from inbox_messages where message_id = ?',
          [body.messageId],
        ),
      ).toBe(0);
      expect(
        await count(
          'select count(*) as n from wager_transactions where external_transaction_id = ?',
          [body.data.externalTransactionId],
        ),
      ).toBe(0);
    } finally {
      await restore();
    }
  }, 60_000);
});
