import { describe, expect, it } from 'bun:test';

import { IntegrationEvent } from '../../../src/modules/@shared/domain/event/integration-event';
import { OutboxMessage } from '../../../src/modules/@shared/domain/outbox/outbox-message.entity';

const at = new Date('2026-10-24T12:00:00.000Z');
class TestEvent extends IntegrationEvent<{ value: string }> {
  readonly eventType = 'TestEvent';

  readonly version = 1;

  constructor() {
    super({
      eventId: 'event',
      aggregateId: 'wallet',
      correlationId: 'correlation',
      occurredAt: at,
      data: { value: '1.00' },
    });
  }
}

describe('OutboxMessage', () => {
  it('enfileira o envelope e fica devido no instante do evento', () => {
    const event = new TestEvent();
    const message = OutboxMessage.enqueue(event);
    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe('wallet');
    expect(message.payload).toEqual(event.toJSON());
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(new Date(at.getTime() - 1))).toBe(false);
    expect(message.isDue(at)).toBe(true);
  });

  it('aplica a sequência exponencial até cinco minutos, sem desistir', () => {
    const message = OutboxMessage.enqueue(new TestEvent());
    for (const [index, delay] of [
      1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000,
      300000, 300000,
    ].entries()) {
      message.scheduleRetry(at);
      expect(message.attempts).toBe(index + 1);
      expect(message.nextAttemptAt.getTime() - at.getTime()).toBe(delay);
      expect(message.isDue(at)).toBe(false);
      expect(message.isDue(message.nextAttemptAt)).toBe(true);
    }
    expect(message.isPending()).toBe(true);
  });

  it('publica uma única vez e não permite retry depois', () => {
    const message = OutboxMessage.enqueue(new TestEvent());
    message.markPublished(at);
    expect(message.publishedAt).toEqual(at);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 1))).toBe(false);
    expect(() => message.markPublished(at)).toThrow('já publicada');
    expect(() => message.scheduleRetry(at)).toThrow('já publicada');
  });

  it('recusa publicação anterior à ocorrência', () => {
    expect(() =>
      OutboxMessage.enqueue(new TestEvent()).markPublished(
        new Date(at.getTime() - 1),
      ),
    ).toThrow();
  });

  it('rehydrate preserva o estado sem revalidar', () => {
    const event = new TestEvent();
    const state = {
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: at,
      attempts: 4,
      nextAttemptAt: new Date(at.getTime() + 8000),
      publishedAt: undefined,
    };
    expect(OutboxMessage.rehydrate(state)).toMatchObject({
      id: state.id,
      payload: state.payload,
      attempts: 4,
      nextAttemptAt: state.nextAttemptAt,
      publishedAt: undefined,
    });
  });
});
