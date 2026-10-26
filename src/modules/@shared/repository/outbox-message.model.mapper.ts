import type { InferEntity } from '@mikro-orm/postgresql';

import { OutboxMessage } from '../domain/outbox/outbox-message.entity';
import type { OutboxMessageModel } from './outbox-message.model';

export type OutboxRow = Omit<
  InferEntity<typeof OutboxMessageModel>,
  'sequence' | 'occurredAt' | 'nextAttemptAt' | 'publishedAt'
> & {
  occurredAt: Date | string;
  nextAttemptAt: Date | string;
  publishedAt: Date | string | null;
};

export const OutboxMessageModelMapper = {
  toEntity(row: OutboxRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      ...row,
      occurredAt: asDate(row.occurredAt),
      nextAttemptAt: asDate(row.nextAttemptAt),
      publishedAt:
        row.publishedAt === null ? undefined : asDate(row.publishedAt),
    });
  },
};

function asDate(value: Date | string): Date {
  return typeof value === 'string' ? new Date(value) : value;
}
