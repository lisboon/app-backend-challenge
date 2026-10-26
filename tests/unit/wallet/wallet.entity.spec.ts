import { describe, expect, it } from 'bun:test';

import { Money } from '../../../src/modules/@shared/domain/money';
import { WalletInvariantError } from '../../../src/modules/wallet/domain/errors/wallet.errors';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry.entity';
import { Wallet } from '../../../src/modules/wallet/domain/wallet.entity';

const at = new Date('2026-10-24T12:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const open = (initialBalance: Money) =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance,
    openingTransactionId: 'opening-1',
    openingEntryId: 'entry-1',
    at,
  });

describe('Wallet.open', () => {
  it('abre com o saldo inicial, versão 1 e a moeda do saldo', () => {
    const { wallet } = open(brl('100.00'));

    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toBe(at);
    expect(wallet.updatedAt).toBe(at);
  });

  it('saldo inicial positivo gera um crédito de abertura de zero até o saldo', () => {
    const { wallet, openingEntry } = open(brl('100.00'));

    expect(openingEntry).toMatchObject({
      id: 'entry-1',
      walletId: wallet.id,
      transactionId: 'opening-1',
      direction: LedgerDirection.Credit,
      walletVersion: 1,
      createdAt: at,
    });
    expect(openingEntry!.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry!.money.toString()).toBe('100.00');
    expect(openingEntry!.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  it('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = open(brl('0.00'));

    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('recusa saldo inicial negativo', () => {
    expect(() => open(brl('1.00').negate())).toThrow(WalletInvariantError);
  });
});

describe('Wallet.rehydrate', () => {
  it('reconstrói o estado persistido sem gerar lançamento', () => {
    const createdAt = new Date('2026-10-01T00:00:00.000Z');
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: brl('20.00'),
      version: 7,
      createdAt,
      updatedAt: at,
    });

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(7);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toBe(createdAt);
    expect(wallet.updatedAt).toBe(at);
  });
});

describe('Wallet: movimentos', () => {
  const later = new Date('2026-10-24T13:00:00.000Z');
  const movement = (amount: string) => ({
    entryId: 'entry-2',
    transactionId: 'tx-2',
    money: brl(amount),
    at: later,
  });

  it('débito baixa o saldo, sobe a versão e devolve o lançamento correspondente', () => {
    const { wallet } = open(brl('100.00'));
    const entry = wallet.debit(movement('80.00'));

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toBe(later);
    expect(entry).toMatchObject({
      id: 'entry-2',
      walletId: 'wallet-1',
      transactionId: 'tx-2',
      direction: LedgerDirection.Debit,
      walletVersion: 2,
      createdAt: later,
    });
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
  });

  it('crédito sobe o saldo e a versão', () => {
    const { wallet } = open(brl('0.00'));
    const entry = wallet.credit(movement('50.00'));

    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.toString()).toBe('50.00');
  });

  it('débito igual ao saldo zera a wallet', () => {
    const { wallet } = open(brl('80.00'));
    wallet.debit(movement('80.00'));

    expect(wallet.balance.isZero()).toBe(true);
  });

  it('débito maior que o saldo é invariante violada e não altera nada', () => {
    const { wallet } = open(brl('79.99'));

    expect(() => wallet.debit(movement('80.00'))).toThrow(
      new WalletInvariantError('débito maior que o saldo'),
    );
    expect(wallet.balance.toString()).toBe('79.99');
    expect(wallet.version).toBe(1);
  });

  it('hasFunds aceita valor igual ao saldo e recusa valor maior', () => {
    const { wallet } = open(brl('80.00'));

    expect(wallet.hasFunds(brl('80.00'))).toBe(true);
    expect(wallet.hasFunds(brl('80.01'))).toBe(false);
  });
});
