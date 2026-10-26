import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';

import {
  entityManagerOf,
  MikroOrmTransactionManager,
} from '../../src/infra/database/mikro-orm-transaction-manager';
import { InfrastructureUnavailableError } from '../../src/modules/@shared/domain/errors/infrastructure.errors';
import { eventually } from '../support/async';
import { dropConnectionsWaitingOn } from '../support/connection-fault';
import {
  ledgerMatchesBalance,
  migrateFresh,
  openTestOrm,
} from '../support/database';
import { startApp } from '../support/http-app';
import { eventsQueue, receiveEvents, testSqs } from '../support/outbox';
import { freePort, spawnWorker, testAppEnv } from '../support/process';
import { sendWagerMessage, wagerQueues } from '../support/wager-queue';

const uuid = (): string => Bun.randomUUIDv7();
const brl = (amount: string) => ({ amount, currency: 'BRL' });
const FAULTS_PER_ENTRYPOINT = 4;

describe('queda de conexão do banco dentro da transação', () => {
  let orm: MikroORM;
  let app: INestApplication;
  let baseUrl: string;
  let walletId: string;
  let playerId: string;
  let transactionId: string;
  let externalTransactionId: string;

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<number> => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await response.arrayBuffer();
    return response.status;
  };

  const bet = () => ({
    providerId: 'provider-fault',
    externalTransactionId: uuid(),
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('1.00'),
  });

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    ({ app, baseUrl } = await startApp({ databasePoolMax: 2 }));
    playerId = uuid();
    const opened = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: brl('1000.00') }),
    });
    walletId = ((await opened.json()) as { id: string }).id;
    const placed = bet();
    externalTransactionId = placed.externalTransactionId;
    const submitted = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': uuid(),
      },
      body: JSON.stringify(placed),
    });
    transactionId = ((await submitted.json()) as { transactionId: string })
      .transactionId;
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  it.each([
    [
      'POST /wallets',
      'wallets',
      201,
      () =>
        call('POST', '/wallets', {
          playerId: uuid(),
          initialBalance: brl('10.00'),
        }),
    ],
    [
      'GET /wallets/:id',
      'wallets',
      200,
      () => call('GET', `/wallets/${walletId}`),
    ],
    [
      'GET /wallets/:id/ledger',
      'wallet_ledger_entries',
      200,
      () => call('GET', `/wallets/${walletId}/ledger`),
    ],
    [
      'POST /wallets/:id/reconciliation',
      'wallet_ledger_entries',
      200,
      () => call('POST', `/wallets/${walletId}/reconciliation`),
    ],
    [
      'POST /wagering/transactions',
      'wallets',
      201,
      () => call('POST', '/wagering/transactions', bet(), uuid()),
    ],
    [
      'GET /wagering/transactions/:id',
      'wager_transactions',
      200,
      () => call('GET', `/wagering/transactions/${transactionId}`),
    ],
    [
      'GET /providers/:id/wagering/transactions/:externalId',
      'wager_transactions',
      200,
      () =>
        call(
          'GET',
          `/providers/provider-fault/wagering/transactions/${externalTransactionId}`,
        ),
    ],
  ] as const)(
    '%s responde 503 na queda e volta a responder com o pool íntegro',
    async (_route, table, healthy, request) => {
      let dropped = 0;
      for (let fault = 0; fault < FAULTS_PER_ENTRYPOINT; fault++) {
        const outcome = await dropConnectionsWaitingOn(orm, table, request);
        expect(outcome.result).toBe(503);
        dropped += outcome.dropped;
      }

      expect(dropped).toBeGreaterThanOrEqual(2);
      expect(await request()).toBe(healthy);
    },
    30_000,
  );

  it('worker volta a publicar a outbox e a consumir a fila depois de quedas nos ciclos', async () => {
    const sqs = testSqs();
    const events = await eventsQueue(sqs);
    const queues = await wagerQueues(sqs, 5);
    const worker = spawnWorker({
      ...testAppEnv(0),
      WORKER_METRICS_PORT: String(freePort()),
      EVENTS_QUEUE_NAME: events.name,
      WAGER_QUEUE_NAME: queues.sourceName,
      WAGER_DLQ_NAME: queues.deadLetterName,
      CONSUMER_CONCURRENCY: '1',
      DATABASE_POOL_MAX: '4',
      OUTBOX_POLL_INTERVAL_MS: '50',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '50',
      CONSUMER_RETRY_BASE_SECONDS: '1',
    });
    void new Response(worker.stdout).text();
    void new Response(worker.stderr).text();
    try {
      let dropped = 0;
      for (const table of ['outbox_messages', 'wager_transactions']) {
        for (let fault = 0; fault < FAULTS_PER_ENTRYPOINT; fault++) {
          dropped += (
            await dropConnectionsWaitingOn(orm, table, () => Bun.sleep(3000))
          ).dropped;
        }
      }
      expect(dropped).toBeGreaterThanOrEqual(4);

      const owner = uuid();
      const opened = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          playerId: owner,
          initialBalance: brl('100.00'),
        }),
      });
      const wallet = ((await opened.json()) as { id: string }).id;
      const published: string[] = [];
      await eventually(async () => {
        published.push(
          ...(await receiveEvents(sqs, events.url, 1)).map(
            (event) => event.Body ?? '',
          ),
        );
        return published.some((body) => body.includes(wallet));
      }, 30_000);

      await sendWagerMessage(
        sqs,
        queues.sourceUrl,
        {
          messageId: uuid(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            ...bet(),
            idempotencyKey: uuid(),
            playerId: owner,
            walletId: wallet,
          },
        },
        wallet,
      );
      await eventually(async () => {
        const state = await ledgerMatchesBalance(orm, wallet);
        return state.stored === '99.00' && state.rebuilt === '99.00';
      }, 20_000);
    } finally {
      worker.kill('SIGKILL');
      await worker.exited;
      await queues.close();
      await events.close();
    }
  }, 90_000);
});

describe('sessão derrubada entre os comandos da transação', () => {
  let orm: MikroORM;
  let database: string;
  let walletId: string;
  let playerId: string;
  let transactionId: string;

  const idleInTransactionTimeout = (value: string | null): Promise<unknown> =>
    orm.em
      .fork()
      .execute(
        value === null
          ? `alter database "${database}" reset idle_in_transaction_session_timeout`
          : `alter database "${database}" set idle_in_transaction_session_timeout = '${value}'`,
      );

  const bet = (wallet: string, player: string) => ({
    providerId: 'provider-idle',
    externalTransactionId: uuid(),
    playerId: player,
    walletId: wallet,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('1.00'),
  });

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    [{ database }] = await orm.em
      .fork()
      .execute<{ database: string }[]>('select current_database() as database');
    const { app, baseUrl } = await startApp();
    playerId = uuid();
    const opened = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: brl('100.00') }),
    });
    walletId = ((await opened.json()) as { id: string }).id;
    const submitted = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': uuid(),
      },
      body: JSON.stringify(bet(walletId, playerId)),
    });
    transactionId = ((await submitted.json()) as { transactionId: string })
      .transactionId;
    await app.close();
  });

  afterAll(async () => {
    await idleInTransactionTimeout(null);
    await orm.close(true);
  });

  it('conexão encerrada entre dois comandos vira falha transitória, não erro interno', async () => {
    const transactions = new MikroOrmTransactionManager(orm);
    const outcome = await transactions
      .execute(async (trx) => {
        const em = entityManagerOf(trx);
        const [{ pid }] = await em.execute<{ pid: number }[]>(
          'select pg_backend_pid() as pid',
        );
        await orm.em.fork().execute('select pg_terminate_backend(?)', [pid]);
        await Bun.sleep(300);
        await em.execute('select 1');
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(outcome).toBeInstanceOf(InfrastructureUnavailableError);
  });

  it('nenhuma rota responde 500 com sessões caindo no meio da transação', async () => {
    await idleInTransactionTimeout('1ms');
    const faulty = await startApp();
    const call = async (
      method: string,
      path: string,
      body?: () => unknown,
    ): Promise<number> =>
      (
        await fetch(faulty.baseUrl + path, {
          method,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': uuid(),
          },
          body: body === undefined ? undefined : JSON.stringify(body()),
        })
      ).status;
    const routes: [string, string, (() => unknown)?][] = [
      [
        'POST',
        '/wallets',
        () => ({ playerId: uuid(), initialBalance: brl('10.00') }),
      ],
      ['GET', `/wallets/${walletId}`],
      ['GET', `/wallets/${walletId}/ledger`],
      ['POST', `/wallets/${walletId}/reconciliation`],
      ['POST', '/wagering/transactions', () => bet(walletId, playerId)],
      ['GET', `/wagering/transactions/${transactionId}`],
    ];
    const statuses: string[] = [];
    try {
      for (const [method, path, body] of routes) {
        for (let attempt = 0; attempt < 5; attempt++) {
          statuses.push(`${method} ${path} ${await call(method, path, body)}`);
        }
      }
    } finally {
      await faulty.app.close();
      await idleInTransactionTimeout(null);
    }

    expect(statuses.filter((status) => status.endsWith(' 500'))).toEqual([]);
    expect(
      statuses.filter((status) => status.endsWith(' 503')).length,
    ).toBeGreaterThan(0);

    const healthy = await startApp();
    try {
      expect(
        (await fetch(`${healthy.baseUrl}/wallets/${walletId}`)).status,
      ).toBe(200);
    } finally {
      await healthy.app.close();
    }
  }, 60_000);

  it('a fila trata a sessão derrubada como transitória: sem FAILED, sem DLQ, aplica uma vez depois', async () => {
    const sqs = testSqs();
    const queues = await wagerQueues(sqs, 2);
    await idleInTransactionTimeout('1ms');
    const worker = spawnWorker({
      ...testAppEnv(0),
      WORKER_METRICS_PORT: String(freePort()),
      WAGER_QUEUE_NAME: queues.sourceName,
      WAGER_DLQ_NAME: queues.deadLetterName,
      CONSUMER_CONCURRENCY: '1',
      CONSUMER_RETRY_BASE_SECONDS: '1',
    });
    void new Response(worker.stdout).text();
    void new Response(worker.stderr).text();
    const message = bet(walletId, playerId);
    try {
      await sendWagerMessage(
        sqs,
        queues.sourceUrl,
        {
          messageId: uuid(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...message, idempotencyKey: uuid() },
        },
        walletId,
      );
      await Bun.sleep(4000);
      const [recorded] = await orm.em
        .fork()
        .execute<{ n: string }[]>(
          'select count(*) as n from wager_transactions where external_transaction_id = ?',
          [message.externalTransactionId],
        );
      expect(Number(recorded.n)).toBe(0);

      await idleInTransactionTimeout(null);
      await eventually(async () => {
        const [row] = await orm.em
          .fork()
          .execute<{ status: string }[]>(
            'select status from wager_transactions where external_transaction_id = ?',
            [message.externalTransactionId],
          );
        return row?.status === 'PROCESSED';
      }, 30_000);
      const [effects] = await orm.em
        .fork()
        .execute<{ n: string }[]>(
          'select count(*) as n from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id where t.external_transaction_id = ?',
          [message.externalTransactionId],
        );
      expect(Number(effects.n)).toBe(1);
      const state = await ledgerMatchesBalance(orm, walletId);
      expect(state.stored).toBe(state.rebuilt);
    } finally {
      worker.kill('SIGKILL');
      await worker.exited;
      await queues.close();
    }
  }, 60_000);
});
