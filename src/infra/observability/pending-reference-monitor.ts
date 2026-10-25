import { Logger } from '@nestjs/common';
import { Counter, Gauge, Registry } from 'prom-client';

import { DomainError } from '../../modules/@shared/domain/errors/domain.error';
import type { WagerTransaction } from '../../modules/wagering/domain/wager-transaction.entity';
import type {
  PendingReferenceMonitor,
  PendingReferenceOutcome,
} from '../../modules/wagering/gateway/pending-reference-monitor.gateway';
import type { PendingWagerTransaction } from '../../modules/wagering/gateway/wager-transaction.gateway';

export class PrometheusPendingReferenceMonitor implements PendingReferenceMonitor {
  private readonly logger = new Logger(PrometheusPendingReferenceMonitor.name);

  private readonly pendingGauge: Gauge;

  private readonly resolvedCounter: Counter<'outcome'>;

  private readonly retryCounter: Counter;

  constructor(registry: Registry) {
    this.pendingGauge = new Gauge({
      name: 'pending_reference_transactions',
      help: 'Transações aguardando referência',
      registers: [registry],
    });
    this.resolvedCounter = new Counter({
      name: 'pending_reference_resolved_total',
      help: 'Desfechos de referências pendentes',
      labelNames: ['outcome'],
      registers: [registry],
    });
    this.retryCounter = new Counter({
      name: 'pending_reference_retries_total',
      help: 'Retentativas agendadas de referências pendentes',
      registers: [registry],
    });
  }

  pending(count: number): void {
    this.pendingGauge.set(count);
  }

  resolved(
    transaction: WagerTransaction,
    outcome: PendingReferenceOutcome,
  ): void {
    this.resolvedCounter.inc({ outcome });
    this.logger.log({
      event: 'pending_reference_resolved',
      ...logContext(transaction),
      outcome,
    });
  }

  retryScheduled(transaction: WagerTransaction): void {
    this.retryCounter.inc();
    this.logger.log({
      event: 'pending_reference_retry_scheduled',
      ...logContext(transaction),
    });
  }

  failed(candidate: PendingWagerTransaction, error: unknown): void {
    this.logger.error({
      event: 'pending_reference_failed',
      ...logContext(candidate),
      errorCode:
        error instanceof DomainError
          ? error.name
          : error instanceof Error
            ? error.constructor.name
            : 'UnknownError',
    });
  }
}

function logContext(
  transaction: PendingWagerTransaction,
): Record<string, unknown> {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    correlationId: transaction.correlationId,
    messageId: null,
  };
}
