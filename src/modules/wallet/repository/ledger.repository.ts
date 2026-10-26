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
      { magnitude: string; negative: boolean; entries: string }[]
    >(
      `select abs(net)::numeric(20,2)::text as magnitude, net < 0 as negative, entries
         from (select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0) as net,
                      count(*)::text as entries
                 from wallet_ledger_entries where wallet_id = ?) totals`,
      [walletId],
    );
    const magnitude = Money.from({ amount: row.magnitude, currency });
    return {
      balance: row.negative ? magnitude.negate() : magnitude,
      entries: Number(row.entries),
    };
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
