import type { MikroORM } from '@mikro-orm/postgresql';

import { deferred } from './async';

const WAITING_ON_LOCK =
  "select pg_terminate_backend(pid) as dropped from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid() and datname = current_database()";

export async function dropConnectionsWaitingOn<T>(
  orm: MikroORM,
  table: string,
  start: () => Promise<T>,
): Promise<{ result: T; dropped: number }> {
  const locked = deferred();
  const release = deferred();
  const holder = orm.em.fork().transactional(async (em) => {
    await em.execute(`lock table ${table} in access exclusive mode`);
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  let settled = false;
  const pending = start().finally(() => {
    settled = true;
  });
  let dropped = 0;
  while (!settled && dropped === 0) {
    dropped = (await orm.em.fork().execute(WAITING_ON_LOCK)).length;
    if (dropped === 0) {
      await Bun.sleep(20);
    }
  }
  release.resolve();
  await holder;
  return { result: await pending, dropped };
}
