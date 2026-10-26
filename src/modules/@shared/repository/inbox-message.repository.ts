import { entityManagerOf } from '../../../infra/database/mikro-orm-transaction-manager';
import type { InboxMessage } from '../domain/inbox/inbox-message.entity';
import type { TransactionContext } from '../domain/transaction/transaction-manager';
import type { InboxMessageGateway } from '../gateway/inbox-message.gateway';
import { InboxMessageModel } from './inbox-message.model';
import { InboxMessageModelMapper } from './inbox-message.model.mapper';

export class InboxMessageRepository implements InboxMessageGateway {
  async create(
    message: InboxMessage,
    trx: TransactionContext,
  ): Promise<boolean> {
    const rows = await entityManagerOf(trx).execute<{ inserted: boolean }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning true as inserted`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
    );
    return rows.length === 1;
  }

  async update(message: InboxMessage, trx: TransactionContext): Promise<void> {
    const affected = await entityManagerOf(trx).nativeUpdate(
      InboxMessageModel,
      {
        consumerName: message.consumerName,
        messageId: message.messageId,
        processedAt: null,
      },
      { processedAt: message.processedAt ?? null },
    );
    if (affected !== 1) {
      throw new Error('mensagem da inbox não estava pendente');
    }
  }

  async findById(
    consumerName: string,
    messageId: string,
    trx: TransactionContext,
  ): Promise<InboxMessage | null> {
    const row = await entityManagerOf(trx).findOne(InboxMessageModel, {
      consumerName,
      messageId,
    });
    return row ? InboxMessageModelMapper.toEntity(row) : null;
  }
}
