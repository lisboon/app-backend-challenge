import type { WagerTransaction } from '../domain/wager-transaction.entity';

export interface WagerTransactionMonitor {
  recorded(transaction: WagerTransaction): void;
  replayed(transaction: WagerTransaction): void;
}
