import { defineEntity, p } from '@mikro-orm/postgresql';

import type { IntegrationEventJSON } from '../domain/event/integration-event';

export const OutboxMessageModel = defineEntity({
  name: 'OutboxMessageModel',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    sequence: p.bigint('string').autoincrement(),
    aggregateId: p.uuid(),
    eventType: p.string(),
    payload: p.json<IntegrationEventJSON<unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    publishedAt: p.datetime().nullable(),
    lastError: p.string().nullable(),
  },
});
