import type { OutboxMessage } from '../domain/outbox/outbox-message.entity';
import type { TransactionContext } from '../domain/transaction/transaction-manager';

export interface PendingOutboxGateway {
  findDue(
    now: Date,
    limit: number,
    trx: TransactionContext,
  ): Promise<OutboxMessage[]>;
  update(
    message: OutboxMessage,
    lastError: string | undefined,
    trx: TransactionContext,
  ): Promise<void>;
  oldestPending(trx: TransactionContext): Promise<Date | null>;
}

export interface OutboxGateway {
  create(message: OutboxMessage, trx: TransactionContext): Promise<void>;
}
