import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { Logger, type INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Registry } from 'prom-client';

import {
  entityManagerOf,
  MikroOrmTransactionManager,
} from '../../src/infra/database/mikro-orm-transaction-manager';
import { PrometheusPendingReferenceMonitor } from '../../src/infra/observability/pending-reference-monitor';
import type { TransactionManager } from '../../src/modules/@shared/domain/transaction/transaction-manager';
import { WageringFactory } from '../../src/modules/wagering/factory/wagering.factory';
import { WagerTransactionRepository } from '../../src/modules/wagering/repository/wager-transaction.repository';
import type { SubmitWagerTransactionUseCaseInputDto } from '../../src/modules/wagering/usecase/submit/submit.usecase.dto';
import { deferred, eventually } from '../support/async';
import {
  ledgerMatchesBalance,
  migrateFresh,
  openTestOrm,
} from '../support/database';
import { startApp } from '../support/http-app';
import { eventsQueue, receiveEvents, testSqs } from '../support/outbox';
import { freePort, spawnWorker, testAppEnv } from '../support/process';
import { retryTransient } from '../support/retry-transient';

type Wallet = { walletId: string; playerId: string };
type Body = Omit<
  SubmitWagerTransactionUseCaseInputDto,
  'idempotencyKey' | 'correlationId'
>;
type Result = {
  transactionId: string;
  status: string;
  failureCode: string | null;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
};
const uuid = () => Bun.randomUUIDv7();
const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('referências pendentes com PostgreSQL e LocalStack reais', () => {
  let orm: MikroORM;
  let app: INestApplication;
  let baseUrl: string;
  const sqs = testSqs();
  let queue: Awaited<ReturnType<typeof eventsQueue>>;
  let registry: Registry;
  let monitor: PrometheusPendingReferenceMonitor;
  let now: Date;
  let logs: unknown[];
  let restore: (() => void)[];

  beforeAll(async () => {
    orm = await openTestOrm();
  });
  beforeEach(async () => {
    await migrateFresh(orm);
    queue = await eventsQueue(sqs);
    ({ app, baseUrl } = await startApp({ eventsQueueName: queue.name }));
    now = new Date(Date.now() + 1000);
    registry = new Registry();
    monitor = new PrometheusPendingReferenceMonitor(registry);
    logs = [];
    restore = ['log', 'error'].map((level) => {
      const spy = spyOn(
        Logger.prototype,
        level as 'log' | 'error',
      ).mockImplementation((value: unknown) => {
        logs.push(value);
      });
      return () => spy.mockRestore();
    });
  });
  afterEach(async () => {
    for (const undo of restore) {
      undo();
    }
    await app.close();
    await queue.close();
  });
  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  const open = async (): Promise<Wallet> => {
    const playerId = uuid();
    const response = await fetch(baseUrl + '/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: brl('100.00') }),
    });
    expect(response.status).toBe(201);
    return {
      walletId: ((await response.json()) as { id: string }).id,
      playerId,
    };
  };
  const body = (wallet: Wallet, overrides: Partial<Body> = {}): Body => ({
    ...wallet,
    providerId: 'provider-pending',
    externalTransactionId: uuid(),
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'REFUND',
    money: brl('25.00'),
    referenceExternalTransactionId: 'missing',
    ...overrides,
  });
  const submit = async (
    payload: Body,
    key = uuid(),
    correlationId = uuid(),
  ) => {
    const response = await retryTransient(() =>
      fetch(baseUrl + '/wagering/transactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': key,
          'X-Correlation-Id': correlationId,
        },
        body: JSON.stringify(payload),
      }),
    );
    return {
      status: response.status,
      result: (await response.json()) as Result,
      key,
      correlationId,
    };
  };
  const invariant = async (wallet: Wallet) => {
    const state = await ledgerMatchesBalance(orm, wallet.walletId);
    expect(state.stored).toBe(state.rebuilt);
    return state.stored;
  };
  const forceNext = (id: string, at = new Date(now.getTime() - 1)) =>
    orm.em
      .fork()
      .execute(
        'update wager_transactions set next_reference_attempt_at=? where id=?',
        [at, id],
      );
  const row = async (id: string) =>
    (
      await orm.em.fork().execute<
        {
          status: string;
          reference_attempts: number;
          next_reference_attempt_at: string | null;
          failure_code: string | null;
          correlation_id: string;
        }[]
      >('select status,reference_attempts,next_reference_attempt_at,failure_code,correlation_id from wager_transactions where id=?', [id])
    )[0];
  const events = (id: string) =>
    orm.em.fork().execute<
      {
        event_type: string;
        payload: {
          correlationId: string;
          causationId?: string;
          eventId: string;
          data: { transactionId: string };
        };
      }[]
    >("select event_type,payload from outbox_messages where payload->'data'->>'transactionId'=? order by sequence", [id]);
  const cycle = (
    ttl = 3600,
    transactions: TransactionManager = new MikroOrmTransactionManager(orm),
  ) =>
    WageringFactory.create({
      transactions,
      ids: { next: uuid },
      clock: { now: () => now },
      pendingMonitor: monitor,
      pendingReferenceTtlSeconds: ttl,
    }).resolvePending.execute({ limit: 100 });
  const bet = async (wallet: Wallet, externalTransactionId: string) => {
    const response = await submit(
      body(wallet, {
        kind: 'BET',
        referenceExternalTransactionId: undefined,
        externalTransactionId,
      }),
    );
    expect(response.status).toBe(201);
    return response.result;
  };

  it('ausência agenda backoff sem repetir evento; replay continua 202', async () => {
    const wallet = await open();
    const payload = body(wallet);
    const accepted = await submit(payload);
    expect(accepted.status).toBe(202);
    expect(accepted.result).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: null,
      failureCode: null,
      idempotentReplay: false,
    });
    await forceNext(accepted.result.transactionId);
    expect(await cycle()).toEqual({ attempted: 1 });
    const state = await row(accepted.result.transactionId);
    expect(state.status).toBe('PENDING_REFERENCE');
    expect(state.reference_attempts).toBe(1);
    expect(new Date(state.next_reference_attempt_at!).getTime()).toBe(
      now.getTime() + 1000,
    );
    expect(await events(accepted.result.transactionId)).toHaveLength(1);
    expect((await submit(payload, accepted.key)).result).toEqual({
      ...accepted.result,
      idempotentReplay: true,
    });
    expect(await registry.metrics()).toContain(
      'pending_reference_retries_total 1',
    );
    expect(await registry.metrics()).toContain(
      'pending_reference_transactions 1',
    );
    expect(await invariant(wallet)).toBe('100.00');
  });

  it('chegada do BET acelera somente pendentes da mesma wallet e replay devolve o desfecho atual', async () => {
    const wallet = await open();
    const other = await open();
    const external = uuid();
    const payload = body(wallet, { referenceExternalTransactionId: external });
    const accepted = await submit(payload);
    const foreign = await submit(
      body(other, { referenceExternalTransactionId: external }),
    );
    const later = new Date(now.getTime() + 300000);
    await forceNext(accepted.result.transactionId, later);
    await forceNext(foreign.result.transactionId, later);
    const reference = await bet(wallet, external);
    expect(
      new Date(
        (await row(accepted.result.transactionId)).next_reference_attempt_at!,
      ).getTime(),
    ).toBeLessThanOrEqual(now.getTime());
    expect(
      new Date(
        (await row(foreign.result.transactionId)).next_reference_attempt_at!,
      ).getTime(),
    ).toBe(later.getTime());
    expect(await cycle()).toEqual({ attempted: 1 });
    const replay = await submit(payload, accepted.key);
    expect(replay.status).toBe(201);
    expect(replay.result).toMatchObject({
      status: 'PROCESSED',
      balance: brl('100.00'),
      idempotentReplay: true,
    });
    const get = await fetch(
      baseUrl + '/wagering/transactions/' + accepted.result.transactionId,
    );
    expect(await get.json()).toMatchObject({
      referenceExternalTransactionId: external,
      referenceTransactionId: reference.transactionId,
    });
    const recorded = await events(accepted.result.transactionId);
    expect(recorded.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(
      recorded.every(
        (event) => event.payload.correlationId === accepted.correlationId,
      ),
    ).toBe(true);
    expect(recorded[2].payload.causationId).toBe(recorded[1].payload.eventId);
    expect((await row(accepted.result.transactionId)).correlation_id).toBe(
      accepted.correlationId,
    );
    await forceNext(foreign.result.transactionId);
    expect(await cycle()).toEqual({ attempted: 1 });
    expect(await row(foreign.result.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_MISMATCH',
    });
    await bet(wallet, uuid());
    expect((await submit(payload, accepted.key)).result.balance).toEqual(
      brl('100.00'),
    );
    expect(await invariant(wallet)).toBe('75.00');
    expect(await invariant(other)).toBe('100.00');
    expect(await registry.metrics()).toContain(
      'pending_reference_resolved_total{outcome="processed"} 1',
    );
  });

  it('WIN antes do BET é aceito e resolvido quando a referência chega', async () => {
    const wallet = await open();
    const external = uuid();
    const payload = body(wallet, {
      kind: 'WIN',
      money: brl('10.00'),
      referenceExternalTransactionId: external,
    });
    const accepted = await submit(payload);
    expect(accepted.status).toBe(202);
    await bet(wallet, external);
    expect(await cycle()).toEqual({ attempted: 1 });
    expect((await submit(payload, accepted.key)).result).toMatchObject({
      status: 'PROCESSED',
      balance: brl('85.00'),
    });
    expect(await invariant(wallet)).toBe('85.00');
  });

  it('WIN pendente é rejeitado se o BET chega e é devolvido antes da resolução', async () => {
    const wallet = await open();
    const external = uuid();
    const payload = body(wallet, {
      kind: 'WIN',
      money: brl('500.00'),
      referenceExternalTransactionId: external,
    });
    const accepted = await submit(payload);
    expect(accepted.status).toBe(202);
    await bet(wallet, external);
    const refund = await submit(
      body(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: external,
      }),
    );
    expect(refund.status).toBe(201);
    expect(await cycle()).toEqual({ attempted: 1 });
    const replay = await submit(payload, accepted.key);
    expect(replay.status).toBe(422);
    expect(replay.result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
      balance: brl('100.00'),
    });
    expect(await invariant(wallet)).toBe('100.00');
  });

  it('ROLLBACK de REFUND que espera BET resolve a cadeia em ordem', async () => {
    const wallet = await open();
    const external = uuid();
    const refundBody = body(wallet, {
      referenceExternalTransactionId: external,
    });
    const refund = await submit(refundBody);
    const rollback = await submit(
      body(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: refundBody.externalTransactionId,
      }),
    );
    expect(refund.status).toBe(202);
    expect(rollback.status).toBe(202);
    await forceNext(
      refund.result.transactionId,
      new Date(now.getTime() + 300000),
    );
    await forceNext(
      rollback.result.transactionId,
      new Date(now.getTime() + 300000),
    );
    await bet(wallet, external);
    expect(await cycle()).toEqual({ attempted: 1 });
    expect((await row(refund.result.transactionId)).status).toBe('PROCESSED');
    expect((await row(rollback.result.transactionId)).status).toBe(
      'PENDING_REFERENCE',
    );
    expect(await cycle()).toEqual({ attempted: 1 });
    expect((await row(rollback.result.transactionId)).status).toBe('PROCESSED');
    expect(await invariant(wallet)).toBe('75.00');
  });

  it('TTL curto expira referência ausente com rejeição, evento e replay 422', async () => {
    const wallet = await open();
    const payload = body(wallet);
    const accepted = await submit(payload);
    now = new Date(now.getTime() + 2000);
    await forceNext(accepted.result.transactionId);
    expect(await cycle(1)).toEqual({ attempted: 1 });
    const replay = await submit(payload, accepted.key);
    expect(replay.status).toBe(422);
    expect(replay.result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      balance: brl('100.00'),
      idempotentReplay: true,
    });
    expect(
      (await events(accepted.result.transactionId)).map(
        (event) => event.event_type,
      ),
    ).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await registry.metrics()).toContain(
      'pending_reference_resolved_total{outcome="expired"} 1',
    );
    expect(await registry.metrics()).toContain(
      'pending_reference_transactions 0',
    );
    expect(await invariant(wallet)).toBe('100.00');
  });

  it('o agendamento respeita o TTL mesmo quando o próximo backoff o ultrapassaria', async () => {
    const wallet = await open();
    const accepted = await submit(body(wallet));
    const [{ created_at }] = await orm.em
      .fork()
      .execute<{ created_at: string }[]>(
        'select created_at from wager_transactions where id=?',
        [accepted.result.transactionId],
      );
    now = new Date(
      (await row(accepted.result.transactionId)).next_reference_attempt_at!,
    );
    await cycle(3);
    now = new Date(
      (await row(accepted.result.transactionId)).next_reference_attempt_at!,
    );
    await cycle(3);
    const deadline = new Date(created_at).getTime() + 3000;
    expect(
      new Date(
        (await row(accepted.result.transactionId)).next_reference_attempt_at!,
      ).getTime(),
    ).toBe(deadline);
    now = new Date(deadline);
    await cycle(3);
    expect(await row(accepted.result.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(await invariant(wallet)).toBe('100.00');
  });

  it('trigger inesperado encerra a pendência como FAILED auditável, sem retry sem fim', async () => {
    const wallet = await open();
    const external = uuid();
    const accepted = await submit(
      body(wallet, { referenceExternalTransactionId: external }),
    );
    await bet(wallet, external);
    now = new Date(now.getTime() + 2000);
    await orm.em.fork()
      .execute(`create function test_pending_failure() returns trigger language plpgsql as $$
      begin if new.status='PROCESSED' and old.status='PENDING_REFERENCE' then raise exception 'falha financeira secreta 123456.78'; end if; return new; end $$`);
    await orm.em
      .fork()
      .execute(
        'create trigger test_pending_failure before update on wager_transactions for each row execute function test_pending_failure()',
      );
    try {
      expect(await cycle(1)).toEqual({ attempted: 1 });
      expect(await row(accepted.result.transactionId)).toMatchObject({
        status: 'FAILED',
        failure_code: 'PROCESSING_FAILED',
        next_reference_attempt_at: null,
      });
      expect(await events(accepted.result.transactionId)).toHaveLength(1);
      expect(await registry.metrics()).toContain(
        'pending_reference_resolved_total{outcome="failed"} 1',
      );
      expect(JSON.stringify(logs)).not.toContain('123456.78');
      expect(JSON.stringify(logs)).not.toContain('falha financeira secreta');
      expect(await invariant(wallet)).toBe('75.00');
    } finally {
      await orm.em
        .fork()
        .execute('drop trigger test_pending_failure on wager_transactions');
      await orm.em.fork().execute('drop function test_pending_failure()');
    }
    now = new Date(now.getTime() + 3_600_000);
    expect(await cycle(1)).toEqual({ attempted: 0 });
    expect((await row(accepted.result.transactionId)).status).toBe('FAILED');
    expect(await events(accepted.result.transactionId)).toHaveLength(1);
    expect(await invariant(wallet)).toBe('75.00');
  });

  it('referência que chega rejeitada produz rejeição auditável no ciclo normal', async () => {
    const wallet = await open();
    const external = uuid();
    const accepted = await submit(
      body(wallet, { referenceExternalTransactionId: external }),
    );
    const rejected = await submit(
      body(wallet, {
        kind: 'BET',
        referenceExternalTransactionId: undefined,
        externalTransactionId: external,
        money: brl('200.00'),
      }),
    );
    expect(rejected.status).toBe(422);
    await forceNext(accepted.result.transactionId);
    await cycle();
    expect(await row(accepted.result.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
    });
    expect(
      (await events(accepted.result.transactionId)).map(
        (event) => event.event_type,
      ),
    ).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await registry.metrics()).toContain(
      'pending_reference_resolved_total{outcome="rejected"} 1',
    );
    expect(await invariant(wallet)).toBe('100.00');
  });

  it('referência existente mas pendente continua aguardando mesmo depois do TTL', async () => {
    const wallet = await open();
    const refundBody = body(wallet);
    const refund = await submit(refundBody);
    const rollback = await submit(
      body(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: refundBody.externalTransactionId,
      }),
    );
    now = new Date(now.getTime() + 2000);
    await forceNext(
      refund.result.transactionId,
      new Date(now.getTime() + 300000),
    );
    await forceNext(rollback.result.transactionId);
    expect(await cycle(1)).toEqual({ attempted: 1 });
    expect(await row(rollback.result.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      failure_code: null,
      reference_attempts: 1,
    });
    expect(await events(rollback.result.transactionId)).toHaveLength(1);
    expect(await invariant(wallet)).toBe('100.00');
  });

  it('worker espera a wallet sem capturar antes a linha pendente', async () => {
    const wallet = await open();
    const accepted = await submit(body(wallet));
    await forceNext(accepted.result.transactionId);
    const held = deferred();
    const release = deferred();
    const real = new MikroOrmTransactionManager(orm);
    const holder = real.execute(async (trx) => {
      await entityManagerOf(trx).execute(
        'select id from wallets where id=? for update',
        [wallet.walletId],
      );
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const longWait: TransactionManager = {
      snapshot: (work) => real.snapshot(work),
      execute: (work) =>
        real.execute(async (trx) => {
          await entityManagerOf(trx).execute("set local lock_timeout='10s'");
          return work(trx);
        }),
    };
    const running = cycle(3600, longWait);
    try {
      await eventually(
        async () =>
          Number(
            (
              await orm.em
                .fork()
                .execute<{ n: string }[]>(
                  "select count(*)::text as n from pg_stat_activity where wait_event_type='Lock' and query ilike '%wallets%for update%'",
                )
            )[0].n,
          ) > 0,
        5000,
      );
      const captured = await real.execute((trx) =>
        new WagerTransactionRepository().lockPendingReference(
          accepted.result.transactionId,
          trx,
        ),
      );
      expect(captured?.id).toBe(accepted.result.transactionId);
    } finally {
      release.resolve();
      await Promise.allSettled([holder, running]);
    }
    expect(await invariant(wallet)).toBe('100.00');
  });

  const startWorker = async () => {
    const port = freePort();
    const child = spawnWorker({
      ...testAppEnv(0),
      EVENTS_QUEUE_NAME: queue.name,
      WORKER_METRICS_PORT: String(port),
      OUTBOX_POLL_INTERVAL_MS: '20',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '30',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      await eventually(async () => {
        if (child.exitCode !== null) {
          throw new Error('worker terminou no boot: ' + (await stderr));
        }
        return (
          (
            await fetch(`http://127.0.0.1:${port}/metrics`).catch(
              () => undefined,
            )
          )?.status === 200
        );
      });
    } catch (error) {
      child.kill('SIGKILL');
      await child.exited;
      throw error;
    }
    return { child, stdout, stderr, port };
  };
  const stopWorker = async (
    worker: Awaited<ReturnType<typeof startWorker>>,
  ) => {
    worker.child.kill('SIGKILL');
    await worker.child.exited;
    await worker.stderr;
    return worker.stdout;
  };

  it('reinício com dois processos resolve pendentes gravadas com o worker parado uma única vez', async () => {
    const previous = await startWorker();
    await stopWorker(previous);
    const records: {
      wallet: Wallet;
      accepted: Awaited<ReturnType<typeof submit>>;
    }[] = [];
    for (let i = 0; i < 5; i++) {
      const wallet = await open();
      const external = uuid();
      const accepted = await submit(
        body(wallet, { referenceExternalTransactionId: external }),
      );
      expect(accepted.status).toBe(202);
      await bet(wallet, external);
      records.push({ wallet, accepted });
    }
    const workers = await Promise.all([startWorker(), startWorker()]);
    try {
      await eventually(async () =>
        (
          await Promise.all(
            records.map((record) => row(record.accepted.result.transactionId)),
          )
        ).every((state) => state.status === 'PROCESSED'),
      );
      const received = (await receiveEvents(sqs, queue.url, 35)).map(
        (message) => JSON.parse(message.Body!),
      );
      for (const { wallet, accepted } of records) {
        expect(await invariant(wallet)).toBe('100.00');
        const recorded = await events(accepted.result.transactionId);
        expect(recorded.map((event) => event.event_type)).toEqual([
          'WagerTransactionPendingReference',
          'WagerTransactionProcessed',
          'WalletBalanceChanged',
        ]);
        const published = received.filter(
          (event) => event.data.transactionId === accepted.result.transactionId,
        );
        expect(published).toHaveLength(3);
        expect(
          published.every(
            (event) => event.correlationId === accepted.correlationId,
          ),
        ).toBe(true);
      }
      const metrics = await Promise.all(
        workers.map((worker) =>
          fetch(`http://127.0.0.1:${worker.port}/metrics`).then((response) =>
            response.text(),
          ),
        ),
      );
      const resolved = metrics.reduce(
        (total, text) =>
          total +
          Number(
            text.match(
              /pending_reference_resolved_total\{outcome="processed"\} (\d+)/,
            )?.[1] ?? '0',
          ),
        0,
      );
      expect(resolved).toBe(5);
    } finally {
      await Promise.all(workers.map(stopWorker));
    }
  }, 30000);

  it.skipIf(process.platform === 'win32')(
    'SIGTERM termina o lote pendente capturado, deixa o próximo para depois e sai com zero',
    async () => {
      const wallet = await open();
      const referenceIds: string[] = [];
      for (let index = 0; index < 101; index++) {
        const external = uuid();
        const accepted = await submit(
          body(wallet, {
            money: brl('0.01'),
            referenceExternalTransactionId: external,
          }),
        );
        expect(accepted.status).toBe(202);
        referenceIds.push(external);
      }
      for (const external of referenceIds) {
        const processed = await submit(
          body(wallet, {
            kind: 'BET',
            referenceExternalTransactionId: undefined,
            externalTransactionId: external,
            money: brl('0.01'),
          }),
        );
        expect(processed.status).toBe(201);
      }
      await orm.em.fork()
        .execute(`create function test_pending_gate() returns trigger language plpgsql as $$
      begin if old.status='PENDING_REFERENCE' and new.status='PROCESSED' then perform pg_advisory_xact_lock(9050,5); end if; return new; end $$`);
      await orm.em
        .fork()
        .execute(
          'create trigger test_pending_gate before update on wager_transactions for each row execute function test_pending_gate()',
        );
      const held = deferred();
      const release = deferred();
      const holder = new MikroOrmTransactionManager(orm).execute(
        async (trx) => {
          await entityManagerOf(trx).execute(
            'select pg_advisory_xact_lock(9050,5)',
          );
          held.resolve();
          await release.promise;
        },
      );
      await held.promise;
      let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
      try {
        worker = await startWorker();
        await eventually(
          async () =>
            Number(
              (
                await orm.em
                  .fork()
                  .execute<{ n: string }[]>(
                    "select count(*)::text as n from pg_stat_activity where wait_event_type='Lock' and wait_event='advisory'",
                  )
              )[0].n,
            ) > 0,
        );
        worker.child.kill('SIGTERM');
        expect(worker.child.exitCode).toBeNull();
        release.resolve();
        await holder;
        const child = worker.child;
        await eventually(async () => child.exitCode !== null, 15000);
        expect(await child.exited).toBe(0);
        const [count] = await orm.em
          .fork()
          .execute<{ processed: string; pending: string }[]>(
            "select count(*) filter(where status='PROCESSED')::text as processed,count(*) filter(where status='PENDING_REFERENCE')::text as pending from wager_transactions where kind='REFUND'",
          );
        expect(count).toEqual({ processed: '100', pending: '1' });
        expect(await invariant(wallet)).toBe('99.99');
        expect(await worker.stdout).toContain(
          'pending_reference_worker_stopped',
        );
      } finally {
        release.resolve();
        await holder;
        if (worker) {
          await stopWorker(worker);
        }
        await orm.em
          .fork()
          .execute('drop trigger test_pending_gate on wager_transactions');
        await orm.em.fork().execute('drop function test_pending_gate()');
      }
    },
    60000,
  );
});
