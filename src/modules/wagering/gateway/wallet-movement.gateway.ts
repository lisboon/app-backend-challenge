import type { EventContext } from '../../@shared/domain/event/integration-event';
import type { Money } from '../../@shared/domain/money';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import type {
  MovementDirection,
  TargetWallet,
} from '../domain/wager-transaction.entity';

export interface WalletMovement {
  eventContext: EventContext;
  transactionId: string;
  entryId: string;
  direction: MovementDirection;
  money: Money;
  at: Date;
}

export interface WalletMovementResult {
  balance: Money;
  recordBalanceChanged(): Promise<void>;
}

export interface LockedWallet extends TargetWallet {
  id: string;
  apply(movement: WalletMovement): Promise<WalletMovementResult>;
}

export interface WalletMovementGateway {
  lock(walletId: string, trx: TransactionContext): Promise<LockedWallet | null>;
}
