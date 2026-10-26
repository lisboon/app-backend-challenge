import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';

const MISSING_QUEUE = new Set([
  'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue',
  'NonExistentQueue',
]);

export class SqsQueueUrl {
  private url: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly name: string,
  ) {}

  resolve(): Promise<string> {
    this.url ??= this.lookup();
    return this.url;
  }

  forgetIfMissing(error: unknown): void {
    const failure = error as { name?: string; Code?: string; code?: string };
    if (
      [failure?.name, failure?.Code ?? failure?.code].some(
        (value) => value !== undefined && MISSING_QUEUE.has(value),
      )
    ) {
      this.url = undefined;
    }
  }

  private async lookup(): Promise<string> {
    try {
      const { QueueUrl } = await this.sqs.send(
        new GetQueueUrlCommand({ QueueName: this.name }),
      );
      if (!QueueUrl) {
        throw new Error('SQS não retornou a URL da fila');
      }
      return QueueUrl;
    } catch (error) {
      this.url = undefined;
      throw error;
    }
  }
}
