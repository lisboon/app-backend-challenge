import type { InferEntity } from '@mikro-orm/postgresql';

import { Money } from '../../@shared/domain/money';
import {
  WalletLedgerEntry,
  type LedgerDirection,
} from '../domain/wallet-ledger-entry.entity';
import type { LedgerEntryModel } from './ledger-entry.model';

export const LedgerEntryModelMapper = {
  toEntity(
    row: InferEntity<typeof LedgerEntryModel>,
    currency: string,
  ): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      ...row,
      direction: row.direction as LedgerDirection,
      money: Money.from({ amount: row.amount, currency }),
      balanceBefore: Money.from({ amount: row.balanceBefore, currency }),
      balanceAfter: Money.from({ amount: row.balanceAfter, currency }),
    });
  },
};
