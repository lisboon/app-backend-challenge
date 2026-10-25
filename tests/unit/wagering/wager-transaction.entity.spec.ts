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
  assertWagerTransactionTransition,
  INTERNAL_PROVIDER_ID,
  MovementDirection,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
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

describe('WagerTransaction: referências e reversões', () => {
  const reference = (overrides: Partial<WagerTransactionState> = {}) =>
    WagerTransaction.rehydrate({
      id: 'bet-id',
      providerId: 'provider-a',
      externalTransactionId: 'bet-external',
      idempotencyKey: 'bet-key',
      payloadHash: 'v1:reference',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      createdAt: at,
      status: WagerTransactionStatus.Processed,
      failureCode: undefined,
      resultBalance: brl('75.00'),
      processedAt: at,
      ...overrides,
    });
  const reversal = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
    submitted({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-external',
      ...overrides,
    });
  const refund = () =>
    reference({
      id: 'refund-id',
      externalTransactionId: 'refund-external',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-external',
      referenceTransactionId: 'bet-id',
    });
  const undoRefund = () =>
    reference({
      id: 'undo-refund-id',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'refund-external',
      referenceTransactionId: 'refund-id',
    });
  const undoBet = () =>
    reference({
      id: 'undo-bet-id',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'bet-external',
      referenceTransactionId: 'bet-id',
    });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    'exige referência em %s',
    (kind) => {
      expect(() => submitted({ kind })).toThrow(
        expect.objectContaining({
          failureCode: FailureCode.REFERENCE_REQUIRED,
        }),
      );
    },
  );
  it.each([
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])('recusa %s que referencia a si mesmo', (kind) => {
    expect(() =>
      submitted({ kind, referenceExternalTransactionId: 'ext-1' }),
    ).toThrow(
      expect.objectContaining({ failureCode: FailureCode.REFERENCE_SELF }),
    );
  });
  it.each([WagerTransactionKind.Bet, WagerTransactionKind.Loss])(
    'proíbe referência em %s',
    (kind) => {
      expect(() =>
        submitted({ kind, referenceExternalTransactionId: 'bet' }),
      ).toThrow(
        expect.objectContaining({
          failureCode: FailureCode.REFERENCE_NOT_ALLOWED,
        }),
      );
    },
  );
  it.each([
    [
      WagerTransactionKind.Bet,
      'v1:2c5cc6a081edbc1a9b2c8a9a9330a504849916bd5bcb5139ad28df9551d051a9',
    ],
    [
      WagerTransactionKind.Win,
      'v1:ffe6fb3027921907dee53e07464204d45faa36e3dabac8baebe26190238e90df',
    ],
    [
      WagerTransactionKind.Loss,
      'v1:f57c1b4d43a74dedfa0919732f79e051914b3a119e4fb8a74f6d032e7edf67ff',
    ],
  ] as const)(
    'preserva o hash fixo de %s calculado na base',
    (kind, expected) => {
      expect(submitted({ kind }).payloadHash).toBe(expected);
    },
  );
  it('WIN com referência muda o hash; ausência continua opcional', () => {
    const win = submitted({ kind: WagerTransactionKind.Win });
    expect(win.requiresReference()).toBe(false);
    const referenced = reversal({ kind: WagerTransactionKind.Win });
    expect(referenced.requiresReference()).toBe(true);
    expect(referenced.payloadHash).toBe(
      'v1:9bb4bc4ad0790852787c123cff8d086629dee8c6292b1d04a4b0b274b85969f3',
    );
    expect(referenced.payloadHash).not.toBe(win.payloadHash);
    expect(
      reversal({
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'other',
      }).payloadHash,
    ).not.toBe(referenced.payloadHash);
  });
  it.each([
    [
      WagerTransactionKind.Refund,
      WagerTransactionKind.Bet,
      MovementDirection.Credit,
    ],
    [
      WagerTransactionKind.Rollback,
      WagerTransactionKind.Bet,
      MovementDirection.Credit,
    ],
    [
      WagerTransactionKind.Rollback,
      WagerTransactionKind.Win,
      MovementDirection.Debit,
    ],
    [
      WagerTransactionKind.Rollback,
      WagerTransactionKind.Refund,
      MovementDirection.Debit,
    ],
  ] as const)('%s de %s tem direção %s', (kind, referencedKind, direction) => {
    expect(
      reversal({ kind }).ledgerDirectionFor(
        reference({ kind: referencedKind }),
      ),
    ).toBe(direction);
  });
  it.each([
    [WagerTransactionKind.Refund, WagerTransactionKind.Win],
    [WagerTransactionKind.Refund, WagerTransactionKind.Opening],
    [WagerTransactionKind.Win, WagerTransactionKind.Win],
    [WagerTransactionKind.Win, WagerTransactionKind.Opening],
    [WagerTransactionKind.Rollback, WagerTransactionKind.Loss],
    [WagerTransactionKind.Rollback, WagerTransactionKind.Opening],
    [WagerTransactionKind.Rollback, WagerTransactionKind.Rollback],
  ] as const)('%s recusa referência do tipo %s', (kind, referenceKind) => {
    expect(
      reversal({ kind }).rejectionFor(
        wallet(),
        reference({ kind: referenceKind }),
      ),
    ).toBe(FailureCode.REFERENCE_KIND_INVALID);
  });
  it.each([
    { providerId: 'other' },
    { walletId: 'other' },
    { playerId: 'other' },
    { roundId: 'other' },
    { externalTransactionId: 'other' },
    { money: Money.from({ amount: '25.00', currency: 'USD' }) },
  ])('rejeita identidade incompatível %j', (change) => {
    expect(reversal().rejectionFor(wallet(), reference(change))).toBe(
      FailureCode.REFERENCE_MISMATCH,
    );
  });
  it('referência rejeitada não pode ser aplicada', () => {
    expect(
      reversal().rejectionFor(
        wallet(),
        reference({ status: WagerTransactionStatus.Rejected }),
      ),
    ).toBe(FailureCode.REFERENCE_NOT_PROCESSED);
  });
  it('referência pendente ainda não decide valor nem saldo', () => {
    expect(
      reversal({
        kind: WagerTransactionKind.Rollback,
        money: brl('999.00'),
      }).rejectionFor(
        wallet('0.00'),
        reference({ status: WagerTransactionStatus.PendingReference }),
      ),
    ).toBeUndefined();
  });
  it('REFUND vivo bloqueia ROLLBACK de BET para não duplicar crédito', () => {
    expect(
      reversal({ kind: WagerTransactionKind.Rollback }).rejectionFor(
        wallet(),
        reference(),
        [refund()],
      ),
    ).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
  });
  it('REFUND desfeito não bloqueia ROLLBACK de BET', () => {
    expect(
      reversal({ kind: WagerTransactionKind.Rollback }).rejectionFor(
        wallet(),
        reference(),
        [refund(), undoRefund()],
      ),
    ).toBeUndefined();
  });
  it('o limite de uma reversão por tipo permanece depois de desfazer REFUND', () => {
    expect(
      reversal().rejectionFor(wallet(), reference(), [refund(), undoRefund()]),
    ).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
  });
  it('ROLLBACK de BET bloqueia REFUND e outro ROLLBACK', () => {
    for (const kind of [
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]) {
      expect(
        reversal({ kind }).rejectionFor(wallet(), reference(), [undoBet()]),
      ).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
    }
  });
  it('ROLLBACK do mesmo REFUND só aplica uma vez', () => {
    expect(
      reversal({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'refund-external',
      }).rejectionFor(wallet(), refund(), [undoRefund()]),
    ).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
  });
  it('WIN não é reversão, nem exige mesmo valor ou quantidade máxima', () => {
    const otherWin = reference({
      id: 'win-id',
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'bet-external',
      referenceTransactionId: 'bet-id',
    });
    expect(
      reversal({
        kind: WagerTransactionKind.Win,
        money: brl('1.00'),
      }).rejectionFor(wallet(), reference(), [
        otherWin,
        refund(),
        undoRefund(),
      ]),
    ).toBeUndefined();
  });
  it.each([
    ['REFUND vivo', () => [refund()]],
    ['ROLLBACK aplicado', () => [undoBet()]],
  ])('WIN não é pago sobre BET revertido por %s', (_caso, reversals) => {
    expect(
      reversal({ kind: WagerTransactionKind.Win }).rejectionFor(
        wallet(),
        reference(),
        reversals(),
      ),
    ).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
  });
  it('reversão exige valor igual', () => {
    expect(
      reversal({ money: brl('24.00') }).rejectionFor(wallet(), reference()),
    ).toBe(FailureCode.REVERSAL_AMOUNT_MISMATCH);
  });
  it('débito de reversão usa o código distinto de falta de saldo', () => {
    expect(
      reversal({ kind: WagerTransactionKind.Rollback }).rejectionFor(
        wallet('0.00'),
        reference({ kind: WagerTransactionKind.Win }),
      ),
    ).toBe(FailureCode.REVERSAL_INSUFFICIENT_BALANCE);
  });
  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    'limite do saldo também protege %s que credita',
    (kind) => {
      expect(
        reversal({ kind }).rejectionFor(
          wallet('999999999999999999.99'),
          reference(),
        ),
      ).toBe(FailureCode.BALANCE_LIMIT_EXCEEDED);
    },
  );
  it('precedência: wallet, tipo, identidade, estado, reversão, valor e saldo', () => {
    const tx = reversal({
      kind: WagerTransactionKind.Rollback,
      money: brl('999.00'),
    });
    const invalid = reference({
      kind: WagerTransactionKind.Opening,
      playerId: 'other',
      status: WagerTransactionStatus.Rejected,
    });
    expect(tx.rejectionFor({ ...wallet(), playerId: 'other' }, invalid)).toBe(
      FailureCode.WALLET_PLAYER_MISMATCH,
    );
    expect(tx.rejectionFor({ ...wallet(), currency: 'USD' }, invalid)).toBe(
      FailureCode.CURRENCY_MISMATCH,
    );
    expect(tx.rejectionFor(wallet(), invalid)).toBe(
      FailureCode.REFERENCE_KIND_INVALID,
    );
    expect(
      tx.rejectionFor(
        wallet(),
        reference({
          playerId: 'other',
          status: WagerTransactionStatus.Rejected,
        }),
      ),
    ).toBe(FailureCode.REFERENCE_MISMATCH);
    expect(
      tx.rejectionFor(
        wallet(),
        reference({ status: WagerTransactionStatus.Rejected }),
        [undoBet()],
      ),
    ).toBe(FailureCode.REFERENCE_NOT_PROCESSED);
    expect(tx.rejectionFor(wallet(), reference(), [undoBet()])).toBe(
      FailureCode.REFERENCE_ALREADY_REVERSED,
    );
    expect(
      tx.rejectionFor(
        wallet('0.00'),
        reference({ kind: WagerTransactionKind.Win }),
      ),
    ).toBe(FailureCode.REVERSAL_AMOUNT_MISMATCH);
  });
  it('aguarda, agenda retry, expira pelo relógio e resolve mantendo a correlação', () => {
    const tx = reversal({ correlationId: 'original' });
    tx.markPendingReference(at);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.isReferenceDue(at)).toBe(false);
    expect(tx.isReferenceDue(new Date(at.getTime() + 1000))).toBe(true);
    tx.scheduleReferenceRetry(at);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.referenceExpired(new Date(at.getTime() + 3599999), 3600)).toBe(
      false,
    );
    expect(tx.referenceExpired(new Date(at.getTime() + 3600000), 3600)).toBe(
      true,
    );
    tx.markProcessed(brl('100.00'), at, 'bet-id');
    expect(tx.referenceTransactionId).toBe('bet-id');
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
    expect(tx.correlationId).toBe('original');
  });

  it('backoff de uma referência ausente não agenda além do TTL', () => {
    const tx = reversal();
    tx.markPendingReference(at, 3);
    tx.scheduleReferenceRetry(new Date(at.getTime() + 1000), 3);
    tx.scheduleReferenceRetry(new Date(at.getTime() + 2000), 3);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(at.getTime() + 3000);
    expect(tx.isReferenceDue(new Date(at.getTime() + 3000))).toBe(true);
  });
  for (const from of Object.values(WagerTransactionStatus)) {
    for (const to of Object.values(WagerTransactionStatus)) {
      it(`transição ${from} → ${to} respeita a tabela fechada`, () => {
        const allowed =
          (from === WagerTransactionStatus.Pending &&
            to !== WagerTransactionStatus.Pending) ||
          (from === WagerTransactionStatus.PendingReference &&
            (to === WagerTransactionStatus.Processed ||
              to === WagerTransactionStatus.Rejected));
        if (allowed) {
          expect(() =>
            assertWagerTransactionTransition(from, to),
          ).not.toThrow();
        } else {
          expect(() => assertWagerTransactionTransition(from, to)).toThrow(
            InvalidTransactionStateError,
          );
        }
      });
    }
  }
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
  it('recusa o provider reservado antes de criar uma transação externa', () => {
    expect(() => submitted({ providerId: INTERNAL_PROVIDER_ID })).toThrow(
      expect.objectContaining({ failureCode: 'PROVIDER_RESERVED' }),
    );
  });

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
  it('rejeita crédito que excederia o limite do saldo', () => {
    expect(
      submitted({
        kind: WagerTransactionKind.Win,
        money: brl('0.01'),
      }).rejectionFor(wallet('999999999999999999.99')),
    ).toBe('BALANCE_LIMIT_EXCEEDED');
  });

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
