import { describe, expect, it, spyOn } from 'bun:test';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

import { SqsEventPublisher } from '../../../src/infra/queue/sqs-event-publisher';
import { EventPublicationError } from '../../../src/modules/@shared/domain/errors/infrastructure.errors';
import { OutboxMessage } from '../../../src/modules/@shared/domain/outbox/outbox-message.entity';

class ProviderFailure extends Error {}

const at = new Date('2026-10-25T12:00:00.000Z');
const message = OutboxMessage.rehydrate({
  id: 'event',
  aggregateId: 'wallet',
  eventType: 'WagerTransactionProcessed',
  occurredAt: at,
  attempts: 0,
  nextAttemptAt: at,
  publishedAt: undefined,
  payload: {
    eventId: 'event',
    aggregateId: 'wallet',
    eventType: 'WagerTransactionProcessed',
    correlationId: 'correlation',
    occurredAt: at.toISOString(),
    version: 1,
    data: {},
  },
});

describe('SqsEventPublisher', () => {
  describe.each(['consulta', 'envio'])('erro na etapa de %s', (stage) => {
    it.each([
      [
        Object.assign(new Error('detalhe recebido'), { code: 'ECONNREFUSED' }),
        'ECONNREFUSED',
      ],
      [
        Object.assign(new Error('detalhe recebido'), {
          Code: 'AWS.SimpleQueueService.NonExistentQueue',
        }),
        'AWS.SimpleQueueService.NonExistentQueue',
      ],
      [
        Object.assign(new Error('detalhe recebido'), {
          code: 'QueueDoesNotExist',
        }),
        'QueueDoesNotExist',
      ],
      [new ProviderFailure('detalhe recebido'), 'ProviderFailure'],
      [
        Object.assign(new Error('detalhe recebido'), {
          code: 'http://dados-recebidos/123456.78',
        }),
        'Error',
      ],
      ['detalhe recebido', 'UnknownError'],
    ])('normaliza a falha %j como %s', async (failure, code) => {
      const sqs = new SQSClient({ region: 'us-east-1' });
      const send = spyOn(sqs, 'send').mockImplementation(async (command) => {
        if (stage === 'envio' && command instanceof GetQueueUrlCommand) {
          return { $metadata: {}, QueueUrl: 'http://sqs.test/events.fifo' };
        }
        throw failure;
      });
      try {
        const error: unknown = await new SqsEventPublisher(sqs, 'events.fifo')
          .publish(message)
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(EventPublicationError);
        expect(error).toMatchObject({
          code,
          message: 'falha na publicação do evento',
        });
        expect(String(error)).not.toContain('detalhe recebido');
        expect(String(error)).not.toContain('123456.78');
      } finally {
        send.mockRestore();
        sqs.destroy();
      }
    });
  });
});
