import type { Money } from '../../@shared/domain/money';
import { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.entity';

export interface LedgerGateway {
  findByWallet(
    walletId: string,
    currency: string,
    page: { beforeVersion?: number; limit: number },
    trx: TransactionContext,
  ): Promise<WalletLedgerEntry[]>;
  sumByWallet(
    walletId: string,
    currency: string,
    trx: TransactionContext,
  ): Promise<{ balance: Money; entries: number }>;
  create(entry: WalletLedgerEntry, trx: TransactionContext): Promise<void>;
}
