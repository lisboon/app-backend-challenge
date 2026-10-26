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

import { deferred, eventually } from '../support/async';
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

  const startWorker = (overrides: Record<string, string> = {}): AppProcess => {
    const env = testAppEnv(freePort());
    const worker = spawnWorker({
      ...env,
      WORKER_METRICS_PORT: String(freePort()),
      WAGER_QUEUE_NAME: queues.sourceName,
      WAGER_DLQ_NAME: queues.deadLetterName,
      CONSUMER_RETRY_BASE_SECONDS: '1',
      ...overrides,
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

  it('o worker real expõe latência, duplicatas e profundidade da DLQ na porta de métricas', async () => {
    const wallet = await open('100.00');
    const body = message(wallet, '10.00');
    await sendWagerMessage(sqs, queues.sourceUrl, body, wallet.walletId);
    await sendWagerMessage(sqs, queues.sourceUrl, body, wallet.walletId);
    const port = freePort();
    startWorker({
      WORKER_METRICS_PORT: String(port),
      CONSUMER_CONCURRENCY: '1',
    });

    await eventually(
      async () => (await approximateMessages(sqs, queues.sourceUrl)) === 0,
      30_000,
    );
    let metrics = '';
    await eventually(async () => {
      metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      return metrics.includes('inbox_duplicates_total 1');
    }, 15_000);
    expect(metrics).toContain(
      'wager_message_processing_seconds_count{outcome="processed"} 1',
    );
    expect(metrics).toContain('wager_dlq_messages 0');
    expect(metrics).toContain(
      'wager_transactions_total{status="PROCESSED",kind="BET"} 1',
    );
  }, 60_000);

  it('worker morto depois do commit e antes do ack não duplica o débito', async () => {
    const wallet = await open('100.00');
    const body = message(wallet, '10.00');
    await sendWagerMessage(sqs, queues.sourceUrl, body, wallet.walletId);
    const gate = gateSqs('DeleteMessage');
    const first = startWorker({ SQS_ENDPOINT: gate.endpoint });
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

  it.skipIf(process.platform === 'win32')(
    'SIGTERM termina a mensagem em voo, confirma, não recebe outra e sai com zero',
    async () => {
      const wallet = await open('100.00');
      const inFlight = message(wallet, '10.00');
      const next = message(wallet, '20.00');
      await orm.em.fork().execute(`
        create function consumer_test_gate() returns trigger language plpgsql as $$
        begin
          if new.external_transaction_id = '${inFlight.data.externalTransactionId}' then
            perform pg_advisory_xact_lock(9051, 1);
          end if;
          return new;
        end $$`);
      await orm.em
        .fork()
        .execute(
          'create trigger consumer_test_gate before insert on wager_transactions for each row execute function consumer_test_gate()',
        );
      const held = deferred();
      const release = deferred();
      const holder = orm.em.fork().transactional(async (em) => {
        await em.execute('select pg_advisory_xact_lock(9051, 1)');
        held.resolve();
        await release.promise;
      });
      try {
        await held.promise;
        await sendWagerMessage(
          sqs,
          queues.sourceUrl,
          inFlight,
          wallet.walletId,
        );
        const worker = startWorker({ CONSUMER_CONCURRENCY: '1' });
        const stdout = new Response(worker.stdout).text();
        await eventually(
          async () =>
            (await count(
              "select count(*) as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'",
              [],
            )) > 0,
          15_000,
        );
        await sendWagerMessage(sqs, queues.sourceUrl, next, wallet.walletId);
        worker.kill('SIGTERM');
        expect(worker.exitCode).toBeNull();
        release.resolve();
        await holder;

        expect(await worker.exited).toBe(0);
        expect(await stdout).toContain('wager_message_worker_stopped');
        expect(await balanceOf(wallet.walletId)).toBe('90.00');
        expect(await approximateMessages(sqs, queues.sourceUrl)).toBe(1);
      } finally {
        release.resolve();
        await holder;
        await orm.em
          .fork()
          .execute('drop trigger consumer_test_gate on wager_transactions');
        await orm.em.fork().execute('drop function consumer_test_gate()');
      }

      startWorker();
      await eventually(
        async () => (await approximateMessages(sqs, queues.sourceUrl)) === 0,
        30_000,
      );
      expect(await balanceOf(wallet.walletId)).toBe('70.00');
      const state = await ledgerMatchesBalance(orm, wallet.walletId);
      expect(state.stored).toBe(state.rebuilt);
    },
    60_000,
  );

  it.skipIf(process.platform === 'win32')(
    'SIGTERM durante a espera do long polling aborta o receive e sai sem esperar a fila',
    async () => {
      const gate = gateSqs('ReceiveMessage');
      try {
        const worker = startWorker({
          SQS_ENDPOINT: gate.endpoint,
          CONSUMER_CONCURRENCY: '1',
        });
        void new Response(worker.stdout).text();
        await eventually(async () => gate.entered(), 15_000);
        const startedAt = performance.now();
        worker.kill('SIGTERM');

        expect(await worker.exited).toBe(0);
        expect(performance.now() - startedAt).toBeLessThan(1500);
      } finally {
        await gate.close();
      }
    },
    30_000,
  );
});
