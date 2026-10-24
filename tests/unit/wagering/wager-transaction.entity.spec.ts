import { describe, expect, it } from 'bun:test';

import { Money } from '../../../src/modules/@shared/domain/money';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/modules/wagering/domain/wager-transaction.entity';

const at = new Date('2026-10-24T12:00:00.000Z');

const opening = (amount = '100.00', walletId = 'wallet-1') =>
  WagerTransaction.opening({
    id: 'opening-1',
    walletId,
    playerId: 'player-1',
    money: Money.from({ amount, currency: 'BRL' }),
    at,
  });

describe('WagerTransaction.opening', () => {
  it('nasce processada, do provedor interno e sem rodada', () => {
    const transaction = opening();

    expect(transaction).toMatchObject({
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: 'opening:wallet-1',
      idempotencyKey: 'internal:opening:wallet-1',
      kind: WagerTransactionKind.Opening,
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: undefined,
      gameId: undefined,
      createdAt: at,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toBe(at);
  });

  it('tem payloadHash determinístico sobre os campos de negócio', () => {
    expect(opening().payloadHash).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(opening().payloadHash).toBe(opening().payloadHash);
    expect(opening('100.01').payloadHash).not.toBe(opening().payloadHash);
    expect(opening('100.00', 'wallet-2').payloadHash).not.toBe(
      opening().payloadHash,
    );
  });
});
