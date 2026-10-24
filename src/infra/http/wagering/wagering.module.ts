import { Module } from '@nestjs/common';

import type { TransactionManager } from '../../../modules/@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../modules/@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../../modules/@shared/gateway/id-generator.gateway';
import {
  WageringFactory,
  type WageringUseCases,
} from '../../../modules/wagering/factory/wagering.factory';
import { TRANSACTION_MANAGER } from '../../database/database.module';
import { CLOCK, ID_GENERATOR } from '../../runtime/runtime.module';
import { WAGERING_USE_CASES, WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: WAGERING_USE_CASES,
      inject: [TRANSACTION_MANAGER, ID_GENERATOR, CLOCK],
      useFactory: (
        transactions: TransactionManager,
        ids: IdGenerator,
        clock: Clock,
      ): WageringUseCases =>
        WageringFactory.create({ transactions, ids, clock }),
    },
  ],
})
export class WageringModule {}
