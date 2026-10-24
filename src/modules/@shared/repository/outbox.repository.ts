import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import type { OutboxMessage } from '../domain/outbox/outbox-message.entity';
import type { TransactionContext } from '../domain/transaction/transaction-manager';
import type { OutboxGateway } from '../gateway/outbox.gateway';
import { OutboxMessageModel } from './outbox-message.model';

export class OutboxRepository implements OutboxGateway {
  async create(message: OutboxMessage, trx: TransactionContext): Promise<void> {
    await entityManagerOf(trx).insert(OutboxMessageModel, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt ?? null,
      lastError: null,
    });
  }
}
