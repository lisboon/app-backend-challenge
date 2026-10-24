import { describe, expect, it } from 'bun:test';

import { CurrencyMismatchError } from '../../../src/modules/@shared/domain/errors/money.errors';
import { Money } from '../../../src/modules/@shared/domain/money';
import { WalletInvariantError } from '../../../src/modules/wallet/domain/errors/wallet.errors';
import {
  type CreateLedgerEntryProps,
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../src/modules/wallet/domain/wallet-ledger-entry.entity';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const entry = (overrides: Partial<CreateLedgerEntryProps> = {}) =>
  WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('80.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('20.00'),
    walletVersion: 2,
    createdAt: new Date('2026-10-24T12:00:00.000Z'),
    ...overrides,
  });

describe('WalletLedgerEntry.create', () => {
  it('aceita débito em que antes menos valor dá depois', () => {
    expect(entry().isBalanced()).toBe(true);
  });

  it('aceita crédito em que antes mais valor dá depois', () => {
    expect(
      entry({
        direction: LedgerDirection.Credit,
        balanceBefore: brl('20.00'),
        balanceAfter: brl('100.00'),
      }).isBalanced(),
    ).toBe(true);
  });

  it.each([
    ['saldo posterior que não fecha a conta', { balanceAfter: brl('20.01') }],
    ['direção trocada', { direction: LedgerDirection.Credit }],
    ['valor zero', { money: brl('0.00'), balanceAfter: brl('100.00') }],
    [
      'valor negativo',
      { money: brl('80.00').negate(), balanceAfter: brl('180.00') },
    ],
    [
      'saldo posterior negativo',
      { balanceBefore: brl('10.00'), balanceAfter: brl('70.00').negate() },
    ],
    ['versão zero', { walletVersion: 0 }],
    ['versão fracionária', { walletVersion: 1.5 }],
  ])('recusa %s', (_caso, overrides) => {
    expect(() => entry(overrides)).toThrow(WalletInvariantError);
  });

  it('recusa moedas diferentes entre valor e saldos', () => {
    expect(() =>
      entry({ money: Money.from({ amount: '80.00', currency: 'USD' }) }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('preserva o estado persistido sem revalidar transições', () => {
    const state = {
      id: 'entry',
      walletId: 'wallet',
      transactionId: 'transaction',
      direction: LedgerDirection.Debit,
      money: brl('0.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('0.00'),
      walletVersion: 0,
      createdAt: new Date(),
    };
    expect(WalletLedgerEntry.rehydrate(state)).toMatchObject(state);
  });
});
