import { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.entity';

export interface LedgerGateway {
  findByWallet(
    walletId: string,
    currency: string,
    page: { beforeVersion?: number; limit: number },
    trx: TransactionContext,
  ): Promise<WalletLedgerEntry[]>;
  create(entry: WalletLedgerEntry, trx: TransactionContext): Promise<void>;
}
