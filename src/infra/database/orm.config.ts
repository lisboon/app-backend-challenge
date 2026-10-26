import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';

import { InboxMessageModel } from '../../modules/@shared/repository/inbox-message.model';
import { OutboxMessageModel } from '../../modules/@shared/repository/outbox-message.model';
import { WagerTransactionModel } from '../../modules/wagering/repository/wager-transaction.model';
import { LedgerEntryModel } from '../../modules/wallet/repository/ledger-entry.model';
import { WalletModel } from '../../modules/wallet/repository/wallet.model';
import { MIGRATIONS } from './migrations';

const CONNECTION_TIMEOUT_MS = 1000;

export function ormConfig(clientUrl: string, poolMax: number): Options {
  return defineConfig({
    clientUrl,
    entities: [
      WalletModel,
      LedgerEntryModel,
      WagerTransactionModel,
      OutboxMessageModel,
      InboxMessageModel,
    ],
    extensions: [Migrator],
    allowGlobalContext: false,
    pool: { max: poolMax },
    driverOptions: { connectionTimeoutMillis: CONNECTION_TIMEOUT_MS },
    migrations: {
      tableName: 'schema_migrations',
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
