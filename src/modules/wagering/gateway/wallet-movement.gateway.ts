import type { Money } from '../../@shared/domain/money';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type {
  MovementDirection,
  TargetWallet,
} from '../domain/wager-transaction.entity';

export interface LockedWallet extends TargetWallet {
  id: string;
}

export interface WalletMovement {
  walletId: string;
  transactionId: string;
  entryId: string;
  direction: MovementDirection;
  money: Money;
  at: Date;
}

export interface WalletMovementGateway {
  lock(walletId: string, trx: TransactionContext): Promise<LockedWallet | null>;
  apply(movement: WalletMovement, trx: TransactionContext): Promise<Money>;
}
