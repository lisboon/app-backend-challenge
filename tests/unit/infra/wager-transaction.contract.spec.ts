import { describe, expect, it } from 'bun:test';

import { wagerTransactionMessageContract } from '../../../src/infra/contract/wager-transaction.contract';

const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const message = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data,
};

const accepts = (value: unknown): boolean =>
  wagerTransactionMessageContract.safeParse(value).success;

describe('contrato da mensagem WagerTransactionRequested', () => {
  it('aceita o exemplo do enunciado', () => {
    expect(accepts(message)).toBe(true);
  });

  it('aceita occurredAt com fuso explícito', () => {
    expect(
      accepts({ ...message, occurredAt: '2026-07-29T12:00:00.000-03:00' }),
    ).toBe(true);
  });

  it('aceita referência opcional como no submit HTTP', () => {
    expect(
      accepts({
        ...message,
        data: {
          ...data,
          kind: 'REFUND',
          referenceExternalTransactionId: 'transaction-100',
        },
      }),
    ).toBe(true);
  });

  it.each([
    ['tipo desconhecido', { ...message, type: 'WagerTransactionCreated' }],
    ['occurredAt inválido', { ...message, occurredAt: 'ontem' }],
    ['messageId vazio', { ...message, messageId: '' }],
    ['messageId longo demais', { ...message, messageId: 'm'.repeat(129) }],
    ['campo extra no envelope', { ...message, extra: true }],
    ['campo extra em data', { ...message, data: { ...data, extra: true } }],
    [
      'idempotencyKey em branco',
      { ...message, data: { ...data, idempotencyKey: '   ' } },
    ],
    [
      'idempotencyKey longa demais',
      { ...message, data: { ...data, idempotencyKey: 'k'.repeat(256) } },
    ],
    [
      'data sem idempotencyKey',
      { ...message, data: { ...data, idempotencyKey: undefined } },
    ],
    [
      'playerId que não é UUID',
      { ...message, data: { ...data, playerId: 'x' } },
    ],
  ])('recusa %s', (_caso, value) => {
    expect(accepts(value)).toBe(false);
  });

  it.each([
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'roundId',
    'gameId',
    'referenceExternalTransactionId',
  ])('recusa o caractere NUL em %s, que o PostgreSQL não grava', (field) => {
    expect(
      accepts({
        ...message,
        data: { ...data, kind: 'WIN', [field]: 'a\u0000b' },
      }),
    ).toBe(false);
  });

  it('recusa o caractere NUL no messageId', () => {
    expect(accepts({ ...message, messageId: 'msg\u0000123' })).toBe(false);
  });

  it.each([
    ['U+FFFE', '\uFFFE'],
    ['U+FFFF', '\uFFFF'],
  ])(
    'recusa %s, que o JSON não escapa e o SQS não aceita no corpo do evento',
    (_name, character) => {
      expect(
        accepts({ ...message, data: { ...data, roundId: `a${character}b` } }),
      ).toBe(false);
    },
  );

  it.each([
    ['U+0001', '\u0001'],
    ['U+001F', '\u001F'],
    ['surrogate solto', '\uD800'],
    ['U+FFFD', '\uFFFD'],
    ['U+10FFFF', '\u{10FFFF}'],
  ])('aceita %s, que o JSON escapa ou o SQS aceita', (_name, character) => {
    expect(
      accepts({ ...message, data: { ...data, roundId: `a${character}b` } }),
    ).toBe(true);
  });
});
