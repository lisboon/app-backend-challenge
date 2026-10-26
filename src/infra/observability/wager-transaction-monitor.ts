import { Logger } from '@nestjs/common';
import { Counter, Registry } from 'prom-client';

import type { WagerTransaction } from '../../modules/wagering/domain/wager-transaction.entity';
import type { WagerTransactionMonitor } from '../../modules/wagering/gateway/wager-transaction-monitor.gateway';

export class PrometheusWagerTransactionMonitor implements WagerTransactionMonitor {
  private readonly logger = new Logger(PrometheusWagerTransactionMonitor.name);

  private readonly statusCounter: Counter<'status' | 'kind'>;

  private readonly replayCounter: Counter<'status'>;

  constructor(registry: Registry) {
    this.statusCounter = new Counter({
      name: 'wager_transactions_total',
      help: 'Transações que entraram em cada status',
      labelNames: ['status', 'kind'],
      registers: [registry],
    });
    this.replayCounter = new Counter({
      name: 'idempotent_replays_total',
      help: 'Reenvios com a mesma idempotency key respondidos como replay',
      labelNames: ['status'],
      registers: [registry],
    });
  }

  recorded(transaction: WagerTransaction): void {
    this.statusCounter.inc({
      status: transaction.status,
      kind: transaction.kind,
    });
    this.logger.log({
      event: 'wager_transaction_recorded',
      ...logContext(transaction),
    });
  }

  replayed(transaction: WagerTransaction): void {
    this.replayCounter.inc({ status: transaction.status });
    this.logger.log({
      event: 'wager_transaction_replayed',
      ...logContext(transaction),
    });
  }
}

function logContext(transaction: WagerTransaction): Record<string, unknown> {
  return {
    correlationId: transaction.correlationId,
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    kind: transaction.kind,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
  };
}
