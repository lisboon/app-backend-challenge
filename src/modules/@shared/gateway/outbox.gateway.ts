import type { OutboxMessage } from '../domain/outbox/outbox-message.entity';
import type { TransactionContext } from '../domain/transaction/transaction-manager';

export interface OutboxGateway {
  create(message: OutboxMessage, trx: TransactionContext): Promise<void>;
}
