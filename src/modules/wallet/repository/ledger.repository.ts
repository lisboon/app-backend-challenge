import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.entity';
import type { LedgerGateway } from '../gateway/ledger.gateway';
import { LedgerEntryModel } from './ledger-entry.model';

export class LedgerRepository implements LedgerGateway {
  async create(
    entry: WalletLedgerEntry,
    trx: TransactionContext,
  ): Promise<void> {
    await entityManagerOf(trx).insert(LedgerEntryModel, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    });
  }
}
