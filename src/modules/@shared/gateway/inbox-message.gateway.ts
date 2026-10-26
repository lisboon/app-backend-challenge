import type { InboxMessage } from '../domain/inbox/inbox-message.entity';
import type { TransactionContext } from '../domain/transaction/transaction-manager';

export interface InboxMessageGateway {
  create(message: InboxMessage, trx: TransactionContext): Promise<boolean>;
  update(message: InboxMessage, trx: TransactionContext): Promise<void>;
  findById(
    consumerName: string,
    messageId: string,
    trx: TransactionContext,
  ): Promise<InboxMessage | null>;
}
