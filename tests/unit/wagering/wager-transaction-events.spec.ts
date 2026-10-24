import { describe, expect, it } from 'bun:test';

import { FailureCode } from '../../../src/modules/@shared/domain/failure-code';
import { Money } from '../../../src/modules/@shared/domain/money';
import { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction.entity';
import { WagerTransactionProcessed } from '../../../src/modules/wagering/event/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../../src/modules/wagering/event/wager-transaction-rejected.event';

const at = new Date('2026-10-24T12:00:00.000Z');
const money = Money.from({ amount: '10.00', currency: 'BRL' });
const context = {
  eventId: 'event',
  correlationId: 'correlation',
  occurredAt: at,
};
const transaction = () =>
  WagerTransaction.create({
    id: 'transaction',
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money,
    at,
  });
const expected = {
  transactionId: 'transaction',
  providerId: 'provider',
  externalTransactionId: 'external',
  walletId: 'wallet',
  playerId: 'player',
  roundId: 'round',
  gameId: 'game',
  kind: 'BET' as const,
  money: money.toJSON(),
  balance: money.toJSON(),
};

describe('eventos da transação', () => {
  it('serializa o evento processado com envelope estável e dinheiro em string', () => {
    const tx = transaction();
    tx.markProcessed(money, at);
    const event = WagerTransactionProcessed.from(tx, context);
    expect(event.toJSON()).toEqual({
      eventId: 'event',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'wallet',
      correlationId: 'correlation',
      occurredAt: at.toISOString(),
      version: 1,
      data: { ...expected, status: 'PROCESSED' },
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  it('serializa o evento rejeitado com código de falha', () => {
    const tx = transaction();
    tx.reject(FailureCode.INSUFFICIENT_BALANCE, money, at);
    expect(WagerTransactionRejected.from(tx, context).toJSON()).toEqual({
      eventId: 'event',
      eventType: 'WagerTransactionRejected',
      aggregateId: 'wallet',
      correlationId: 'correlation',
      occurredAt: at.toISOString(),
      version: 1,
      data: {
        ...expected,
        status: 'REJECTED',
        failureCode: FailureCode.INSUFFICIENT_BALANCE,
      },
    });
  });

  it('OPENING preserva os campos ausentes como null', () => {
    const tx = WagerTransaction.opening({
      id: 'opening',
      walletId: 'wallet',
      playerId: 'player',
      money,
      at,
    });
    expect(
      WagerTransactionProcessed.from(tx, context).toJSON().data,
    ).toMatchObject({
      kind: 'OPENING',
      roundId: null,
      gameId: null,
      balance: money.toJSON(),
    });
  });

  it('recusa eventos incompatíveis com o estado da transação', () => {
    expect(() =>
      WagerTransactionProcessed.from(transaction(), context),
    ).toThrow();
    expect(() =>
      WagerTransactionRejected.from(transaction(), context),
    ).toThrow();
  });
});
