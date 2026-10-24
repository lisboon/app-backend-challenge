import type { WalletReconciliation } from '../domain/wallet-reconciliation';

export interface ReconciliationMonitor {
  divergenceDetected(reconciliation: WalletReconciliation): void;
}
