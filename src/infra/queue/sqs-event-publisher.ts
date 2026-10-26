import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

import { EventPublicationError } from '../../modules/@shared/domain/errors/infrastructure.errors';
import type { OutboxMessage } from '../../modules/@shared/domain/outbox/outbox-message.entity';
import type { EventPublisherGateway } from '../../modules/@shared/gateway/event-publisher.gateway';
import { SqsQueueUrl } from './sqs-queue-url';

export class SqsEventPublisher implements EventPublisherGateway {
  private readonly queueUrl: SqsQueueUrl;

  constructor(
    private readonly sqs: SQSClient,
    queueName: string,
  ) {
    this.queueUrl = new SqsQueueUrl(sqs, queueName);
  }

  async publish(message: OutboxMessage): Promise<void> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: await this.queueUrl.resolve(),
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
        }),
      );
    } catch (error) {
      this.queueUrl.forgetIfMissing(error);
      throw publicationErrorOf(error);
    }
  }
}

function publicationErrorOf(error: unknown): EventPublicationError {
  if (!(error instanceof Error)) {
    return new EventPublicationError('UnknownError');
  }
  const failure = error as Error & { Code?: unknown; code?: unknown };
  const code = failure.Code ?? failure.code;
  return new EventPublicationError(
    typeof code === 'string' && /^[A-Za-z0-9_.-]{2,64}$/.test(code)
      ? code
      : error.constructor.name,
  );
}
