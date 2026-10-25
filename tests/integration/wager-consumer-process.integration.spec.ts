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

import { eventually } from '../support/async';
import {
  ledgerMatchesBalance,
  migrateFresh,
  openTestOrm,
} from '../support/database';
import { startApp } from '../support/http-app';
import { testSqs } from '../support/outbox';
import {
  type AppProcess,
  freePort,
  spawnWorker,
  testAppEnv,
} from '../support/process';
import { gateSqs } from '../support/sqs-gate';
import {
  approximateMessages,
  receiveDeadLetters,
  sendWagerMessage,
  wagerQueues,
  type WagerQueues,
} from '../support/wager-queue';

const uuid = (): string => Bun.randomUUIDv7();
const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface Wallet {
  walletId: string;
  playerId: string;
}

describe('processos consumidores com PostgreSQL e LocalStack reais', () => {
  const sqs = testSqs();
  let orm: MikroORM;
  let app: INestApplication;
  let baseUrl: string;
  let queues: WagerQueues;
  const workers: AppProcess[] = [];

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
    queues = await wagerQueues(sqs, 5);
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      worker.kill('SIGKILL');
      await worker.exited;
    }
    await queues.close();
  });

  const startWorker = (sqsEndpoint?: string): AppProcess => {
    const env = testAppEnv(freePort());
    const worker = spawnWorker({
      ...env,
      WORKER_METRICS_PORT: String(freePort()),
      WAGER_QUEUE_NAME: queues.sourceName,
      WAGER_DLQ_NAME: queues.deadLetterName,
      CONSUMER_RETRY_BASE_SECONDS: '1',
      ...(sqsEndpoint ? { SQS_ENDPOINT: sqsEndpoint } : {}),
    });
    workers.push(worker);
    return worker;
  };

  const open = async (amount: string): Promise<Wallet> => {
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

  const message = (wallet: Wallet, amount: string) => ({
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
      money: brl(amount),
    },
  });

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

  it('três workers consumindo a mesma fila com entregas duplicadas aplicam cada aposta uma vez', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => open('50.00')),
    );
    for (const wallet of wallets) {
      for (let bet = 0; bet < 5; bet += 1) {
        const body = message(wallet, '3.00');
        await sendWagerMessage(sqs, queues.sourceUrl, body, wallet.walletId);
        await sendWagerMessage(sqs, queues.sourceUrl, body, wallet.walletId);
      }
    }
    startWorker();
    startWorker();
    startWorker();

    await eventually(
      async () => (await approximateMessages(sqs, queues.sourceUrl)) === 0,
      90_000,
    );
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.walletId)).toBe('35.00');
      expect(
        await count(
          "select count(*) as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
          [wallet.walletId],
        ),
      ).toBe(5);
      const state = await ledgerMatchesBalance(orm, wallet.walletId);
      expect(state.stored).toBe(state.rebuilt);
    }
    expect(await receiveDeadLetters(sqs, queues.deadLetterUrl)).toEqual([]);
  }, 120_000);

  it('worker morto depois do commit e antes do ack não duplica o débito', async () => {
    const wallet = await open('100.00');
    const body = message(wallet, '10.00');
    await sendWagerMessage(sqs, queues.sourceUrl, body, wallet.walletId);
    const gate = gateSqs('DeleteMessage');
    const first = startWorker(gate.endpoint);
    try {
      await eventually(async () => gate.entered(), 30_000);
      expect(await balanceOf(wallet.walletId)).toBe('90.00');
      expect(
        await count(
          'select count(*) as n from inbox_messages where message_id = ? and processed_at is not null',
          [body.messageId],
        ),
      ).toBe(1);
      first.kill('SIGKILL');
      await first.exited;
    } finally {
      await gate.close();
    }

    startWorker();
    await eventually(
      async () => (await approximateMessages(sqs, queues.sourceUrl)) === 0,
      30_000,
    );
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    expect(
      await count(
        "select count(*) as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
        [wallet.walletId],
      ),
    ).toBe(1);
    expect(await receiveDeadLetters(sqs, queues.deadLetterUrl)).toEqual([]);
  }, 60_000);
});
