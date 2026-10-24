import {
  GetQueueUrlCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import type { OutboxMessage } from '../../modules/@shared/domain/outbox/outbox-message.entity';
import type { EventPublisherGateway } from '../../modules/@shared/gateway/event-publisher.gateway';

export class SqsEventPublisher implements EventPublisherGateway {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    try {
      const QueueUrl = await this.resolveQueueUrl();
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
        }),
      );
    } catch (error) {
      const name = (error as { name?: string })?.name;
      const code =
        (error as { Code?: string; code?: string })?.Code ??
        (error as { code?: string })?.code;
      if (
        [name, code].some(
          (value) =>
            value === 'QueueDoesNotExist' ||
            value === 'AWS.SimpleQueueService.NonExistentQueue' ||
            value === 'NonExistentQueue',
        )
      ) {
        this.queueUrl = undefined;
      }
      throw error;
    }
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.lookupQueueUrl();
    return this.queueUrl;
  }

  private async lookupQueueUrl(): Promise<string> {
    try {
      const { QueueUrl } = await this.sqs.send(
        new GetQueueUrlCommand({ QueueName: this.queueName }),
      );
      if (!QueueUrl) {
        throw new Error('SQS não retornou a URL da fila');
      }
      return QueueUrl;
    } catch (error) {
      this.queueUrl = undefined;
      throw error;
    }
  }
}
