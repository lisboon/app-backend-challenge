import { Global, Module } from '@nestjs/common';
import { Registry } from 'prom-client';

import { PrometheusOutboxMonitor } from './outbox-monitor';
import { MetricsController } from './metrics.controller';
import { PrometheusReconciliationMonitor } from './reconciliation-monitor';

export const OUTBOX_MONITOR = Symbol('OUTBOX_MONITOR');

export const RECONCILIATION_MONITOR = Symbol('RECONCILIATION_MONITOR');
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: OUTBOX_MONITOR,
      inject: [Registry],
      useFactory: (registry: Registry): PrometheusOutboxMonitor =>
        new PrometheusOutboxMonitor(registry),
    },
    { provide: Registry, useFactory: (): Registry => new Registry() },
    {
      provide: RECONCILIATION_MONITOR,
      inject: [Registry],
      useFactory: (registry: Registry): PrometheusReconciliationMonitor =>
        new PrometheusReconciliationMonitor(registry),
    },
  ],
  exports: [Registry, RECONCILIATION_MONITOR, OUTBOX_MONITOR],
})
export class ObservabilityModule {}
