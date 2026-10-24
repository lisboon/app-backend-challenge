import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.entity';
import type { LedgerGateway } from '../gateway/ledger.gateway';
import { LedgerEntryModel } from './ledger-entry.model';
import { LedgerEntryModelMapper } from './ledger-entry.model.mapper';

export class LedgerRepository implements LedgerGateway {
  async findByWallet(
    walletId: string,
    currency: string,
    page: { beforeVersion?: number; limit: number },
    trx: TransactionContext,
  ): Promise<WalletLedgerEntry[]> {
    const em = entityManagerOf(trx);
    const rows = await em.find(
      LedgerEntryModel,
      {
        walletId,
        ...(page.beforeVersion === undefined
          ? {}
          : { walletVersion: { $lt: page.beforeVersion } }),
      },
      { orderBy: { walletVersion: 'desc' }, limit: page.limit },
    );
    return rows.map((row) => LedgerEntryModelMapper.toEntity(row, currency));
  }

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
