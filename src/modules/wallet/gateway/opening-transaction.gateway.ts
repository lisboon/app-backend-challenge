import type { Money } from '../../@shared/domain/money';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';

export interface WalletOpening {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export interface OpeningTransactionGateway {
  create(opening: WalletOpening, trx: TransactionContext): Promise<void>;
}
