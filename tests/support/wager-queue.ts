import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

export interface WagerQueues {
  sourceName: string;
  sourceUrl: string;
  deadLetterName: string;
  deadLetterUrl: string;
  close: () => Promise<void>;
}

export interface DeadLetter {
  body: string;
  failureCode: string | undefined;
}

export async function wagerQueues(
  sqs: SQSClient,
  visibilityTimeoutSeconds = 30,
): Promise<WagerQueues> {
  const suffix = Bun.randomUUIDv7();
  const deadLetterName = `wager-dlq-${suffix}.fifo`;
  const sourceName = `wager-${suffix}.fifo`;
  const { QueueUrl: deadLetterUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: deadLetterName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: deadLetterUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const { QueueUrl: sourceUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: sourceName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes?.QueueArn,
          maxReceiveCount: '5',
        }),
      },
    }),
  );
  return {
    sourceName,
    sourceUrl: sourceUrl!,
    deadLetterName,
    deadLetterUrl: deadLetterUrl!,
    close: async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: sourceUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: deadLetterUrl }));
    },
  };
}

export async function sendWagerMessage(
  sqs: SQSClient,
  queueUrl: string,
  body: unknown,
  groupId: string,
  deduplicationId = Bun.randomUUIDv7(),
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

export async function receiveDeadLetters(
  sqs: SQSClient,
  queueUrl: string,
): Promise<DeadLetter[]> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0,
      MessageAttributeNames: ['All'],
    }),
  );
  return Messages.map((message) => ({
    body: message.Body ?? '',
    failureCode: message.MessageAttributes?.failureCode?.StringValue,
  }));
}

export async function approximateMessages(
  sqs: SQSClient,
  queueUrl: string,
): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? '0') +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0')
  );
}
