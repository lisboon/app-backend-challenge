import { expect, it } from 'bun:test';

import { Money } from '../../../src/modules/@shared/domain/money';
import { Wallet } from '../../../src/modules/wallet/domain/wallet.entity';
import { WalletBalanceChanged } from '../../../src/modules/wallet/event/wallet-balance-changed.event';

it('WalletBalanceChanged serializa envelope, causalidade e lançamento sem Money', () => {
  const at = new Date('2026-10-24T12:00:00.000Z');

  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet',
    playerId: 'player',
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    openingTransactionId: 'transaction',
    openingEntryId: 'entry',
    at,
  });

  const event = WalletBalanceChanged.from(wallet, openingEntry!, {
    eventId: 'event',
    correlationId: 'correlation',
    causationId: 'processed',
    occurredAt: at,
  });
  expect(event.toJSON()).toEqual({
    eventId: 'event',
    eventType: 'WalletBalanceChanged',
    aggregateId: 'wallet',
    correlationId: 'correlation',
    causationId: 'processed',
    occurredAt: at.toISOString(),
    version: 1,
    data: {
      walletId: 'wallet',
      transactionId: 'transaction',
      direction: 'CREDIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '10.00', currency: 'BRL' },
      walletVersion: 1,
    },
  });
  expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
});
