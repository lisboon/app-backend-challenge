import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Registry } from 'prom-client';

import type { TransactionManager } from '../../modules/@shared/domain/transaction/transaction-manager';
import { OutboxFactory } from '../../modules/@shared/factory/outbox.factory';
import type { Clock } from '../../modules/@shared/gateway/clock.gateway';
import type { OutboxMonitor } from '../../modules/@shared/gateway/outbox-monitor.gateway';
import type { PublishOutboxUseCase } from '../../modules/@shared/usecase/publish-outbox/publish-outbox.usecase';
import type { WageringUseCases } from '../../modules/wagering/factory/wagering.factory';
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
} from '../observability/observability.module';
import { PrometheusWagerConsumerMonitor } from '../observability/wager-consumer-monitor';
import { QueueModule } from '../queue/queue.module';
import { SqsEventPublisher } from '../queue/sqs-event-publisher';
import { WagerQueue } from '../queue/wager-queue';
import { CLOCK, RuntimeModule } from '../runtime/runtime.module';
import {
  WAGERING_USE_CASES,
  WageringUseCasesModule,
} from '../wagering/wagering-use-cases.module';
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
  WAGER_CONSUMER_MONITOR,
  WAGER_QUEUE,
  WagerMessageWorker,
} from './wager-message-worker';

@Module({
  imports: [
    ConfigModule,
    RuntimeModule,
    DatabaseModule,
    QueueModule,
    ObservabilityModule,
    WageringUseCasesModule,
  ],
  providers: [
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
      provide: WAGER_CONSUMER_MONITOR,
      inject: [Registry, WAGER_QUEUE],
      useFactory: (
        registry: Registry,
        queue: WagerQueue,
      ): PrometheusWagerConsumerMonitor =>
        new PrometheusWagerConsumerMonitor(registry, queue),
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
