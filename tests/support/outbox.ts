import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

import { IntegrationEvent } from '../../src/modules/@shared/domain/event/integration-event';
import { OutboxMessage } from '../../src/modules/@shared/domain/outbox/outbox-message.entity';
import { OutboxRepository } from '../../src/modules/@shared/repository/outbox.repository';
import { MikroOrmTransactionManager } from '../../src/infra/database/mikro-orm-transaction-manager';
import { testInfra } from './http-app';

export interface TestEventData {
  index: number;
  transactionId: string;
  providerId: string;
  money: { amount: string; currency: string };
}

class TestEvent extends IntegrationEvent<TestEventData> {
  readonly eventType = 'WagerTransactionProcessed';

  readonly version = 1;

  constructor(index: number, aggregateId: string, at: Date) {
    super({
      eventId: Bun.randomUUIDv7(),
      aggregateId,
      correlationId: Bun.randomUUIDv7(),
      occurredAt: at,
      data: {
        index,
        transactionId: Bun.randomUUIDv7(),
        providerId: 'provider-test',
        money: { amount: '123456.78', currency: 'BRL' },
      },
    });
  }
}

export function testSqs(endpoint = testInfra().sqsEndpoint): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint,
    useQueueUrlAsEndpoint: false,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 300, requestTimeout: 5000 },
  });
}

export async function eventsQueue(
  sqs: SQSClient,
): Promise<{ name: string; url: string; close: () => Promise<void> }> {
  const name = 'events-' + Bun.randomUUIDv7() + '.fifo';

  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  return {
    name,
    url: QueueUrl!,
    close: async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl }));
    },
  };
}

export async function seedOutbox(
  orm: MikroORM,
  count: number,
  aggregateId?: string,
  transform?: (message: OutboxMessage, index: number) => OutboxMessage,
): Promise<OutboxMessage[]> {
  const messages = Array.from({ length: count }, (_, index) =>
    OutboxMessage.enqueue(
      new TestEvent(
        index,
        aggregateId ?? Bun.randomUUIDv7(),
        new Date(Date.now() - 60_000 + index),
      ),
    ),
  );

  const repository = new OutboxRepository();
  await new MikroOrmTransactionManager(orm).execute(async (trx) => {
    for (const [index, message] of messages.entries()) {
      await repository.create(transform?.(message, index) ?? message, trx);
    }
  });
  return messages;
}

export async function receiveEvents(
  sqs: SQSClient,
  url: string,
  count: number,
): Promise<Message[]> {
  const messages: Message[] = [];

  const deadline = Date.now() + 15_000;
  while (messages.length < count && Date.now() < deadline) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['All'],
      }),
    );
    messages.push(...Messages);
    if (Messages.length) {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: url,
          Entries: Messages.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle!,
          })),
        }),
      );
    }
  }
  if (messages.length < count) {
    throw new Error('nem todos os eventos chegaram ao SQS');
  }
  return messages;
}

export async function queueIsEmpty(
  sqs: SQSClient,
  url: string,
): Promise<boolean> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  return Attributes?.ApproximateNumberOfMessages === '0';
}
