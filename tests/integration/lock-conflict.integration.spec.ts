import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Registry } from 'prom-client';

import {
  entityManagerOf,
  MikroOrmTransactionManager,
} from '../../src/infra/database/mikro-orm-transaction-manager';
import { PrometheusLockConflictMonitor } from '../../src/infra/observability/lock-conflict-monitor';
import { InfrastructureUnavailableError } from '../../src/modules/@shared/domain/errors/infrastructure.errors';
import { deferred } from '../support/async';
import { migrateFresh, openTestOrm } from '../support/database';
import { startApp } from '../support/http-app';

const uuid = (): string => Bun.randomUUIDv7();
const LOCK_WALLET = 'select 1 from wallets where id = ? for update';

describe('conflitos de lock contados pela TransactionManager', () => {
  let orm: MikroORM;
  let wallets: string[];

  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    const { app, baseUrl } = await startApp();
    wallets = [];
    for (let index = 0; index < 3; index++) {
      const response = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          playerId: uuid(),
          initialBalance: { amount: '10.00', currency: 'BRL' },
        }),
      });
      wallets.push(((await response.json()) as { id: string }).id);
    }
    await app.close();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  const observed = () => {
    const registry = new Registry();
    return {
      registry,
      transactions: new MikroOrmTransactionManager(
        orm,
        new PrometheusLockConflictMonitor(registry),
      ),
    };
  };

  it('timeout de lock vira transitório e conta lock_timeout', async () => {
    const { registry, transactions } = observed();
    const locked = deferred();
    const release = deferred();
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute(LOCK_WALLET, [wallets[0]]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const outcome = await transactions
      .execute((trx) => entityManagerOf(trx).execute(LOCK_WALLET, [wallets[0]]))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    release.resolve();
    await holder;

    expect(outcome).toBeInstanceOf(InfrastructureUnavailableError);
    expect(await registry.metrics()).toContain(
      'lock_conflicts_total{reason="lock_timeout"} 1',
    );
  }, 10_000);

  it('deadlock real entre duas transações conta deadlock uma vez', async () => {
    const { registry, transactions } = observed();
    const bothLocked = { first: deferred(), second: deferred() };
    const crossed = (
      own: string,
      other: string,
      mine: { resolve: () => void },
      theirs: Promise<void>,
    ) =>
      transactions
        .execute(async (trx) => {
          const em = entityManagerOf(trx);
          await em.execute(LOCK_WALLET, [own]);
          mine.resolve();
          await theirs;
          await em.execute(LOCK_WALLET, [other]);
        })
        .then(
          () => 'ok',
          (error: unknown) => error,
        );

    const outcomes = await Promise.all([
      crossed(
        wallets[1],
        wallets[2],
        bothLocked.first,
        bothLocked.second.promise,
      ),
      crossed(
        wallets[2],
        wallets[1],
        bothLocked.second,
        bothLocked.first.promise,
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) => outcome instanceof InfrastructureUnavailableError,
      ),
    ).toHaveLength(1);
    expect(await registry.metrics()).toContain(
      'lock_conflicts_total{reason="deadlock"} 1',
    );
  }, 10_000);
});
