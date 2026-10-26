import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

import type { TransactionManager } from '../../modules/@shared/domain/transaction/transaction-manager';
import { OutboxFactory } from '../../modules/@shared/factory/outbox.factory';
import type { Clock } from '../../modules/@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../modules/@shared/gateway/id-generator.gateway';
import type { OutboxMonitor } from '../../modules/@shared/gateway/outbox-monitor.gateway';
import type { PublishOutboxUseCase } from '../../modules/@shared/usecase/publish-outbox/publish-outbox.usecase';
import {
  WageringFactory,
  type WageringUseCases,
} from '../../modules/wagering/factory/wagering.factory';
import type { PendingReferenceMonitor } from '../../modules/wagering/gateway/pending-reference-monitor.gateway';
import type { ResolvePendingWagerTransactionsUseCase } from '../../modules/wagering/usecase/resolve-pending/resolve-pending.usecase';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG, ConfigModule } from '../config/config.module';
import {
  TRANSACTION_MANAGER,
  DatabaseModule,
} from '../database/database.module';
import {
  ObservabilityModule,
  OUTBOX_MONITOR,
  PENDING_REFERENCE_MONITOR,
} from '../observability/observability.module';
import { QueueModule } from '../queue/queue.module';
import { SqsEventPublisher } from '../queue/sqs-event-publisher';
import { WagerQueue } from '../queue/wager-queue';
import { CLOCK, ID_GENERATOR, RuntimeModule } from '../runtime/runtime.module';
import { OutboxWorker, PUBLISH_OUTBOX } from './outbox-worker';
import {
  PendingReferenceWorker,
  RESOLVE_PENDING_WAGER_TRANSACTIONS,
} from './pending-reference-worker';
import {
  RECORD_FAILURE_FOR_DELIVERY,
  type RecordFailureForDelivery,
  SUBMIT_FOR_DELIVERY,
  type SubmitForDelivery,
  WAGER_QUEUE,
  WagerMessageWorker,
} from './wager-message-worker';

const WAGERING_USE_CASES = Symbol('WAGERING_USE_CASES');

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
      provide: WAGERING_USE_CASES,
      inject: [
        TRANSACTION_MANAGER,
        ID_GENERATOR,
        CLOCK,
        PENDING_REFERENCE_MONITOR,
        APP_CONFIG,
      ],
      useFactory: (
        transactions: TransactionManager,
        ids: IdGenerator,
        clock: Clock,
        pendingMonitor: PendingReferenceMonitor,
        config: AppConfig,
      ): WageringUseCases =>
        WageringFactory.create({
          transactions,
          ids,
          clock,
          pendingMonitor,
          pendingReferenceTtlSeconds: config.pendingReferenceTtlSeconds,
        }),
    },
    {
      provide: RESOLVE_PENDING_WAGER_TRANSACTIONS,
      inject: [WAGERING_USE_CASES],
      useFactory: (
        useCases: WageringUseCases,
      ): ResolvePendingWagerTransactionsUseCase => useCases.resolvePending,
    },
    {
      provide: SUBMIT_FOR_DELIVERY,
      inject: [WAGERING_USE_CASES],
      useFactory: (useCases: WageringUseCases): SubmitForDelivery =>
        useCases.submitFor,
    },
    {
      provide: RECORD_FAILURE_FOR_DELIVERY,
      inject: [WAGERING_USE_CASES],
      useFactory: (useCases: WageringUseCases): RecordFailureForDelivery =>
        useCases.recordFailureFor,
    },
    {
      provide: WAGER_QUEUE,
      inject: [SQSClient, APP_CONFIG],
      useFactory: (sqs: SQSClient, config: AppConfig): WagerQueue =>
        new WagerQueue(
          sqs,
          config.sqs.wagerQueueName,
          config.sqs.wagerDeadLetterQueueName,
        ),
    },
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
    PendingReferenceWorker,
    WagerMessageWorker,
  ],
})
export class WorkerModule {}
