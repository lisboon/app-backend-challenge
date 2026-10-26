import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

import type { TransactionManager } from '../../modules/@shared/domain/transaction/transaction-manager';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { MikroOrmTransactionManager } from './mikro-orm-transaction-manager';
import { ormConfig } from './orm.config';

export const TRANSACTION_MANAGER = Symbol('TRANSACTION_MANAGER');

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Promise<MikroORM> =>
        MikroORM.init(ormConfig(config.databaseUrl, config.databasePoolMax)),
    },
    {
      provide: TRANSACTION_MANAGER,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): TransactionManager =>
        new MikroOrmTransactionManager(orm),
    },
  ],
  exports: [MikroORM, TRANSACTION_MANAGER],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
