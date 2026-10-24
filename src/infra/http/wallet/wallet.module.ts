import { Module } from '@nestjs/common';

import type { TransactionManager } from '../../../modules/@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../modules/@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../../modules/@shared/gateway/id-generator.gateway';
import {
  WalletFactory,
  type WalletUseCases,
} from '../../../modules/wallet/factory/wallet.factory';
import type { ReconciliationMonitor } from '../../../modules/wallet/gateway/reconciliation-monitor.gateway';
import { TRANSACTION_MANAGER } from '../../database/database.module';
import { RECONCILIATION_MONITOR } from '../../observability/observability.module';
import { CLOCK, ID_GENERATOR } from '../../runtime/runtime.module';
import { WALLET_USE_CASES, WalletController } from './wallet.controller';

@Module({
  controllers: [WalletController],
  providers: [
    {
      provide: WALLET_USE_CASES,
      inject: [
        TRANSACTION_MANAGER,
        ID_GENERATOR,
        CLOCK,
        RECONCILIATION_MONITOR,
      ],
      useFactory: (
        transactions: TransactionManager,
        ids: IdGenerator,
        clock: Clock,
        monitor: ReconciliationMonitor,
      ): WalletUseCases =>
        WalletFactory.create({ transactions, ids, clock, monitor }),
    },
  ],
})
export class WalletModule {}
