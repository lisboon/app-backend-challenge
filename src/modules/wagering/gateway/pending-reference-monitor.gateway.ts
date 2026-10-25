import type { WagerTransaction } from '../domain/wager-transaction.entity';
import type { PendingWagerTransaction } from './wager-transaction.gateway';

export type PendingReferenceOutcome = 'processed' | 'rejected' | 'expired';

export interface PendingReferenceMonitor {
  pending(count: number): void;
  resolved(
    transaction: WagerTransaction,
    outcome: PendingReferenceOutcome,
  ): void;
  retryScheduled(transaction: WagerTransaction): void;
  failed(candidate: PendingWagerTransaction, error: unknown): void;
}
