import { isUniqueViolation } from '../../../infra/database/database-errors';
import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import { WalletAlreadyExistsError } from '../domain/errors/wallet.errors';
import type { Wallet } from '../domain/wallet.entity';
import type { WalletGateway } from '../gateway/wallet.gateway';
import { WalletModel } from './wallet.model';
import { WalletModelMapper } from './wallet.model.mapper';

const ONE_WALLET_PER_PLAYER_AND_CURRENCY = 'wallets_player_currency_uk';

export class WalletRepository implements WalletGateway {
  async create(wallet: Wallet, trx: TransactionContext): Promise<void> {
    try {
      await entityManagerOf(trx).insert(
        WalletModel,
        WalletModelMapper.toModel(wallet),
      );
    } catch (error) {
      if (isUniqueViolation(error, ONE_WALLET_PER_PLAYER_AND_CURRENCY)) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }

  async findById(id: string, trx: TransactionContext): Promise<Wallet | null> {
    const row = await entityManagerOf(trx).findOne(WalletModel, { id });
    return row ? WalletModelMapper.toEntity(row) : null;
  }
}
