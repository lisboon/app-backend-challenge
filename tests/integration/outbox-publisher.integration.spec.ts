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
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Registry } from 'prom-client';

import {
  entityManagerOf,
  MikroOrmTransactionManager,
} from '../../src/infra/database/mikro-orm-transaction-manager';
import { PrometheusOutboxMonitor } from '../../src/infra/observability/outbox-monitor';
import { SqsEventPublisher } from '../../src/infra/queue/sqs-event-publisher';
import { OutboxMessage } from '../../src/modules/@shared/domain/outbox/outbox-message.entity';
import type { TransactionManager } from '../../src/modules/@shared/domain/transaction/transaction-manager';
import type { EventPublisherGateway } from '../../src/modules/@shared/gateway/event-publisher.gateway';
import { OutboxRepository } from '../../src/modules/@shared/repository/outbox.repository';
import { PublishOutboxUseCase } from '../../src/modules/@shared/usecase/publish-outbox/publish-outbox.usecase';
import { deferred, eventually } from '../support/async';
import {
  openTestOrm,
  migrateFresh,
  ledgerMatchesBalance,
} from '../support/database';
import {
  eventsQueue,
  queueIsEmpty,
  receiveEvents,
  seedOutbox,
  testSqs,
} from '../support/outbox';
import { freePort, spawnApp, testAppEnv, waitReady } from '../support/process';
import { retryTransient } from '../support/retry-transient';

const clock = { now: () => new Date() };

describe('publicação da outbox com PostgreSQL e SQS reais', () => {
  let orm: MikroORM;

  const sqs = testSqs();
  let queue: Awaited<ReturnType<typeof eventsQueue>>;
  let quiet: { mockRestore(): void };
  let registry: Registry;
  let monitor: PrometheusOutboxMonitor;

  beforeAll(async () => {
    orm = await openTestOrm();
  });
  beforeEach(async () => {
    quiet = spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await migrateFresh(orm);
    queue = await eventsQueue(sqs);
    registry = new Registry();
    monitor = new PrometheusOutboxMonitor(registry);
  });
  afterEach(async () => {
    quiet.mockRestore();
    await queue.close();
  });

  afterAll(async () => {
    await orm.close(true);
    sqs.destroy();
  });

  const publisher = (
    gateway: EventPublisherGateway = new SqsEventPublisher(sqs, queue.name),
    now = clock,
    transactions: TransactionManager = new MikroOrmTransactionManager(orm),
  ) =>
    new PublishOutboxUseCase(
      transactions,
      new OutboxRepository(),
      gateway,
      now,
      monitor,
    );

  const rows = async () =>
    (
      await orm.em.fork().execute<
        {
          id: string;
          attempts: number;
          next_attempt_at: string;
          published_at: string | null;
          last_error: string | null;
        }[]
      >('select id,attempts,next_attempt_at,published_at,last_error from outbox_messages order by sequence')
    ).map((row) => ({
      ...row,
      next_attempt_at: new Date(row.next_attempt_at),
      published_at:
        row.published_at === null ? null : new Date(row.published_at),
    }));

  it('dois publishers repartem 200 eventos sem esperar o lote travado nem enviar a mesma linha', async () => {
    const messages = await seedOutbox(orm, 200);
    const entered = [deferred(), deferred()];
    const release = deferred();
    const active = new Set<string>();
    const owners = new Map<string, number>();
    const counts = [0, 0];
    const inFlight = [0, 0];
    const peakInFlight = [0, 0];
    const gateway = new SqsEventPublisher(sqs, queue.name);
    const make = (index: number): EventPublisherGateway => ({
      publish: async (message) => {
        if (active.has(message.id) || owners.has(message.id)) {
          throw new Error('mesma linha capturada por dois publishers');
        }
        active.add(message.id);
        inFlight[index]++;
        peakInFlight[index] = Math.max(peakInFlight[index], inFlight[index]);
        owners.set(message.id, index);
        counts[index]++;
        if (counts[index] === 1) {
          entered[index].resolve();
          await release.promise;
        }
        try {
          await gateway.publish(message);
        } finally {
          active.delete(message.id);
          inFlight[index]--;
        }
      },
    });
    const first = publisher(make(0)).execute({ limit: 100 });
    await entered[0].promise;
    const second = publisher(make(1)).execute({ limit: 100 });
    try {
      const progressed = await Promise.race([
        entered[1].promise.then(() => true),
        Bun.sleep(1200).then(() => false),
      ]);
      expect(progressed).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
    expect(await first).toEqual({ attempted: 100 });
    expect(await second).toEqual({ attempted: 100 });
    expect(counts).toEqual([100, 100]);
    for (const peak of peakInFlight) {
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(10);
    }
    expect(owners.size).toBe(200);
    expect((await rows()).every((row) => row.published_at !== null)).toBe(true);
    const received = await receiveEvents(sqs, queue.url, 200);
    expect(
      new Set(received.map((message) => JSON.parse(message.Body!).eventId)),
    ).toEqual(new Set(messages.map((message) => message.id)));
    for (const message of received) {
      const event = JSON.parse(message.Body!);
      expect(message.Attributes?.MessageGroupId).toBe(event.aggregateId);
      expect(message.Attributes?.MessageDeduplicationId).toBe(event.eventId);
    }
  }, 30_000);

  it('publica somente depois do commit financeiro', async () => {
    const staged = deferred();
    const release = deferred();
    const repository = new OutboxRepository();
    const [message] = await seedOutbox(orm, 1);
    await publisher().execute({ limit: 10 });
    await receiveEvents(sqs, queue.url, 1);
    const cloned = { id: Bun.randomUUIDv7(), aggregateId: Bun.randomUUIDv7() };
    const pending = OutboxMessage.rehydrate({
      id: cloned.id,
      aggregateId: cloned.aggregateId,
      eventType: message.eventType,
      payload: {
        ...message.payload,
        eventId: cloned.id,
        aggregateId: cloned.aggregateId,
      },
      occurredAt: message.occurredAt,
      attempts: 0,
      nextAttemptAt: message.occurredAt,
      publishedAt: undefined,
    });
    const transaction = new MikroOrmTransactionManager(orm).execute(
      async (trx) => {
        await repository.create(pending, trx);
        staged.resolve();
        await release.promise;
      },
    );
    await staged.promise;
    try {
      expect(await publisher().execute({ limit: 10 })).toEqual({
        attempted: 0,
      });
      expect(await queueIsEmpty(sqs, queue.url)).toBe(true);
    } finally {
      release.resolve();
      await transaction;
    }
    expect(await publisher().execute({ limit: 10 })).toEqual({ attempted: 1 });
    expect(
      JSON.parse((await receiveEvents(sqs, queue.url, 1))[0].Body!).eventId,
    ).toBe(pending.id);
  });

  it('eventos da mesma wallet chegam por sequence mesmo com UUIDs e datas invertidos', async () => {
    const aggregateId = Bun.randomUUIDv7();
    await seedOutbox(orm, 5, aggregateId, (message, index) => {
      const id =
        'ffffffff-ffff-7fff-bfff-' + String(5 - index).padStart(12, '0');
      const occurredAt = new Date(Date.now() - 60_000 - index * 1000);
      return OutboxMessage.rehydrate({
        id,
        aggregateId,
        eventType: message.eventType,
        payload: {
          ...message.payload,
          eventId: id,
          occurredAt: occurredAt.toISOString(),
        },
        occurredAt,
        attempts: 0,
        nextAttemptAt: occurredAt,
        publishedAt: undefined,
      });
    });
    const real = new SqsEventPublisher(sqs, queue.name);
    let inFlight = 0;
    let peak = 0;
    const serial: EventPublisherGateway = {
      publish: async (message) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          await real.publish(message);
        } finally {
          inFlight--;
        }
      },
    };
    const results = await Promise.all([
      publisher(serial).execute({ limit: 10 }),
      publisher(serial).execute({ limit: 10 }),
    ]);
    expect(results.reduce((sum, result) => sum + result.attempted, 0)).toBe(5);
    expect(peak).toBe(1);
    const received = await receiveEvents(sqs, queue.url, 5);
    expect(
      received.map((message) => JSON.parse(message.Body!).data.index),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it('retry futuro impede que outro evento da mesma wallet ultrapasse o anterior', async () => {
    await seedOutbox(orm, 2, Bun.randomUUIDv7());
    let at = new Date();
    const now = { now: () => at };
    const failing: EventPublisherGateway = {
      publish: async () => {
        throw new Error('falha injetada');
      },
    };
    expect(await publisher(failing, now).execute({ limit: 10 })).toEqual({
      attempted: 1,
    });
    expect(await publisher(undefined, now).execute({ limit: 10 })).toEqual({
      attempted: 0,
    });
    expect(await queueIsEmpty(sqs, queue.url)).toBe(true);
    at = new Date(at.getTime() + 1000);
    expect(await publisher(undefined, now).execute({ limit: 10 })).toEqual({
      attempted: 2,
    });
    expect(await publisher(undefined, now).execute({ limit: 10 })).toEqual({
      attempted: 0,
    });
    const received = await receiveEvents(sqs, queue.url, 2);
    expect(
      received.map((message) => JSON.parse(message.Body!).data.index),
    ).toEqual([0, 1]);
  });

  it('SQS fora preserva pendência, aplica backoff e publica quando volta', async () => {
    await seedOutbox(orm, 1);
    let at = new Date();
    const now = { now: () => at };
    const unavailable = testSqs('http://127.0.0.1:1');
    try {
      const useCase = publisher(
        new SqsEventPublisher(unavailable, queue.name),
        now,
      );
      expect(await useCase.execute({ limit: 10 })).toEqual({ attempted: 1 });
      let [row] = await rows();
      expect(row.attempts).toBe(1);
      expect(row.published_at).toBeNull();
      expect(row.next_attempt_at.getTime() - at.getTime()).toBe(1000);
      expect(row.last_error).toBe('ECONNREFUSED');
      expect(await useCase.execute({ limit: 10 })).toEqual({ attempted: 0 });
      at = new Date(at.getTime() + 1000);
      await useCase.execute({ limit: 10 });
      [row] = await rows();
      expect(row.attempts).toBe(2);
      expect(row.next_attempt_at.getTime() - at.getTime()).toBe(2000);
      expect(row.published_at).toBeNull();
      at = new Date(at.getTime() + 2000);
      await publisher(undefined, now).execute({ limit: 10 });
      [row] = await rows();
      expect(row.published_at).toEqual(at);
      expect(row.last_error).toBeNull();
      expect(await receiveEvents(sqs, queue.url, 1)).toHaveLength(1);
      const text = await registry.metrics();
      expect(text).toContain(
        'outbox_publish_failures_total{event_type="WagerTransactionProcessed"} 2',
      );
      expect(text).toContain(
        'outbox_published_total{event_type="WagerTransactionProcessed"} 1',
      );
      expect(text).toContain(
        'outbox_publish_retries_total{event_type="WagerTransactionProcessed"} 2',
      );
      expect(text).toContain('outbox_lag_seconds 0');
    } finally {
      unavailable.destroy();
    }
  });

  it('uma falha não impede outra wallet e o lag inclui retries futuros', async () => {
    const messages = await seedOutbox(orm, 2);
    const real = new SqsEventPublisher(sqs, queue.name);
    const logs: unknown[] = [];
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation((value) => {
      logs.push(value);
    });
    try {
      await publisher({
        publish: async (message) => {
          if (message.id === messages[0].id) {
            throw new Error('segredo financeiro 123456.78');
          }
          await real.publish(message);
        },
      }).execute({ limit: 10 });
      const stored = await rows();
      expect(stored[0].published_at).toBeNull();
      expect(stored[0].attempts).toBe(1);
      expect(stored[0].last_error).toBe('Error');
      expect(stored[1].published_at).not.toBeNull();
      expect(JSON.stringify(logs)).not.toContain('123456.78');
      expect(logs).toHaveLength(1);
      expect(
        Number(
          (await registry.metrics()).match(/^outbox_lag_seconds (\S+)/m)![1],
        ),
      ).toBeGreaterThanOrEqual(60);
      expect(await receiveEvents(sqs, queue.url, 1)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('SQS recebeu mas commit falhou: reenvia o mesmo eventId sem perder o evento', async () => {
    const [message] = await seedOutbox(orm, 1);
    const real = new MikroOrmTransactionManager(orm);
    let sends = 0;
    const gateway = new SqsEventPublisher(sqs, queue.name);
    const counted: EventPublisherGateway = {
      publish: async (event) => {
        sends++;
        await gateway.publish(event);
      },
    };
    const aborting: TransactionManager = {
      execute: (work) =>
        real.execute(async (trx) => {
          await work(trx);
          throw new Error('commit abortado');
        }),
      snapshot: (work) => real.snapshot(work),
    };
    expect(
      await publisher(counted, clock, aborting)
        .execute({ limit: 10 })
        .catch((error: unknown) => error),
    ).toBeInstanceOf(Error);
    expect((await rows())[0].published_at).toBeNull();
    await publisher(counted).execute({ limit: 10 });
    expect(sends).toBe(2);
    expect((await rows())[0].published_at).not.toBeNull();
    const received = await receiveEvents(sqs, queue.url, 1);
    expect(JSON.parse(received[0].Body!).eventId).toBe(message.id);
    expect(await queueIsEmpty(sqs, queue.url)).toBe(true);
  });

  it('o SQL exclui linha publicada mesmo quando sua próxima tentativa venceu', async () => {
    await seedOutbox(orm, 1);
    const instance = publisher();
    await instance.execute({ limit: 10 });
    expect(
      await new MikroOrmTransactionManager(orm).execute((trx) =>
        new OutboxRepository().findDue(new Date(), 10, trx),
      ),
    ).toEqual([]);
    expect(await instance.execute({ limit: 10 })).toEqual({ attempted: 0 });
  });

  it('o SQL encerra o prefixo no primeiro retry futuro mesmo com evento devido depois', async () => {
    const at = new Date();
    const messages = await seedOutbox(
      orm,
      3,
      Bun.randomUUIDv7(),
      (message, index) => {
        if (index === 1) {
          message.scheduleRetry(at);
        }
        return message;
      },
    );
    const transactions = new MikroOrmTransactionManager(orm);
    const repository = new OutboxRepository();
    const due = await transactions.execute((trx) =>
      repository.findDue(at, 10, trx),
    );
    expect(due.map((message) => message.id)).toEqual([messages[0].id]);
    const afterRetry = await transactions.execute((trx) =>
      repository.findDue(new Date(at.getTime() + 1000), 10, trx),
    );
    expect(afterRetry.map((message) => message.id)).toEqual(
      messages.map((message) => message.id),
    );
  });

  it('o SQL revalida a cabeça publicada depois do snapshot antes de capturar a wallet', async () => {
    const messages = await seedOutbox(orm, 2, Bun.randomUUIDv7());
    const transactions = new MikroOrmTransactionManager(orm);
    const repository = new OutboxRepository();
    await transactions.execute(async (trx) => {
      const em = entityManagerOf(trx);
      await em.execute(
        'alter table outbox_messages rename to outbox_snapshot_messages',
      );
      await em.execute(`create function outbox_snapshot_gate(event_sequence bigint)
        returns bigint language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(9042, 9);
          return event_sequence;
        end $$`);
      await em.execute(`create view outbox_messages as
        select id, outbox_snapshot_gate(sequence) as sequence, aggregate_id,
               event_type, payload, occurred_at, attempts, next_attempt_at, published_at, last_error
          from outbox_snapshot_messages`);
    });
    const held = deferred();
    const release = deferred();
    const readerStarted = deferred<number>();
    const blocker = transactions.execute(async (trx) => {
      await entityManagerOf(trx).execute(
        'select pg_advisory_xact_lock(9042, 9)',
      );
      held.resolve();
      await release.promise;
    });
    let reader: Promise<OutboxMessage[]> | undefined;
    try {
      await held.promise;
      reader = transactions.execute(async (trx) => {
        const em = entityManagerOf(trx);
        await em.execute("set local lock_timeout = '10s'");
        const [{ pid }] = await em.execute<{ pid: number }[]>(
          'select pg_backend_pid() as pid',
        );
        readerStarted.resolve(pid);
        return repository.findDue(new Date(), 10, trx);
      });
      const pid = await readerStarted.promise;
      await eventually(async () => {
        const [state] = await orm.em.fork().execute<{ waiting: boolean }[]>(
          `select wait_event_type = 'Lock' and wait_event = 'advisory' as waiting
             from pg_stat_activity where pid = ?`,
          [pid],
        );
        return state?.waiting === true;
      }, 5000);
      await new SqsEventPublisher(sqs, queue.name).publish(messages[0]);
      messages[0].markPublished(new Date());
      await transactions.execute((trx) =>
        repository.update(messages[0], undefined, trx),
      );
      release.resolve();
      await blocker;
      expect(await reader).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, ...(reader ? [reader] : [])]);
      await transactions.execute(async (trx) => {
        const em = entityManagerOf(trx);
        await em.execute('drop view outbox_messages');
        await em.execute(
          'alter table outbox_snapshot_messages rename to outbox_messages',
        );
        await em.execute('drop function outbox_snapshot_gate(bigint)');
      });
    }
    expect((await rows()).map((row) => row.published_at !== null)).toEqual([
      true,
      false,
    ]);
    expect(
      JSON.parse((await receiveEvents(sqs, queue.url, 1))[0].Body!).eventId,
    ).toBe(messages[0].id);
    expect(
      (
        await transactions.execute((trx) =>
          repository.findDue(new Date(), 10, trx),
        )
      ).map((message) => message.id),
    ).toEqual([messages[1].id]);
  });

  it('falha no meio do prefixo não tenta nem incrementa os seguintes da wallet', async () => {
    const messages = await seedOutbox(orm, 4, Bun.randomUUIDv7());
    const real = new SqsEventPublisher(sqs, queue.name);
    const instance = publisher({
      publish: async (message) => {
        if (message.id === messages[1].id) {
          throw new Error('falha no segundo evento');
        }
        await real.publish(message);
      },
    });
    expect(await instance.execute({ limit: 10 })).toEqual({ attempted: 2 });
    const stored = await rows();
    expect(stored.map((row) => row.attempts)).toEqual([0, 1, 0, 0]);
    expect(stored.map((row) => row.published_at !== null)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(await instance.execute({ limit: 10 })).toEqual({ attempted: 0 });
    expect(
      JSON.parse((await receiveEvents(sqs, queue.url, 1))[0].Body!).data.index,
    ).toBe(0);
  });

  it('resolve GetQueueUrl uma vez por instância ao publicar um lote', async () => {
    await seedOutbox(orm, 25);
    const send = spyOn(sqs, 'send');
    try {
      const instance = publisher();
      expect(await instance.execute({ limit: 100 })).toEqual({ attempted: 25 });
      expect(
        send.mock.calls.filter(
          ([command]) => command instanceof GetQueueUrlCommand,
        ),
      ).toHaveLength(1);
    } finally {
      send.mockRestore();
    }
  });

  it('inválida a URL em cache quando a fila deixa de existir', async () => {
    const [message] = await seedOutbox(orm, 1);
    const gateway = new SqsEventPublisher(sqs, queue.name);
    const send = spyOn(sqs, 'send');
    try {
      await gateway.publish(message);
      await queue.close();
      queue = await eventsQueue(sqs);
      expect(
        await gateway.publish(message).catch((error: unknown) => error),
      ).toBeInstanceOf(Error);
      expect(
        send.mock.calls.filter(
          ([command]) => command instanceof GetQueueUrlCommand,
        ),
      ).toHaveLength(1);
      expect(
        await gateway.publish(message).catch((error: unknown) => error),
      ).toBeInstanceOf(Error);
      expect(
        send.mock.calls.filter(
          ([command]) => command instanceof GetQueueUrlCommand,
        ),
      ).toHaveLength(2);
    } finally {
      send.mockRestore();
    }
  });

  it('50 BETs por duas APIs drenam em até três ciclos com dois publishers, por versão e causalidade', async () => {
    const ports = [freePort(), freePort()];
    const processes = ports.map((port) => spawnApp(testAppEnv(port)));
    try {
      await Promise.all(ports.map((port) => waitReady(port)));
      const urls = ports.map((port) => 'http://127.0.0.1:' + port);
      const playerId = Bun.randomUUIDv7();
      const opening = await fetch(urls[0] + '/wallets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '1000.00', currency: 'BRL' },
        }),
      });
      expect(opening.status).toBe(201);
      const walletId = ((await opening.json()) as { id: string }).id;
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => {
          const key = Bun.randomUUIDv7();
          const body = JSON.stringify({
            providerId: 'provider-prefix',
            externalTransactionId: Bun.randomUUIDv7(),
            playerId,
            walletId,
            roundId: 'round',
            gameId: 'game',
            kind: 'BET',
            money: { amount: '1.00', currency: 'BRL' },
          });
          return retryTransient(() =>
            fetch(urls[index % 2] + '/wagering/transactions', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'Idempotency-Key': key,
              },
              body,
            }),
          );
        }),
      );
      expect(responses.every((response) => response.status === 201)).toBe(true);
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      const expected = await orm.em
        .fork()
        .execute<{ id: string }[]>(
          'select id from outbox_messages where aggregate_id=? order by sequence',
          [walletId],
        );
      expect(expected).toHaveLength(102);
      const publishers = [publisher(), publisher()];
      let attempted = 0;
      let cycles = 0;
      while (attempted < 102 && cycles < 3) {
        const outcomes = await Promise.all(
          publishers.map((instance) => instance.execute({ limit: 100 })),
        );
        attempted += outcomes.reduce((n, result) => n + result.attempted, 0);
        cycles++;
      }
      expect(attempted).toBe(102);
      expect(cycles).toBeLessThanOrEqual(3);
      const received = (await receiveEvents(sqs, queue.url, 102)).map(
        (message) => JSON.parse(message.Body!),
      );
      expect(received.map((event) => event.eventId)).toEqual(
        expected.map((row) => row.id),
      );
      expect(
        received
          .filter((event) => event.eventType === 'WalletBalanceChanged')
          .map((event) => event.data.walletVersion),
      ).toEqual(Array.from({ length: 51 }, (_, index) => index + 1));
      for (let index = 0; index < received.length; index += 2) {
        const processed = received[index];
        const changed = received[index + 1];
        expect(processed.eventType).toBe('WagerTransactionProcessed');
        expect(changed.eventType).toBe('WalletBalanceChanged');
        expect(changed.causationId).toBe(processed.eventId);
        expect(changed.data.transactionId).toBe(processed.data.transactionId);
      }
      expect(await ledgerMatchesBalance(orm, walletId)).toEqual({
        stored: '950.00',
        rebuilt: '950.00',
      });
    } finally {
      for (const child of processes) {
        child.kill('SIGKILL');
      }
      await Promise.all(processes.map((child) => child.exited));
    }
  }, 30_000);
});
