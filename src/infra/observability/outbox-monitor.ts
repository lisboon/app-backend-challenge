import { Logger } from '@nestjs/common';
import { Counter, Gauge, Registry } from 'prom-client';

import type { OutboxMessage } from '../../modules/@shared/domain/outbox/outbox-message.entity';
import type { OutboxMonitor } from '../../modules/@shared/gateway/outbox-monitor.gateway';

export class PrometheusOutboxMonitor implements OutboxMonitor {
  private readonly logger = new Logger(PrometheusOutboxMonitor.name);

  private readonly lagGauge: Gauge;

  private readonly publishedCounter: Counter<'event_type'>;

  private readonly failedCounter: Counter<'event_type'>;

  private readonly retriesCounter: Counter<'event_type'>;

  constructor(registry: Registry) {
    this.lagGauge = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade do evento pendente mais antigo em segundos',
      registers: [registry],
    });
    this.publishedCounter = new Counter({
      name: 'outbox_published_total',
      help: 'Envios de eventos concluídos no SQS',
      labelNames: ['event_type'],
      registers: [registry],
    });
    this.retriesCounter = new Counter({
      name: 'outbox_publish_retries_total',
      help: 'Retentativas agendadas de publicação da outbox',
      labelNames: ['event_type'],
      registers: [registry],
    });
    this.failedCounter = new Counter({
      name: 'outbox_publish_failures_total',
      help: 'Falhas de publicação de eventos no SQS',
      labelNames: ['event_type'],
      registers: [registry],
    });
  }

  published(message: OutboxMessage): void {
    this.publishedCounter.inc({ event_type: message.eventType });
    this.logger.log({ event: 'outbox_published', ...logContext(message) });
  }

  publicationFailed(message: OutboxMessage, errorCode: string): void {
    this.failedCounter.inc({ event_type: message.eventType });
    this.logger.warn({
      event: 'outbox_publish_failed',
      ...logContext(message),
      errorCode,
    });
  }

  retryScheduled(message: OutboxMessage): void {
    this.retriesCounter.inc({ event_type: message.eventType });
  }

  lag(seconds: number): void {
    this.lagGauge.set(seconds);
  }
}

function logContext(message: OutboxMessage): Record<string, unknown> {
  const data = message.payload.data as {
    transactionId?: string;
    providerId?: string;
  } | null;
  return {
    correlationId: message.payload.correlationId,
    messageId: message.id,
    transactionId: data?.transactionId ?? null,
    walletId: message.aggregateId,
    providerId: data?.providerId ?? null,
    eventType: message.eventType,
  };
}
