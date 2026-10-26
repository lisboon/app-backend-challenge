import { Global, Module } from '@nestjs/common';
import { Registry } from 'prom-client';

import { MetricsController } from './metrics.controller';
import { PrometheusOutboxMonitor } from './outbox-monitor';
import { PrometheusPendingReferenceMonitor } from './pending-reference-monitor';
import { PrometheusReconciliationMonitor } from './reconciliation-monitor';
import { PrometheusWagerTransactionMonitor } from './wager-transaction-monitor';

export const OUTBOX_MONITOR = Symbol('OUTBOX_MONITOR');
export const PENDING_REFERENCE_MONITOR = Symbol('PENDING_REFERENCE_MONITOR');

export const RECONCILIATION_MONITOR = Symbol('RECONCILIATION_MONITOR');

export const WAGER_TRANSACTION_MONITOR = Symbol('WAGER_TRANSACTION_MONITOR');

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: PENDING_REFERENCE_MONITOR,
      inject: [Registry],
      useFactory: (registry: Registry): PrometheusPendingReferenceMonitor =>
        new PrometheusPendingReferenceMonitor(registry),
    },
    {
      provide: OUTBOX_MONITOR,
      inject: [Registry],
      useFactory: (registry: Registry): PrometheusOutboxMonitor =>
        new PrometheusOutboxMonitor(registry),
    },
    { provide: Registry, useFactory: (): Registry => new Registry() },
    {
      provide: WAGER_TRANSACTION_MONITOR,
      inject: [Registry],
      useFactory: (registry: Registry): PrometheusWagerTransactionMonitor =>
        new PrometheusWagerTransactionMonitor(registry),
    },
    {
      provide: RECONCILIATION_MONITOR,
      inject: [Registry],
      useFactory: (registry: Registry): PrometheusReconciliationMonitor =>
        new PrometheusReconciliationMonitor(registry),
    },
  ],
  exports: [
    Registry,
    RECONCILIATION_MONITOR,
    OUTBOX_MONITOR,
    PENDING_REFERENCE_MONITOR,
    WAGER_TRANSACTION_MONITOR,
  ],
})
export class ObservabilityModule {}
