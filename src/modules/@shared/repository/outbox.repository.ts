import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import type { OutboxMessage } from '../domain/outbox/outbox-message.entity';
import type { TransactionContext } from '../domain/transaction/transaction-manager';
import type {
  OutboxGateway,
  PendingOutboxGateway,
} from '../gateway/outbox.gateway';
import { OutboxMessageModel } from './outbox-message.model';
import {
  OutboxMessageModelMapper,
  type OutboxRow,
} from './outbox-message.model.mapper';

export class OutboxRepository implements OutboxGateway, PendingOutboxGateway {
  async findDue(
    now: Date,
    limit: number,
    trx: TransactionContext,
  ): Promise<OutboxMessage[]> {
    const rows = await entityManagerOf(trx).execute<OutboxRow[]>(
      `with pending as materialized (
        select id, aggregate_id, sequence, next_attempt_at, published_at,
               min(sequence) over (partition by aggregate_id) as head_sequence,
               min(sequence) filter (where next_attempt_at > ?) over (partition by aggregate_id) as blocked_sequence
          from outbox_messages where published_at is null
      ), heads as materialized (
        select o.aggregate_id
          from outbox_messages o join pending p on p.id = o.id
         where p.sequence = p.head_sequence and o.next_attempt_at <= ?
           and o.published_at is not distinct from p.published_at
         order by p.sequence limit ? for update of o skip locked
      ), prefix as (
        select p.id, p.sequence from pending p join heads h on h.aggregate_id = p.aggregate_id
         where p.blocked_sequence is null or p.sequence < p.blocked_sequence
         order by p.sequence limit ?
      )
      select o.id, o.aggregate_id as "aggregateId", o.event_type as "eventType", o.payload,
             o.occurred_at as "occurredAt", o.attempts, o.next_attempt_at as "nextAttemptAt",
             o.published_at as "publishedAt", o.last_error as "lastError"
        from outbox_messages o join prefix p on p.id = o.id
       order by p.sequence for update of o`,
      [now, now, limit, limit],
    );
    return rows.map((row) => OutboxMessageModelMapper.toEntity(row));
  }

  async update(
    message: OutboxMessage,
    lastError: string | undefined,
    trx: TransactionContext,
  ): Promise<void> {
    await entityManagerOf(trx).nativeUpdate(
      OutboxMessageModel,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        publishedAt: message.publishedAt ?? null,
        lastError: lastError ?? null,
      },
    );
  }

  async oldestPending(trx: TransactionContext): Promise<Date | null> {
    const [row] = await entityManagerOf(trx).execute<
      { oldest: string | null }[]
    >(
      'select min(occurred_at) as oldest from outbox_messages where published_at is null',
    );
    return row.oldest === null ? null : new Date(row.oldest);
  }

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
