import { describe, expect, it } from 'bun:test';

import { FailureCode } from '../../../src/modules/@shared/domain/failure-code';
import { Money } from '../../../src/modules/@shared/domain/money';
import {
  InvalidTransactionStateError,
  TransactionAmountInvalidError,
  TransactionKindNotSubmittableError,
} from '../../../src/modules/wagering/domain/errors/wagering.errors';
import {
  type CreateWagerTransactionProps,
  INTERNAL_PROVIDER_ID,
  MovementDirection,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/modules/wagering/domain/wager-transaction.entity';

const at = new Date('2026-10-24T12:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const opening = (amount = '100.00', walletId = 'wallet-1') =>
  WagerTransaction.opening({
    id: 'opening-1',
    walletId,
    playerId: 'player-1',
    money: brl(amount),
    at,
  });

const submitted = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    at,
    ...overrides,
  });

const wallet = (balance = '100.00') => ({
  playerId: 'player-1',
  currency: 'BRL',
  balance: brl(balance),
});

describe('WagerTransaction.opening', () => {
  it('nasce processada, do provedor interno, sem rodada e com o saldo de abertura', () => {
    const transaction = opening();

    expect(transaction).toMatchObject({
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: 'opening:wallet-1',
      idempotencyKey: 'internal:opening:wallet-1',
      kind: WagerTransactionKind.Opening,
      roundId: undefined,
      gameId: undefined,
      createdAt: at,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toBe(at);
    expect(transaction.resultBalance?.toString()).toBe('100.00');
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

describe('WagerTransaction.create', () => {
  it('nasce pendente, sem desfecho', () => {
    const transaction = submitted();

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.resultBalance).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
  });

  it('recusa OPENING, que é interno', () => {
    expect(() => submitted({ kind: WagerTransactionKind.Opening })).toThrow(
      TransactionKindNotSubmittableError,
    );
  });

  it.each([[WagerTransactionKind.Bet], [WagerTransactionKind.Win]])(
    'recusa %s de valor zero',
    (kind) => {
      expect(() => submitted({ kind, money: brl('0.00') })).toThrow(
        TransactionAmountInvalidError,
      );
    },
  );

  it('aceita LOSS de valor zero', () => {
    expect(
      submitted({ kind: WagerTransactionKind.Loss, money: brl('0.00') }).status,
    ).toBe(WagerTransactionStatus.Pending);
  });

  it('o hash cobre os campos de negócio e ignora a idempotency key', () => {
    const base = submitted().payloadHash;

    expect(submitted({ idempotencyKey: 'outra-chave' }).payloadHash).toBe(base);
    expect(submitted({ id: 'outro-id' }).payloadHash).toBe(base);
    expect(submitted({ at: new Date(0) }).payloadHash).toBe(base);
    for (const change of [
      { providerId: 'provider-b' },
      { externalTransactionId: 'ext-2' },
      { walletId: 'wallet-2' },
      { playerId: 'player-2' },
      { roundId: 'round-2' },
      { gameId: 'game-2' },
      { kind: WagerTransactionKind.Win },
      { money: brl('25.01') },
      { money: Money.from({ amount: '25.00', currency: 'USD' }) },
    ]) {
      expect(submitted(change).payloadHash).not.toBe(base);
    }
  });

  it('matchesPayload compara o hash recebido', () => {
    const transaction = submitted();

    expect(transaction.matchesPayload(transaction.payloadHash)).toBe(true);
    expect(
      transaction.matchesPayload(submitted({ money: brl('1.00') }).payloadHash),
    ).toBe(false);
  });
});

describe('WagerTransaction: movimento e regras', () => {
  it.each([
    [WagerTransactionKind.Bet, MovementDirection.Debit],
    [WagerTransactionKind.Win, MovementDirection.Credit],
  ])('%s move saldo como %s', (kind, direction) => {
    const transaction = submitted({ kind });

    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.ledgerDirectionFor()).toBe(direction);
  });

  it('LOSS não move saldo', () => {
    expect(
      submitted({ kind: WagerTransactionKind.Loss }).affectsBalance(),
    ).toBe(false);
  });

  it('isTerminal só é falso enquanto pendente', () => {
    const transaction = submitted();

    expect(transaction.isTerminal()).toBe(false);
    transaction.markProcessed(brl('1.00'), at);
    expect(transaction.isTerminal()).toBe(true);
  });

  it('aceita BET com saldo suficiente, inclusive exato', () => {
    expect(submitted().rejectionFor(wallet('25.00'))).toBeUndefined();
  });

  it.each([
    ['BET sem saldo', {}, wallet('24.99'), FailureCode.INSUFFICIENT_BALANCE],
    [
      'wallet de outro player',
      {},
      { ...wallet(), playerId: 'player-2' },
      FailureCode.WALLET_PLAYER_MISMATCH,
    ],
    [
      'moeda diferente da wallet',
      { money: Money.from({ amount: '25.00', currency: 'USD' }) },
      wallet(),
      FailureCode.CURRENCY_MISMATCH,
    ],
  ])('rejeita %s', (_caso, overrides, target, code) => {
    expect(submitted(overrides).rejectionFor(target)).toBe(code);
  });

  it.each([[WagerTransactionKind.Win], [WagerTransactionKind.Loss]])(
    '%s não depende de saldo',
    (kind) => {
      expect(submitted({ kind }).rejectionFor(wallet('0.00'))).toBeUndefined();
    },
  );
});

describe('WagerTransaction: transições', () => {
  it('markProcessed registra o saldo observado e a data', () => {
    const transaction = submitted();
    transaction.markProcessed(brl('75.00'), at);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.resultBalance?.toString()).toBe('75.00');
    expect(transaction.processedAt).toBe(at);
    expect(transaction.failureCode).toBeUndefined();
  });

  it('reject registra o código e o saldo observado', () => {
    const transaction = submitted();
    transaction.reject(FailureCode.INSUFFICIENT_BALANCE, brl('10.00'), at);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);
    expect(transaction.resultBalance?.toString()).toBe('10.00');
  });

  it.each([
    ['processada', (t: WagerTransaction) => t.markProcessed(brl('1.00'), at)],
    [
      'rejeitada',
      (t: WagerTransaction) =>
        t.reject(FailureCode.INSUFFICIENT_BALANCE, brl('1.00'), at),
    ],
  ])('transação %s é terminal', (_caso, settle) => {
    const transaction = submitted();
    settle(transaction);

    expect(() => transaction.markProcessed(brl('1.00'), at)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      transaction.reject(FailureCode.INSUFFICIENT_BALANCE, brl('1.00'), at),
    ).toThrow(InvalidTransactionStateError);
  });

  it('a abertura nasce terminal', () => {
    expect(() => opening().markProcessed(brl('1.00'), at)).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('rehydrate reconstrói o estado sem revalidar', () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'k',
      payloadHash: 'v1:x',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl('0.00'),
      createdAt: at,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.INSUFFICIENT_BALANCE,
      resultBalance: brl('5.00'),
      processedAt: at,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.money.toString()).toBe('0.00');
    expect(transaction.resultBalance?.toString()).toBe('5.00');
  });
});
