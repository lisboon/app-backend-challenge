import { Module } from '@nestjs/common';

import type { TransactionManager } from '../../../modules/@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../modules/@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../../modules/@shared/gateway/id-generator.gateway';
import {
  WageringFactory,
  type WageringUseCases,
} from '../../../modules/wagering/factory/wagering.factory';
import type { PendingReferenceMonitor } from '../../../modules/wagering/gateway/pending-reference-monitor.gateway';
import type { WagerTransactionMonitor } from '../../../modules/wagering/gateway/wager-transaction-monitor.gateway';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';
import { TRANSACTION_MANAGER } from '../../database/database.module';
import {
  PENDING_REFERENCE_MONITOR,
  WAGER_TRANSACTION_MONITOR,
} from '../../observability/observability.module';
import { CLOCK, ID_GENERATOR } from '../../runtime/runtime.module';
import { WAGERING_USE_CASES, WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: WAGERING_USE_CASES,
      inject: [
        TRANSACTION_MANAGER,
        ID_GENERATOR,
        CLOCK,
        PENDING_REFERENCE_MONITOR,
        WAGER_TRANSACTION_MONITOR,
        APP_CONFIG,
      ],
      useFactory: (
        transactions: TransactionManager,
        ids: IdGenerator,
        clock: Clock,
        pendingMonitor: PendingReferenceMonitor,
        wagerMonitor: WagerTransactionMonitor,
        config: AppConfig,
      ): WageringUseCases =>
        WageringFactory.create({
          transactions,
          ids,
          clock,
          pendingMonitor,
          wagerMonitor,
          pendingReferenceTtlSeconds: config.pendingReferenceTtlSeconds,
        }),
    },
  ],
})
export class WageringModule {}
