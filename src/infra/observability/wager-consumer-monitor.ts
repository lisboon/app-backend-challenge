import { Logger } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import type { WagerQueue } from '../queue/wager-queue';
import type { MessageDisposition } from '../worker/message-disposition';
import type { WagerConsumerMonitor } from '../worker/wager-message-worker';

export class PrometheusWagerConsumerMonitor implements WagerConsumerMonitor {
  private readonly logger = new Logger(PrometheusWagerConsumerMonitor.name);

  private readonly duration: Histogram<'outcome'>;

  private readonly duplicates: Counter;

  private readonly retries: Counter;

  private readonly deadLettered: Counter<'failure_code'>;

  private readonly settleFailures: Counter<'action'>;

  constructor(registry: Registry, queue: WagerQueue) {
    const logger = this.logger;
    this.duration = new Histogram({
      name: 'wager_message_processing_seconds',
      help: 'Latência de processamento das mensagens da fila por desfecho',
      labelNames: ['outcome'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    });
    this.duplicates = new Counter({
      name: 'inbox_duplicates_total',
      help: 'Entregas repetidas detectadas pela inbox',
      registers: [registry],
    });
    this.retries = new Counter({
      name: 'wager_message_retries_total',
      help: 'Mensagens devolvidas à fila com backoff por falha transitória',
      registers: [registry],
    });
    this.deadLettered = new Counter({
      name: 'wager_messages_dead_lettered_total',
      help: 'Mensagens enviadas à DLQ pelo consumidor, por código',
      labelNames: ['failure_code'],
      registers: [registry],
    });
    this.settleFailures = new Counter({
      name: 'wager_message_settle_failures_total',
      help: 'Ack, retry ou envio à DLQ que o SQS não confirmou',
      labelNames: ['action'],
      registers: [registry],
    });
    new Gauge({
      name: 'wager_dlq_messages',
      help: 'Mensagens na DLQ, inclusive as movidas pelo redrive',
      registers: [registry],
      async collect(): Promise<void> {
        try {
          this.set(await queue.deadLetterDepth());
        } catch {
          logger.warn({ event: 'wager_dlq_depth_unavailable' });
        }
      },
    });
  }

  handled(disposition: MessageDisposition, seconds: number): void {
    this.duration.observe({ outcome: outcomeOf(disposition) }, seconds);
    switch (disposition.action) {
      case 'acknowledge':
        if (disposition.reason === 'duplicate') {
          this.duplicates.inc();
        }
        return;
      case 'retry':
        this.retries.inc();
        return;
      case 'dead-letter':
        this.deadLettered.inc({ failure_code: disposition.failureCode });
    }
  }

  settleFailed(disposition: MessageDisposition): void {
    this.settleFailures.inc({ action: disposition.action });
  }
}

function outcomeOf(disposition: MessageDisposition): string {
  return disposition.action === 'acknowledge'
    ? disposition.reason
    : disposition.action;
}
