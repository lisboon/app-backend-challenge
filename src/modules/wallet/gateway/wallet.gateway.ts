import { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import { Wallet } from '../domain/wallet.entity';

export interface WalletGateway {
  create(wallet: Wallet, trx: TransactionContext): Promise<void>;
  update(
    wallet: Wallet,
    expectedVersion: number,
    trx: TransactionContext,
  ): Promise<void>;
  findById(id: string, trx: TransactionContext): Promise<Wallet | null>;
  findByIdForUpdate(
    id: string,
    trx: TransactionContext,
  ): Promise<Wallet | null>;
}
