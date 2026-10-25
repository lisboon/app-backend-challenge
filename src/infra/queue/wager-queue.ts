import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import type { FailureCode } from '../../modules/@shared/domain/failure-code';
import { SqsQueueUrl } from './sqs-queue-url';

const RECEIVE_WAIT_SECONDS = 4;

export interface ReceivedWagerMessage {
  sqsMessageId: string;
  body: string;
  receiptHandle: string;
  groupId: string;
  receiveCount: number;
}

export class WagerQueue {
  private readonly source: SqsQueueUrl;

  private readonly deadLetter: SqsQueueUrl;

  constructor(
    private readonly sqs: SQSClient,
    sourceName: string,
    deadLetterName: string,
  ) {
    this.source = new SqsQueueUrl(sqs, sourceName);
    this.deadLetter = new SqsQueueUrl(sqs, deadLetterName);
  }

  async receive(
    signal: AbortSignal,
  ): Promise<ReceivedWagerMessage | undefined> {
    const { Messages: [message] = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.source.resolve(),
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
      { abortSignal: signal },
    );
    return message
      ? {
          sqsMessageId: message.MessageId ?? '',
          body: message.Body ?? '',
          receiptHandle: message.ReceiptHandle ?? '',
          groupId: message.Attributes?.MessageGroupId ?? '',
          receiveCount: Number(
            message.Attributes?.ApproximateReceiveCount ?? '1',
          ),
        }
      : undefined;
  }

  async acknowledge(message: ReceivedWagerMessage): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: await this.source.resolve(),
        ReceiptHandle: message.receiptHandle,
      }),
    );
  }

  async retryLater(
    message: ReceivedWagerMessage,
    seconds: number,
  ): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.source.resolve(),
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async sendToDeadLetter(
    message: ReceivedWagerMessage,
    failureCode: FailureCode,
  ): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.deadLetter.resolve(),
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.sqsMessageId,
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: failureCode },
        },
      }),
    );
    await this.acknowledge(message);
  }
}
