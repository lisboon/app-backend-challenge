import type { InferEntity } from '@mikro-orm/postgresql';

import { Money } from '../../@shared/domain/money';
import { Wallet } from '../domain/wallet.entity';
import type { WalletModel } from './wallet.model';

export type WalletRow = InferEntity<typeof WalletModel>;

export const WalletModelMapper = {
  toModel(wallet: Wallet): WalletRow {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },

  toEntity(row: WalletRow): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      balance: Money.from({ amount: row.balance, currency: row.currency }),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },
};
