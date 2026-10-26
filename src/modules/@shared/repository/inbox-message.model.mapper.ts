import type { InferEntity } from '@mikro-orm/postgresql';

import { InboxMessage } from '../domain/inbox/inbox-message.entity';
import type { InboxMessageModel } from './inbox-message.model';

export type InboxMessageRow = InferEntity<typeof InboxMessageModel>;

export const InboxMessageModelMapper = {
  toEntity(row: InboxMessageRow): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: row.consumerName,
      messageId: row.messageId,
      payloadHash: row.payloadHash,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt ?? undefined,
    });
  },
};
