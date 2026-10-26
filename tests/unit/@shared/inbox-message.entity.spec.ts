import { describe, expect, it } from 'bun:test';

import { InboxMessage } from '../../../src/modules/@shared/domain/inbox/inbox-message.entity';

const receivedAt = new Date('2026-10-25T12:00:00.000Z');
const hash = `v1:${'a'.repeat(64)}`;

const received = (): InboxMessage =>
  InboxMessage.receive({
    consumerName: 'wager-transactions',
    messageId: 'msg-1',
    payloadHash: hash,
    receivedAt,
  });

describe('InboxMessage', () => {
  it('nasce recebida e ainda não processada', () => {
    const message = received();

    expect(message).toMatchObject({
      consumerName: 'wager-transactions',
      messageId: 'msg-1',
      payloadHash: hash,
      receivedAt,
    });
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('markProcessed registra o instante', () => {
    const message = received();
    const at = new Date(receivedAt.getTime() + 1);

    message.markProcessed(at);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(at);
  });

  it('processar duas vezes é erro de programação', () => {
    const message = received();
    message.markProcessed(receivedAt);

    expect(() => message.markProcessed(receivedAt)).toThrow(
      'mensagem da inbox já processada',
    );
  });

  it('processar antes do recebimento é erro de programação', () => {
    expect(() =>
      received().markProcessed(new Date(receivedAt.getTime() - 1)),
    ).toThrow('processamento anterior ao recebimento');
  });

  it('matchesPayload compara o hash recebido', () => {
    expect(received().matchesPayload(hash)).toBe(true);
    expect(received().matchesPayload(`v1:${'b'.repeat(64)}`)).toBe(false);
  });

  it('rehydrate reconstrói o estado sem revalidar', () => {
    const message = InboxMessage.rehydrate({
      consumerName: 'wager-transactions',
      messageId: 'msg-1',
      payloadHash: hash,
      receivedAt,
      processedAt: receivedAt,
    });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(receivedAt);
  });
});
