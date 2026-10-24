import { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.entity';

export interface LedgerGateway {
  create(entry: WalletLedgerEntry, trx: TransactionContext): Promise<void>;
}
