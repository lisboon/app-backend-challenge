import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

import type { TransactionManager } from '../../modules/@shared/domain/transaction/transaction-manager';
import { OutboxFactory } from '../../modules/@shared/factory/outbox.factory';
import type { Clock } from '../../modules/@shared/gateway/clock.gateway';
import type { OutboxMonitor } from '../../modules/@shared/gateway/outbox-monitor.gateway';
import type { PublishOutboxUseCase } from '../../modules/@shared/usecase/publish-outbox/publish-outbox.usecase';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG, ConfigModule } from '../config/config.module';
import {
  TRANSACTION_MANAGER,
  DatabaseModule,
} from '../database/database.module';
import {
  ObservabilityModule,
  OUTBOX_MONITOR,
} from '../observability/observability.module';
import { QueueModule } from '../queue/queue.module';
import { SqsEventPublisher } from '../queue/sqs-event-publisher';
import { CLOCK, RuntimeModule } from '../runtime/runtime.module';
import { OutboxWorker, PUBLISH_OUTBOX } from './outbox-worker';

@Module({
  imports: [
    ConfigModule,
    RuntimeModule,
    DatabaseModule,
    QueueModule,
    ObservabilityModule,
  ],
  providers: [
    {
      provide: PUBLISH_OUTBOX,
      inject: [
        TRANSACTION_MANAGER,
        CLOCK,
        SQSClient,
        APP_CONFIG,
        OUTBOX_MONITOR,
      ],
      useFactory: (
        transactions: TransactionManager,
        clock: Clock,
        sqs: SQSClient,
        config: AppConfig,
        monitor: OutboxMonitor,
      ): PublishOutboxUseCase =>
        OutboxFactory.create({
          transactions,
          clock,
          publisher: new SqsEventPublisher(sqs, config.sqs.eventsQueueName),
          monitor,
        }),
    },
    OutboxWorker,
  ],
})
export class WorkerModule {}
