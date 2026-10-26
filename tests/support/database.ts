import { MikroORM } from '@mikro-orm/postgresql';

import { DEFAULT_DATABASE_POOL_MAX } from '../../src/infra/config/app-config';
import { ormConfig } from '../../src/infra/database/orm.config';
import { testInfra } from './http-app';

export async function openTestOrm(): Promise<MikroORM> {
  return MikroORM.init(
    ormConfig(testInfra().databaseUrl, DEFAULT_DATABASE_POOL_MAX),
  );
}

export async function migrateFresh(orm: MikroORM): Promise<void> {
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
}

export interface DatabaseFailure {
  code: string | undefined;
  constraint: string | undefined;
  message: string;
}

export async function failureOf(
  attempt: () => Promise<unknown>,
): Promise<DatabaseFailure> {
  try {
    await attempt();
  } catch (error) {
    const { code, constraint, message } = error as {
      code?: string;
      constraint?: string;
      message: string;
    };
    return { code, constraint, message };
  }
  throw new Error('a operação deveria ter falhado');
}

export async function ledgerMatchesBalance(
  orm: MikroORM,
  walletId: string,
): Promise<{ stored: string; rebuilt: string }> {
  const [row] = await orm.em
    .fork()
    .getConnection()
    .execute<{ stored: string; rebuilt: string }[]>(
      `select w.balance::text as stored,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20, 2)::text as rebuilt
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ?
      group by w.balance`,
      [walletId],
    );
  return row;
}
