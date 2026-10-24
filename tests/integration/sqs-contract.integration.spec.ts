import { afterAll, describe, expect, it } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { testInfra, WAGER_QUEUE_NAME } from '../support/http-app';

const TIMEOUT_MS = 20_000;

const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: testInfra().sqsEndpoint,
});
const run = Date.now().toString(36);

interface Queue {
  url: string;
  arn: string;
}

interface QueueOptions {
  deadLetterArn?: string;
  visibilitySeconds?: number;
  maxReceiveCount?: number;
}

async function createQueue(
  name: string,
  options: QueueOptions = {},
): Promise<Queue> {
  const attributes: Record<string, string> = {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: String(options.visibilitySeconds ?? 2),
  };
  if (options.deadLetterArn) {
    attributes.RedrivePolicy = JSON.stringify({
      deadLetterTargetArn: options.deadLetterArn,
      maxReceiveCount: options.maxReceiveCount ?? 2,
    });
  }
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${name}-${run}.fifo`,
      Attributes: attributes,
    }),
  );
  return { url: QueueUrl!, arn: await queueArn(QueueUrl!) };
}

async function queueArn(url: string): Promise<string> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['QueueArn'],
    }),
  );
  return Attributes!.QueueArn!;
}

const send = (queue: Queue, body: string, group = 'g', dedup = body) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: queue.url,
      MessageBody: body,
      MessageGroupId: group,
      MessageDeduplicationId: dedup,
    }),
  );

async function receive(
  queue: Queue,
  max = 10,
  waitSeconds = 0,
): Promise<Message[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queue.url,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: waitSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );
  return Messages ?? [];
}

const remove = (queue: Queue, message: Message) =>
  sqs.send(
    new DeleteMessageCommand({
      QueueUrl: queue.url,
      ReceiptHandle: message.ReceiptHandle!,
    }),
  );

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

afterAll(() => {
  sqs.destroy();
});

describe('filas provisionadas pelo hook do LocalStack', () => {
  it('a fila principal é FIFO e redireciona para a DLQ FIFO após 5 recebimentos', async () => {
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: WAGER_QUEUE_NAME }),
    );
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
    );
    const redrive = JSON.parse(Attributes!.RedrivePolicy!);

    expect(Attributes!.FifoQueue).toBe('true');
    expect(Attributes!.ContentBasedDeduplication).toBe('false');
    expect(Number(redrive.maxReceiveCount)).toBe(5);
    expect(redrive.deadLetterTargetArn).toEndWith(
      ':wager-transactions-dlq.fifo',
    );
  });
});

describe('contrato SQS que a solução usa', () => {
  it('cria fila FIFO com RedrivePolicy e a devolve na leitura', async () => {
    const dlq = await createQueue('c01-dlq');
    const queue = await createQueue('c01', { deadLetterArn: dlq.arn });
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.url,
        AttributeNames: ['All'],
      }),
    );

    expect(Attributes!.FifoQueue).toBe('true');
    expect(JSON.parse(Attributes!.RedrivePolicy!)).toMatchObject({
      deadLetterTargetArn: dlq.arn,
    });
  });

  it('descarta reenvio com o mesmo MessageDeduplicationId', async () => {
    const queue = await createQueue('c02');
    const first = await send(queue, 'x', 'g', 'same');
    const second = await send(queue, 'x', 'g', 'same');

    expect(second.MessageId).toBe(first.MessageId!);
    expect(await receive(queue)).toHaveLength(1);
  });

  it('aceita o mesmo dedupId com corpo diferente e preserva o original', async () => {
    const queue = await createQueue('c03');
    await send(queue, 'original', 'g', 'k');
    await send(queue, 'adulterado', 'g', 'k');
    const messages = await receive(queue);

    expect(messages.map((message) => message.Body)).toEqual(['original']);
  });

  it('descarta duplicata mesmo depois que a original foi apagada', async () => {
    const queue = await createQueue('c04');
    await send(queue, 'z', 'g', 'dz');
    await remove(queue, (await receive(queue, 1))[0]);
    await send(queue, 'z', 'g', 'dz');

    expect(await receive(queue, 1, 1)).toHaveLength(0);
  });

  it('entrega na ordem dentro do grupo', async () => {
    const queue = await createQueue('c05');
    for (const body of ['a1', 'a2', 'a3']) {
      await send(queue, body);
    }
    const delivered: string[] = [];
    for (let attempt = 0; attempt < 5 && delivered.length < 3; attempt += 1) {
      for (const message of await receive(queue)) {
        delivered.push(message.Body!);
        await remove(queue, message);
      }
    }

    expect(delivered).toEqual(['a1', 'a2', 'a3']);
  });

  it('bloqueia o grupo enquanto há mensagem em voo e deixa outro grupo fluir', async () => {
    const queue = await createQueue('c06', { visibilitySeconds: 10 });
    await send(queue, 'a1', 'A');
    await send(queue, 'a2', 'A');
    await send(queue, 'b1', 'B');
    const inFlight = await receive(queue, 1);
    const next = (await receive(queue)).map((message) => message.Body);

    expect(inFlight[0].Body).toBe('a1');
    expect(next).not.toContain('a2');
    expect(next).toContain('b1');
  });

  it(
    'três consumidores concorrentes nunca recebem o mesmo grupo ao mesmo tempo',
    async () => {
      const queue = await createQueue('c07', { visibilitySeconds: 10 });
      for (let group = 0; group < 4; group += 1) {
        for (let index = 0; index < 3; index += 1) {
          await send(
            queue,
            `g${group}-${index}`,
            `G${group}`,
            `d${group}-${index}`,
          );
        }
      }
      const batches = await Promise.all(
        [0, 1, 2].map(() => receive(queue, 10, 1)),
      );
      const ownerByGroup = new Map<string, number>();
      batches.forEach((batch, consumer) => {
        for (const message of batch) {
          const group = message.Body!.split('-')[0];
          expect(ownerByGroup.get(group) ?? consumer).toBe(consumer);
          ownerByGroup.set(group, consumer);
        }
      });
      const bodies = batches.flat().map((message) => message.Body);

      expect(new Set(bodies).size).toBe(bodies.length);
    },
    TIMEOUT_MS,
  );

  it(
    'reentrega após o visibility timeout e incrementa ApproximateReceiveCount',
    async () => {
      const queue = await createQueue('c08', { visibilitySeconds: 1 });
      await send(queue, 'r');
      const first = await receive(queue, 1);
      await sleep(1600);
      const second = await receive(queue, 1, 2);

      expect(first[0].Attributes!.ApproximateReceiveCount).toBe('1');
      expect(second[0].Body).toBe('r');
      expect(second[0].Attributes!.ApproximateReceiveCount).toBe('2');
    },
    TIMEOUT_MS,
  );

  it('ChangeMessageVisibility para 0 devolve a mensagem na hora', async () => {
    const queue = await createQueue('c09', { visibilitySeconds: 30 });
    await send(queue, 'v');
    const [message] = await receive(queue, 1);
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queue.url,
        ReceiptHandle: message.ReceiptHandle!,
        VisibilityTimeout: 0,
      }),
    );

    expect((await receive(queue, 1, 1))[0]?.Body).toBe('v');
  });

  it(
    'estender a visibilidade impede a reentrega durante o processamento',
    async () => {
      const queue = await createQueue('c10', { visibilitySeconds: 1 });
      await send(queue, 'long');
      const [message] = await receive(queue, 1);
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queue.url,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: 5,
        }),
      );
      await sleep(1800);

      expect(await receive(queue, 1, 1)).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  it(
    'apagar a mensagem impede a reentrega',
    async () => {
      const queue = await createQueue('c11', { visibilitySeconds: 1 });
      await send(queue, 'd');
      await remove(queue, (await receive(queue, 1))[0]);
      await sleep(1500);

      expect(await receive(queue, 1, 1)).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  it(
    'move para a DLQ depois de maxReceiveCount recebimentos sem delete',
    async () => {
      const dlq = await createQueue('c12-dlq');
      const queue = await createQueue('c12', {
        deadLetterArn: dlq.arn,
        visibilitySeconds: 1,
        maxReceiveCount: 2,
      });
      await send(queue, '{"k":"v"}');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await receive(queue, 1, 2);
        await sleep(1300);
      }

      expect(await receive(queue, 1, 2)).toHaveLength(0);
      expect((await receive(dlq, 1, 3))[0]?.Body).toBe('{"k":"v"}');
    },
    TIMEOUT_MS,
  );

  it(
    'long polling espera a mensagem chegar',
    async () => {
      const queue = await createQueue('c13');
      const emptyStarted = Date.now();
      const empty = await receive(queue, 1, 2);
      const waited = Date.now() - emptyStarted;
      setTimeout(() => void send(queue, 'late'), 700);
      const wakeStarted = Date.now();
      const woken = await receive(queue, 1, 5);

      expect(empty).toHaveLength(0);
      expect(waited).toBeGreaterThanOrEqual(1500);
      expect(woken[0]?.Body).toBe('late');
      expect(Date.now() - wakeStarted).toBeLessThan(4000);
    },
    TIMEOUT_MS,
  );

  it('envia e apaga em lote', async () => {
    const queue = await createQueue('c14');
    const sent = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queue.url,
        Entries: [0, 1, 2].map((index) => ({
          Id: `e${index}`,
          MessageBody: `b${index}`,
          MessageGroupId: `g${index}`,
          MessageDeduplicationId: `d${index}`,
        })),
      }),
    );
    const messages = await receive(queue);
    const deleted = await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queue.url,
        Entries: messages.map((message, index) => ({
          Id: `x${index}`,
          ReceiptHandle: message.ReceiptHandle!,
        })),
      }),
    );

    expect(sent.Successful).toHaveLength(3);
    expect(messages).toHaveLength(3);
    expect(deleted.Successful).toHaveLength(3);
  });

  it('informa ApproximateNumberOfMessages', async () => {
    const queue = await createQueue('c15');
    await send(queue, 'n1', 'g1');
    await send(queue, 'n2', 'g2');
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.url,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );

    expect(Attributes!.ApproximateNumberOfMessages).toBe('2');
  });

  it('recusa envio para FIFO sem MessageGroupId', async () => {
    const queue = await createQueue('c16');

    const failure = await sqs
      .send(
        new SendMessageCommand({
          QueueUrl: queue.url,
          MessageBody: 'x',
          MessageDeduplicationId: 'd',
        }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(Error);
  });
});
