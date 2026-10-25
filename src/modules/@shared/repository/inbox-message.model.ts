import { defineEntity, p } from '@mikro-orm/postgresql';

export const InboxMessageModel = defineEntity({
  name: 'InboxMessageModel',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().primary(),
    messageId: p.string().primary(),
    payloadHash: p.string(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
