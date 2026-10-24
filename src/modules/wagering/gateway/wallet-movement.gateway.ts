import type { Money } from '../../@shared/domain/money';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type {
  MovementDirection,
  TargetWallet,
} from '../domain/wager-transaction.entity';

export interface WalletMovement {
  transactionId: string;
  entryId: string;
  direction: MovementDirection;
  money: Money;
  at: Date;
}

export interface LockedWallet extends TargetWallet {
  id: string;
  apply(movement: WalletMovement): Promise<Money>;
}

export interface WalletMovementGateway {
  lock(walletId: string, trx: TransactionContext): Promise<LockedWallet | null>;
}
