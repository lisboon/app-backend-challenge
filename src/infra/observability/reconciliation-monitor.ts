import { Logger } from '@nestjs/common';
import { Counter, Registry } from 'prom-client';

import type { WalletReconciliation } from '../../modules/wallet/domain/wallet-reconciliation';
import type { ReconciliationMonitor } from '../../modules/wallet/gateway/reconciliation-monitor.gateway';

export class PrometheusReconciliationMonitor implements ReconciliationMonitor {
  private readonly logger = new Logger(PrometheusReconciliationMonitor.name);

  private readonly divergences: Counter;

  constructor(registry: Registry) {
    this.divergences = new Counter({
      name: 'wallet_reconciliation_divergences_total',
      help: 'Divergências detectadas na reconciliação de wallets',
      registers: [registry],
    });
  }

  divergenceDetected(report: WalletReconciliation): void {
    this.logger.warn({
      walletId: report.walletId,
      difference: report.difference.toJSON(),
      checkedEntries: report.checkedEntries,
    });
    this.divergences.inc();
  }
}
