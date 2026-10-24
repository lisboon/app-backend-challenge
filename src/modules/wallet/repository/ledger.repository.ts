import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import { Money } from '../../@shared/domain/money';
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

  async sumByWallet(
    walletId: string,
    currency: string,
    trx: TransactionContext,
  ): Promise<{ balance: Money; entries: number }> {
    const [row] = await entityManagerOf(trx).execute<
      { credits: string; debits: string; entries: string }[]
    >(
      `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::numeric(20,2)::text as credits,
              coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::numeric(20,2)::text as debits,
              count(*)::text as entries
         from wallet_ledger_entries where wallet_id = ?`,
      [walletId],
    );
    const credits = Money.from({ amount: row.credits, currency });
    const debits = Money.from({ amount: row.debits, currency });
    return { balance: credits.subtract(debits), entries: Number(row.entries) };
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
