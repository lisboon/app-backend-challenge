import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import { ormConfig } from '../../src/infra/database/orm.config';
import { deferred } from '../support/async';
import { testInfra } from '../support/http-app';

describe('pool do banco com PostgreSQL real', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(ormConfig(testInfra().databaseUrl, 2));
  });

  afterAll(async () => {
    await orm.close(true);
  });

  it('respeita o máximo configurado e libera a conexão ao fim da transação', async () => {
    const release = deferred();
    const opened = [deferred(), deferred()];
    const held = opened.map((ready) =>
      orm.em.fork().transactional(async (em) => {
        await em.execute('select 1');
        ready.resolve();
        await release.promise;
      }),
    );
    await Promise.all(opened.map((ready) => ready.promise));

    const startedAt = performance.now();
    const exhausted = await orm.em
      .fork()
      .execute('select 1')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(String(exhausted)).toContain(
      'timeout exceeded when trying to connect',
    );
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(900);

    release.resolve();
    await Promise.all(held);
    expect(await orm.em.fork().execute('select 1 as ok')).toEqual([{ ok: 1 }]);
  });
});
