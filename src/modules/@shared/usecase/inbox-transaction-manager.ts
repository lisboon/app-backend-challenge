import {
  DuplicateMessageError,
  MessageIdPayloadConflictError,
} from '../domain/errors/inbox.errors';
import {
  InboxMessage,
  type InboxDelivery,
} from '../domain/inbox/inbox-message.entity';
import type {
  TransactionContext,
  TransactionManager,
} from '../domain/transaction/transaction-manager';
import type { Clock } from '../gateway/clock.gateway';
import type { InboxMessageGateway } from '../gateway/inbox-message.gateway';

export class InboxTransactionManager implements TransactionManager {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly inbox: InboxMessageGateway,
    private readonly clock: Clock,
    private readonly delivery: InboxDelivery,
  ) {}

  execute<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T> {
    return this.transactions.execute(async (trx) => {
      const message = InboxMessage.receive({
        ...this.delivery,
        receivedAt: this.clock.now(),
      });
      await this.claim(message, trx);
      const result = await work(trx);
      message.markProcessed(this.clock.now());
      await this.inbox.update(message, trx);
      return result;
    });
  }

  snapshot<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T> {
    return this.transactions.snapshot(work);
  }

  private async claim(
    message: InboxMessage,
    trx: TransactionContext,
  ): Promise<void> {
    if (await this.inbox.create(message, trx)) {
      return;
    }
    const recorded = await this.inbox.findById(
      message.consumerName,
      message.messageId,
      trx,
    );
    if (!recorded) {
      throw new Error('a inbox acusou conflito sem registro gravado');
    }
    if (!recorded.matchesPayload(message.payloadHash)) {
      throw new MessageIdPayloadConflictError();
    }
    throw new DuplicateMessageError();
  }
}
