import { WalletNotFoundError } from '../../../@shared/domain/errors/wallet-not-found.error';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import { WalletReconciliation } from '../../domain/wallet-reconciliation';
import type { LedgerGateway } from '../../gateway/ledger.gateway';
import type { ReconciliationMonitor } from '../../gateway/reconciliation-monitor.gateway';
import type { WalletGateway } from '../../gateway/wallet.gateway';
import type {
  ReconcileWalletUseCaseInputDto,
  ReconcileWalletUseCaseOutputDto,
  ReconcileWalletUseCaseInterface,
} from './reconcile-wallet.usecase.dto';

export class ReconcileWalletUseCase implements ReconcileWalletUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wallets: WalletGateway,
    private readonly ledger: LedgerGateway,
    private readonly monitor: ReconciliationMonitor,
  ) {}

  async execute(
    input: ReconcileWalletUseCaseInputDto,
  ): Promise<ReconcileWalletUseCaseOutputDto> {
    const report = await this.transactions.snapshot(async (trx) => {
      const wallet = await this.wallets.findById(input.walletId, trx);
      if (!wallet) {
        throw new WalletNotFoundError();
      }
      const sum = await this.ledger.sumByWallet(
        wallet.id,
        wallet.currency,
        trx,
      );
      return WalletReconciliation.compare({
        walletId: wallet.id,
        stored: wallet.balance,
        calculated: sum.balance,
        checkedEntries: sum.entries,
      });
    });
    if (!report.consistent) {
      this.monitor.divergenceDetected(report);
    }
    return {
      walletId: report.walletId,
      storedBalance: report.storedBalance.toJSON(),
      calculatedBalance: report.calculatedBalance.toJSON(),
      difference: report.difference.toJSON(),
      consistent: report.consistent,
      checkedEntries: report.checkedEntries,
    };
  }
}
